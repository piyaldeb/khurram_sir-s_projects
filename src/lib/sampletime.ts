/**
 * Lead time — how long a sample or a bulk order takes from its date to done.
 *
 * Odoo's PPC wizard already produces this as a spreadsheet ("SA Based SAMPLE
 * BTM DATA Detail"), and the lead time in it is an Excel formula rather than a
 * value, so nothing downstream can read it without evaluating the workbook.
 * This runs the same report, applies the same formula, and joins on what the
 * spreadsheet cannot reach.
 *
 * The formula, from the report's own J column:
 *
 *   completion blank -> today - SA date - (holidays in between)
 *   otherwise        -> completion  - SA date - (holidays in between)
 *
 * Holidays come from the report's own second sheet, so the arithmetic stays
 * whatever Odoo says it is rather than a calendar of our own.
 *
 * A lead time can come out negative, which reads as nonsense until you know
 * why: the order was revised and its date moved *after* the work had already
 * been finished. The revision that did it is in the sales module, so every
 * such row is joined to `sale.order`'s revision fields and to the
 * `sales.revision` chain — which also carries the original date, and so the
 * lead time the order actually ran to.
 *
 * Two things differ between the two datasets, and neither is ours to reconcile:
 *
 *   - Sample lead time deducts holidays; Odoo's bulk report does not, and ships
 *     a plain calendar-day figure with no holiday sheet beside it. Each is
 *     shown on its own basis and the page says which.
 *   - The wizard reports on ONE company at a time — passing both ids returns
 *     the first, not the union — so a combined view is two builds merged here.
 */
import { callButton, callKw, fetchBinary, getSession, buildContext } from './odoo';
import { loadWorkbook } from './xlsx';

const PPC_MODEL = 'ppc.report';

/** One row per sample line, with its completion date and a holiday sheet. */
const SAMPLE_REPORT = 'sbtm_detail';
/** One row per bulk order line; Odoo computes its lead time itself. */
const BULK_REPORT = 'bbtm';
/** Maps a sample to the OA numbers it turned into. */
const HISTORY_REPORT = 'samplehistory';

export type Dataset = 'sample' | 'bulk';
export type CompanyKey = 'zipper' | 'mt';

export const COMPANIES: { key: CompanyKey; id: number; name: string }[] = [
  { key: 'zipper', id: 1, name: 'Zipper' },
  { key: 'mt', id: 3, name: 'Metal Trims' },
];

export const DATASETS: { key: Dataset; label: string; noun: string }[] = [
  { key: 'sample', label: 'Sample', noun: 'SA' },
  { key: 'bulk', label: 'Bulk', noun: 'OA' },
];

// -------------------------------------------------------------- fiscal years

/** A fiscal year runs 1 April to 31 March; FY 2025 is "FY 25-26". */
export function fyWindow(fy: number): { from: string; to: string } {
  return { from: `${fy}-04-01`, to: `${fy + 1}-03-31` };
}

export function fyLabel(fy: number): string {
  return `FY ${String(fy).slice(2)}-${String(fy + 1).slice(2)}`;
}

export function fyOf(iso: string): number {
  const [y, m] = iso.split('-').map(Number);
  return m >= 4 ? y : y - 1;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The fiscal years this page offers. */
export function availableFys(): number[] {
  const current = fyOf(todayIso());
  return [...new Set([2025, 2026, current])].sort((a, b) => a - b);
}

// ------------------------------------------------------------------- shapes

export interface LeadRow {
  kind: Dataset;
  company: CompanyKey;
  /** SA or OA number as the report prints it, e.g. "42035". */
  no: string;
  /** The sale.order name it resolves to, e.g. "SA042035". */
  order: string | null;
  /** SA date for a sample, OA date for a bulk order. */
  date: string;
  buyer: string;
  customer: string;
  productType: string;
  shade: string;
  /** Bulk only. */
  style: string;
  buyingHouse: string;
  qty: number;
  readyQty: number | null;
  balanceQty: number | null;
  completedOn: string | null;
  status: string;
  remarks: string;
  /** Holidays inside the window, already deducted. Bulk never deducts any. */
  holidays: number;
  /** Days from date to completion, on this dataset's own basis. */
  lead: number;
  /** Still open: the lead time is counted against today and keeps growing. */
  pending: boolean;
  /** OA numbers a sample turned into. */
  oas: string[];
  revision: RevisionInfo | null;
  /**
   * Lead time measured from the date the order was actually worked to.
   *
   * Only set where a revision moved the date; that is the whole reason a
   * negative lead time exists, and it is the figure that makes sense of it.
   */
  trueLead: number | null;
}

export interface RevisionInfo {
  /** The sale.order this resolved to, e.g. "SA042035". */
  order: string;
  revised: boolean;
  /** "R1", "R2", … */
  number: string | null;
  cause: string | null;
  lastRevisedAt: string | null;
  /** Every revision on the order, oldest first. */
  chain: {
    number: string | null;
    /** The order date before this revision — the sample's original SA date. */
    from: string | null;
    /** When the revision was made. */
    at: string | null;
    qtyFrom: number;
    qtyTo: number;
  }[];
}

export interface Bucket {
  label: string;
  count: number;
}

export interface SampleAggregates {
  rows: number;
  pending: number;
  negative: number;
  /** Mean lead time over rows that are not negative. */
  meanLead: number;
  medianLead: number;
  /** Share completed within seven days. */
  withinWeek: number;
  distribution: Bucket[];
  statusMix: Bucket[];
  /** Mean lead time per SA month, oldest first. */
  byMonth: { month: string; count: number; meanLead: number; negative: number; pending: number }[];
  topBuyers: Ranked[];
  topCustomers: Ranked[];
  /** One row per business unit, so a combined view still splits out. */
  byCompany: Ranked[];
}

export interface Ranked {
  name: string;
  count: number;
  meanLead: number;
  negative: number;
  pending: number;
}

export interface LeadFyData {
  fy: number;
  label: string;
  dataset: Dataset;
  from: string;
  to: string;
  builtAt: string;
  holidays: string[];
  rows: LeadRow[];
}

// -------------------------------------------------------------------- cache

/**
 * A fiscal year is one ~20s Odoo report build over ~22,000 rows, and the closed
 * part of it never changes. Holding the parsed year keeps the page instant
 * after the first visit; the year in progress ages out so today's samples
 * appear.
 */
const CLOSED_TTL_MS = 12 * 60 * 60 * 1000;
const OPEN_TTL_MS = Number(process.env.SAMPLE_CACHE_MS || 15 * 60 * 1000);

const cache = new Map<string, { at: number; data: LeadFyData }>();
const inFlight = new Map<string, Promise<LeadFyData>>();

const cacheKey = (fy: number, dataset: Dataset, company: CompanyKey) =>
  `${fy}|${dataset}|${company}`;

export function invalidateLeadTimes() {
  cache.clear();
}

/** One company's slice of one dataset for one year. */
async function getSlice(
  fy: number,
  dataset: Dataset,
  company: CompanyKey,
  force = false,
): Promise<LeadFyData> {
  const key = cacheKey(fy, dataset, company);
  const ttl = fy === fyOf(todayIso()) ? OPEN_TTL_MS : CLOSED_TTL_MS;

  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < ttl) return hit.data;

  const running = inFlight.get(key);
  if (!force && running) return running;

  const job = buildSlice(fy, dataset, company)
    .then((data) => {
      cache.set(key, { at: Date.now(), data });
      return data;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, job);
  return job;
}

/**
 * A year of one dataset across the companies asked for.
 *
 * The two companies are independent Odoo builds, so asking for both costs the
 * wall-clock of the slower one rather than the sum.
 */
export async function getLeadFy(
  fy: number,
  dataset: Dataset,
  companies: CompanyKey[],
  force = false,
): Promise<LeadFyData> {
  const slices = await Promise.all(companies.map((c) => getSlice(fy, dataset, c, force)));
  const first = slices[0];

  return {
    fy,
    label: fyLabel(fy),
    dataset,
    from: first?.from ?? fyWindow(fy).from,
    to: first?.to ?? fyWindow(fy).to,
    builtAt: slices.map((s) => s.builtAt).sort().at(-1) ?? new Date().toISOString(),
    holidays: [...new Set(slices.flatMap((s) => s.holidays))].sort(),
    rows: slices.flatMap((s) => s.rows),
  };
}

// -------------------------------------------------------------------- build

async function buildSlice(
  fy: number,
  dataset: Dataset,
  company: CompanyKey,
): Promise<LeadFyData> {
  const { from, to } = fyWindow(fy);
  // Never ask for a window that has not happened; the report walks it day by
  // day and an empty tail is paid for in build time.
  const end = to > todayIso() ? todayIso() : to;
  const id = COMPANIES.find((c) => c.key === company)!.id;

  if (dataset === 'bulk') {
    const buffer = await runPpcReport(BULK_REPORT, from, end, id);
    const rows = await parseBulk(buffer, company);
    await joinRevisions(rows, 'OA');
    return { fy, label: fyLabel(fy), dataset, from, to: end, builtAt: new Date().toISOString(), holidays: [], rows };
  }

  const [detail, history] = await Promise.all([
    runPpcReport(SAMPLE_REPORT, from, end, id),
    runPpcReport(HISTORY_REPORT, from, end, id).catch(() => null),
  ]);

  const { rows, holidays } = await parseSample(detail, company);
  const oaBySample = history ? await parseHistory(history) : new Map<string, string[]>();
  for (const row of rows) row.oas = oaBySample.get(normaliseNo(row.no)) ?? [];

  await joinRevisions(rows, 'SA', holidays);

  return {
    fy,
    label: fyLabel(fy),
    dataset,
    from,
    to: end,
    builtAt: new Date().toISOString(),
    holidays: holidays.map((h) => new Date(h).toISOString().slice(0, 10)),
    rows,
  };
}

/** Hangs the sales-module revision onto each row, and the corrected lead time. */
async function joinRevisions(rows: LeadRow[], prefix: 'SA' | 'OA', holidays: number[] = []) {
  const revisions = await fetchRevisions(rows.map((r) => r.no), prefix);
  for (const row of rows) {
    row.revision = revisions.get(normaliseNo(row.no)) ?? null;
    row.order = row.revision?.order ?? null;
    row.trueLead = trueLeadOf(row, holidays);
  }
}

/** Drives the PPC wizard the way the Odoo web client does, and takes the file. */
async function runPpcReport(
  type: string,
  from: string,
  to: string,
  companyId: number,
): Promise<ArrayBuffer> {
  const session = await getSession();
  // The wizard reports on the active company only, so the id is passed alone
  // rather than as one of a pair — see the note at the top of this file.
  const context = buildContext(session, { allowed_company_ids: [companyId] }, companyId);

  const saved = await callKw<any[]>(PPC_MODEL, 'web_save', {
    args: [
      [],
      {
        report_type: type,
        date_from: from,
        date_to: to,
        order_filter: 'all',
        all_buyer_list: [],
        all_Customer: [],
      },
    ],
    kwargs: {
      context,
      specification: { report_type: {}, date_from: {}, date_to: {}, order_filter: {} },
    },
  });

  const wizardId = saved?.[0]?.id;
  if (!wizardId) throw new Error('Odoo did not create the PPC report wizard.');

  const action = await callButton<any>(PPC_MODEL, 'action_generate_xlsx_report', [wizardId], context);
  if (!action || action.type !== 'ir.actions.report') {
    const hint = action?.params?.message || action?.type || 'the filters matched no data';
    throw new Error(`Odoo returned no report for "${type}" — ${hint}.`);
  }

  const query = new URLSearchParams();
  if (action.data) query.set('options', JSON.stringify(action.data));
  query.set(
    'context',
    JSON.stringify({
      ...context,
      ...(action.context ?? {}),
      active_model: PPC_MODEL,
      active_id: wizardId,
      active_ids: [wizardId],
    }),
  );

  const { buffer } = await fetchBinary(
    `/report/${action.report_type}/${action.report_name}?${query.toString()}`,
  );
  return buffer;
}

const DAY_MS = 86_400_000;

/**
 * The detail sheet, plus the holiday calendar it deducts.
 *
 * Column order is fixed by the report:
 * SL | SA Date | SA Number | Buyer | Customer | Product type | Shade | Qty |
 * SA final completion date | Lead time | Status | Remarks
 */
async function parseSample(
  buffer: ArrayBuffer,
  company: CompanyKey,
): Promise<{ rows: LeadRow[]; holidays: number[] }> {
  const wb = await loadWorkbook(buffer);
  const sheet = wb.worksheets[0];
  const holidaySheet = wb.getWorksheet('Holiday');

  const holidays: number[] = [];
  if (holidaySheet) {
    for (let r = 2; r <= holidaySheet.rowCount; r++) {
      const at = asDate(holidaySheet.getRow(r).getCell(1).value);
      if (at) holidays.push(at);
    }
  }

  // The open rows are aged against today, exactly as the sheet's TODAY() does.
  const today = Date.parse(`${todayIso()}T00:00:00Z`);
  const rows: LeadRow[] = [];

  for (let r = 2; r <= sheet.rowCount; r++) {
    const cell = (i: number) => sheet.getRow(r).getCell(i).value;
    const date = asDate(cell(2));
    if (date === null) continue;

    const completed = asDate(cell(9));
    const end = completed ?? today;
    const holidayCount = holidays.filter((h) => h >= date && h <= end).length;

    rows.push({
      kind: 'sample',
      company,
      no: String(cell(3) ?? '').trim(),
      order: null,
      date: iso(date),
      buyer: text(cell(4)),
      customer: text(cell(5)),
      productType: text(cell(6)),
      shade: text(cell(7)),
      style: '',
      buyingHouse: '',
      qty: Number(cell(8)) || 0,
      readyQty: null,
      balanceQty: null,
      completedOn: completed === null ? null : iso(completed),
      status: text(cell(11)) || 'Unknown',
      remarks: text(cell(12)),
      holidays: holidayCount,
      lead: Math.round((end - date) / DAY_MS) - holidayCount,
      pending: completed === null,
      oas: [],
      revision: null,
      trueLead: null,
    });
  }

  return { rows, holidays };
}

/**
 * The bulk sheet.
 *
 * OA Date | OA Number | Buyer | Style | Customer | Product type | No. of shade |
 * Order qty | Ready qty | Balance qty | OA final completion | Lead time |
 * Status | Buying house
 *
 * Odoo computes this lead time itself and does NOT deduct holidays — there is
 * no holiday sheet in this workbook. Its own figure is kept, so the page shows
 * what the report shows; the open rows have none, and are aged against today
 * the way the sample report does it.
 */
async function parseBulk(buffer: ArrayBuffer, company: CompanyKey): Promise<LeadRow[]> {
  const wb = await loadWorkbook(buffer);
  const sheet = wb.worksheets[0];
  const today = Date.parse(`${todayIso()}T00:00:00Z`);
  const rows: LeadRow[] = [];

  for (let r = 2; r <= sheet.rowCount; r++) {
    const cell = (i: number) => sheet.getRow(r).getCell(i).value;
    const date = asDate(cell(1));
    if (date === null) continue;

    const completed = asDate(cell(11));
    const reported = Number(text(cell(12)));
    const lead = Number.isFinite(reported)
      ? reported
      : Math.round(((completed ?? today) - date) / DAY_MS);

    rows.push({
      kind: 'bulk',
      company,
      no: String(cell(2) ?? '').trim(),
      order: null,
      date: iso(date),
      buyer: text(cell(3)),
      customer: text(cell(5)),
      productType: text(cell(6)),
      shade: text(cell(7)),
      style: text(cell(4)),
      buyingHouse: text(cell(14)),
      qty: Number(cell(8)) || 0,
      readyQty: Number(cell(9)) || 0,
      balanceQty: Number(cell(10)) || 0,
      completedOn: completed === null ? null : iso(completed),
      status: text(cell(13)) || 'Unknown',
      remarks: '',
      holidays: 0,
      lead,
      pending: completed === null,
      oas: [],
      revision: null,
      trueLead: null,
    });
  }
  return rows;
}

/** Sample History: SAMPLE NO | SAMPLE DATE | CUSTOMER | BUYER | SHADE | OA NUMBERS | OA QTY */
async function parseHistory(buffer: ArrayBuffer): Promise<Map<string, string[]>> {
  const wb = await loadWorkbook(buffer);
  const sheet = wb.worksheets[0];
  const out = new Map<string, string[]>();

  for (let r = 2; r <= sheet.rowCount; r++) {
    const sample = normaliseNo(text(sheet.getRow(r).getCell(1).value));
    if (!sample) continue;
    const oas = text(sheet.getRow(r).getCell(6).value)
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!oas.length) continue;

    const held = out.get(sample) ?? [];
    for (const oa of oas) if (!held.includes(oa)) held.push(oa);
    out.set(sample, held);
  }
  return out;
}

/**
 * The revision behind each sample, from the sales module.
 *
 * Sample orders are named `SA` plus the number, zero-padded to six in recent
 * years and unpadded in older ones, so both spellings are asked for. Matching
 * on the digits alone would fold in OA orders that happen to share a number.
 */
async function fetchRevisions(
  numbers: string[],
  prefix: 'SA' | 'OA',
): Promise<Map<string, RevisionInfo>> {
  const digits = [...new Set(numbers.map(normaliseNo).filter(Boolean))];
  const out = new Map<string, RevisionInfo>();
  if (!digits.length) return out;

  const names = digits.flatMap((n) => [`${prefix}${n.padStart(6, '0')}`, `${prefix}${n}`]);

  // Only revised orders matter here, and asking for them keeps a year's worth
  // of samples from coming back when a few hundred are the point.
  const orders: any[] = [];
  const CHUNK = 4000;
  for (let i = 0; i < names.length; i += CHUNK) {
    const slice = names.slice(i, i + CHUNK);
    orders.push(
      ...(await callKw<any[]>('sale.order', 'search_read', {
        args: [
          [
            ['name', 'in', slice],
            '|',
            ['is_revised', '=', true],
            ['cause_of_revision', '!=', false],
          ],
          ['name', 'is_revised', 'revised_num', 'cause_of_revision', 'last_revised_date', 'revision_ids'],
        ],
        kwargs: { context: ctx(), limit: 0 },
      })),
    );
  }
  if (!orders.length) return out;

  const chainIds = [...new Set(orders.flatMap((o) => o.revision_ids ?? []))] as number[];
  const chains = new Map<number, any[]>();
  if (chainIds.length) {
    const revs = await callKw<any[]>('sales.revision', 'read', {
      args: [
        chainIds,
        ['sale_order_id', 'revised_num', 'last_date_order', 'revise_date', 'last_qty', 'current_qty'],
      ],
      kwargs: { context: ctx() },
    });
    for (const rev of revs) {
      const orderId = Array.isArray(rev.sale_order_id) ? rev.sale_order_id[0] : null;
      if (orderId === null) continue;
      const held = chains.get(orderId) ?? [];
      held.push(rev);
      chains.set(orderId, held);
    }
  }

  for (const order of orders) {
    const key = normaliseNo(order.name);
    if (!key) continue;
    const mine = (chains.get(order.id) ?? []).sort((a, b) =>
      String(a.revise_date ?? '').localeCompare(String(b.revise_date ?? '')),
    );

    out.set(key, {
      order: String(order.name),
      revised: !!order.is_revised,
      number: label(order.revised_num),
      cause: cleanCause(order.cause_of_revision),
      lastRevisedAt: order.last_revised_date ? String(order.last_revised_date) : null,
      chain: mine.map((rev) => ({
        number: label(rev.revised_num),
        from: rev.last_date_order ? String(rev.last_date_order).slice(0, 10) : null,
        at: rev.revise_date ? String(rev.revise_date).slice(0, 10) : null,
        qtyFrom: Number(rev.last_qty) || 0,
        qtyTo: Number(rev.current_qty) || 0,
      })),
    });
  }

  return out;
}

/**
 * The lead time measured from the date the sample was actually worked to.
 *
 * A revision that moves the SA date forward past the completion date is what
 * turns a lead time negative. The first revision's `last_date_order` is the
 * date the order carried before any of that, so measuring from it gives the
 * run the sample really had.
 */
function trueLeadOf(row: LeadRow, holidays: number[]): number | null {
  const original = row.revision?.chain[0]?.from;
  if (!original || !row.completedOn) return null;

  const start = Date.parse(`${original}T00:00:00Z`);
  const end = Date.parse(`${row.completedOn}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  // Only worth showing when it actually differs from what the report printed.
  if (original === row.date) return null;

  const count = holidays.filter((h) => h >= start && h <= end).length;
  return Math.round((end - start) / DAY_MS) - count;
}

// --------------------------------------------------------------- aggregates

export function aggregate(rows: LeadRow[]): SampleAggregates {
  const leads = rows.map((r) => r.lead);
  const sane = leads.filter((v) => v >= 0);

  const bucketOf = (v: number) =>
    v < 0 ? 'Negative' : v <= 3 ? '0–3 days' : v <= 7 ? '4–7 days' : v <= 14 ? '8–14 days' : v <= 30 ? '15–30 days' : 'Over 30 days';
  const order = ['Negative', '0–3 days', '4–7 days', '8–14 days', '15–30 days', 'Over 30 days'];

  const dist = new Map<string, number>();
  for (const v of leads) dist.set(bucketOf(v), (dist.get(bucketOf(v)) ?? 0) + 1);

  const status = new Map<string, number>();
  for (const r of rows) status.set(r.status, (status.get(r.status) ?? 0) + 1);

  const months = new Map<string, LeadRow[]>();
  for (const r of rows) {
    const key = r.date.slice(0, 7);
    (months.get(key) ?? months.set(key, []).get(key)!).push(r);
  }

  return {
    rows: rows.length,
    pending: rows.filter((r) => r.pending).length,
    negative: rows.filter((r) => r.lead < 0).length,
    meanLead: mean(sane),
    medianLead: median(sane),
    withinWeek: rows.length ? sane.filter((v) => v <= 7).length / rows.length : 0,
    distribution: order.filter((l) => dist.has(l)).map((label) => ({ label, count: dist.get(label)! })),
    statusMix: [...status].sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count })),
    byMonth: [...months]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, list]) => ({
        month,
        count: list.length,
        meanLead: mean(list.filter((r) => r.lead >= 0).map((r) => r.lead)),
        negative: list.filter((r) => r.lead < 0).length,
        pending: list.filter((r) => r.pending).length,
      })),
    topBuyers: rank(rows, (r) => r.buyer),
    topCustomers: rank(rows, (r) => r.customer),
    byCompany: rank(rows, (r) => COMPANIES.find((c) => c.key === r.company)?.name ?? r.company),
  };
}

function rank(rows: LeadRow[], key: (r: LeadRow) => string) {
  const by = new Map<string, LeadRow[]>();
  for (const r of rows) {
    const k = key(r) || '—';
    (by.get(k) ?? by.set(k, []).get(k)!).push(r);
  }
  return [...by]
    .map(([name, list]) => ({
      name,
      count: list.length,
      meanLead: mean(list.filter((r) => r.lead >= 0).map((r) => r.lead)),
      negative: list.filter((r) => r.lead < 0).length,
      pending: list.filter((r) => r.pending).length,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ------------------------------------------------------------------ helpers

function ctx() {
  return { lang: 'en_US', tz: 'Asia/Dhaka', allowed_company_ids: [1, 3] };
}

/** Strips the prefix and any leading zeroes so SA042035 and 42035 are one key. */
export function normaliseNo(value: string): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.replace(/^0+/, '');
}

const text = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const o = v as any;
    return String(o.result ?? o.text ?? '').trim();
  }
  return String(v).trim();
};

/** Odoo writes these as ISO strings, sometimes quoted, sometimes as Dates. */
function asDate(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Date.parse(`${value.toISOString().slice(0, 10)}T00:00:00Z`);
  const raw = String(value).replace(/"/g, '').trim();
  if (!raw) return null;
  const at = Date.parse(raw.length > 10 ? raw : `${raw}T00:00:00Z`);
  if (Number.isNaN(at)) return null;
  return Date.parse(`${new Date(at).toISOString().slice(0, 10)}T00:00:00Z`);
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const label = (v: unknown): string | null => (Array.isArray(v) ? String(v[1] ?? '') || null : null);

/** Odoo stores the cause as free text; blank-ish values should read as absent. */
function cleanCause(v: unknown): string | null {
  const s = String(v ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s && s !== 'false' ? s : null;
}
