/**
 * Zipper RM demand plan — required against consumed, with what is on the water.
 *
 * This replaces `SC_ RM Demand Plan (1).xlsx`, tab "Zip Demand Plan Aug". The
 * only thing taken from that workbook is its FORMULA, which ships as
 * `src/data/rm-demand-formula.json`. Every quantity is read from Odoo, so the
 * report rolls to next month on its own without anyone re-extracting a sheet.
 *
 *   demand    rolling.forecast.line       by fg category, for the month
 *   required  the formula, over that demand
 *   opening   rm.stock.detailed.monthly   opening_qty
 *   consumed  rm.stock.detailed.monthly   issue_qty, sign-flipped
 *   stock     rm.stock.detailed.monthly   cloing_qty
 *   in-house  transit.line                where the shipment lands in the month
 *   GIT       transit.line                still on the water, whenever it ships
 *
 * THE FORMULA
 * -----------
 *   required = SUM over terms of
 *                ( SUM over the term's categories of demand x that category's rate )
 *                x factor / 1000
 *
 * Each zipper category carries its own rate; each material row a factor and the
 * categories it draws from. Recovered from the sheet cell by cell and exact:
 * Metal #5 metal wire is (632,105 x 7.06 + 271,690 x 23.64 + 20,892 x 23.72)
 * x 0.95 / 1000 = 10,811.9 against the sheet's 10,811.92258.
 *
 * It reads oddly at a glance — 6.7 million zippers needing only 29,741 — until
 * the unit lands: that is 5.5 x 0.77 / 1000 = 4.2 grams of brass wire each, and
 * the ledger counts wire in kg.
 *
 * WHAT IS NOT HERE
 * ----------------
 * The sheet's STI slider block sets each slider's requirement by hand, and no
 * readable Odoo model carries it — `demand.plan.slider` lists which sliders
 * matter, not how many are wanted. So the slider table shows what Odoo does
 * know, per slider, and says the requirement is missing rather than inventing
 * one. Odoo's own `rm.demand.availability.dashboard` would supply it, and this
 * login is denied access to that model.
 */
import { buildContext, callKw, getSession } from './odoo';
import formula from '../data/rm-demand-formula.json';

/** The plan is Zipper only, which is what the report is for. */
const ZIPPER = 1;

const LEDGER_MODEL = 'rm.stock.detailed.monthly';
const TRANSIT_MODEL = 'transit.line';
const FORECAST_MODEL = 'rolling.forecast.line';
const SLIDER_MODEL = 'demand.plan.slider';

/** Transit states that still count as on the water rather than received. */
const IN_TRANSIT = ['logistics', 'in_transit'];

/**
 * Forecast lines firm enough to plan material against.
 *
 * Approved alone understates badly — a third of August — because much of the
 * book is still awaiting approval when the material has to be ordered. Draft
 * and cancelled are excluded.
 */
const FORECAST_STATES = ['approved', 'to approve'];

/** Everything outside Bangladesh is the sheet's Export column. */
const EXPORT_REGION = 'OVERSEAS';

/* ------------------------------------------------------------- the formula */

export interface FormulaCategory {
  key: string;
  group: string;
  type: string;
  rate: number;
}

export interface FormulaTerm {
  categories: string[];
  factor: number;
}

export interface FormulaRow {
  group: string;
  type: string;
  material: string;
  terms: FormulaTerm[];
}

export interface DemandFormula {
  company: string;
  source: string;
  note: string;
  categories: FormulaCategory[];
  rows: FormulaRow[];
}

export const demandFormula = formula as DemandFormula;

/**
 * The sheet's material names against Odoo's item categories.
 *
 * Two vocabularies, and the mapping is deliberately partial. "Tape / Long
 * Chain" is one line in the formula and two categories in Odoo, so it maps to
 * both. "Alm Wire" — aluminium wire — has no category of its own in the Zipper
 * ledger, so it maps to nothing and the report says so rather than quietly
 * folding it into METAL WIRE.
 */
export const MATERIAL_CATEGORIES: Record<string, string[]> = {
  'Metal Wire': ['METAL WIRE'],
  'Tape / Long Chain': ['TAPE', 'LONG CHAIN'],
  POM: ['POM'],
  'STI Slider': ['SLIDER'],
};

/**
 * The zipper type a raw-material product belongs to, read off its own name.
 *
 * The ledger has no zipper-type dimension, but it does not need one: the
 * products name themselves. "M#4 BRASS WIRE DN+" and "M#5 BRASS WIRE DN+" are
 * both METAL WIRE and belong to different rows, and their names are the only
 * thing that tells them apart. Coil is written N# as often as C#.
 */
export const GROUP_TOKENS: [string, RegExp][] = [
  ['Metal #4', /\bM#4(?:\.5)?\b/i],
  ['Metal #5', /\bM#5\b/i],
  ['Metal #8', /\bM#8\b/i],
  ['Aluminium #4', /\bAL#4\b/i],
  ['Aluminium #5', /\bAL#5\b/i],
  ['Invisible #3', /\bINV#3\b/i],
  ['Coil #3', /\b[NC]#3\b/i],
  ['Coil #5', /\b[NC]#5\b/i],
  ['Coil #8', /\b[NC]#8\b/i],
  ['Plastic #3', /\bP#3\b/i],
  ['Plastic #5', /\bP#5\b/i],
];

/** Which group a product name belongs to, or null when it says nothing. */
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

export interface CategoryDemand {
  key: string;
  group: string;
  type: string;
  rate: number;
  bd: number;
  export: number;
  total: number;
  /** What the order book is worth, from the forecast's own pricing. */
  value: number;
}

export interface LiveCategory {
  category: string;
  unit: string | null;
  consumption: number;
  consumptionValue: number;
  currentStock: number;
  currentStockValue: number;
  git: number;
  gitValue: number;
  gitLines: number;
}

export interface DemandRow {
  group: string;
  type: string | null;
  material: string;
  slider: string | null;

  /** The categories whose demand feeds this row, and what they contribute. */
  from: { key: string; demand: number; rate: number; factor: number }[];
  demandBd: number | null;
  demandExport: number | null;
  demandTotal: number | null;
  /** The order book in money, so the demand reads like every other column. */
  demandValue: number | null;

  required: number | null;
  /**
   * The requirement in money, priced at what the ledger actually paid.
   *
   * The formula works in the material's own unit; the page reads in money. The
   * rate comes from the ledger itself — value over quantity for what moved this
   * month, falling back to what is sitting in stock when nothing moved — so it
   * is the plant's own cost, not a list price from somewhere else.
   */
  requiredValue: number | null;
  /** What one unit cost, and which side of the ledger that came from. */
  unitCost: number | null;
  costBasis: 'consumed' | 'stock' | 'trailing' | null;
  /** Null when no readable Odoo model carries the requirement. */
  requiredFrom: 'formula' | 'unavailable';

  op: number | null;
  opValue: number | null;
  ih: number | null;
  ihValue: number | null;
  opIh: number | null;
  opIhValue: number | null;

  consumption: number | null;
  consumptionValue: number | null;
  currentStock: number | null;
  currentStockValue: number | null;
  git: number | null;
  gitValue: number | null;
  gitLines: number;

  totalAvailable: number | null;
  availability: number | null;

  /** What this row is counted in — kg for wire and tape, Pcs for sliders. */
  unit: string | null;
  matchedOn: string[];
}

export interface DemandReport {
  month: string;
  /** Every month a forecast exists for, so the page can move between them. */
  months: string[];
  /**
   * True when the ledger has not reached this month yet.
   *
   * The forecast runs months ahead of the actuals, so a future month has a real
   * requirement and no consumption at all. Stock and GIT then answer a
   * different question — not "what did this month hold" but "what will be there
   * by the time it arrives" — and the page has to say which it is showing.
   */
  projected: boolean;
  /** The month the stock position is actually read from. */
  stockAsOf: string;
  company: string;
  source: string;
  demand: CategoryDemand[];
  materials: DemandRow[];
  sliders: DemandRow[];
  live: LiveCategory[];
  unmapped: string[];
  unmatched: string[];
  fetchedAt: string;
  error?: string;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const nameOf = (v: unknown) => (Array.isArray(v) ? String(v[1] ?? '').trim() : '');
const round = (v: number) => Math.round(v * 100) / 100;

/** The first of the month `back` months before `month`. */
function monthsBack(month: string, back: number): string {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) - back;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`;
}

/** The month as Odoo's `month` date column bounds it. */
function monthBounds(month: string): [string, string] {
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return [`${month}-01`, next];
}

/**
 * What one unit of a material costs, read off the ledger.
 *
 * What moved this month is the better answer, because it is what the plant
 * actually paid to consume. When nothing moved, the stock sitting there still
 * has a value and a quantity, and that is the next best thing. When there is
 * neither, there is no honest rate and the money column stays empty.
 */
function unitCostOf(
  qty: number | null,
  value: number | null,
  stockQty: number | null,
  stockValue: number | null,
  trailing: number | null = null,
): { rate: number | null; basis: 'consumed' | 'stock' | 'trailing' | null } {
  if (qty && value) return { rate: value / qty, basis: 'consumed' };
  if (stockQty && stockValue) return { rate: stockValue / stockQty, basis: 'stock' };
  if (trailing) return { rate: trailing, basis: 'trailing' };
  return { rate: null, basis: null };
}

/** A cell of the live grid: one material category crossed with one zipper type. */
interface Cell {
  opening: number;
  openingValue: number;
  /** Goods actually taken into the house this month — the sheet's I/H. */
  received: number;
  receivedValue: number;
  consumption: number;
  consumptionValue: number;
  currentStock: number;
  currentStockValue: number;
  git: number;
  gitValue: number;
  gitLines: number;
  ih: number;
}

const emptyCell = (): Cell => ({
  opening: 0,
  openingValue: 0,
  received: 0,
  receivedValue: 0,
  consumption: 0,
  consumptionValue: 0,
  currentStock: 0,
  currentStockValue: 0,
  git: 0,
  gitValue: 0,
  gitLines: 0,
  ih: 0,
});

const cellKey = (group: string | null, category: string) => `${group ?? '?'}|${category}`;

/* ------------------------------------------------------------------ report */

export async function demandReport(wanted?: string): Promise<DemandReport> {
  const context = buildContext(await getSession());

  // Which months the forecast covers. The page opens on the latest, which is
  // what makes the report roll forward without anyone touching it.
  const monthRows = await callKw<any[]>(FORECAST_MODEL, 'read_group', {
    args: [
      [['company_id', '=', ZIPPER], ['state', 'in', FORECAST_STATES]],
      ['qty'],
      ['next_month'],
    ],
    kwargs: { context, lazy: false, limit: 0 },
  });
  const months = monthRows
    .map((r) => String(r.next_month ?? ''))
    .filter((m) => /^\d{4}-\d{2}$/.test(m))
    .sort();

  /*
   * The forecast runs months ahead of the ledger, so the furthest month it
   * reaches has no actuals at all and the page would open on an empty sheet.
   * It opens on the last month that has actually happened instead — which is
   * still the roll-forward the report exists for, just one that has something
   * to compare against.
   */
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const settled = months.filter((m) => m <= thisMonth);
  const month =
    wanted && months.includes(wanted) ? wanted : (settled.at(-1) ?? months.at(-1) ?? '');

  const report: DemandReport = {
    month,
    months,
    projected: false,
    stockAsOf: month,
    company: demandFormula.company,
    source: demandFormula.source,
    demand: [],
    materials: [],
    sliders: [],
    live: [],
    unmapped: [],
    unmatched: [],
    fetchedAt: new Date().toISOString(),
  };
  if (!month) {
    report.error = 'Odoo holds no rolling forecast for Zipper.';
    return report;
  }

  /*
   * A future month has no snapshot of its own. Its stock position is the last
   * one that exists, and its GIT is everything still on the water that is
   * planned to land by the end of it — which is the question that month
   * actually poses: will there be enough by then.
   */
  const latestLedger = await callKw<any[]>(LEDGER_MODEL, 'read_group', {
    args: [[['company_id', '=', ZIPPER]], ['id'], ['month:month']],
    kwargs: { context, lazy: false, limit: 0 },
  })
    .then((rows) =>
      rows
        .map((r) => String(r.__range?.['month:month']?.from ?? '').slice(0, 7))
        .filter(Boolean)
        .sort()
        .at(-1) ?? month,
    )
    .catch(() => month);

  const projected = month > latestLedger;
  report.projected = projected;
  report.stockAsOf = projected ? latestLedger : month;

  const [from, to] = monthBounds(report.stockAsOf);
  /** GIT and in-house are asked of the month on screen, not the stock month. */
  const [, horizon] = monthBounds(month);
  const grid = new Map<string, Cell>();
  const byCategory = new Map<string, LiveCategory>();
  const rowUnit = new Map<string, string>();
  const demandOf = new Map<string, CategoryDemand>();

  for (const c of demandFormula.categories) {
    demandOf.set(c.key, { ...c, bd: 0, export: 0, total: 0, value: 0 });
  }

  try {
    const [forecast, ledger, transit, inHouse, units, sliderNames, trailing] = await Promise.all([
      callKw<any[]>(FORECAST_MODEL, 'read_group', {
        args: [
          [
            ['company_id', '=', ZIPPER],
            ['next_month', '=', month],
            ['state', 'in', FORECAST_STATES],
          ],
          ['qty', 'total_price'],
          ['item_category', 'sales_person_region'],
        ],
        kwargs: { context, lazy: false, limit: 0 },
      }),
      callKw<any[]>(LEDGER_MODEL, 'read_group', {
        args: [
          [['company_id', '=', ZIPPER], ['month', '>=', from], ['month', '<', to]],
          [
            'opening_qty',
            'opening_value',
            'receive_qty',
            'receive_value',
            'issue_qty',
            'issue_value',
            'cloing_qty',
            'cloing_value',
          ],
          ['item_category', 'product_name'],
        ],
        kwargs: { context, lazy: false, limit: 0 },
      }),
      callKw<any[]>(TRANSIT_MODEL, 'read_group', {
        args: [
          [
            ['state', 'in', IN_TRANSIT],
            ['transit_id.company_id', '=', ZIPPER],
            // On a month that has already happened, GIT is simply what is on
            // the water. On one that has not, only what is planned to land by
            // the end of it can count towards covering it.
            ...(projected
              ? ['|', ['transit_id.ih_plan', '=', false], ['transit_id.ih_plan', '<', horizon]]
              : []),
          ],
          ['qty_in_transit', 'subtotal'],
          ['item_category', 'product_id'],
        ],
        kwargs: { context, lazy: false, limit: 0 },
      }),
      // The sheet's I/H: what is planned to land in this month.
      callKw<any[]>(TRANSIT_MODEL, 'read_group', {
        args: [
          [
            ['transit_id.company_id', '=', ZIPPER],
            ['transit_id.ih_plan', '>=', from],
            ['transit_id.ih_plan', '<', to],
          ],
          ['qty_in_transit'],
          ['item_category', 'product_id'],
        ],
        kwargs: { context, lazy: false, limit: 0 },
      }),
      callKw<any[]>(LEDGER_MODEL, 'read_group', {
        args: [
          [['company_id', '=', ZIPPER], ['month', '>=', from], ['month', '<', to]],
          ['issue_qty'],
          ['item_category', 'product_uom'],
        ],
        kwargs: { context, lazy: false, limit: 0 },
      }),
      callKw<any[]>(SLIDER_MODEL, 'search_read', {
        args: [[['company_id', '=', ZIPPER]], ['name', 'sequence']],
        kwargs: { context, limit: 0, order: 'sequence, name' },
      }),
      // A month still in the future has consumed nothing, so it can price
      // nothing. The trailing year can, and a material's cost does not move
      // enough in a month for that to mislead.
      callKw<any[]>(LEDGER_MODEL, 'read_group', {
        args: [
          [
            ['company_id', '=', ZIPPER],
            ['month', '>=', monthsBack(month, 12)],
            ['month', '<', to],
          ],
          ['issue_qty', 'issue_value'],
          ['item_category'],
        ],
        kwargs: { context, lazy: false, limit: 0 },
      }),
    ]);

    const fallbackCost = new Map<string, number>();
    for (const row of trailing) {
      const cat = nameOf(row.item_category);
      const qty = -num(row.issue_qty);
      const value = -num(row.issue_value);
      if (cat && qty > 0 && value > 0) fallbackCost.set(cat, value / qty);
    }

    /* ---- demand ---- */
    for (const row of forecast) {
      const key = nameOf(row.item_category);
      const held = demandOf.get(key);
      if (!held) continue;
      const qty = num(row.qty);
      if (String(row.sales_person_region ?? '') === EXPORT_REGION) held.export += qty;
      else held.bd += qty;
      held.total += qty;
      held.value += num(row.total_price);
    }
    report.demand = [...demandOf.values()].sort((a, b) => b.total - a.total);

    /* ---- the live grid ---- */
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
            unit: null,
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

      target.opening += num(row.opening_qty);
      target.openingValue += num(row.opening_value);
      target.received += num(row.receive_qty);
      target.receivedValue += num(row.receive_value);
      target.consumption += -num(row.issue_qty);
      target.consumptionValue += -num(row.issue_value);
      target.currentStock += num(row.cloing_qty);
      target.currentStockValue += num(row.cloing_value);

      roll.consumption += -num(row.issue_qty);
      roll.consumptionValue += -num(row.issue_value);
      roll.currentStock += num(row.cloing_qty);
      roll.currentStockValue += num(row.cloing_value);
    }

    for (const row of transit) {
      const cat = nameOf(row.item_category) || '(uncategorised)';
      const target = cellAt(groupOf(nameOf(row.product_id)), cat);
      const roll = categoryAt(cat);
      target.git += num(row.qty_in_transit);
      target.gitValue += num(row.subtotal);
      target.gitLines += num(row.__count);
      roll.git += num(row.qty_in_transit);
      roll.gitValue += num(row.subtotal);
      roll.gitLines += num(row.__count);
    }

    for (const row of inHouse) {
      const cat = nameOf(row.item_category) || '(uncategorised)';
      cellAt(groupOf(nameOf(row.product_id)), cat).ih += num(row.qty_in_transit);
    }

    // A category can carry a stray row in another unit; the one that moved the
    // most speaks for it.
    /*
     * The stock month lends its POSITION to a projected month, never its
     * flows. What August consumed is a fact about August; carrying it into
     * September would invent a consumption that has not happened and make the
     * deviation column read as if the month were already under way.
     */
    if (projected) {
      for (const cell of grid.values()) {
        cell.consumption = 0;
        cell.consumptionValue = 0;
        cell.received = 0;
        cell.receivedValue = 0;
      }
      for (const roll of byCategory.values()) {
        roll.consumption = 0;
        roll.consumptionValue = 0;
      }
    }

    const best = new Map<string, number>();
    for (const row of units) {
      const cat = nameOf(row.item_category) || '(uncategorised)';
      const unit = nameOf(row.product_uom);
      if (!unit) continue;
      const moved = Math.abs(num(row.issue_qty));
      if (moved >= (best.get(cat) ?? -1)) {
        best.set(cat, moved);
        rowUnit.set(cat, unit);
      }
    }

    report.live = [...byCategory.values()]
      .map((c) => ({
        ...c,
        unit: rowUnit.get(c.category) ?? null,
        consumption: Math.round(c.consumption),
        consumptionValue: Math.round(c.consumptionValue),
        currentStock: Math.round(c.currentStock),
        currentStockValue: Math.round(c.currentStockValue),
        git: Math.round(c.git),
        gitValue: Math.round(c.gitValue),
      }))
      .sort((a, b) => b.consumption - a.consumption);

    /* ---- the material rows ---- */
    const cellsFor = (group: string, categories: string[]) =>
      categories.map((c) => grid.get(cellKey(group, c))).filter((c): c is Cell => !!c);

    report.materials = demandFormula.rows.map((row) => {
      const categories = MATERIAL_CATEGORIES[row.material] ?? [];
      const cells = cellsFor(row.group, categories);
      const has = cells.length > 0;
      const sum = (pick: (c: Cell) => number) =>
        has ? Math.round(cells.reduce((a, c) => a + pick(c), 0)) : null;

      let required = 0;
      const feeds: DemandRow['from'] = [];
      let bd = 0;
      let exported = 0;
      let orderValue = 0;
      for (const term of row.terms) {
        let weighted = 0;
        for (const key of term.categories) {
          const d = demandOf.get(key);
          if (!d) continue;
          weighted += d.total * d.rate;
          feeds.push({ key, demand: d.total, rate: d.rate, factor: term.factor });
          bd += d.bd;
          exported += d.export;
          orderValue += d.value;
        }
        required += (weighted * term.factor) / 1000;
      }

      const consumption = sum((c) => c.consumption);
      const consumptionValue = sum((c) => c.consumptionValue);
      const currentStock = sum((c) => c.currentStock);
      const currentStockValue = sum((c) => c.currentStockValue);
      const git = sum((c) => c.git);
      /*
       * A month that has not started opens on the last position that exists,
       * which is the stock month's CLOSING rather than its opening.
       */
      const op = projected ? sum((c) => c.currentStock) : sum((c) => c.opening);
      const opValue = projected
        ? sum((c) => c.currentStockValue)
        : sum((c) => c.openingValue);
      /*
       * I/H is In-House: what was actually taken into the factory this month.
       * The sheet proves it — it computes current stock as (OP + I/H) minus
       * consumption, and the ledger's own identity is opening + received minus
       * issued. Both give 20,115 kg for Metal #4 wire in August, so I/H is
       * `receive_qty` and nothing else. A month that has not happened has
       * received nothing yet, and what is coming is already the GIT column, so
       * repeating it here would count the same shipment twice.
       */
      const ih = projected ? null : sum((c) => c.received);
      const ihValue = projected ? null : sum((c) => c.receivedValue);
      const totalAvailable =
        currentStock === null && git === null ? null : (currentStock ?? 0) + (git ?? 0);

      const cost = unitCostOf(
        consumption,
        consumptionValue,
        currentStock,
        currentStockValue,
        categories.map((c) => fallbackCost.get(c)).find((v) => v !== undefined) ?? null,
      );

      return {
        group: row.group,
        type: row.type,
        material: row.material,
        slider: null,
        from: feeds,
        demandBd: Math.round(bd),
        demandExport: Math.round(exported),
        demandTotal: Math.round(bd + exported),
        demandValue: Math.round(orderValue),
        required: round(required),
        requiredValue: cost.rate === null ? null : Math.round(required * cost.rate),
        unitCost: cost.rate,
        costBasis: cost.basis,
        requiredFrom: 'formula' as const,
        op,
        opValue,
        ih,
        ihValue,
        opIh: op === null && ih === null ? null : (op ?? 0) + (ih ?? 0),
        opIhValue:
          opValue === null && ihValue === null ? null : (opValue ?? 0) + (ihValue ?? 0),
        consumption,
        consumptionValue,
        currentStock,
        currentStockValue,
        git,
        gitValue: sum((c) => c.gitValue),
        gitLines: has ? cells.reduce((a, c) => a + c.gitLines, 0) : 0,
        totalAvailable,
        // Cover in money, so it agrees with the columns either side of it.
        // As a ratio it lands within a point of the quantity version anyway,
        // but a page that reads in value should not compute in kilos.
        availability:
          cost.rate && required && currentStockValue !== null
            ? ((currentStockValue ?? 0) + (sum((c) => c.gitValue) ?? 0)) /
              (required * cost.rate)
            : null,
        unit: categories.map((c) => rowUnit.get(c)).find(Boolean) ?? null,
        matchedOn: categories,
      };
    });

    /* ---- the sliders ---- */
    report.sliders = await sliderRows(
      context,
      sliderNames.map((s) => String(s.name)),
      from,
      to,
    );

    const claimed = new Set(Object.values(MATERIAL_CATEGORIES).flat());
    report.unmapped = report.live
      .filter((c) => !claimed.has(c.category) && (c.consumption || c.git))
      .map((c) => c.category);
    report.unmatched = [
      ...new Set(
        demandFormula.rows.filter((r) => !MATERIAL_CATEGORIES[r.material]).map((r) => r.material),
      ),
    ];
  } catch (err) {
    report.error = (err as Error).message;
  }

  return report;
}

/**
 * One row per slider Odoo tracks, with what the ledger says about it.
 *
 * No requirement: the sheet sets each slider's demand by hand and no readable
 * model carries it, so the column says so rather than inventing a number.
 */
async function sliderRows(
  context: Record<string, unknown>,
  names: string[],
  from: string,
  to: string,
): Promise<DemandRow[]> {
  if (!names.length) return [];

  // Every TZP product once, then matched to sliders by whole-number code.
  const products = await callKw<any[]>('product.product', 'search_read', {
    args: [[['name', 'ilike', 'TZP%']], ['name']],
    kwargs: { context, limit: 0 },
  });

  const idsFor = new Map<string, number[]>();
  for (const name of names) {
    const digits = Number(name.replace(/[^0-9]/g, ''));
    // "TZP-305 (N)" is its own slider, so a bare "TZP-305" must not swallow it.
    const marked = /\(\s*N\s*\)/i.test(name);
    idsFor.set(
      name,
      products
        .filter((p) => {
          if (!tzpCodes(p.name).includes(digits)) return false;
          return /\(\s*N\s*\)/i.test(String(p.name)) === marked;
        })
        .map((p) => p.id),
    );
  }

  const everyId = [...new Set([...idsFor.values()].flat())];
  if (!everyId.length) return [];

  const [ledger, transit] = await Promise.all([
    callKw<any[]>(LEDGER_MODEL, 'read_group', {
      args: [
        [
          ['company_id', '=', ZIPPER],
          ['product_id', 'in', everyId],
          ['month', '>=', from],
          ['month', '<', to],
        ],
        [
          'opening_qty',
          'opening_value',
          'issue_qty',
          'issue_value',
          'cloing_qty',
          'cloing_value',
        ],
        ['product_id'],
      ],
      kwargs: { context, lazy: false, limit: 0 },
    }),
    callKw<any[]>(TRANSIT_MODEL, 'read_group', {
      args: [
        [
          ['state', 'in', IN_TRANSIT],
          ['transit_id.company_id', '=', ZIPPER],
          ['product_id', 'in', everyId],
        ],
        ['qty_in_transit', 'subtotal'],
        ['product_id'],
      ],
      kwargs: { context, lazy: false, limit: 0 },
    }),
  ]);

  const byProduct = new Map<number, Cell>();
  const at = (id: number) => {
    let held = byProduct.get(id);
    if (!held) byProduct.set(id, (held = emptyCell()));
    return held;
  };
  for (const row of ledger) {
    const id = Array.isArray(row.product_id) ? (row.product_id[0] as number) : null;
    if (id === null) continue;
    const c = at(id);
    c.opening += num(row.opening_qty);
    c.openingValue += num(row.opening_value);
    c.consumption += -num(row.issue_qty);
    c.consumptionValue += -num(row.issue_value);
    c.currentStock += num(row.cloing_qty);
    c.currentStockValue += num(row.cloing_value);
  }
  for (const row of transit) {
    const id = Array.isArray(row.product_id) ? (row.product_id[0] as number) : null;
    if (id === null) continue;
    const c = at(id);
    c.git += num(row.qty_in_transit);
    c.gitValue += num(row.subtotal);
    c.gitLines += num(row.__count);
  }

  return names.map((name) => {
    const cells = (idsFor.get(name) ?? []).map(at);
    const sum = (pick: (c: Cell) => number) =>
      cells.length ? Math.round(cells.reduce((a, c) => a + pick(c), 0)) : null;

    const consumption = sum((c) => c.consumption);
    const consumptionValue = sum((c) => c.consumptionValue);
    const currentStock = sum((c) => c.currentStock);
    const currentStockValue = sum((c) => c.currentStockValue);
    const git = sum((c) => c.git);
    const cost = unitCostOf(consumption, consumptionValue, currentStock, currentStockValue);

    return {
      group: 'STI sliders',
      type: null,
      material: 'STI Slider',
      slider: name,
      from: [],
      demandBd: null,
      demandExport: null,
      demandTotal: null,
      demandValue: null,
      required: null,
      requiredValue: null,
      unitCost: cost.rate,
      costBasis: cost.basis,
      requiredFrom: 'unavailable' as const,
      op: sum((c) => c.opening),
      opValue: sum((c) => c.openingValue),
      ih: null,
      ihValue: null,
      opIh: sum((c) => c.opening),
      opIhValue: sum((c) => c.openingValue),
      consumption,
      consumptionValue,
      currentStock,
      currentStockValue,
      git,
      gitValue: sum((c) => c.gitValue),
      gitLines: cells.reduce((a, c) => a + c.gitLines, 0),
      totalAvailable:
        currentStock === null && git === null ? null : (currentStock ?? 0) + (git ?? 0),
      availability: null,
      unit: 'Pcs',
      matchedOn: [`${(idsFor.get(name) ?? []).length} products`],
    };
  });
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
  eta: string | null;
  ihPlan: string | null;
  mode: string;
  qty: number;
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
  matchedOn: string[];
  months: MonthPoint[];
  shipments: Shipment[];
  items: ItemLine[];
  fetchedAt: string;
  error?: string;
}

const TREND_MONTHS = 12;

let categoryIds: Promise<Map<string, number>> | null = null;

/**
 * Item categories resolved to ids, once.
 *
 * Filtering on `item_category.display_name` looks like it works and does not:
 * `display_name` is computed, not stored, so Odoo cannot push the comparison
 * into SQL and the domain silently matches far more than it should — asking for
 * METAL WIRE came back with sliders, pin boxes and 20 million units against the
 * 26 thousand the grouped read gives. Ids are the only safe key.
 */
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

/**
 * What sits behind one row.
 *
 * Three reads, all scoped to Zipper: the row's consumption month by month, the
 * shipments that make up its GIT, and the items underneath it. A material is
 * found by item category and narrowed to its zipper type; a slider by the
 * products whose name carries its TZP code.
 */
export async function rowDetail(
  kind: 'material' | 'slider',
  key: string,
  month: string,
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
  const from = monthsBack(month, TREND_MONTHS);
  const [monthFrom, to] = monthBounds(month);

  try {
    let scope: unknown[];
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
      const marked = /\(\s*N\s*\)/i.test(key);
      const candidates = await callKw<any[]>('product.product', 'search_read', {
        args: [[['name', 'ilike', `TZP%${digits}`]], ['name']],
        kwargs: { context, limit: 200 },
      });
      const wanted = candidates.filter(
        (p) => tzpCodes(p.name).includes(digits) && /\(\s*N\s*\)/i.test(String(p.name)) === marked,
      );
      if (!wanted.length) {
        detail.error = `No product in the ledger carries ${key}.`;
        return detail;
      }
      detail.matchedOn = wanted.map((p) => String(p.name));
      scope = [['product_id', 'in', wanted.map((p) => p.id)]];
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
      const key2 = String(row.__range?.['month:month']?.from ?? '').slice(0, 7);
      if (!key2) continue;
      const held =
        months.get(key2) ??
        ({ month: key2, consumption: 0, consumptionValue: 0, closing: 0, closingValue: 0 } as MonthPoint);
      held.consumption += -num(row.issue_qty);
      held.consumptionValue += -num(row.issue_value);
      held.closing += num(row.cloing_qty);
      held.closingValue += num(row.cloing_value);
      months.set(key2, held);
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
    const headerIds = [
      ...new Set(
        wanted
          .map((l) => (Array.isArray(l.transit_id) ? (l.transit_id[0] as number) : null))
          .filter((v): v is number => !!v),
      ),
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
        ihPlan:
          plans.get(Array.isArray(line.transit_id) ? (line.transit_id[0] as number) : -1) ?? null,
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
