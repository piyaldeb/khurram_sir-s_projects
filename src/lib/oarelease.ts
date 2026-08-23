/**
 * OA released — what the plant has been told to make, by product and company.
 *
 * An OA (Order Acknowledgement) is a bulk sales order, named `OA` plus its
 * number; `released_status = released` is the moment marketing hands it to
 * production. So "OA released" is the order book actually on the floor, and it
 * leads the daily production sheet by weeks.
 *
 *   sale.order        name =like OA% and released_status = released
 *   sale.order.line   the same orders, reached through order_id
 *
 * A month is attributed by the ORDER's `date_order`, not the line's creation
 * date: summing `price_subtotal` over lines whose order falls in the month
 * reproduces the order-level `amount_untaxed` exactly (July 2026 Zipper:
 * $1,562,705 both ways).
 *
 * PRODUCT
 * -------
 * Odoo has no product level between "COIL 3 ZIPPER CLOSE END" and the 21,000
 * variants that spell out every slider, shade and length. The line's
 * `product_code` comes close, but it was only filled in from September 2023, so
 * it cannot carry the early months.
 *
 * What holds for all of it is the variant's own name: everything before the
 * bracketed spec is the product family. Grouping the variants by that gives ~73
 * products in a recent month and covers April 2023 too. The codes and the
 * variants themselves are not lost — they open underneath the row.
 *
 * A month costs Odoo about six seconds to group, so each month's AGGREGATE is
 * cached: a closed month is fetched exactly once, the month in progress ages
 * out on a TTL, and the caller fills a few months per request so no single
 * request outlives a serverless timeout.
 */
import { buildContext, callKw, getSession, productionCompanies, type OdooCompany } from './odoo';
import { readCacheMany, writeCache } from './cache';

const FRESH_MINUTES = Number(process.env.ODOO_SYNC_FRESH_MINUTES || 15);

/** The first month Odoo holds a released OA for. Nothing earlier exists. */
export const FIRST_MONTH = '2023-04';

/**
 * How many months one request may fetch.
 *
 * Six seconds a month against a serverless ceiling: four months keeps a request
 * comfortably short, and the page asks again until nothing is pending.
 */
export const FETCH_BUDGET = Number(process.env.OA_FETCH_PER_REQUEST || 4);

export interface ProductEntry {
  /** Order value, USD, ex tax. */
  value: number;
  /** Ordered quantity, in the line's own unit — pieces for trims, yards for chain. */
  qty: number;
  lines: number;
  /** Distinct variants of this product ordered in the month. */
  variants: number;
}

export interface CompanyMonth {
  id: number;
  name: string;
  /** From sale.order, so it ties out against Odoo's own list view. */
  orders: number;
  value: number;
  qty: number;
  lines: number;
  byProduct: Record<string, ProductEntry>;
}

export interface MonthOa {
  month: string;
  companies: CompanyMonth[];
  fetchedAt: string;
  error?: string;
}

/* ------------------------------------------------------------------- Odoo */

const norm = (v: unknown) => String(v ?? '').trim();
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const idOf = (v: unknown) => (Array.isArray(v) ? (v[0] as number) : null);
const nameOf = (v: unknown) => (Array.isArray(v) ? String(v[1] ?? '') : '');

/** The order-side domain: released bulk orders only. */
export const OA_ORDER_DOMAIN: unknown[] = [
  ['name', '=like', 'OA%'],
  ['released_status', '=', 'released'],
];

/** The same orders, reached from their lines. */
export const OA_LINE_DOMAIN: unknown[] = [
  ['order_id.name', '=like', 'OA%'],
  ['order_id.released_status', '=', 'released'],
];

/**
 * Every allowed company: which company an order belongs to is a result here,
 * not a filter, so the read has to be able to see both of them.
 */
async function ctx(): Promise<Record<string, unknown>> {
  return buildContext(await getSession());
}

/**
 * The product family behind a variant name.
 *
 * "COIL 3 ZIPPER CLOSE END (DTM, Slider C#3 ...)" -> "COIL 3 ZIPPER CLOSE END".
 * A handful of variants carry their internal number instead of a bracket
 * ("HIDDEN SNAP 100234813"); that number is part of the spec too, so it goes
 * the same way.
 */
export function productFamily(variantName: string): string {
  return norm(variantName)
    .split('(')[0]
    .replace(/\s+\d{4,}\s*$/, '')
    .replace(/[\s,\-]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const lastDayOf = (month: string): number => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/**
 * The month as a pair of Odoo datetimes.
 *
 * Odoo compares stored UTC against whatever string it is given, and the report
 * is read the way the factory reads it — so the bounds are the calendar month
 * as written, matching how the same figures come back from Odoo's own list.
 */
function monthBounds(month: string): [string, string] {
  return [`${month}-01 00:00:00`, `${month}-${String(lastDayOf(month)).padStart(2, '0')} 23:59:59`];
}

export function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/** Every month Odoo could hold an OA for, oldest first. */
export function allMonths(): string[] {
  const out: string[] = [];
  const end = currentMonth();
  let [y, m] = FIRST_MONTH.split('-').map(Number);
  for (;;) {
    const month = `${y}-${String(m).padStart(2, '0')}`;
    out.push(month);
    if (month >= end) break;
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

const cacheKey = (month: string) => {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`bad month "${month}"`);
  return `oarel-${month}`;
};

function isFresh(entry: MonthOa): boolean {
  const age = Date.now() - new Date(entry.fetchedAt).getTime();
  // A failed month is retried on the same schedule as the month in progress.
  if (entry.error) return age < FRESH_MINUTES * 60_000;
  // A closed month never changes.
  if (entry.month !== currentMonth()) return true;
  return age < FRESH_MINUTES * 60_000;
}

/**
 * One month's OA release, split by company and product.
 *
 * Two reads: the lines carry the product split, the orders carry the count and
 * the authoritative value. Both are scoped by `date_order`, so they agree.
 */
async function fetchMonth(month: string, companies: OdooCompany[]): Promise<MonthOa> {
  const known = new Map(companies.map((c) => [c.id, c.name]));
  const entry: MonthOa = { month, companies: [], fetchedAt: new Date().toISOString() };

  // A month that has not started cannot have released anything.
  if (month > currentMonth()) return entry;

  const [from, to] = monthBounds(month);
  const context = await ctx();

  const slot = (id: number, name: string): CompanyMonth => {
    let found = entry.companies.find((c) => c.id === id);
    if (!found) {
      found = { id, name, orders: 0, value: 0, qty: 0, lines: 0, byProduct: {} };
      entry.companies.push(found);
    }
    return found;
  };

  try {
    const [lines, orders] = await Promise.all([
      callKw<any[]>('sale.order.line', 'read_group', {
        args: [
          [
            ['order_id.date_order', '>=', from],
            ['order_id.date_order', '<=', to],
            ...OA_LINE_DOMAIN,
          ],
          ['price_subtotal', 'product_uom_qty'],
          ['product_id', 'company_id'],
        ],
        kwargs: { context, lazy: false },
      }),
      callKw<any[]>('sale.order', 'read_group', {
        args: [
          [['date_order', '>=', from], ['date_order', '<=', to], ...OA_ORDER_DOMAIN],
          ['amount_untaxed'],
          ['company_id'],
        ],
        kwargs: { context, lazy: false },
      }),
    ]);

    for (const row of orders) {
      const id = idOf(row.company_id);
      if (id === null) continue;
      const company = slot(id, known.get(id) ?? nameOf(row.company_id));
      company.orders = num(row.__count);
      company.value = num(row.amount_untaxed);
    }

    for (const row of lines) {
      const id = idOf(row.company_id);
      if (id === null) continue;
      const company = slot(id, known.get(id) ?? nameOf(row.company_id));
      const family = productFamily(nameOf(row.product_id)) || '(unnamed product)';

      const product = (company.byProduct[family] ??= { value: 0, qty: 0, lines: 0, variants: 0 });
      product.value += num(row.price_subtotal);
      product.qty += num(row.product_uom_qty);
      product.lines += num(row.__count);
      product.variants += 1;

      company.qty += num(row.product_uom_qty);
      company.lines += num(row.__count);
    }

    // The order-level total is the one to trust, but a company that only shows
    // up on the line side would otherwise read as zero.
    for (const company of entry.companies) {
      if (!company.value) {
        company.value = Object.values(company.byProduct).reduce((a, p) => a + p.value, 0);
      }
    }
  } catch (err) {
    entry.error = (err as Error).message;
  }

  entry.companies.sort((a, b) => a.id - b.id);
  await writeCache(cacheKey(month), entry, 'oa-released');
  return entry;
}

/* ----------------------------------------------------------------- history */

export interface OaHistory {
  months: MonthOa[];
  companies: OdooCompany[];
  /** Months still to fetch — ask again until this is empty. */
  pending: string[];
  failed: { month: string; error: string }[];
  ready: boolean;
  firstMonth: string;
  fetchedAt: string;
}

/**
 * Everything Odoo holds, filling at most `budget` missing months per call.
 *
 * Newest first: a cold cache should put the months people actually look at on
 * screen before it walks back to 2023.
 */
export async function oaHistory(budget = FETCH_BUDGET): Promise<OaHistory> {
  const session = await getSession();
  const companies = productionCompanies(session);
  const months = allMonths();

  const cached = await readCacheMany<MonthOa>(months.map(cacheKey), 'oa-released');

  const have: MonthOa[] = [];
  const missing: string[] = [];
  for (const month of months) {
    const entry = cached.get(cacheKey(month));
    if (entry && isFresh(entry)) have.push(entry);
    else missing.push(month);
  }

  missing.sort((a, b) => b.localeCompare(a));
  const toFetch = missing.slice(0, Math.max(budget, 0));
  const pending = missing.slice(toFetch.length);

  // Two at a time: Odoo groups these one query at a time anyway, and more
  // parallelism just trades one queue for another.
  const CONCURRENCY = 2;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, toFetch.length) }, async () => {
      while (next < toFetch.length) {
        have.push(await fetchMonth(toFetch[next++], companies));
      }
    }),
  );

  have.sort((a, b) => a.month.localeCompare(b.month));

  return {
    months: have,
    companies,
    pending: pending.sort(),
    failed: have.filter((m) => m.error).map((m) => ({ month: m.month, error: m.error! })),
    ready: pending.length === 0,
    firstMonth: FIRST_MONTH,
    fetchedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------- one product */

export interface Breakdown {
  name: string;
  value: number;
  qty: number;
  lines: number;
}

export interface RecentOrder {
  order: string;
  date: string;
  customer: string;
  company: string;
  value: number;
}

export interface ProductDetail {
  product: string;
  companyId: number | null;
  byVariant: Breakdown[];
  byCode: Breakdown[];
  byCustomer: Breakdown[];
  recent: RecentOrder[];
  fetchedAt: string;
}

/** Odoo's `=like` is a raw SQL LIKE, so its wildcards have to be escaped. */
const likeEscape = (s: string) => s.replace(/([%_\\])/g, '\\$1');

/**
 * What sits underneath one product, read live.
 *
 * The month-by-month history is already on the page — it comes from the cached
 * months — so this only fetches what the roll-up threw away: which variants,
 * which internal codes, which customers, and the last OAs to carry it. Each is
 * a sub-second grouped read, so they go together.
 */
export async function productDetail(
  product: string,
  companyId: number | null = null,
): Promise<ProductDetail> {
  const context = await ctx();
  const domain: unknown[] = [
    ['product_id.name', '=like', `${likeEscape(product)}%`],
    ...OA_LINE_DOMAIN,
    ...(companyId ? [['company_id', '=', companyId]] : []),
  ];

  const top = (field: string) => ({
    args: [domain, ['price_subtotal', 'product_uom_qty'], [field]],
    kwargs: { context, lazy: false, limit: 25, orderby: 'price_subtotal desc' },
  });

  const [variants, codes, customers, lines] = await Promise.all([
    callKw<any[]>('sale.order.line', 'read_group', top('product_id')),
    callKw<any[]>('sale.order.line', 'read_group', top('product_code')),
    callKw<any[]>('sale.order.line', 'read_group', top('order_partner_id')),
    callKw<any[]>('sale.order.line', 'search_read', {
      args: [domain, ['order_id', 'order_partner_id', 'company_id', 'price_subtotal']],
      kwargs: { context, limit: 400, order: 'id desc' },
    }),
  ]);

  const mapped = (rows: any[], field: string, fallback: string): Breakdown[] =>
    rows
      .map((row) => ({
        name: (typeof row[field] === 'string' ? row[field] : nameOf(row[field])) || fallback,
        value: num(row.price_subtotal),
        qty: num(row.product_uom_qty),
        lines: num(row.__count),
      }))
      .filter((row) => row.lines > 0);

  // One OA can carry several lines of the same product; the row is the order.
  const orders = new Map<number, RecentOrder>();
  for (const row of lines) {
    const id = idOf(row.order_id);
    if (id === null) continue;
    const held = orders.get(id);
    if (held) {
      held.value += num(row.price_subtotal);
      continue;
    }
    orders.set(id, {
      order: nameOf(row.order_id),
      date: '',
      customer: nameOf(row.order_partner_id),
      company: nameOf(row.company_id),
      value: num(row.price_subtotal),
    });
  }

  // Line ids run with time, so the newest lines are already the newest orders;
  // only those need their date read.
  const ids = [...orders.keys()].slice(0, 40);
  if (ids.length) {
    const dates = await callKw<any[]>('sale.order', 'read', {
      args: [ids, ['date_order']],
      kwargs: { context },
    });
    for (const row of dates) {
      const held = orders.get(row.id);
      if (held) held.date = norm(row.date_order).slice(0, 10);
    }
  }

  return {
    product,
    companyId,
    byVariant: mapped(variants, 'product_id', '(no variant)'),
    byCode: mapped(codes, 'product_code', '(no code)'),
    byCustomer: mapped(customers, 'order_partner_id', '(no customer)'),
    recent: [...orders.values()]
      .filter((o) => o.date)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 25),
    fetchedAt: new Date().toISOString(),
  };
}
