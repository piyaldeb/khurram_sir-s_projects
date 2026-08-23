/**
 * RM consumption history — what the plant has actually burned, month by month.
 *
 * Source: `rm.stock.detailed.monthly`, Odoo's own monthly raw-material ledger.
 * One row per item per lot per month, carrying the full movement:
 *
 *   opening + receive + issue = closing
 *
 * That identity holds to the dollar in every month and company checked, so the
 * page states it and shows the residual rather than quietly trusting it.
 *
 * `issue_qty` and `issue_value` are stored NEGATIVE — they are movements out.
 * Everything here flips the sign at the boundary, so "consumption" is a
 * positive number from this module onwards and nothing downstream has to
 * remember which way round it was.
 *
 * VALUE, NOT QUANTITY
 * -------------------
 * The ledger mixes twenty-one units of measure — Pcs, kg, Gross, Yard, Litre,
 * Gallon, Roll, Drum, MT and more. Adding a kilo of brass wire to a gross of
 * sliders produces a number, but not a meaning, so every aggregate on this page
 * is money. Quantity appears only where one product means one unit: inside a
 * drill-down, beside its own UoM.
 *
 * Grouping the whole 123k-row history takes Odoo well under two seconds, so
 * unlike the OA report there is no month-by-month fill: one grouped read covers
 * everything and the result is cached under a short TTL.
 */
import { buildContext, callKw, getSession, productionCompanies } from './odoo';
import { readCache, writeCache } from './cache';

const MODEL = 'rm.stock.detailed.monthly';
const FRESH_MINUTES = Number(process.env.RM_FRESH_MINUTES || process.env.ODOO_SYNC_FRESH_MINUTES || 15);

/** The ledger columns, in the order they tell the story. */
const LEDGER_FIELDS = [
  'opening_value',
  'receive_value',
  'issue_value',
  'cloing_value',
  'issue_qty',
] as const;

/**
 * The ways the ledger can be cut.
 *
 * `product_category` leads: it is the level the material is actually managed
 * at — "METAL 4 / BRASS WIRE M#4 DN+", "COIL 3 / N#3 SLIDER" — naming both the
 * product line and the part in one label. The others are coarser or answer a
 * different question: the item family, the finished line the material feeds,
 * and who supplied it.
 */
export const DIMENSIONS = [
  { key: 'category', field: 'product_category', label: 'Product category', noun: 'category' },
  { key: 'item', field: 'item_category', label: 'Item type', noun: 'item type' },
  { key: 'line', field: 'parent_category', label: 'Product line', noun: 'product line' },
  { key: 'vendor', field: 'partner_id', label: 'Vendor', noun: 'vendor' },
] as const;

export type DimensionKey = (typeof DIMENSIONS)[number]['key'];

/** The cut the page opens on. */
export const DEFAULT_DIMENSION: DimensionKey = 'category';

export const isDimension = (key: string): key is DimensionKey =>
  DIMENSIONS.some((d) => d.key === key);

export interface LedgerMonth {
  month: string;
  companyId: number;
  opening: number;
  receive: number;
  /** Consumption, positive. */
  issue: number;
  closing: number;
  rows: number;
}

export interface DimensionRow {
  label: string;
  /** Consumption per month, aligned to `months`, keyed by company id. */
  issue: Record<number, number[]>;
  /** Closing stock per month, same alignment — what feeds months-of-cover. */
  closing: Record<number, number[]>;
}

export interface RmHistory {
  dimension: DimensionKey;
  months: string[];
  companies: { id: number; name: string }[];
  ledger: LedgerMonth[];
  rows: DimensionRow[];
  fetchedAt: string;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const idOf = (v: unknown) => (Array.isArray(v) ? (v[0] as number) : null);
const labelOf = (v: unknown) => (Array.isArray(v) ? String(v[1] ?? '').trim() : '');

/** Money to the cent; the ledger identity is checked against these. */
const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Odoo renders the group key as "July 2026", which is a label, not a key.
 * `__range.from` is the ISO date the group actually starts at, so the month
 * comes from there and never depends on the server's locale.
 */
function monthKey(row: any, field: string): string | null {
  const from = row.__range?.[`${field}:month`]?.from ?? row.__range?.[field]?.from;
  if (typeof from === 'string' && /^\d{4}-\d{2}/.test(from)) return from.slice(0, 7);

  // Fall back to parsing the label, so a change in Odoo's grouping shape
  // degrades to a wrong-looking month rather than an empty report.
  const raw = String(row[`${field}:month`] ?? '');
  const parsed = new Date(`1 ${raw} UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 7);
}

async function ctx(): Promise<Record<string, unknown>> {
  // The ledger spans both manufacturing companies and which one a row belongs
  // to is a result here, not a filter.
  return buildContext(await getSession());
}

const cacheKey = (dim: DimensionKey) => `rmcons-${dim}`;

function isFresh(entry: RmHistory): boolean {
  return Date.now() - new Date(entry.fetchedAt).getTime() < FRESH_MINUTES * 60_000;
}

/**
 * The whole history, cut by one dimension.
 *
 * Two grouped reads: the ledger by month and company, and the same by
 * dimension member. They are asked for together because the second is the
 * table and the first is what the table has to add up to.
 */
export async function rmHistory(dimension: DimensionKey = DEFAULT_DIMENSION): Promise<RmHistory> {
  const cached = await readCache<RmHistory>(cacheKey(dimension), 'rm-consumption');
  if (cached && isFresh(cached)) return cached;

  const dim = DIMENSIONS.find((d) => d.key === dimension)!;
  const session = await getSession();
  const known = new Map(productionCompanies(session).map((c) => [c.id, c.name]));
  const context = await ctx();

  const [ledgerRows, dimRows] = await Promise.all([
    callKw<any[]>(MODEL, 'read_group', {
      args: [[], [...LEDGER_FIELDS], ['month:month', 'company_id']],
      kwargs: { context, lazy: false },
    }),
    callKw<any[]>(MODEL, 'read_group', {
      args: [[], ['issue_value', 'cloing_value'], ['month:month', 'company_id', dim.field]],
      kwargs: { context, lazy: false },
    }),
  ]);

  // The months come from the ledger read, which is the authoritative one.
  const months = [
    ...new Set(ledgerRows.map((row) => monthKey(row, 'month')).filter((m): m is string => !!m)),
  ].sort();
  const at = new Map(months.map((m, i) => [m, i]));

  const companies = new Map<number, string>();
  const ledger: LedgerMonth[] = [];

  for (const row of ledgerRows) {
    const month = monthKey(row, 'month');
    const id = idOf(row.company_id);
    if (!month || id === null) continue;
    companies.set(id, known.get(id) ?? labelOf(row.company_id) ?? `Company ${id}`);

    ledger.push({
      month,
      companyId: id,
      opening: round2(num(row.opening_value)),
      receive: round2(num(row.receive_value)),
      // Issues are stored negative; consumption is positive from here on.
      issue: round2(-num(row.issue_value)),
      closing: round2(num(row.cloing_value)),
      rows: num(row.__count),
    });
  }

  const blank = `(no ${dim.noun})`;
  const rows = new Map<string, DimensionRow>();

  for (const row of dimRows) {
    const month = monthKey(row, 'month');
    const id = idOf(row.company_id);
    if (!month || id === null) continue;
    const i = at.get(month);
    if (i === undefined) continue;

    const raw = row[dim.field];
    const label = (typeof raw === 'string' ? raw : labelOf(raw)) || blank;

    let held = rows.get(label);
    if (!held) rows.set(label, (held = { label, issue: {}, closing: {} }));
    const issue = (held.issue[id] ??= months.map(() => 0));
    const closing = (held.closing[id] ??= months.map(() => 0));
    issue[i] += -num(row.issue_value);
    closing[i] += num(row.cloing_value);
  }

  // Rounding here rather than on every addition keeps the payload small
  // without the running totals drifting by a cent per group.
  for (const row of rows.values()) {
    for (const map of [row.issue, row.closing]) {
      for (const series of Object.values(map)) {
        for (let i = 0; i < series.length; i++) series[i] = Math.round(series[i]);
      }
    }
  }

  const doc: RmHistory = {
    dimension,
    months,
    companies: [...companies.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.id - b.id),
    ledger: ledger.sort(
      (a, b) => a.month.localeCompare(b.month) || a.companyId - b.companyId,
    ),
    // A member that never moved anything is not a row anyone wants to read.
    rows: [...rows.values()].filter((r) =>
      Object.values(r.issue).some((series) => series.some((v) => v !== 0)),
    ),
    fetchedAt: new Date().toISOString(),
  };

  await writeCache(cacheKey(dimension), doc, 'rm-consumption');
  return doc;
}

/* ----------------------------------------------------------- one dimension */

export interface Breakdown {
  name: string;
  issue: number;
  closing: number;
  qty: number;
  /** The unit that quantity is in, when the whole breakdown shares one. */
  unit: string | null;
  rows: number;
}

export interface MemberDetail {
  dimension: DimensionKey;
  member: string;
  companyId: number | null;
  range: { from: string; to: string } | null;
  byProduct: Breakdown[];
  byVendor: Breakdown[];
  byLine: Breakdown[];
  /** Set when every product underneath shares one unit of measure. */
  unit: string | null;
  fetchedAt: string;
}

const monthStart = (month: string) => `${month}-01`;

/** The first day of the month after `month` — an exclusive upper bound. */
function monthAfter(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/**
 * What sits underneath one row of the sheet, read live.
 *
 * The month-by-month history is already on the page, so this only fetches what
 * the roll-up threw away: which items, which vendors, and which finished
 * product lines the material fed. Each is a sub-second grouped read.
 *
 * Quantity comes back too, but it is only shown when every product in the
 * breakdown shares a unit — otherwise it would be kilos added to gross.
 */
export async function memberDetail(
  dimension: DimensionKey,
  member: string,
  companyId: number | null = null,
  range: { from: string; to: string } | null = null,
): Promise<MemberDetail> {
  const dim = DIMENSIONS.find((d) => d.key === dimension)!;
  const context = await ctx();

  // The sheet groups by display name, so the detail matches on it. A member
  // labelled "(no vendor)" is the rows with no vendor at all.
  const blank = `(no ${dim.noun})`;
  const domain: unknown[] = [
    ...(member === blank
      ? [[dim.field, '=', false]]
      : [[`${dim.field}.display_name`, '=', member]]),
    ...(companyId ? [['company_id', '=', companyId]] : []),
    ...(range
      ? [
          ['month', '>=', monthStart(range.from)],
          ['month', '<', monthAfter(range.to)],
        ]
      : []),
  ];

  const top = (field: string) => ({
    args: [domain, ['issue_value', 'cloing_value', 'issue_qty'], [field]],
    kwargs: { context, lazy: false, limit: 25, orderby: 'issue_value asc' },
  });

  const [products, vendors, lines, units] = await Promise.all([
    callKw<any[]>(MODEL, 'read_group', top('product_id')),
    callKw<any[]>(MODEL, 'read_group', top('partner_id')),
    callKw<any[]>(MODEL, 'read_group', top('parent_category')),
    callKw<any[]>(MODEL, 'read_group', {
      args: [domain, ['issue_qty'], ['product_uom']],
      kwargs: { context, lazy: false },
    }),
  ]);

  // One unit across the whole member means the quantity column means
  // something; more than one and it would be adding kilos to gross.
  const moving = units.filter((row) => num(row.issue_qty) !== 0);
  const unit = moving.length === 1 ? labelOf(moving[0].product_uom) || null : null;

  const mapped = (rows: any[], field: string, fallback: string): Breakdown[] =>
    rows
      .map((row) => ({
        name: (typeof row[field] === 'string' ? row[field] : labelOf(row[field])) || fallback,
        issue: Math.round(-num(row.issue_value)),
        closing: Math.round(num(row.cloing_value)),
        qty: Math.round(-num(row.issue_qty)),
        unit,
        rows: num(row.__count),
      }))
      .filter((row) => row.issue !== 0 || row.closing !== 0);

  return {
    dimension,
    member,
    companyId,
    range,
    byProduct: mapped(products, 'product_id', '(no item)'),
    byVendor: mapped(vendors, 'partner_id', '(no vendor)'),
    byLine: mapped(lines, 'parent_category', '(unassigned)'),
    unit,
    fetchedAt: new Date().toISOString(),
  };
}
