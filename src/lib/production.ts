/**
 * Daily Zipper / Metal Trims production, read from Odoo.
 *
 * The workbook pulled these figures out of a Google Sheet. The equivalent in
 * Odoo is the **Invoice Summary** report: its USD rows, split by category —
 * the six Metal Trims categories on one side, every other category on the
 * other. Zipper and Metal Trims are invoiced by different companies, so the
 * report is run once per allowed company and the results are added.
 *
 * Checked against `Aug-26- Automation`: every working day matches the sheet to
 * within rounding (e.g. 17-Aug 70,167 sheet vs 70,162 Odoo).
 */
import { OdooError, getSession, productionCompanies } from './odoo';
import { generateReport } from './reports';
import { parseWorkbook, type Sheet, type SheetCell } from './xlsx';
import { DEFAULT_SOURCE, MT_AMBIGUOUS, type BudgetSource } from './budget';

export interface DailyProduction {
  date: string;
  zipper: number;
  mt: number;
}

export interface FetchResult {
  days: DailyProduction[];
  /** Per-company diagnostics, so a silent zero is explainable. */
  companies: { id: number; name: string; rows: number; zipper: number; mt: number; error?: string }[];
  columns: { zipper: string[]; mt: string[]; ignored: string[] };
  unit: string | null;
  reportType: string;
  fetchedAt: string;
}

const norm = (s: unknown) => String(s ?? '').trim().toUpperCase();

/** Odoo writes "01-Aug-2026"; the ISO form also turns up. */
export function parseReportDate(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || typeof value === 'number') return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /^(\d{1,2})[-/ ]([A-Za-z]{3,})[-/ ](\d{4})$/.exec(s);
  if (m) {
    const month = new Date(`${m[2]} 1, 2000`).getMonth();
    if (Number.isNaN(month)) return null;
    return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

interface SplitSheet {
  headers: string[];
  dateColumn: number;
  unitColumn: number | null;
  zipperColumns: number[];
  mtColumns: number[];
  ignored: string[];
}

/** Works out which column is which from the header row and the source mapping. */
function planSheet(sheet: Sheet, source: BudgetSource): SplitSheet {
  const headerRow = sheet.headerRow >= 0 ? sheet.headerRow : 0;
  const headers = (sheet.rows[headerRow] ?? []).map((c: SheetCell | null, i: number) =>
    c?.v !== null && c?.v !== undefined ? String(c.v) : `Column ${i + 1}`,
  );
  const body = sheet.rows.slice(headerRow + 1);

  const mt = new Set(source.mtColumns.map(norm));
  const ignore = new Set(source.ignoreColumns.map(norm));

  // The date column is the first whose cells parse as dates.
  let dateColumn = 0;
  for (let c = 0; c < headers.length; c++) {
    if (body.some((row) => parseReportDate(row[c]?.v))) {
      dateColumn = c;
      break;
    }
  }

  // The unit column carries the PCS / USD marker rather than a number.
  let unitColumn: number | null = null;
  if (source.unit) {
    const wanted = norm(source.unit);
    for (let c = 0; c < headers.length; c++) {
      if (body.some((row) => norm(row[c]?.v) === wanted)) {
        unitColumn = c;
        break;
      }
    }
  }

  const zipperColumns: number[] = [];
  const mtColumns: number[] = [];
  const ignored: string[] = [];

  const dataColumns: number[] = [];
  for (let c = 0; c < headers.length; c++) {
    if (c === dateColumn || c === unitColumn) continue;
    if (ignore.has(norm(headers[c]))) {
      ignored.push(headers[c]);
      continue;
    }
    dataColumns.push(c);
  }

  // Odoo scopes this report to one company, and each company sells one side of
  // the business: the zipper company's sheet has no trims categories at all,
  // and ends with its own catch-all "Others" column. So a generic name only
  // reads as Metal Trims when a named trims category is on the sheet with it.
  const ambiguous = new Set(MT_AMBIGUOUS.map(norm));
  const hasNamedMt = dataColumns.some((c) => {
    const name = norm(headers[c]);
    return mt.has(name) && !ambiguous.has(name);
  });

  const claimed = new Set<string>();
  for (const c of dataColumns) {
    const name = norm(headers[c]);
    const isMt = mt.has(name) && (hasNamedMt || !ambiguous.has(name)) && !claimed.has(name);
    if (isMt) {
      claimed.add(name);
      mtColumns.push(c);
      continue;
    }
    // A zipper column has to actually hold numbers; a named Metal Trims column
    // counts even when this company invoiced none of it.
    if (body.some((row) => typeof row[c]?.v === 'number')) zipperColumns.push(c);
  }

  return { headers, dateColumn, unitColumn, zipperColumns, mtColumns, ignored };
}

function aggregate(sheet: Sheet, source: BudgetSource) {
  const plan = planSheet(sheet, source);
  const headerRow = sheet.headerRow >= 0 ? sheet.headerRow : 0;
  const body = sheet.rows.slice(headerRow + 1);
  const wanted = source.unit ? norm(source.unit) : null;

  const totals = new Map<string, { zipper: number; mt: number }>();
  let rows = 0;
  let carriedDate: string | null = null;

  for (const row of body) {
    // The date is merged across the PCS/USD pair, so it only appears once.
    const parsed = parseReportDate(row[plan.dateColumn]?.v);
    if (parsed) carriedDate = parsed;
    if (!carriedDate) continue;

    if (wanted && plan.unitColumn !== null && norm(row[plan.unitColumn]?.v) !== wanted) continue;

    const sum = (cols: number[]) =>
      cols.reduce((acc, c) => {
        const v = row[c]?.v;
        return acc + (typeof v === 'number' ? v : 0);
      }, 0);

    const entry = totals.get(carriedDate) ?? { zipper: 0, mt: 0 };
    entry.zipper += sum(plan.zipperColumns);
    entry.mt += sum(plan.mtColumns);
    totals.set(carriedDate, entry);
    rows++;
  }

  return { totals, rows, plan };
}

/**
 * Runs the report for every allowed company and adds the results together.
 *
 * `skipCompanies` lets a multi-month run stop retrying a company that has no
 * MRP data - Head Office and the like answer HTTP 500 for every month, and
 * rebuilding that report twelve times is pure waiting.
 */
export async function fetchMonthProduction(
  month: string,
  source: BudgetSource = DEFAULT_SOURCE,
  skipCompanies?: Set<number>,
): Promise<FetchResult> {
  const [y, m] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const dateFrom = `${month}-01`;
  const dateTo = `${month}-${String(lastDay).padStart(2, '0')}`;

  const session = await getSession();
  const combined = new Map<string, { zipper: number; mt: number }>();
  const diagnostics: FetchResult['companies'] = [];
  const columns = { zipper: [] as string[], mt: [] as string[], ignored: [] as string[] };
  let anySucceeded = false;

  for (const company of productionCompanies(session)) {
    if (skipCompanies?.has(company.id)) continue;
    try {
      const artifact = await generateReport({
        report_type: source.reportType,
        date_from: dateFrom,
        date_to: dateTo,
        company_id: company.id,
      });
      const workbook = await parseWorkbook(artifact.buffer, artifact.filename);
      const sheet = workbook.sheets[0];
      if (!sheet) throw new OdooError('the report came back with no sheets');

      const { totals, rows, plan } = aggregate(sheet, source);
      let zipper = 0;
      let mt = 0;
      for (const [date, value] of totals) {
        zipper += value.zipper;
        mt += value.mt;
        const entry = combined.get(date) ?? { zipper: 0, mt: 0 };
        entry.zipper += value.zipper;
        entry.mt += value.mt;
        combined.set(date, entry);
      }

      for (const c of plan.zipperColumns) {
        if (!columns.zipper.includes(plan.headers[c])) columns.zipper.push(plan.headers[c]);
      }
      for (const c of plan.mtColumns) {
        if (!columns.mt.includes(plan.headers[c])) columns.mt.push(plan.headers[c]);
      }
      for (const name of plan.ignored) {
        if (!columns.ignored.includes(name)) columns.ignored.push(name);
      }

      diagnostics.push({ id: company.id, name: company.name, rows, zipper, mt });
      anySucceeded = true;
    } catch (err) {
      diagnostics.push({
        id: company.id,
        name: company.name,
        rows: 0,
        zipper: 0,
        mt: 0,
        error: (err as Error).message,
      });
    }
  }

  if (!anySucceeded) {
    const reasons = diagnostics.map((d) => `${d.name}: ${d.error}`).join(' · ');
    throw new OdooError(`Odoo returned no production for ${month}. ${reasons}`);
  }

  const days = [...combined.entries()]
    .map(([date, v]) => ({ date, zipper: Math.round(v.zipper), mt: Math.round(v.mt) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    days,
    companies: diagnostics,
    columns,
    unit: source.unit,
    reportType: source.reportType,
    fetchedAt: new Date().toISOString(),
  };
}
