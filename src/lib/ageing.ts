/**
 * 180+ days stock — the ageing side of Odoo's inventory.
 *
 * The "180 plus days stock" workbook is five sheets of VLOOKUPs over four Odoo
 * exports. Odoo holds all four as real models, so this reads them directly and
 * the workbook's arithmetic becomes a projection rather than a pipeline:
 *
 *   stock.ageing.movement       lot-level rows, one per lot per month snapshot.
 *                               slot_1..slot_6 are the age buckets; 5 and 6 are
 *                               the 181-365 and 365+ that make up "180+".
 *   rm.ageing.summary.report    the same, pre-aggregated to
 *                               company x item category x classification.
 *   rm.ageing.monthly.report    opening -> new add -> issue -> closing for the
 *                               180+ band, per item category per month.
 *   stock.lot.unusable          the flag that splits 180+ into what can still
 *                               be consumed and what is dead money.
 *
 * Everything is snapshotted monthly back to March 2024, so every figure the
 * dashboard shows has a history behind it rather than just a current value.
 */
import { callKw } from './odoo';

export const COMPANIES = [
  { key: 'zipper', id: 1, name: 'Zipper' },
  { key: 'mt', id: 3, name: 'Metal Trims' },
] as const;

export type CompanyKey = (typeof COMPANIES)[number]['key'];
export type Scope = CompanyKey | 'all';

/**
 * The seven age buckets Odoo keeps, in order.
 *
 * The movement model numbers them differently from the summary model (its
 * slot_5/slot_6 are 181-365 and 365+, with 91-180 collapsed into one). SLOTS
 * describes the summary model, which is the one with the finer split.
 */
export const SLOTS = [
  { field: 'slot_0_30', label: '0–30' },
  { field: 'slot_31_60', label: '31–60' },
  { field: 'slot_61_90', label: '61–90' },
  { field: 'slot_91_120', label: '91–120' },
  { field: 'slot_121_180', label: '121–180' },
  { field: 'slot_181_365', label: '181–365' },
  { field: 'slot_365_plus', label: '365+' },
] as const;

/** Index into SLOTS at which stock counts as "180+". */
export const AGED_FROM = 5;

const MOVEMENT_MODEL = 'stock.ageing.movement';
const SUMMARY_MODEL = 'rm.ageing.summary.report';
const MONTHLY_MODEL = 'rm.ageing.monthly.report';

// ------------------------------------------------------------------- shapes

export interface MovementPoint {
  month: string;
  opening: number;
  newAdd: number;
  /** Value that aged into 180+ this month rather than arriving as a receipt. */
  currentStatus: number;
  /** Negative: value consumed out of the 180+ band. */
  issue: number;
  closing: number;
}

export interface BucketPoint {
  month: string;
  /** One entry per SLOTS entry, same order. */
  value: number[];
  qty: number[];
}

export interface CategoryRow {
  category: string;
  opening: number;
  newAdd: number;
  issue: number;
  closing: number;
  /** Closing value per month, aligned to the report's `months`. */
  history: (number | null)[];
}

export interface LotRow {
  lot: string;
  product: string;
  code: string;
  category: string;
  company: CompanyKey;
  uom: string;
  receivedOn: string | null;
  /** Days the lot has been on the floor, as Odoo counts it. */
  duration: number;
  qty: number;
  band181: number;
  band365: number;
  value: number;
  unusable: boolean;
  rejected: string;
  shipment: string;
  unitPrice: number;
}

/** The usable / unusable split of the 180+ band for one month. */
export interface SplitPoint {
  month: string;
  usable: number;
  unusable: number;
}

export interface CompanyReport {
  key: CompanyKey;
  id: number;
  name: string;
  movement: MovementPoint[];
  buckets: BucketPoint[];
  categories: CategoryRow[];
  /** One entry per report month, same order. */
  split: SplitPoint[];
  /** Lot detail for the newest snapshot; other months are fetched on demand. */
  lots: LotRow[];
}

export interface InventoryMatrix {
  months: string[];
  years: string[];
  cell: Record<string, Record<string, { total: number; rm: number }>>;
}

/** One day's issues out of the 180+ band, per company. */
export interface DailyPoint {
  date: string;
  zipper: number;
  mt: number;
}

export interface AgeingReport {
  generatedAt: string;
  /** Snapshot months, ascending, e.g. ['2024-03', …, '2026-08']. */
  months: string[];
  asOf: string;
  slots: { field: string; label: string }[];
  companies: CompanyReport[];
  /** Total inventory by month and fiscal year, for share-of-stock context. */
  inventory: InventoryMatrix | null;
  /** Issues out of the band, day by day through the current month. */
  daily: DailyPoint[];
}

// -------------------------------------------------------------------- cache

/**
 * Six round trips and ~250KB of JSON, over snapshots that only change when
 * Odoo's monthly cron runs. Holding the built report briefly keeps a page
 * reload from re-running all of it.
 */
const TTL_MS = Number(process.env.AGEING_CACHE_MS || 5 * 60 * 1000);
let cache: { at: number; report: AgeingReport } | null = null;
let inFlight: Promise<AgeingReport> | null = null;

export function invalidateAgeing() {
  cache = null;
  lotCache.clear();
}

export async function getAgeingReport(force = false): Promise<AgeingReport> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.report;
  if (!force && inFlight) return inFlight;

  inFlight = buildReport()
    .then((report) => {
      cache = { at: Date.now(), report };
      return report;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

// -------------------------------------------------------------------- build

async function buildReport(): Promise<AgeingReport> {
  const [movement, summary, monthly, inventory, split] = await Promise.all([
    fetchMovementDashboard(),
    fetchBucketHistory(),
    fetchCategoryHistory(),
    fetchInventoryMatrix(),
    fetchUsableSplit(),
  ]);

  // Every source carries its own month list; the union keeps a source that
  // starts late from silently shortening everyone else's history.
  const months = [...new Set([...movement.months, ...summary.months, ...monthly.months])].sort();
  const asOf = months[months.length - 1] ?? '';

  const { byCompany: lotsByCompany, priceOfLot } = await fetchLots(asOf);
  const daily = await fetchDailyConsumption(asOf, priceOfLot);

  const companies: CompanyReport[] = COMPANIES.map((c) => ({
    key: c.key,
    id: c.id,
    name: c.name,
    movement: alignMovement(movement.byCompany.get(c.id) ?? [], months),
    buckets: alignBuckets(summary.byCompany.get(c.id) ?? new Map(), months),
    categories: monthly.byCompany.get(c.id) ?? [],
    split: alignSplit(split.get(c.id) ?? new Map(), months),
    lots: lotsByCompany.get(c.key) ?? [],
  }));

  return {
    generatedAt: new Date().toISOString(),
    months,
    asOf,
    slots: SLOTS.map((s) => ({ field: s.field, label: s.label })),
    companies,
    inventory,
    daily,
  };
}

/**
 * The headline waterfall: what 180+ opened at, what aged in, what was consumed,
 * what it closed at — for every month Odoo has snapshotted.
 */
async function fetchMovementDashboard(): Promise<{
  months: string[];
  byCompany: Map<number, MovementPoint[]>;
}> {
  const res = await callKw<{ months_asc?: string[]; data?: Record<string, any[]> }>(
    MOVEMENT_MODEL,
    'get_movement_dashboard',
    { kwargs: { context: ctx() } },
  );

  const byCompany = new Map<number, MovementPoint[]>();
  for (const [id, rows] of Object.entries(res?.data ?? {})) {
    byCompany.set(
      Number(id),
      (rows ?? []).map((r) => ({
        month: String(r.month),
        opening: num(r.opening),
        newAdd: num(r.new_add),
        currentStatus: num(r.current_status),
        issue: num(r.issue),
        closing: num(r.closing),
      })),
    );
  }
  return { months: res?.months_asc ?? [], byCompany };
}

/**
 * The full age profile per month — all seven buckets, not just 180+.
 *
 * Read straight off the stored summary rows rather than through
 * `retrive_ageing_by_item_cat_data`, which answers for one bucket and one
 * fiscal year per call and would need ~50 round trips to cover the same ground.
 */
async function fetchBucketHistory(): Promise<{
  months: string[];
  byCompany: Map<number, Map<string, BucketPoint>>;
}> {
  const fields = SLOTS.flatMap((s) => [s.field, `${s.field}_qty`]);
  const rows = await callKw<any[]>(SUMMARY_MODEL, 'search_read', {
    args: [[], ['company_id', 'month', ...fields]],
    kwargs: { context: ctx(), limit: 0 },
  });

  const months = new Set<string>();
  const byCompany = new Map<number, Map<string, BucketPoint>>();

  for (const row of rows) {
    const month = monthKey(row.month);
    if (!month) continue;
    months.add(month);
    // company_id is a selection of string ids on this model, not a many2one.
    const id = Number(Array.isArray(row.company_id) ? row.company_id[0] : row.company_id);
    if (!Number.isFinite(id)) continue;

    let perMonth = byCompany.get(id);
    if (!perMonth) byCompany.set(id, (perMonth = new Map()));

    let point = perMonth.get(month);
    if (!point) {
      point = { month, value: SLOTS.map(() => 0), qty: SLOTS.map(() => 0) };
      perMonth.set(month, point);
    }
    SLOTS.forEach((s, i) => {
      point!.value[i] += num(row[s.field]);
      point!.qty[i] += num(row[`${s.field}_qty`]);
    });
  }

  return { months: [...months].sort(), byCompany };
}

interface MonthFigures {
  opening: number;
  newAdd: number;
  issue: number;
  closing: number;
}

/**
 * The usable / unusable split of the band, for every month at once.
 *
 * `unusable` is a boolean on stock.lot, and Odoo accepts it as a dotted domain
 * on the ageing snapshot — so two grouped reads cover all thirty months rather
 * than one lot-level fetch per month.
 *
 * The flag is not historised: it says what the lot is considered today, applied
 * to whichever snapshot it appears in. A lot condemned last week therefore
 * reads as unusable in older months too. That is still the useful question —
 * how much of what was sitting there is value we now know is gone — but it is
 * not a record of what anyone believed at the time, and the page says so.
 */
async function fetchUsableSplit(): Promise<Map<number, Map<string, SplitPoint>>> {
  const aged = ['|', ['slot_5', '>', 0], ['slot_6', '>', 0]];
  const out = new Map<number, Map<string, SplitPoint>>();

  const read = (flag: boolean) =>
    callKw<any[]>(MOVEMENT_MODEL, 'read_group', {
      args: [[['lot_id.unusable', '=', flag], ...aged], ['slot_5', 'slot_6'], ['month', 'company_id']],
      kwargs: { context: ctx(), lazy: false },
    });

  try {
    const [unusable, usable] = await Promise.all([read(true), read(false)]);

    const absorb = (rows: any[], field: 'usable' | 'unusable') => {
      for (const row of rows) {
        const month = monthKey(row.month);
        const id = idOf(row.company_id);
        if (!month || id === null) continue;

        let byMonth = out.get(id);
        if (!byMonth) out.set(id, (byMonth = new Map()));
        const point = byMonth.get(month) ?? { month, usable: 0, unusable: 0 };
        point[field] += num(row.slot_5) + num(row.slot_6);
        byMonth.set(month, point);
      }
    };

    absorb(usable, 'usable');
    absorb(unusable, 'unusable');
  } catch {
    /* the rest of the report stands without the split */
  }

  return out;
}

/**
 * Per-item-category movement through the 180+ band.
 *
 * Odoo returns these values as formatted strings ("15,963.54"), so they are
 * parsed back to numbers here rather than at every call site.
 */
async function fetchCategoryHistory(): Promise<{
  months: string[];
  byCompany: Map<number, CategoryRow[]>;
}> {
  const rows = await callKw<any[]>(MONTHLY_MODEL, 'get_monthly_report', {
    args: [{}],
    kwargs: { context: ctx() },
  });

  const months = new Set<string>();
  // company -> category -> month -> the four figures
  const nest = new Map<number, Map<string, Map<string, MonthFigures>>>();

  for (const row of rows ?? []) {
    const month = monthKey(row.month);
    if (!month) continue;
    months.add(month);
    const id = Number(row.company);
    if (!Number.isFinite(id)) continue;
    const category = String(row.item_category || 'Uncategorised').trim();

    let byCat = nest.get(id);
    if (!byCat) nest.set(id, (byCat = new Map()));
    let byMonth = byCat.get(category);
    if (!byMonth) byCat.set(category, (byMonth = new Map()));

    // A category can appear more than once in a month when it spans
    // classifications, so accumulate rather than overwrite.
    const acc = byMonth.get(month) ?? { opening: 0, newAdd: 0, issue: 0, closing: 0 };
    acc.opening += money(row.opening_value);
    acc.newAdd += money(row.new_add_value);
    acc.issue += money(row.issue_value);
    acc.closing += money(row.closing_value);
    byMonth.set(month, acc);
  }

  const ordered = [...months].sort();
  const latest = ordered[ordered.length - 1];
  const byCompany = new Map<number, CategoryRow[]>();

  for (const [id, byCat] of nest) {
    const list: CategoryRow[] = [];
    for (const [category, byMonth] of byCat) {
      const now = latest ? byMonth.get(latest) : undefined;
      list.push({
        category,
        opening: now?.opening ?? 0,
        newAdd: now?.newAdd ?? 0,
        issue: now?.issue ?? 0,
        closing: now?.closing ?? 0,
        history: ordered.map((m) => byMonth.get(m)?.closing ?? null),
      });
    }
    // Biggest sitting value first — the order anyone reading this report wants
    // to work down.
    list.sort((a, b) => b.closing - a.closing);
    byCompany.set(id, list);
  }

  return { months: ordered, byCompany };
}

/**
 * Every lot currently sitting in 180+, with the usable flag joined on.
 *
 * The flag lives on stock.lot rather than on the ageing snapshot, so it takes a
 * second read — batched over the distinct lot ids, not one call per row.
 */
export async function fetchLots(month: string): Promise<{
  byCompany: Map<CompanyKey, LotRow[]>;
  /** "<productId>:<lotId>" -> unit price, for valuing daily issues. */
  priceOfLot: Map<string, number>;
}> {
  const out = new Map<CompanyKey, LotRow[]>(COMPANIES.map((c) => [c.key, [] as LotRow[]]));
  const priceOfLot = new Map<string, number>();
  if (!month) return { byCompany: out, priceOfLot };

  const rows = await callKw<any[]>(MOVEMENT_MODEL, 'search_read', {
    args: [
      [['month', '=', `${month}-01`], '|', ['slot_5', '>', 0], ['slot_6', '>', 0]],
      [
        'company_id',
        'lot_id',
        'product_id',
        'product_category',
        'product_uom',
        'receive_date',
        'duration',
        'cloing_qty',
        'slot_5',
        'slot_6',
        'rejected',
        'shipment_mode',
        'lot_price',
      ],
    ],
    kwargs: { context: ctx(), limit: 0 },
  });

  const lotIds = [...new Set(rows.map((r) => idOf(r.lot_id)).filter((v): v is number => v !== null))];
  const unusable = new Map<number, boolean>();
  if (lotIds.length) {
    const lots = await callKw<any[]>('stock.lot', 'read', {
      args: [lotIds, ['unusable']],
      kwargs: { context: ctx() },
    });
    for (const l of lots) unusable.set(l.id, !!l.unusable);
  }

  const byId = new Map<number, CompanyKey>(COMPANIES.map((c) => [c.id as number, c.key]));

  for (const row of rows) {
    const key = byId.get(idOf(row.company_id) ?? -1);
    if (!key) continue;
    const band181 = num(row.slot_5);
    const band365 = num(row.slot_6);
    const { code, name } = splitProduct(labelOf(row.product_id));
    priceOfLot.set(`${idOf(row.product_id)}:${idOf(row.lot_id)}`, num(row.lot_price));

    out.get(key)!.push({
      lot: labelOf(row.lot_id) || '—',
      product: name,
      code,
      category: labelOf(row.product_category) || '—',
      company: key,
      uom: labelOf(row.product_uom),
      receivedOn: row.receive_date ? String(row.receive_date).slice(0, 10) : null,
      duration: Math.round(num(row.duration)),
      qty: num(row.cloing_qty),
      band181,
      band365,
      value: band181 + band365,
      unusable: unusable.get(idOf(row.lot_id) ?? -1) ?? false,
      rejected: String(row.rejected || 'Ok'),
      shipment: row.shipment_mode ? String(row.shipment_mode) : '—',
      unitPrice: num(row.lot_price),
    });
  }

  for (const list of out.values()) list.sort((a, b) => b.value - a.value);
  return { byCompany: out, priceOfLot };
}

/**
 * Lot detail for one month, shaped for the wire.
 *
 * Kept out of the main payload: ~800 lots per month over thirty months is
 * megabytes, and only the month on screen is ever wanted. Cached per month
 * because a snapshot that is not the current one never changes again.
 */
const lotCache = new Map<string, { at: number; rows: Record<CompanyKey, LotRow[]> }>();

export async function getLotsForMonth(month: string): Promise<Record<CompanyKey, LotRow[]>> {
  const hit = lotCache.get(month);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;

  const { byCompany } = await fetchLots(month);
  const rows = Object.fromEntries(
    COMPANIES.map((c) => [c.key, byCompany.get(c.key) ?? []]),
  ) as Record<CompanyKey, LotRow[]>;

  lotCache.set(month, { at: Date.now(), rows });
  return rows;
}

/**
 * Issues out of the 180+ band, day by day through the current month.
 *
 * The monthly snapshot gives a month-to-date consumption total but no shape, so
 * this reads the done move lines behind it. Value is quantity times the lot's
 * own price — the same arithmetic the workbook's per-day sheet does, and the
 * reason the price map is carried out of `fetchLots` rather than re-read here.
 *
 * Best-effort: the rest of the report stands without it.
 */
async function fetchDailyConsumption(
  asOf: string,
  priceOfLot: Map<string, number>,
): Promise<DailyPoint[]> {
  if (!asOf || !priceOfLot.size) return [];

  const lotIds = [
    ...new Set([...priceOfLot.keys()].map((k) => Number(k.split(':')[1])).filter(Number.isFinite)),
  ];
  if (!lotIds.length) return [];

  try {
    const lines = await callKw<any[]>('stock.move.line', 'search_read', {
      args: [
        [
          ['state', '=', 'done'],
          ['lot_id', 'in', lotIds],
          ['date', '>=', `${asOf}-01 00:00:00`],
          // Consumption means it left stock for production, not an internal hop.
          ['location_dest_id.usage', 'in', ['production', 'customer', 'inventory']],
        ],
        ['date', 'lot_id', 'product_id', 'quantity', 'company_id'],
      ],
      kwargs: { context: ctx(), limit: 0, order: 'date asc' },
    });

    const byDate = new Map<string, DailyPoint>();
    for (const line of lines) {
      const date = String(line.date ?? '').slice(0, 10);
      if (!date) continue;
      const price = priceOfLot.get(`${idOf(line.product_id)}:${idOf(line.lot_id)}`) ?? 0;
      const value = num(line.quantity) * price;
      if (!value) continue;

      let point = byDate.get(date);
      if (!point) byDate.set(date, (point = { date, zipper: 0, mt: 0 }));
      if (idOf(line.company_id) === 1) point.zipper += value;
      else point.mt += value;
    }

    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

/**
 * Total inventory by month and fiscal year — the denominator that turns a 180+
 * figure into a share of everything on the floor.
 *
 * Best-effort: the dashboard is still complete without it.
 */
async function fetchInventoryMatrix(): Promise<InventoryMatrix | null> {
  try {
    const res = await callKw<{ matrix?: Record<string, Record<string, any>> }>(
      'consolidated.inventory.report',
      'retrieve_inventory_summary_data',
      { args: [0, 0, []], kwargs: { context: ctx() } },
    );
    const matrix = res?.matrix;
    if (!matrix) return null;

    const months = Object.keys(matrix);
    const years = [...new Set(months.flatMap((m) => Object.keys(matrix[m] ?? {})))].sort();
    const cell: InventoryMatrix['cell'] = {};
    for (const m of months) {
      cell[m] = {};
      for (const [y, v] of Object.entries(matrix[m] ?? {})) {
        cell[m][y] = { total: num(v?.total), rm: num(v?.rm) };
      }
    }
    return { months, years, cell };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- alignment

/** Pads a company's series out to the report's month list so charts line up. */
function alignMovement(points: MovementPoint[], months: string[]): MovementPoint[] {
  const by = new Map(points.map((p) => [p.month, p]));
  return months.map(
    (month) =>
      by.get(month) ?? { month, opening: 0, newAdd: 0, currentStatus: 0, issue: 0, closing: 0 },
  );
}

function alignBuckets(by: Map<string, BucketPoint>, months: string[]): BucketPoint[] {
  return months.map(
    (month) => by.get(month) ?? { month, value: SLOTS.map(() => 0), qty: SLOTS.map(() => 0) },
  );
}

function alignSplit(by: Map<string, SplitPoint>, months: string[]): SplitPoint[] {
  return months.map((month) => by.get(month) ?? { month, usable: 0, unusable: 0 });
}

// ------------------------------------------------------------------ scoping

/** Adds two companies' figures together for the "Both units" view. */
export function combineMovement(reports: CompanyReport[], months: string[]): MovementPoint[] {
  return months.map((month, i) => ({
    month,
    opening: sum(reports.map((r) => r.movement[i]?.opening ?? 0)),
    newAdd: sum(reports.map((r) => r.movement[i]?.newAdd ?? 0)),
    currentStatus: sum(reports.map((r) => r.movement[i]?.currentStatus ?? 0)),
    issue: sum(reports.map((r) => r.movement[i]?.issue ?? 0)),
    closing: sum(reports.map((r) => r.movement[i]?.closing ?? 0)),
  }));
}

export function combineBuckets(reports: CompanyReport[], months: string[]): BucketPoint[] {
  return months.map((month, i) => ({
    month,
    value: SLOTS.map((_, s) => sum(reports.map((r) => r.buckets[i]?.value[s] ?? 0))),
    qty: SLOTS.map((_, s) => sum(reports.map((r) => r.buckets[i]?.qty[s] ?? 0))),
  }));
}

/**
 * Merges category rows across companies.
 *
 * Zipper and Metal Trims name some categories identically ("SS", "Nylon"), so
 * merging by name is what makes the combined view add up to the combined total.
 */
export function combineCategories(reports: CompanyReport[], monthCount: number): CategoryRow[] {
  const by = new Map<string, CategoryRow>();
  for (const report of reports) {
    for (const row of report.categories) {
      const found = by.get(row.category);
      if (!found) {
        by.set(row.category, { ...row, history: [...row.history] });
        continue;
      }
      found.opening += row.opening;
      found.newAdd += row.newAdd;
      found.issue += row.issue;
      found.closing += row.closing;
      for (let i = 0; i < monthCount; i++) {
        const add = row.history[i];
        if (add === null || add === undefined) continue;
        found.history[i] = (found.history[i] ?? 0) + add;
      }
    }
  }
  return [...by.values()].sort((a, b) => b.closing - a.closing);
}

// ------------------------------------------------------------------ helpers

function ctx() {
  return { lang: 'en_US', tz: 'Asia/Dhaka', allowed_company_ids: COMPANIES.map((c) => c.id) };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** "15,963.54" -> 15963.54. Odoo formats these server-side. */
function money(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  return num(String(v ?? '').replace(/,/g, ''));
}

/** Odoo months arrive as '2026-08-01' or 'August 2026' depending on the call. */
function monthKey(v: unknown): string | null {
  const raw = String(v ?? '').trim();
  if (!raw) return null;
  const iso = /^(\d{4})-(\d{2})/.exec(raw);
  if (iso) return `${iso[1]}-${iso[2]}`;
  const parsed = new Date(`${raw} 1`);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}`;
}

const idOf = (v: unknown): number | null => (Array.isArray(v) ? Number(v[0]) : null);
const labelOf = (v: unknown): string => (Array.isArray(v) ? String(v[1] ?? '') : '');

/** Product display names are "[CODE] Name"; the code is worth its own column. */
function splitProduct(display: string): { code: string; name: string } {
  const m = /^\[([^\]]+)\]\s*(.*)$/.exec(display);
  return m ? { code: m[1], name: m[2] || m[1] } : { code: '', name: display || '—' };
}

export function monthLabel(month: string): string {
  const [y, m] = month.split('-');
  const date = new Date(Number(y), Number(m) - 1, 1);
  if (Number.isNaN(date.getTime())) return month;
  return date.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}
