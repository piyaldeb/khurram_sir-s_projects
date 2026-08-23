/**
 * Zipper RM demand plan — required against consumed, with what is on the water.
 *
 * The sheet this replaces is `SC_ RM Demand Plan (1).xlsx`, tab "Zip Demand
 * Plan Aug". What ships with the site is that sheet's INPUTS, not its answers:
 * the month's demand per zipper type, the per-unit rate, and the two
 * hand-entered stock columns. Everything the sheet works out, this works out
 * again; everything Odoo knows, this reads from Odoo.
 *
 * The sheet's arithmetic, verified cell by cell against its cached values:
 *
 *   demand   = BD + Export + other
 *   required = demand x (rate x material factor) / 1000
 *   total    = stock + GIT
 *   coverage = total / required
 *
 * Row 7 checks out at 7,022,653 x (5.5 x 0.77) / 1000 = 29,740.94 against a
 * cached 29,740.93546, and every other row recomputes exactly. Two rows draw
 * their requirement from a SUM across sibling rows instead of their own demand;
 * those carry the sheet's figure and say so through `requiredFrom`.
 *
 * WHY THE REQUIREMENT IS NOT READ FROM ODOO
 * -----------------------------------------
 * Odoo has the model — `rm.demand.availability.dashboard` — and this login is
 * denied access to it, as it is to `sc.rm.demand.plan.dashboard`. The hand-entry
 * table behind them holds one Zipper row and it is empty. `rolling.forecast.line`
 * is readable but is the FG sales forecast in pieces, and converting it needs
 * the same rate the sheet keeps in its own column. Grant this login read access
 * to that dashboard and the requirement comes live; nothing else changes.
 *
 * WHAT IS LIVE
 * ------------
 *   rm.stock.detailed.monthly   consumption (issue, sign-flipped) and closing
 *                               stock, in quantity and in USD
 *   transit.line                what is still on the water, not yet in-housed
 */
import { buildContext, callKw, getSession } from './odoo';
import plan from '../data/rm-demand-plan.json';

/** The plan is Zipper only, which is what the report is for. */
const ZIPPER = 1;

const LEDGER_MODEL = 'rm.stock.detailed.monthly';
const TRANSIT_MODEL = 'transit.line';

/** Transit states that still count as on the water rather than received. */
const IN_TRANSIT = ['logistics', 'in_transit'];

/* ---------------------------------------------------------------- the plan */

export interface PlanInput {
  ref: string;
  group: string;
  material: string;
  demand: { bd: number | null; export: number | null; other: number | null };
  demandTotal: number;
  /** The sheet's own per-unit factor, its column H. */
  rate: number | null;
  /** rate x material factor / 1000 — what the demand is multiplied by. */
  effectiveRate: number | null;
  op: number | null;
  ih: number | null;
  /** The sheet's own answer, kept only so any divergence can be shown. */
  cachedRequired: number;
  requiredFrom?: 'sheet';
  note?: string;
  type?: string;
  slider?: string;
}

export interface DemandPlan {
  month: string;
  company: string;
  source: string;
  inferredGroups: Record<string, string>;
  materials: PlanInput[];
  sliders: PlanInput[];
}

export const demandPlan = plan as DemandPlan;

/**
 * The sheet's material names against Odoo's item categories.
 *
 * Two vocabularies, and the mapping is deliberately partial. "Tape / Long
 * Chain" is one line in the sheet and two categories in Odoo, so it maps to
 * both. "Alm Wire" — aluminium wire — has no category of its own in the Zipper
 * ledger, so it maps to nothing and the report says so rather than quietly
 * folding it into METAL WIRE.
 */
export const MATERIAL_CATEGORIES: Record<string, string[]> = {
  'Metal Wire': ['METAL WIRE'],
  'Tape / Long Chain': ['TAPE', 'LONG CHAIN'],
  'Tape / Long Chain (GRS/n-GRS)': ['TAPE', 'LONG CHAIN'],
  POM: ['POM'],
  'STI Slider': ['SLIDER'],
};

/**
 * The zipper type a raw-material product belongs to, read off its own name.
 *
 * The ledger has no zipper-type dimension, but it does not need one: the
 * products name themselves. "M#4 BRASS WIRE DN+" and "M#5 BRASS WIRE DN+" are
 * both METAL WIRE and belong to different rows of the plan, and their names are
 * the only thing that tells them apart. Coil is written N# as often as C#.
 */
export const GROUP_TOKENS: [string, RegExp][] = [
  ['Metal #4', /\bM#4(?:\.5)?\b/i],
  ['Metal #5', /\bM#5\b/i],
  ['Metal #8', /\bM#8\b/i],
  ['Coil #3', /\b[NC]#3\b/i],
  ['Coil #5', /\b[NC]#5\b/i],
  ['Coil #8', /\b[NC]#8\b/i],
  ['Plastic #3', /\bP#3\b/i],
  ['Plastic #5', /\bP#5\b/i],
];

/** Which plan group a product name belongs to, or null when it says nothing. */
export function groupOf(productName: string): string | null {
  return GROUP_TOKENS.find(([, re]) => re.test(productName))?.[0] ?? null;
}

/**
 * The TZP code a product name carries.
 *
 * "TZP 305", "TZP-305 (N)" and "TZP-2239" each name their slider; "TZP-1794" is
 * a different one from "TZP-794", so the digits are read as a whole number
 * rather than matched as a substring.
 */
export function tzpCodes(productName: string): number[] {
  return [...String(productName).matchAll(/TZP[\s-]*(\d+)/gi)].map((m) => Number(m[1]));
}

/* ------------------------------------------------------------- the results */

export interface LiveCategory {
  category: string;
  consumption: number;
  consumptionValue: number;
  currentStock: number;
  currentStockValue: number;
  git: number;
  gitValue: number;
  gitLines: number;
}

/**
 * One row of the plan, computed.
 *
 * Nothing here is copied from the sheet's answer columns: `required` is demand
 * times rate, consumption and stock and GIT are read from Odoo for the row's
 * own materials and zipper type, and the rest is arithmetic over those.
 */
export interface DemandRow {
  ref: string;
  group: string;
  material: string;
  type: string | null;
  slider: string | null;
  note: string | null;

  demand: { bd: number | null; export: number | null; other: number | null };
  demandTotal: number;
  rate: number | null;
  effectiveRate: number | null;

  required: number;
  requiredFrom: 'computed' | 'sheet';

  op: number | null;
  ih: number | null;
  opIh: number | null;

  consumption: number | null;
  consumptionValue: number | null;
  currentStock: number | null;
  currentStockValue: number | null;
  git: number | null;
  gitValue: number | null;
  gitLines: number;

  totalAvailable: number | null;
  availability: number | null;

  /** The sheet's own (op + ih) - consumption, for comparison only. */
  sheetStock: number | null;
  /** What the live figures were read from. */
  matchedOn: string[];
}

export interface DemandReport {
  month: string;
  company: string;
  source: string;
  materials: DemandRow[];
  sliders: DemandRow[];
  live: LiveCategory[];
  /** Categories the plan's materials never mention. */
  unmapped: string[];
  /** Plan materials with no Odoo category behind them. */
  unmatched: string[];
  fetchedAt: string;
  error?: string;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const idOf = (v: unknown) => (Array.isArray(v) ? (v[0] as number) : null);
const nameOf = (v: unknown) => (Array.isArray(v) ? String(v[1] ?? '').trim() : '');
const round = (v: number) => Math.round(v * 100) / 100;

/**
 * Item categories resolved to ids, once.
 *
 * Filtering on `item_category.display_name` looks like it works and does not:
 * `display_name` is computed, not stored, so Odoo cannot push the comparison
 * into SQL and the domain silently matches far more than it should — asking for
 * METAL WIRE came back with sliders, pin boxes and 20 million units against the
 * 26 thousand the grouped read gives. Ids are the only safe key.
 */
let categoryIds: Promise<Map<string, number>> | null = null;

function itemCategories(context: Record<string, unknown>): Promise<Map<string, number>> {
  categoryIds ??= callKw<any[]>('category.type', 'search_read', {
    args: [[], ['name']],
    kwargs: { context, limit: 0 },
  })
    .then((rows) => new Map(rows.map((r) => [String(r.name ?? '').trim().toUpperCase(), r.id])))
    .catch((err) => {
      categoryIds = null;
      throw err;
    });
  return categoryIds;
}

/** The month as Odoo's `month` date column bounds it. */
function monthBounds(month: string): [string, string] {
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return [`${month}-01`, next];
}

/** A cell of the live grid: one material category crossed with one zipper type. */
interface Cell {
  consumption: number;
  consumptionValue: number;
  currentStock: number;
  currentStockValue: number;
  git: number;
  gitValue: number;
  gitLines: number;
}

const emptyCell = (): Cell => ({
  consumption: 0,
  consumptionValue: 0,
  currentStock: 0,
  currentStockValue: 0,
  git: 0,
  gitValue: 0,
  gitLines: 0,
});

const cellKey = (group: string | null, category: string) => `${group ?? '?'}|${category}`;

/**
 * The plan's month, computed against Odoo.
 *
 * Two grouped reads build a grid of item category x zipper type, and each plan
 * row takes the cells its own materials and group point at. GIT is deliberately
 * NOT scoped to the month: goods in transit are a position, not a flow — what
 * matters is what is on the water now, whichever month it shipped in.
 */
export async function demandReport(): Promise<DemandReport> {
  const report: DemandReport = {
    month: demandPlan.month,
    company: demandPlan.company,
    source: demandPlan.source,
    materials: [],
    sliders: [],
    live: [],
    unmapped: [],
    unmatched: [],
    fetchedAt: new Date().toISOString(),
  };

  const [from, to] = monthBounds(demandPlan.month);
  const context = buildContext(await getSession());
  const grid = new Map<string, Cell>();
  const byCategory = new Map<string, LiveCategory>();

  try {
    const [ledger, transit] = await Promise.all([
      callKw<any[]>(LEDGER_MODEL, 'read_group', {
        args: [
          [['company_id', '=', ZIPPER], ['month', '>=', from], ['month', '<', to]],
          ['issue_qty', 'issue_value', 'cloing_qty', 'cloing_value'],
          ['item_category', 'product_name'],
        ],
        kwargs: { context, lazy: false, limit: 0 },
      }),
      callKw<any[]>(TRANSIT_MODEL, 'read_group', {
        args: [
          [['state', 'in', IN_TRANSIT], ['transit_id.company_id', '=', ZIPPER]],
          ['qty_in_transit', 'subtotal'],
          ['item_category', 'product_id'],
        ],
        kwargs: { context, lazy: false, limit: 0 },
      }),
    ]);

    const cellAt = (group: string | null, category: string) => {
      const key = cellKey(group, category);
      let held = grid.get(key);
      if (!held) grid.set(key, (held = emptyCell()));
      return held;
    };
    const categoryAt = (name: string) => {
      let held = byCategory.get(name);
      if (!held) {
        byCategory.set(
          name,
          (held = {
            category: name,
            consumption: 0,
            consumptionValue: 0,
            currentStock: 0,
            currentStockValue: 0,
            git: 0,
            gitValue: 0,
            gitLines: 0,
          }),
        );
      }
      return held;
    };

    for (const row of ledger) {
      const cat = nameOf(row.item_category) || '(uncategorised)';
      const target = cellAt(groupOf(String(row.product_name ?? '')), cat);
      const roll = categoryAt(cat);

      const consumption = -num(row.issue_qty);
      const consumptionValue = -num(row.issue_value);
      const stock = num(row.cloing_qty);
      const stockValue = num(row.cloing_value);

      target.consumption += consumption;
      target.consumptionValue += consumptionValue;
      target.currentStock += stock;
      target.currentStockValue += stockValue;
      roll.consumption += consumption;
      roll.consumptionValue += consumptionValue;
      roll.currentStock += stock;
      roll.currentStockValue += stockValue;
    }

    for (const row of transit) {
      const cat = nameOf(row.item_category) || '(uncategorised)';
      const target = cellAt(groupOf(nameOf(row.product_id)), cat);
      const roll = categoryAt(cat);

      const git = num(row.qty_in_transit);
      const value = num(row.subtotal);
      const lines = num(row.__count);

      target.git += git;
      target.gitValue += value;
      target.gitLines += lines;
      roll.git += git;
      roll.gitValue += value;
      roll.gitLines += lines;
    }

    report.live = [...byCategory.values()]
      .map((c) => ({
        ...c,
        consumption: Math.round(c.consumption),
        consumptionValue: Math.round(c.consumptionValue),
        currentStock: Math.round(c.currentStock),
        currentStockValue: Math.round(c.currentStockValue),
        git: Math.round(c.git),
        gitValue: Math.round(c.gitValue),
      }))
      .sort((a, b) => b.consumption - a.consumption);

    const claimed = new Set(
      [...demandPlan.materials, ...demandPlan.sliders].flatMap(
        (r) => MATERIAL_CATEGORIES[r.material] ?? [],
      ),
    );
    report.unmapped = report.live
      .filter((c) => !claimed.has(c.category) && (c.consumption || c.git))
      .map((c) => c.category);
    report.unmatched = [
      ...new Set(
        [...demandPlan.materials, ...demandPlan.sliders]
          .filter((r) => !MATERIAL_CATEGORIES[r.material])
          .map((r) => r.material),
      ),
    ];
  } catch (err) {
    report.error = (err as Error).message;
  }

  const compute = (input: PlanInput): DemandRow => {
    const rate = input.effectiveRate;
    const required =
      rate !== null && rate !== undefined ? round(input.demandTotal * rate) : input.cachedRequired;

    const categories = MATERIAL_CATEGORIES[input.material] ?? [];
    const cells = categories
      .map((c) => grid.get(cellKey(input.group, c)))
      .filter((c): c is Cell => !!c);
    const has = cells.length > 0 && !report.error;

    const sum = (pick: (c: Cell) => number) =>
      has ? Math.round(cells.reduce((a, c) => a + pick(c), 0)) : null;

    const consumption = sum((c) => c.consumption);
    const currentStock = sum((c) => c.currentStock);
    const git = sum((c) => c.git);
    const totalAvailable =
      currentStock === null && git === null ? null : (currentStock ?? 0) + (git ?? 0);
    const opIh = input.op === null && input.ih === null ? null : (input.op ?? 0) + (input.ih ?? 0);

    return {
      ref: input.ref,
      group: input.group,
      material: input.material,
      type: input.type ?? null,
      slider: input.slider ?? null,
      note: input.note ?? null,

      demand: input.demand,
      demandTotal: input.demandTotal,
      rate: input.rate,
      effectiveRate: rate ?? null,

      required,
      requiredFrom: input.requiredFrom === 'sheet' ? 'sheet' : 'computed',

      op: input.op,
      ih: input.ih,
      opIh,

      consumption,
      consumptionValue: sum((c) => c.consumptionValue),
      currentStock,
      currentStockValue: sum((c) => c.currentStockValue),
      git,
      gitValue: sum((c) => c.gitValue),
      gitLines: has ? cells.reduce((a, c) => a + c.gitLines, 0) : 0,

      totalAvailable,
      availability: required && totalAvailable !== null ? totalAvailable / required : null,

      sheetStock: opIh !== null && consumption !== null ? round(opIh - consumption) : null,
      matchedOn: categories,
    };
  };

  report.materials = demandPlan.materials.map(compute);
  report.sliders = demandPlan.sliders.map(compute);
  return report;
}

/* ------------------------------------------------------------- one plan row */

export interface MonthPoint {
  month: string;
  consumption: number;
  consumptionValue: number;
  closing: number;
  closingValue: number;
}

export interface Shipment {
  transit: string;
  vendor: string;
  po: string;
  /** When it is expected to land, and when it is planned in-house. */
  eta: string | null;
  ihPlan: string | null;
  mode: string;
  qty: number;
  /** What the shipment is worth, in USD. */
  value: number;
  product: string;
  category: string;
}

export interface ItemLine {
  code: string;
  name: string;
  unit: string;
  consumption: number;
  consumptionValue: number;
  closing: number;
  closingValue: number;
}

export interface RowDetail {
  key: string;
  kind: 'material' | 'slider';
  /** What the live figures were read from. */
  matchedOn: string[];
  months: MonthPoint[];
  shipments: Shipment[];
  items: ItemLine[];
  fetchedAt: string;
  error?: string;
}

/** How many months of consumption the drill-down draws. */
const TREND_MONTHS = 12;

function monthsBack(month: string, back: number): string {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) - back;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`;
}

/**
 * What sits behind one row of the sheet.
 *
 * Three reads, all scoped to Zipper: the row's consumption month by month, the
 * shipments that make up its GIT, and the items underneath it. A material is
 * found by item category and narrowed to its zipper type; a slider by the
 * products whose name carries its TZP code, because one plan row is one slider,
 * not the whole SLIDER category.
 */
export async function rowDetail(
  kind: 'material' | 'slider',
  key: string,
  group?: string,
): Promise<RowDetail> {
  const detail: RowDetail = {
    key,
    kind,
    matchedOn: [],
    months: [],
    shipments: [],
    items: [],
    fetchedAt: new Date().toISOString(),
  };

  const context = buildContext(await getSession());
  const from = monthsBack(demandPlan.month, TREND_MONTHS);
  const [monthFrom, to] = monthBounds(demandPlan.month);

  try {
    let scope: unknown[];
    /** Applied after the read, because the zipper type lives in the name. */
    let keep: (productName: string) => boolean = () => true;

    if (kind === 'material') {
      const wanted = MATERIAL_CATEGORIES[key] ?? [];
      const byName = await itemCategories(context);
      const ids = wanted.map((n) => byName.get(n.toUpperCase())).filter((id): id is number => !!id);
      if (!ids.length) {
        detail.error = `"${key}" has no item category in the Zipper ledger.`;
        return detail;
      }
      detail.matchedOn = group ? wanted.map((w) => `${group} · ${w}`) : wanted;
      scope = [['item_category', 'in', ids]];
      if (group) keep = (name) => groupOf(name) === group;
    } else {
      const digits = Number(key.replace(/[^0-9]/g, ''));
      // Candidates first, then an exact read of the code: `ilike TZP%794` also
      // matches TZP-1794, which is a different slider.
      const candidates = await callKw<any[]>('product.product', 'search_read', {
        args: [[['name', 'ilike', `TZP%${digits}`]], ['name']],
        kwargs: { context, limit: 200 },
      });
      const ids = candidates.filter((p) => tzpCodes(p.name).includes(digits)).map((p) => p.id);
      if (!ids.length) {
        detail.error = `No product in the ledger carries ${key}.`;
        return detail;
      }
      detail.matchedOn = candidates.filter((p) => ids.includes(p.id)).map((p) => String(p.name));
      scope = [['product_id', 'in', ids]];
    }

    const ledgerScope = [['company_id', '=', ZIPPER], ...scope];

    const [series, items, shipments] = await Promise.all([
      callKw<any[]>(LEDGER_MODEL, 'read_group', {
        args: [
          [...ledgerScope, ['month', '>=', from], ['month', '<', to]],
          ['issue_qty', 'issue_value', 'cloing_qty', 'cloing_value'],
          ['month:month', 'product_name'],
        ],
        kwargs: { context, lazy: false, limit: 0 },
      }),
      callKw<any[]>(LEDGER_MODEL, 'read_group', {
        args: [
          [...ledgerScope, ['month', '>=', monthFrom], ['month', '<', to]],
          ['issue_qty', 'issue_value', 'cloing_qty', 'cloing_value'],
          ['pr_code', 'product_name', 'product_uom'],
        ],
        kwargs: { context, lazy: false, limit: 0 },
      }),
      callKw<any[]>(TRANSIT_MODEL, 'search_read', {
        args: [
          [['state', 'in', IN_TRANSIT], ['transit_id.company_id', '=', ZIPPER], ...scope],
          [
            'transit_id',
            'vendor_main',
            'vendor',
            'po_id',
            'eta',
            'qty_in_transit',
            'subtotal',
            'product_id',
            'item_category',
            'shipment_mode',
          ],
        ],
        kwargs: { context, limit: 60, order: 'eta asc, id desc' },
      }),
    ]);

    const months = new Map<string, MonthPoint>();
    for (const row of series) {
      if (!keep(String(row.product_name ?? ''))) continue;
      const month = String(row.__range?.['month:month']?.from ?? '').slice(0, 7);
      if (!month) continue;
      const held =
        months.get(month) ??
        ({ month, consumption: 0, consumptionValue: 0, closing: 0, closingValue: 0 } as MonthPoint);
      held.consumption += -num(row.issue_qty);
      held.consumptionValue += -num(row.issue_value);
      held.closing += num(row.cloing_qty);
      held.closingValue += num(row.cloing_value);
      months.set(month, held);
    }
    detail.months = [...months.values()]
      .map((m) => ({
        month: m.month,
        consumption: Math.round(m.consumption),
        consumptionValue: Math.round(m.consumptionValue),
        closing: Math.round(m.closing),
        closingValue: Math.round(m.closingValue),
      }))
      .sort((a, b) => a.month.localeCompare(b.month));

    detail.items = items
      .filter((row) => keep(String(row.product_name ?? '')))
      .map((row) => ({
        code: String(row.pr_code ?? '').trim(),
        name: String(row.product_name ?? '').trim(),
        unit: nameOf(row.product_uom),
        consumption: Math.round(-num(row.issue_qty)),
        consumptionValue: Math.round(-num(row.issue_value)),
        closing: Math.round(num(row.cloing_qty)),
        closingValue: Math.round(num(row.cloing_value)),
      }))
      .filter((i) => i.consumption || i.closing)
      .sort((a, b) => b.consumption - a.consumption)
      .slice(0, 12);

    const wanted = shipments.filter((line) => keep(nameOf(line.product_id)));

    // The in-house plan date lives on the transit header, not the line.
    const headerIds = [
      ...new Set(wanted.map((l) => idOf(l.transit_id)).filter((v): v is number => !!v)),
    ];
    const plans = new Map<number, string | null>();
    if (headerIds.length) {
      const headers = await callKw<any[]>('transit.model', 'read', {
        args: [headerIds, ['ih_plan']],
        kwargs: { context },
      });
      for (const h of headers) plans.set(h.id, h.ih_plan || null);
    }

    detail.shipments = wanted
      .map((line) => ({
        transit: nameOf(line.transit_id),
        vendor: nameOf(line.vendor_main) || nameOf(line.vendor),
        po: nameOf(line.po_id),
        eta: line.eta || null,
        ihPlan: plans.get(idOf(line.transit_id) ?? -1) ?? null,
        mode: nameOf(line.shipment_mode),
        qty: Math.round(num(line.qty_in_transit)),
        value: Math.round(num(line.subtotal)),
        product: nameOf(line.product_id),
        category: nameOf(line.item_category),
      }))
      .filter((s) => s.qty);
  } catch (err) {
    detail.error = (err as Error).message;
  }

  return detail;
}
