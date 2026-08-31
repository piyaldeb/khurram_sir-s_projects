/**
 * What the BOM says a month should have cost, against what the store issued.
 *
 * Two sides, built separately and joined on the raw-material product id:
 *
 *   standard  mrp.bom.line         which components, and of what material type
 *             sale.order.line      how much of each - the `*_con` fields
 *             purchase.order.line  what that component costs to buy
 *   actual    rm.stock.detailed.monthly   issue_value, what actually left the store
 *
 * The join is on the product id rather than a category name on purpose: a name
 * map would be one Odoo rename away from silently reporting a whole material as
 * unaccounted for.
 *
 * THE ONE THING WORTH UNDERSTANDING
 * ---------------------------------
 * A BOM line here does NOT carry a usable quantity. `mrp.bom.line.product_qty`
 * is whatever `fg.product.formula` returned for the order line that first
 * created the BOM, and that BOM is then reused by every later line sharing its
 * code - so the number belongs to a different order than the one being read.
 *
 * Odoo's own planner knows this and never reads it: `_prepare_requisition_lines`
 * in `taps_manufacturing_plan` walks the BOM for the component list, then calls
 * `_get_consumption_qty`, which reads the SALE ORDER LINE's own fields. This
 * follows it exactly, because the alternative is a report that looks right and
 * is wrong:
 *
 *   tape    tape_con        slider  slider_con       wire  wire_con
 *   metal   topwire_con / botomwire_con / pinbox_con     (category starts M or A)
 *   other   tbwire_con, split evenly across the top/bottom/pinbox/pom lines
 *
 * Checked against a real line: BOM 11505 carries pinbox 1.03, the order line
 * 1,575 pieces, and `pinbox_con` is 1,622.25 - which is 1.03 x 1,575 exactly.
 *
 * WHAT THE GAP IS NOT
 * -------------------
 * It is not a clean consumption variance, and the page says so rather than
 * letting anyone believe otherwise. The standard is the BOM's claim on orders
 * BOOKED in the month; the ledger is what was ISSUED in it, and an order booked
 * in July is cut in August - so a single month compares two slightly different
 * populations and only the whole run settles. And the ledger values an issue at
 * the lot's own landed cost where the standard uses a year's weighted average
 * purchase price, so a few points of any gap are valuation rather than material.
 *
 * Labour, overhead and freight are on neither side.
 */
import { cached, odooStamp } from './cache';
import { buildContext, callKw, getSession, type OdooSession } from './odoo';

/* ----------------------------------------------------------------- shapes */

export type MaterialType = 'tape' | 'slider' | 'wire' | 'top' | 'bottom' | 'pinbox' | 'pom';

/** The seven types the BOM stamps, in the order the plant talks about them. */
export const MATERIAL_TYPES: MaterialType[] = [
  'tape',
  'slider',
  'wire',
  'top',
  'bottom',
  'pinbox',
  'pom',
];

/** How a component's unit cost was arrived at, so the page can say. */
export type CostBasis = 'average' | 'last' | 'none';

export interface CostedLine {
  id: number;
  oa: string;
  buyer: string;
  product: string;
  category: string;
  qty: number;
  revenue: number;
  material: number;
  /** Material as a share of revenue. Null when the line was booked at zero. */
  share: number | null;
  /** Per material type, what it cost. */
  mix: Record<string, number>;
  /** Components whose cost could not be sourced. The line is still counted. */
  unpriced: string[];
}

export interface Rollup {
  key: string;
  /** The buyer behind an order, where the key is an OA number. */
  sub?: string;
  qty: number;
  lines: number;
  revenue: number;
  material: number;
  share: number | null;
}

/**
 * Revenue below which a line's margin says nothing.
 *
 * A three-piece line booked at $0.36 against $0.44 of material is not a pricing
 * failure, it is a minimum charge and a rounding: the sizes and the wastage
 * that a bulk line spreads over 200,000 pieces fall on three. Left in, these
 * lines take every place at the top of a worst-margin table and bury the
 * $40,000 order sold at 90%. They stay in every total - the money was real -
 * and are held out of the ranking only.
 */
export const RANKING_FLOOR = 50;

/** How many lines the report carries back for the detail table. */
const LINE_CAP = 300;

export interface Coverage {
  /** Confirmed bulk order lines in the window, whether or not they carry a BOM. */
  bookedLines: number;
  /** Those that carry one, and so could be costed. */
  costedLines: number;
  /** Revenue on the costed lines, against all booked revenue. */
  costedRevenue: number;
  bookedRevenue: number;
  /** BOM lines whose material type was never stamped - they cost nothing here. */
  untypedBomLines: number;
  /** Components with no purchase history at all. */
  unpricedComponents: string[];
  /** Currencies seen on the order lines. Anything but USD alone needs saying. */
  currencies: string[];
}

/**
 * One material type, as the BOM says it should be against as the plant issued.
 *
 * `standard` is the BOM's claim on the month's orders; `actual` is what the RM
 * ledger says actually left the store. Both in dollars.
 */
export interface Variance {
  key: string;
  standard: number;
  actual: number;
  /** actual - standard. Positive means the floor burned more than the BOM allows. */
  gap: number;
  /** The gap against the standard. Null where there is no standard to measure against. */
  gapShare: number | null;
}

/** A raw material the plant issued that no BOM in the month accounts for. */
export interface Unmodelled {
  key: string;
  category: string;
  actual: number;
}

export interface Actuals {
  /** What the ledger says left the store this month, in total. */
  issued: number;
  /** The part of it that sits under a material type the BOM stamps. */
  matched: number;
  /** The part with no BOM line behind it at all - chemicals, dyes, packing. */
  unmodelled: number;
  byMaterial: Variance[];
  /** Biggest unmodelled spends, worst first. */
  outside: Unmodelled[];
  /** Where a single component most overran its standard. */
  overruns: Variance[];
  /** False when the ledger has nothing for the month, so the page can say so. */
  present: boolean;
}

export interface MonthCost {
  month: string;
  label: string;
  totals: Rollup;
  byCategory: Rollup[];
  byBuyer: Rollup[];
  byOrder: Rollup[];
  byMaterial: Rollup[];
  /**
   * The thinnest-margin lines worth ranking - see `RANKING_FLOOR`. Capped, so
   * a month of eight thousand lines does not travel down the wire whole.
   */
  lines: CostedLine[];
  /** How many lines the month actually holds, and how many were too small to rank. */
  lineCount: number;
  belowFloor: number;
  actuals: Actuals;
  coverage: Coverage;
}

export interface TrendPoint {
  month: string;
  label: string;
  revenue: number;
  /** The BOM's claim on the month. */
  material: number;
  /** What the ledger says the plant actually issued. */
  actual: number;
  share: number | null;
}

export interface CostReport {
  months: string[];
  month: string | null;
  label: string;
  totals: Rollup;
  byCategory: Rollup[];
  byBuyer: Rollup[];
  byOrder: Rollup[];
  byMaterial: Rollup[];
  lines: CostedLine[];
  lineCount: number;
  belowFloor: number;
  actuals: Actuals;
  coverage: Coverage;
  /** Month by month, so the headline is never read on its own. */
  trend: TrendPoint[];
  builtAt: string;
  stale: boolean;
  staleError: string | null;
}

/* ------------------------------------------------------------- the window */

/**
 * BOM linking began in March 2026, when `create_bom_and_link_mo` went in.
 * Nothing before that carries a BOM, so nothing before that can be costed.
 */
export const EARLIEST_MONTH = '2026-03';

export function todayMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Every month with data, newest first. */
export function availableMonths(): string[] {
  const out: string[] = [];
  for (let m = todayMonth(); m >= EARLIEST_MONTH; m = shiftMonth(m, -1)) out.push(m);
  return out;
}

function monthWindow(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const next = new Date(Date.UTC(y, m, 1));
  return { from: `${month}-01 00:00:00`, to: `${next.toISOString().slice(0, 10)} 00:00:00` };
}

/* -------------------------------------------------------------- the reads */

/** Odoo chokes on very long id lists; ask in slices. */
const CHUNK = 500;

async function readMany<T>(
  model: string,
  ids: number[],
  fields: string[],
  context: Record<string, unknown>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    if (!slice.length) continue;
    out.push(...(await callKw<T[]>(model, 'read', { args: [slice, fields], kwargs: { context } })));
  }
  return out;
}

/** `search_read` over an id list too long to send in one domain. */
async function searchReadChunked(
  model: string,
  field: string,
  ids: number[],
  extra: unknown[],
  fields: string[],
  context: Record<string, unknown>,
  order = '',
): Promise<any[]> {
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    out.push(
      ...(await callKw<any[]>(model, 'search_read', {
        kwargs: {
          domain: [[field, 'in', ids.slice(i, i + CHUNK)], ...extra],
          fields,
          limit: 0,
          order,
          context,
        },
      })),
    );
  }
  return out;
}

/**
 * The company that has BOMs.
 *
 * Only Zipper runs the BOM link - Metal Trims books orders but nothing stamps a
 * BOM on them, so costing it would report a zero that reads as "no material"
 * rather than "not recorded". The page says which company it speaks for.
 */
function zipperCompany(session: OdooSession): number {
  return session.companies.find((c) => /zipper/i.test(c.name))?.id ?? 1;
}

/**
 * What a component costs to buy, in its own unit.
 *
 * A year's ordering, weighted by quantity, rather than the last price paid: one
 * odd PO - a rush lot, a part shipment at a bad rate - should not become the
 * cost of every zipper the month made. Where a year holds nothing the last
 * price stands in, and where there is no purchase history at all the component
 * is named in `coverage.unpricedComponents` rather than silently costed at zero.
 *
 * `standard_price` is deliberately not used: it is 0.00 on every raw material
 * in this database, so a report built on it would show every order as pure
 * margin.
 */
async function unitCosts(
  productIds: number[],
  asOf: string,
  context: Record<string, unknown>,
): Promise<Map<number, { cost: number; basis: CostBasis }>> {
  const out = new Map<number, { cost: number; basis: CostBasis }>();
  if (!productIds.length) return out;

  const since = new Date(`${asOf}-01T00:00:00Z`);
  since.setUTCFullYear(since.getUTCFullYear() - 1);
  const from = `${since.toISOString().slice(0, 10)} 00:00:00`;

  const rows = await searchReadChunked(
    'purchase.order.line',
    'product_id',
    productIds,
    [['state', 'in', ['purchase', 'done']]],
    ['product_id', 'product_qty', 'price_unit', 'date_order'],
    context,
    'date_order desc',
  );

  const agg = new Map<number, { value: number; qty: number }>();
  const last = new Map<number, number>();
  for (const row of rows) {
    const id = row.product_id?.[0];
    if (!id) continue;
    if (!last.has(id)) last.set(id, row.price_unit || 0);
    if ((row.date_order ?? '') < from) continue;
    const a = agg.get(id) ?? { value: 0, qty: 0 };
    a.value += (row.price_unit || 0) * (row.product_qty || 0);
    a.qty += row.product_qty || 0;
    agg.set(id, a);
  }

  for (const id of productIds) {
    const a = agg.get(id);
    if (a && a.qty > 0) out.set(id, { cost: a.value / a.qty, basis: 'average' });
    else if (last.has(id)) out.set(id, { cost: last.get(id)!, basis: 'last' });
    else out.set(id, { cost: 0, basis: 'none' });
  }
  return out;
}

/* -------------------------------------------------------------- the build */

/** Which `*_con` field answers for a material type on a metal product. */
const CON_FIELD: Record<MaterialType, string> = {
  tape: 'tape_con',
  slider: 'slider_con',
  wire: 'wire_con',
  top: 'topwire_con',
  bottom: 'botomwire_con',
  pinbox: 'pinbox_con',
  pom: '',
};

/** Metal and aluminium price their stops separately; everything else shares one figure. */
const isMetal = (category: string) => /^[ma]/i.test(category.trim());

const SPLIT_TYPES: MaterialType[] = ['top', 'bottom', 'pinbox', 'pom'];

const SOL_FIELDS = [
  'order_id',
  'order_partner_id',
  'product_id',
  'product_template_id',
  'product_uom_qty',
  'price_subtotal',
  'currency_id',
  'bomid_db',
  'tape_con',
  'slider_con',
  'wire_con',
  'topwire_con',
  'botomwire_con',
  'pinbox_con',
  'tbwire_con',
];

/** The RM ledger: what actually left the store, by product, in a month. */
const LEDGER_MODEL = 'rm.stock.detailed.monthly';

/**
 * What the plant actually issued, against what the BOM said it should.
 *
 * The two sides are joined on the product id rather than on a category name.
 * A name map would be one Odoo rename away from silently reporting a material
 * as unaccounted for; the product id is the same key the BOM itself uses.
 *
 * Issues are stored negative - the ledger is written from the store's side -
 * so every figure here is sign-flipped into the plain reading: what was spent.
 *
 * TWO THINGS THIS COMPARISON CANNOT DO
 * ------------------------------------
 * The standard is the BOM's claim on the orders BOOKED in the month; the actual
 * is what was ISSUED in it, and an order booked in July is cut in August. Month
 * by month the two are not the same population, which is why the page offers
 * the whole run as well - over five months the timing largely washes out.
 *
 * And the ledger values an issue at the lot's own landed cost, where the
 * standard is priced at a year's weighted average purchase price. Close, but
 * not the same rule, so a few points of any gap are valuation rather than
 * consumption. Both are said on the page rather than buried here.
 */
async function actualsFor(
  month: string,
  company: number,
  materialOf: Map<number, string>,
  standardByProduct: Map<number, number>,
  context: Record<string, unknown>,
): Promise<Actuals> {
  const { from, to } = monthWindow(month);

  const rows = await callKw<any[]>(LEDGER_MODEL, 'read_group', {
    args: [
      [
        ['company_id', '=', company],
        ['month', '>=', from.slice(0, 10)],
        ['month', '<', to.slice(0, 10)],
      ],
      ['issue_value', 'issue_qty'],
      ['product_id', 'item_category'],
    ],
    kwargs: { context, lazy: false, limit: 0 },
  });

  const empty: Actuals = {
    issued: 0,
    matched: 0,
    unmodelled: 0,
    byMaterial: [],
    outside: [],
    overruns: [],
    present: false,
  };
  if (!rows.length) return empty;

  const byType = new Map<string, number>();
  const byProduct = new Map<number, { name: string; actual: number }>();
  const outside = new Map<string, Unmodelled>();
  let issued = 0;
  let matched = 0;

  for (const row of rows) {
    const spent = -(row.issue_value ?? 0);
    if (!spent) continue;
    issued += spent;

    const id = row.product_id?.[0];
    const type = id != null ? materialOf.get(id) : undefined;

    if (type) {
      matched += spent;
      byType.set(type, (byType.get(type) ?? 0) + spent);
      const held = byProduct.get(id) ?? { name: String(row.product_id?.[1] ?? ''), actual: 0 };
      held.actual += spent;
      byProduct.set(id, held);
    } else {
      const key = String(row.product_id?.[1] ?? 'Unidentified');
      const held = outside.get(key) ?? {
        key,
        category: String(row.item_category?.[1] ?? 'Uncategorised'),
        actual: 0,
      };
      held.actual += spent;
      outside.set(key, held);
    }
  }

  const variance = (key: string, standard: number, actual: number): Variance => ({
    key,
    standard,
    actual,
    gap: actual - standard,
    gapShare: standard > 0 ? (actual - standard) / standard : null,
  });

  const types = new Set([...byType.keys(), ...materialOf.values()]);

  return {
    issued,
    matched,
    unmodelled: issued - matched,
    byMaterial: [...types]
      .map((type) => variance(type, standardOfType(standardByProduct, materialOf, type), byType.get(type) ?? 0))
      .filter((v) => v.standard > 0 || v.actual > 0)
      .sort((a, b) => b.actual - a.actual),
    outside: [...outside.values()].sort((a, b) => b.actual - a.actual).slice(0, 12),
    overruns: [...byProduct.entries()]
      .map(([id, p]) => variance(p.name, standardByProduct.get(id) ?? 0, p.actual))
      .filter((v) => v.gap > 0)
      .sort((a, b) => b.gap - a.gap)
      .slice(0, 12),
    present: true,
  };
}

/** The BOM's claim for one material type, summed over the products carrying it. */
function standardOfType(
  standardByProduct: Map<number, number>,
  materialOf: Map<number, string>,
  type: string,
): number {
  let total = 0;
  for (const [id, value] of standardByProduct) {
    if (materialOf.get(id) === type) total += value;
  }
  return total;
}

function emptyMonth(month: string): MonthCost {
  return {
    month,
    label: monthLabel(month),
    totals: { key: month, lines: 0, qty: 0, revenue: 0, material: 0, share: null },
    byCategory: [],
    byBuyer: [],
    byOrder: [],
    byMaterial: [],
    lines: [],
    lineCount: 0,
    belowFloor: 0,
    actuals: {
      issued: 0,
      matched: 0,
      unmodelled: 0,
      byMaterial: [],
      outside: [],
      overruns: [],
      present: false,
    },
    coverage: {
      bookedLines: 0,
      costedLines: 0,
      costedRevenue: 0,
      bookedRevenue: 0,
      untypedBomLines: 0,
      unpricedComponents: [],
      currencies: [],
    },
  };
}

async function buildMonth(month: string): Promise<MonthCost> {
  const session = await getSession();
  const company = zipperCompany(session);
  const context = buildContext(session, {}, company);
  const { from, to } = monthWindow(month);

  // The bulk order book for the month. Samples price differently and carry no
  // margin worth reading, so only order acceptances count.
  const orders = await callKw<any[]>('sale.order', 'search_read', {
    kwargs: {
      domain: [
        ['date_order', '>=', from],
        ['date_order', '<', to],
        ['sales_type', '=', 'oa'],
        ['company_id', '=', company],
        ['state', 'in', ['sale', 'done']],
      ],
      fields: ['name', 'date_order', 'partner_id'],
      limit: 0,
      context,
    },
  });

  const empty = emptyMonth(month);
  const orderIds = orders.map((o) => o.id);
  if (!orderIds.length) return empty;

  const lines = await searchReadChunked(
    'sale.order.line',
    'order_id',
    orderIds,
    [
      ['product_uom_qty', '>', 0],
      ['state', 'in', ['sale', 'done']],
    ],
    SOL_FIELDS,
    context,
  );

  const bookedRevenue = lines.reduce((a, l) => a + (l.price_subtotal || 0), 0);
  const currencies = [...new Set(lines.map((l) => l.currency_id?.[1]).filter(Boolean))] as string[];
  const costable = lines.filter((l) => l.bomid_db > 0);
  if (!costable.length) {
    return {
      ...empty,
      coverage: { ...empty.coverage, bookedLines: lines.length, bookedRevenue, currencies },
    };
  }

  // The BOMs behind them: the component list, and each component's material type.
  const bomIds = [...new Set(costable.map((l) => l.bomid_db))];
  const bomLines = await searchReadChunked(
    'mrp.bom.line',
    'bom_id',
    bomIds,
    [],
    ['bom_id', 'product_id', 'material_type'],
    context,
  );

  const byBom = new Map<number, any[]>();
  for (const bl of bomLines) {
    const key = bl.bom_id?.[0];
    if (!key) continue;
    if (!byBom.has(key)) byBom.set(key, []);
    byBom.get(key)!.push(bl);
  }

  // The finished-goods category decides which consumption fields apply.
  const tmplIds = [...new Set(costable.map((l) => l.product_template_id?.[0]).filter(Boolean))];
  const tmpls = await readMany<any>('product.template', tmplIds, ['fg_categ_type'], context);
  const categoryOf = new Map<number, string>(
    tmpls.map((t) => [t.id, t.fg_categ_type ? String(t.fg_categ_type[1]) : '']),
  );

  const rmIds = [...new Set(bomLines.map((b) => b.product_id?.[0]).filter(Boolean))];
  const costOf = await unitCosts(rmIds, month, context);
  const nameOf = new Map<number, string>(
    bomLines.map((b) => [b.product_id?.[0], String(b.product_id?.[1] ?? '')]),
  );

  /* ------------------------------------------------------------ costing */

  const costed: CostedLine[] = [];
  const unpricedSeen = new Set<string>();
  /** The BOM's claim in dollars, per raw-material product. */
  const standardByProduct = new Map<number, number>();
  /** Which material type each raw-material product answers to. */
  const materialOf = new Map<number, string>();

  for (const line of costable) {
    const components = byBom.get(line.bomid_db) ?? [];
    if (!components.length) continue;

    const category = categoryOf.get(line.product_template_id?.[0]) ?? '';
    const metal = isMetal(category);

    // The shared top/bottom figure is divided across however many of those
    // lines the BOM carries - the same arithmetic the planner does.
    const splitCount = components.filter((c) => SPLIT_TYPES.includes(c.material_type)).length || 1;

    const mix: Record<string, number> = {};
    const unpriced: string[] = [];
    let material = 0;

    for (const component of components) {
      const type = component.material_type as MaterialType;
      if (!type) continue;

      let qty = 0;
      if (type === 'tape' || type === 'slider' || type === 'wire') {
        qty = line[CON_FIELD[type]] || 0;
      } else if (metal) {
        qty = CON_FIELD[type] ? line[CON_FIELD[type]] || 0 : 0;
      } else if (SPLIT_TYPES.includes(type)) {
        qty = (line.tbwire_con || 0) / splitCount;
      }
      if (!qty) continue;

      const rate = costOf.get(component.product_id?.[0]);
      if (!rate || rate.basis === 'none') {
        const name = nameOf.get(component.product_id?.[0]) || 'unknown component';
        unpriced.push(name);
        unpricedSeen.add(name);
        continue;
      }

      const value = qty * rate.cost;
      material += value;
      mix[type] = (mix[type] ?? 0) + value;

      // Kept per component as well as per type: the ledger reports by product,
      // so this is the only key the two sides can be joined on.
      const pid = component.product_id?.[0];
      if (pid != null) {
        standardByProduct.set(pid, (standardByProduct.get(pid) ?? 0) + value);
        materialOf.set(pid, type);
      }
    }

    if (!material) continue;

    const revenue = line.price_subtotal || 0;
    costed.push({
      id: line.id,
      oa: String(line.order_id?.[1] ?? ''),
      buyer: String(line.order_partner_id?.[1] ?? 'Unknown'),
      product: String(line.product_id?.[1] ?? ''),
      category: category || '(uncategorised)',
      qty: line.product_uom_qty || 0,
      revenue,
      material,
      share: revenue > 0 ? material / revenue : null,
      mix,
      unpriced,
    });
  }

  /* ---------------------------------------------------------- roll it up */

  const rollup = (key: string, rows: CostedLine[]): Rollup => {
    const revenue = rows.reduce((a, r) => a + r.revenue, 0);
    const material = rows.reduce((a, r) => a + r.material, 0);
    return {
      key,
      lines: rows.length,
      qty: rows.reduce((a, r) => a + r.qty, 0),
      revenue,
      material,
      share: revenue > 0 ? material / revenue : null,
    };
  };

  const group = (pick: (r: CostedLine) => string, sub?: (r: CostedLine) => string): Rollup[] => {
    const map = new Map<string, CostedLine[]>();
    for (const row of costed) {
      const key = pick(row);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(row);
    }
    return [...map.entries()]
      .map(([key, rows]) => ({
        ...rollup(key, rows),
        ...(sub ? { sub: sub(rows[0]) } : {}),
      }))
      .sort((a, b) => b.revenue - a.revenue);
  };

  const byMaterial: Rollup[] = MATERIAL_TYPES.map((type) => ({
    key: type,
    lines: 0,
    qty: 0,
    revenue: 0,
    material: costed.reduce((a, r) => a + (r.mix[type] ?? 0), 0),
    share: null,
  }))
    .filter((r) => r.material > 0)
    .sort((a, b) => b.material - a.material);

  const rankable = costed.filter((r) => r.revenue >= RANKING_FLOOR);
  const actuals = await actualsFor(month, company, materialOf, standardByProduct, context);

  return {
    month,
    label: monthLabel(month),
    totals: rollup(month, costed),
    byCategory: group((r) => r.category),
    byBuyer: group((r) => r.buyer),
    byOrder: group(
      (r) => r.oa,
      (r) => r.buyer,
    ),
    byMaterial,
    // Thinnest margin first: the report exists to surface what is sold thin.
    lines: rankable.sort((a, b) => (b.share ?? 0) - (a.share ?? 0)).slice(0, LINE_CAP),
    lineCount: costed.length,
    belowFloor: costed.length - rankable.length,
    actuals,
    coverage: {
      bookedLines: lines.length,
      costedLines: costed.length,
      costedRevenue: costed.reduce((a, r) => a + r.revenue, 0),
      bookedRevenue,
      untypedBomLines: bomLines.filter((b) => !b.material_type).length,
      unpricedComponents: [...unpricedSeen].sort(),
      currencies,
    },
  };
}

/* ------------------------------------------------------------------ cache */

/** A month still being booked moves; a closed one does not. */
const OPEN_TTL_MS = Number(process.env.RM_COST_CACHE_MS || 30 * 60 * 1000);
const CLOSED_TTL_MS = 12 * 60 * 60 * 1000;

/** Bumped when the built shape changes, so old entries rebuild rather than render blank. */
const SHAPE = 3;

function stampFor(month: string) {
  const { from, to } = monthWindow(month);
  return () =>
    odooStamp('sale.order', [
      ['date_order', '>=', from],
      ['date_order', '<', to],
      ['sales_type', '=', 'oa'],
    ]);
}

function getMonth(month: string, force = false) {
  const open = month >= todayMonth();
  return cached<MonthCost>(`rmcost-v${SHAPE}-${month}`, 'rmcost', {
    ttlMs: open ? OPEN_TTL_MS : CLOSED_TTL_MS,
    stamp: stampFor(month),
    staleWhileRevalidate: !force && !open,
    force,
    build: () => buildMonth(month),
  });
}

/* ----------------------------------------------------------------- report */

const mergeRollups = (parts: Rollup[][]): Rollup[] => {
  const map = new Map<string, Rollup>();
  for (const row of parts.flat()) {
    const held = map.get(row.key) ?? {
      key: row.key,
      ...(row.sub ? { sub: row.sub } : {}),
      lines: 0,
      qty: 0,
      revenue: 0,
      material: 0,
      share: null,
    };
    held.lines += row.lines;
    held.qty += row.qty;
    held.revenue += row.revenue;
    held.material += row.material;
    map.set(row.key, held);
  }
  return [...map.values()]
    .map((r) => ({ ...r, share: r.revenue > 0 ? r.material / r.revenue : null }))
    .sort((a, b) => b.revenue - a.revenue || b.material - a.material);
};

/** Several months of variance added into one, so a run reads like a month. */
function mergeActuals(parts: Actuals[]): Actuals {
  const present = parts.filter((a) => a.present);
  if (!present.length) {
    return {
      issued: 0,
      matched: 0,
      unmodelled: 0,
      byMaterial: [],
      outside: [],
      overruns: [],
      present: false,
    };
  }

  const add = <T extends { key: string }>(
    rows: T[][],
    seed: (row: T) => T,
    sum: (into: T, row: T) => void,
  ): T[] => {
    const map = new Map<string, T>();
    for (const row of rows.flat()) {
      const held = map.get(row.key) ?? seed(row);
      sum(held, row);
      map.set(row.key, held);
    }
    return [...map.values()];
  };

  const settle = (v: Variance): Variance => ({
    ...v,
    gap: v.actual - v.standard,
    gapShare: v.standard > 0 ? (v.actual - v.standard) / v.standard : null,
  });

  const byMaterial = add<Variance>(
    present.map((a) => a.byMaterial),
    (r) => ({ key: r.key, standard: 0, actual: 0, gap: 0, gapShare: null }),
    (into, r) => {
      into.standard += r.standard;
      into.actual += r.actual;
    },
  )
    .map(settle)
    .sort((a, b) => b.actual - a.actual);

  // Overruns only survive the merge if they are still overruns once the months
  // are added: a component over in June and under in July is not a leak.
  const overruns = add<Variance>(
    present.map((a) => a.overruns),
    (r) => ({ key: r.key, standard: 0, actual: 0, gap: 0, gapShare: null }),
    (into, r) => {
      into.standard += r.standard;
      into.actual += r.actual;
    },
  )
    .map(settle)
    .filter((v) => v.gap > 0)
    .sort((a, b) => b.gap - a.gap)
    .slice(0, 12);

  const outside = add<Unmodelled>(
    present.map((a) => a.outside),
    (r) => ({ key: r.key, category: r.category, actual: 0 }),
    (into, r) => {
      into.actual += r.actual;
    },
  )
    .sort((a, b) => b.actual - a.actual)
    .slice(0, 12);

  return {
    issued: present.reduce((a, x) => a + x.issued, 0),
    matched: present.reduce((a, x) => a + x.matched, 0),
    unmodelled: present.reduce((a, x) => a + x.unmodelled, 0),
    byMaterial,
    outside,
    overruns,
    present: true,
  };
}

/**
 * One month, or every month with data when `month` is null.
 *
 * The trend always covers every month, because the headline is close to
 * meaningless read alone - 61% is only alarming once you know it was 54%. So
 * asking for August still touches every month behind it. Those come from cache
 * at whatever freshness they hold and are never force-rebuilt, but on a cold
 * cache they are built: roughly fifty seconds for the whole run, once, and
 * every month but the current one is then held for twelve hours.
 */
export async function costReport(month: string | null, force = false): Promise<CostReport> {
  const months = availableMonths();
  const wanted = month ? [month] : months;
  const held = await Promise.all(wanted.map((m) => getMonth(m, force)));
  const slices = held.map((h) => h.value);

  const trendSlices = month
    ? (await Promise.all(months.map((m) => getMonth(m)))).map((h) => h.value)
    : slices;

  const lines = slices
    .flatMap((s) => s.lines)
    .sort((a, b) => (b.share ?? 0) - (a.share ?? 0))
    .slice(0, LINE_CAP);
  const revenue = slices.reduce((a, s) => a + s.totals.revenue, 0);
  const material = slices.reduce((a, s) => a + s.totals.material, 0);

  return {
    months,
    month,
    label: month ? monthLabel(month) : 'Every month with data',
    totals: {
      key: month ?? 'all',
      lines: slices.reduce((a, s) => a + s.totals.lines, 0),
      qty: slices.reduce((a, s) => a + s.totals.qty, 0),
      revenue,
      material,
      share: revenue > 0 ? material / revenue : null,
    },
    byCategory: mergeRollups(slices.map((s) => s.byCategory)),
    byBuyer: mergeRollups(slices.map((s) => s.byBuyer)),
    byOrder: mergeRollups(slices.map((s) => s.byOrder)),
    byMaterial: mergeRollups(slices.map((s) => s.byMaterial)).sort(
      (a, b) => b.material - a.material,
    ),
    lines,
    lineCount: slices.reduce((a, s) => a + s.lineCount, 0),
    belowFloor: slices.reduce((a, s) => a + s.belowFloor, 0),
    actuals: mergeActuals(slices.map((s) => s.actuals)),
    coverage: {
      bookedLines: slices.reduce((a, s) => a + s.coverage.bookedLines, 0),
      costedLines: slices.reduce((a, s) => a + s.coverage.costedLines, 0),
      costedRevenue: slices.reduce((a, s) => a + s.coverage.costedRevenue, 0),
      bookedRevenue: slices.reduce((a, s) => a + s.coverage.bookedRevenue, 0),
      untypedBomLines: slices.reduce((a, s) => a + s.coverage.untypedBomLines, 0),
      unpricedComponents: [...new Set(slices.flatMap((s) => s.coverage.unpricedComponents))].sort(),
      currencies: [...new Set(slices.flatMap((s) => s.coverage.currencies))],
    },
    trend: trendSlices
      .map((s) => ({
        month: s.month,
        label: s.label,
        revenue: s.totals.revenue,
        material: s.totals.material,
        actual: s.actuals.matched,
        share: s.totals.share,
      }))
      .sort((a, b) => a.month.localeCompare(b.month)),
    builtAt: held.map((h) => h.builtAt).sort()[0] ?? new Date().toISOString(),
    stale: held.some((h) => h.stale),
    staleError: held.find((h) => h.error)?.error ?? null,
  };
}
