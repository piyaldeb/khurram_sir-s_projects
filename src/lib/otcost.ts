/**
 * Overtime cost, read live from Odoo's attendance OT analysis.
 *
 * Source: the `attendance.pdf.report` wizard's `ot_analysis` report. Its
 * *SectionWise OT* sheet carries two rows per section — OT Hours and OT Cost —
 * with one column per day, which is exactly the grain the OT Cost sheet works
 * in.
 *
 * Three reports make up one plant:
 *   - Zipper           company 1
 *   - C-Zipper Worker  employee category 42, seen from companies 4 and 1
 *   - Metal Trims      company 3
 * The first two are the same business unit and are added together; that is what
 * the `ZIP_OT_DATA` tab of the Daily OT monitoring workbook holds.
 *
 * Odoo reports cost in BDT. What is cached here stays in BDT; `otanalysis.ts`
 * converts to USD at the rate `fxrate.ts` looks up, so a change of rate never
 * costs a refetch.
 *
 * An **OT month** is not a calendar month: `YYYY-MM` runs from the 26th of the
 * previous calendar month to the 25th of this one, matching the payroll cycle
 * the OT Cost sheets are cut on.
 *
 * Verified against `OT Cost (1).xlsx`, sheet `26-Jul to 25-Aug-2026`: this file
 * reproduces Zipper manufacturing $17,754.99, Zipper other $1,349.19, Metal
 * Trims manufacturing $2,517.87 and Metal Trims other $131.40 to the cent, and
 * matches day by day.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type ExcelJS from 'exceljs';
import { buildContext, callButton, callKw, fetchBinary, getSession, OdooError } from './odoo';
import { loadWorkbook } from './xlsx';
import { cacheGetMany, cacheSet, supabaseConfig } from './supabase';
import { env } from './env';
import sectionData from '../data/ot-sections.json';

export const OT_MODEL = 'attendance.pdf.report';
const SHEET = 'SectionWise OT';

const CACHE_DIR = resolve(process.env.DATA_DIR || 'data', 'otcost');
const FRESH_MINUTES = Number(process.env.ODOO_SYNC_FRESH_MINUTES || 15);

/**
 * How many (month, report) pairs one request may fetch from Odoo.
 *
 * Each report takes Odoo ~8s to build and a serverless function has a hard
 * ceiling, so a cold year fills over several requests while the page polls.
 * A month costs three reports, so the default covers two whole months.
 */
export const OT_FETCH_BUDGET = Number(process.env.OT_FETCH_PER_REQUEST || 6);

/** Earliest OT month offered. Odoo answers with real data from Apr 2023. */
export const EARLIEST_MONTH = env('OT_EARLIEST_MONTH', '2023-04');

export type BuKey = 'zipper' | 'mt';
export type JobKey = 'zipper' | 'c_zipper' | 'mt';
export type Tag = 'M-VA' | 'M-NVA' | 'NM-NVA';
export type Bucket = 'manufacturing' | 'other';

interface Job {
  key: JobKey;
  bu: BuKey;
  label: string;
  modeType: 'company' | 'category';
  companyId: number | false;
  categoryId: number | false;
  allowedCompanyIds: number[];
}

/** Mirrors the three wizard runs the OT monitoring sheet is built from. */
export const JOBS: Job[] = [
  {
    key: 'zipper',
    bu: 'zipper',
    label: 'Zipper',
    modeType: 'company',
    companyId: 1,
    categoryId: false,
    allowedCompanyIds: [1],
  },
  {
    key: 'c_zipper',
    bu: 'zipper',
    label: 'C-Zipper Worker',
    modeType: 'category',
    companyId: false,
    categoryId: 42,
    allowedCompanyIds: [4, 1],
  },
  {
    key: 'mt',
    bu: 'mt',
    label: 'Metal Trims',
    modeType: 'company',
    companyId: 3,
    categoryId: false,
    allowedCompanyIds: [3],
  },
];

export const BU_LABEL: Record<BuKey, string> = { zipper: 'Zipper', mt: 'Metal Trims' };

/* ------------------------------------------------------- section classing */

interface SectionDef {
  tag: Tag;
  department: string;
}

const SECTIONS = sectionData.sections as Record<BuKey, Record<string, SectionDef>>;

/**
 * Sections the roll-up moves out of Manufacturing.
 *
 * They are tagged M-NVA on the monitoring sheets, but the OT Cost sheet takes
 * them off Manufacturing and adds them to Other Departments — see the SUMIFS on
 * rows 110/111 (Zipper) and 89/90 (Metal Trims). Stores, effluent treatment and
 * MIS serve the plant rather than run it.
 */
const RECLASSIFIED = new Set<string>(sectionData.reclassifiedToOther);

/** Odoo pads some section names with non-breaking spaces. */
export function normaliseSection(name: unknown): string {
  return String(name ?? '')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sectionDef(bu: BuKey, section: string): SectionDef | null {
  return SECTIONS[bu]?.[normaliseSection(section)] ?? null;
}

/**
 * Manufacturing or Other Departments.
 *
 * Unknown sections count as Manufacturing — every section Odoo has returned
 * since April 2023 is in the map, so this only catches something genuinely new,
 * and a new section is far more likely to be a production one. `OtMonth.unmapped`
 * names anything that lands here so it never passes unnoticed.
 */
export function bucketOf(bu: BuKey, section: string): Bucket {
  const name = normaliseSection(section);
  if (RECLASSIFIED.has(name)) return 'other';
  return sectionDef(bu, name)?.tag === 'NM-NVA' ? 'other' : 'manufacturing';
}

/* ------------------------------------------------------------- OT months */

const MONTH_RE = /^\d{4}-\d{2}$/;

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The 26th-to-25th window an OT month covers. */
export function otPeriod(month: string): { from: string; to: string } {
  if (!MONTH_RE.test(month)) throw new Error(`Refusing to build OT month "${month}".`);
  return { from: `${shiftMonth(month, -1)}-26`, to: `${month}-25` };
}

/** The OT month a date falls in: the 26th starts the next one. */
export function otMonthOf(iso: string): string {
  const month = iso.slice(0, 7);
  return Number(iso.slice(8, 10)) >= 26 ? shiftMonth(month, 1) : month;
}

export function todayIso(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: env('ODOO_TZ', 'Asia/Dhaka') });
}

/** OT months of a fiscal year, April to March. */
export function fyOtMonths(fy: number): string[] {
  return Array.from({ length: 12 }, (_, i) => shiftMonth(`${fy}-04`, i));
}

export function fyOfMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return m >= 4 ? y : y - 1;
}

export function fyLabel(fy: number): string {
  return `FY ${String(fy).slice(2)}-${String(fy + 1).slice(2)}`;
}

/** Fiscal years with at least one OT month between EARLIEST_MONTH and today. */
export function availableFiscalYears(): number[] {
  const first = fyOfMonth(EARLIEST_MONTH);
  const last = fyOfMonth(otMonthOf(todayIso()));
  const out: number[] = [];
  for (let fy = last; fy >= first; fy--) out.push(fy);
  return out;
}

/** Every OT month Odoo can answer for, newest first. */
export function availableOtMonths(): string[] {
  const out: string[] = [];
  for (let m = otMonthOf(todayIso()); m >= EARLIEST_MONTH; m = shiftMonth(m, -1)) out.push(m);
  return out;
}

export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', {
    month: 'short',
    timeZone: 'UTC',
  })}-${String(y).slice(2)}`;
}

/* ------------------------------------------------------ the Odoo wizard */

/** Field specification the wizard's form view sends on every call. */
const SPEC = {
  report_type: {},
  date_from: {},
  date_to: {},
  is_company: {},
  atten_type: {},
  types: {},
  mode_type: {},
  employee_id: { fields: { display_name: {} } },
  mode_company_id: { fields: { display_name: {} } },
  category_id: { fields: { display_name: {} } },
  department_id: { fields: { display_name: {} } },
  company_all: {},
} as const;

/**
 * Runs the wizard the way the Odoo web client does: save a transient record,
 * press the button, download what the returned action describes.
 */
async function generateOtReport(job: Job, from: string, to: string): Promise<ArrayBuffer> {
  const session = await getSession();
  // The category run has to see two companies at once, which buildContext's
  // single-company shortcut cannot express — so pass the list explicitly.
  const context = buildContext(session, {
    allowed_company_ids: job.allowedCompanyIds,
    default_is_company: false,
  });

  const values = {
    report_type: 'ot_analysis',
    date_from: from,
    date_to: to,
    is_company: false,
    atten_type: false,
    types: false,
    mode_type: job.modeType,
    employee_id: false,
    mode_company_id: job.companyId,
    category_id: job.categoryId,
    department_id: false,
    company_all: 'allcompany',
  };

  const saved = await callKw<any[]>(OT_MODEL, 'web_save', {
    args: [[], values],
    kwargs: { context, specification: SPEC },
  });
  const wizardId: number | undefined = saved?.[0]?.id;
  if (!wizardId) throw new OdooError('Odoo did not create the OT report wizard record.');

  const action = await callButton<any>(
    OT_MODEL,
    'action_generate_xlsx_report',
    [wizardId],
    context,
  );
  if (!action || action.type !== 'ir.actions.report') {
    const hint = action?.params?.message || action?.type || 'the button returned nothing';
    throw new OdooError(`Odoo did not return an OT report for ${job.label} — ${hint}.`);
  }

  const query = new URLSearchParams();
  if (action.data) query.set('options', JSON.stringify(action.data));
  query.set(
    'context',
    JSON.stringify({
      ...context,
      ...(action.context ?? {}),
      active_model: OT_MODEL,
      active_id: wizardId,
      active_ids: [wizardId],
    }),
  );

  const file = await fetchBinary(`/report/xlsx/${action.report_name}?${query.toString()}`);
  return file.buffer;
}

/* ---------------------------------------------------------------- parsing */

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Date column headers come back year-less, as `26 Jul Sun`.
 *
 * The year is whichever end of the requested window the month belongs to, which
 * resolves a window that straddles New Year — every OT month straddles two
 * calendar months, and the January one straddles two years.
 */
export function headerDate(header: unknown, from: string, to: string): string | null {
  if (header instanceof Date) return header.toISOString().slice(0, 10);
  const m = /^\s*(\d{1,2})\s+([A-Za-z]{3})/.exec(String(header ?? ''));
  if (!m) return null;
  const month = MONTH_NAMES.indexOf(m[2][0].toUpperCase() + m[2].slice(1, 3).toLowerCase()) + 1;
  if (!month) return null;
  const fromYear = Number(from.slice(0, 4));
  const toYear = Number(to.slice(0, 4));
  const year = fromYear === toYear || month >= Number(from.slice(5, 7)) ? fromYear : toYear;
  return `${year}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/** Per-section daily hours and BDT cost, aligned to `dates`. */
export interface SectionSeries {
  hours: number[];
  cost: number[];
}

export interface OtJobMonth {
  month: string;
  job: JobKey;
  from: string;
  to: string;
  dates: string[];
  sections: Record<string, SectionSeries>;
  fetchedAt: string;
  error?: string;
}

const numberAt = (row: ExcelJS.Row, col: number): number => {
  const v = row.getCell(col).value;
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && 'result' in (v as any)) {
    const r = (v as any).result;
    return typeof r === 'number' ? r : 0;
  }
  return 0;
};

const textAt = (row: ExcelJS.Row, col: number): string => {
  const v = row.getCell(col).value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && 'richText' in (v as any)) {
    return normaliseSection((v as any).richText.map((r: any) => r.text).join(''));
  }
  return normaliseSection(v);
};

/**
 * Reads the *SectionWise OT* sheet.
 *
 * Layout: row 4 is the header — Section, (metric), Total, then one column per
 * day. Rows come in pairs, OT Hours then OT Cost, with the section name written
 * only on the first of the pair. The `Total` column is a formula Odoo leaves
 * uncached, so it is ignored and the days are summed instead.
 */
export async function parseOtBuffer(
  buffer: ArrayBuffer,
  from: string,
  to: string,
): Promise<{ dates: string[]; sections: Record<string, SectionSeries> }> {
  // Odoo writes two merges over the same header on these reports; loadWorkbook
  // is the repair the report console already relies on.
  const wb = await loadWorkbook(buffer);

  const ws = wb.getWorksheet(SHEET);
  if (!ws) {
    throw new OdooError(
      `The OT report has no "${SHEET}" sheet (found: ${wb.worksheets.map((w) => w.name).join(', ')}).`,
    );
  }

  const header = ws.getRow(4);
  const cols: { col: number; date: string }[] = [];
  for (let c = 4; c <= ws.columnCount; c++) {
    const date = headerDate(header.getCell(c).value, from, to);
    if (date) cols.push({ col: c, date });
  }

  const dates = cols.map((c) => c.date);
  const sections: Record<string, SectionSeries> = {};

  let section = '';
  for (let r = 5; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const name = textAt(row, 1);
    if (name) section = name;
    const metric = textAt(row, 2);
    if (!section || !metric || section === 'Total') continue;

    const slot = (sections[section] ??= {
      hours: new Array(dates.length).fill(0),
      cost: new Array(dates.length).fill(0),
    });
    const target = metric === 'OT Hours' ? slot.hours : metric === 'OT Cost' ? slot.cost : null;
    if (!target) continue;
    // A section can appear more than once when Odoo splits it by department.
    cols.forEach((c, i) => {
      target[i] += numberAt(row, c.col);
    });
  }

  return { dates, sections };
}

/* ------------------------------------------------------------------ cache */

const cacheKey = (month: string, job: JobKey) => {
  if (!MONTH_RE.test(month)) throw new Error(`bad OT month "${month}"`);
  return `otcost-${month}-${job}`;
};

let cacheWarned = false;
function warnCacheOnce(message: string) {
  if (cacheWarned) return;
  cacheWarned = true;
  console.warn(`[otcost] cache unavailable, falling back to refetching: ${message}`);
}

async function readCacheMany(keys: string[]): Promise<Map<string, OtJobMonth>> {
  if (supabaseConfig.enabled) {
    try {
      return await cacheGetMany<OtJobMonth>(keys);
    } catch (err) {
      warnCacheOnce((err as Error).message);
      return new Map();
    }
  }
  const out = new Map<string, OtJobMonth>();
  for (const key of keys) {
    try {
      out.set(key, JSON.parse(await readFile(join(CACHE_DIR, `${key}.json`), 'utf8')));
    } catch {
      /* not cached */
    }
  }
  return out;
}

async function writeCache(entry: OtJobMonth): Promise<void> {
  const key = cacheKey(entry.month, entry.job);
  if (supabaseConfig.enabled) {
    try {
      await cacheSet(key, entry);
    } catch (err) {
      warnCacheOnce((err as Error).message);
    }
    return;
  }
  const path = join(CACHE_DIR, `${key}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(entry), 'utf8');
}

/**
 * A closed OT month never changes, so it is fetched exactly once. The month in
 * progress ages out on the sync TTL; a failed fetch retries on the same clock.
 */
function isFresh(entry: OtJobMonth): boolean {
  if (entry.error) {
    return Date.now() - new Date(entry.fetchedAt).getTime() < FRESH_MINUTES * 60_000;
  }
  const today = todayIso();
  if (entry.to < today) return true;
  if (entry.from > today) return true;
  return Date.now() - new Date(entry.fetchedAt).getTime() < FRESH_MINUTES * 60_000;
}

async function fetchJobMonth(month: string, job: Job): Promise<OtJobMonth> {
  const { from, to } = otPeriod(month);
  const entry: OtJobMonth = {
    month,
    job: job.key,
    from,
    to,
    dates: [],
    sections: {},
    fetchedAt: new Date().toISOString(),
  };

  // A window that has not opened yet cannot hold overtime, and asking costs a
  // full report build.
  if (from > todayIso()) {
    await writeCache(entry);
    return entry;
  }

  try {
    const buffer = await generateOtReport(job, from, to);
    const parsed = await parseOtBuffer(buffer, from, to);
    entry.dates = parsed.dates;
    entry.sections = parsed.sections;
  } catch (err) {
    const message = (err as Error).message;
    if (!/no data/i.test(message)) entry.error = message;
  }

  await writeCache(entry);
  return entry;
}

export interface JobMonthRange {
  entries: OtJobMonth[];
  pending: { month: string; job: JobKey }[];
  fetched: number;
}

/**
 * The raw job-months for a range, filling at most `budget` missing ones from
 * Odoo. Anything still missing comes back in `pending` so the caller can ask
 * again, which is what keeps each request inside a serverless timeout.
 */
export async function rangeJobMonths(
  months: string[],
  budget = OT_FETCH_BUDGET,
): Promise<JobMonthRange> {
  const jobs = months.flatMap((month) => JOBS.map((job) => ({ month, job })));
  const cached = await readCacheMany(jobs.map((j) => cacheKey(j.month, j.job.key)));

  const have: OtJobMonth[] = [];
  const missing: typeof jobs = [];
  for (const j of jobs) {
    const entry = cached.get(cacheKey(j.month, j.job.key));
    if (entry && isFresh(entry)) have.push(entry);
    else missing.push(j);
  }

  // Newest first: the recent months are the ones people open the page for.
  missing.sort((a, b) => b.month.localeCompare(a.month));

  const toFetch = missing.slice(0, Math.max(budget, 0));
  const pending = missing.slice(toFetch.length);

  // Two at a time — Odoo builds these serially anyway, and more parallelism
  // just trades one queue for another.
  const CONCURRENCY = 2;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, toFetch.length) }, async () => {
      while (next < toFetch.length) {
        const j = toFetch[next++];
        have.push(await fetchJobMonth(j.month, j.job));
      }
    }),
  );

  return {
    entries: have,
    pending: pending.map((j) => ({ month: j.month, job: j.job.key })),
    fetched: toFetch.length,
  };
}
