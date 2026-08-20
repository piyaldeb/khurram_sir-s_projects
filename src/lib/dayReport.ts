/**
 * The daily MRP Invoice report (`dpr`), per company.
 *
 * This is the sheet the factory actually reads: one row per product with
 * packing, pending, cumulative production and invoicing, today's released
 * figures and the pending OA count — plus "Total Order Close" for the day.
 *
 * Two things worth knowing about this report:
 *
 *   - It does NOT combine companies. Asking for `allowed_company_ids: [1, 3]`
 *     returns the Zipper sheet only, so it is run once per company.
 *   - Its workbook has overlapping merge ranges that ExcelJS rejects outright;
 *     `parseWorkbook` repairs those before reading (see xlsx.ts).
 *
 * Verified against the sheet on 20-Aug-2026: Zipper totals 52,501 packing pcs /
 * $5,986 / 2,401,111 pending pcs / $340,069 pending / 238 pending OA.
 */
import { getSession, OdooError, productionCompanies } from './odoo';
import { generateReport } from './reports';
import { parseWorkbook, type Sheet, type SheetCell } from './xlsx';

export const INVOICE_REPORT = 'dpr';

/** Columns of the product block, in the order the sheet presents them. */
export interface InvoiceRow {
  product: string;
  packingQty: number;
  packingValue: number;
  pendingQty: number;
  pendingValue: number;
  cumProduction: number;
  cumInvoicing: number;
  todayReleasedQty: number;
  todayReleasedValue: number;
  cumReleasedQty: number;
  cumReleasedValue: number;
  pendingOa: number;
}

export interface CompanyInvoiceDay {
  id: number;
  name: string;
  /** Unit the quantity columns are in — PCS for zipper, GRS for trims. */
  unit: string;
  rows: InvoiceRow[];
  totals: InvoiceRow;
  /** The sheet's own "Total Order Close" figure for the day. */
  ordersClosed: number;
  error?: string;
}

export interface DayReport {
  date: string;
  reportType: string;
  companies: CompanyInvoiceDay[];
  generatedAt: string;
}

const norm = (v: unknown) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
const num = (cell: SheetCell | null | undefined) => (typeof cell?.v === 'number' ? cell.v : 0);

export function yesterdayIso(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

const emptyRow = (product: string): InvoiceRow => ({
  product,
  packingQty: 0,
  packingValue: 0,
  pendingQty: 0,
  pendingValue: 0,
  cumProduction: 0,
  cumInvoicing: 0,
  todayReleasedQty: 0,
  todayReleasedValue: 0,
  cumReleasedQty: 0,
  cumReleasedValue: 0,
  pendingOa: 0,
});

/** Columns that hold money, so the page can mark them with a currency symbol. */
export const MONEY_FIELDS: (keyof InvoiceRow)[] = [
  'packingValue',
  'pendingValue',
  'cumInvoicing',
  'todayReleasedValue',
  'cumReleasedValue',
];

/**
 * Maps the header row onto field names.
 *
 * Matched by wording rather than position, because the quantity columns are
 * labelled PCS for zipper and GRS for metal trims, and "COMULATIVE" is the
 * sheet's own spelling.
 */
function mapColumns(header: (SheetCell | null)[]) {
  const columns: Partial<Record<keyof InvoiceRow, number>> = {};
  let unit = 'PCS';

  header.forEach((cell, i) => {
    const name = norm(cell?.v);
    if (!name) return;
    const isValue = /VALUE|USD|\$/.test(name);

    if (name === 'PRODUCT') columns.product = i;
    else if (/^PACKING/.test(name)) {
      if (isValue) columns.packingValue = i;
      else {
        columns.packingQty = i;
        const m = /PACKING (\w+)/.exec(name);
        if (m) unit = m[1];
      }
    } else if (/^PENDING OA/.test(name)) columns.pendingOa = i;
    else if (/^PENDING/.test(name)) {
      if (isValue) columns.pendingValue = i;
      else columns.pendingQty = i;
    } else if (/PRODUCTION/.test(name)) columns.cumProduction = i;
    else if (/INVOIC/.test(name)) columns.cumInvoicing = i;
    else if (/TODAY RELEASED/.test(name)) {
      if (isValue) columns.todayReleasedValue = i;
      else columns.todayReleasedQty = i;
    } else if (/RELEASED/.test(name)) {
      if (isValue) columns.cumReleasedValue = i;
      else columns.cumReleasedQty = i;
    }
  });

  return { columns, unit };
}

function parseSheet(sheet: Sheet): Omit<CompanyInvoiceDay, 'id' | 'name'> {
  // The header is split over two rows by vertical merges: PRODUCT and the
  // quantity column sit on the "PRODUCT" row, the value columns on the row
  // above it (DATE : …). Combine them, preferring the PRODUCT row's cell.
  const found = sheet.rows.findIndex((row) => norm(row?.[0]?.v) === 'PRODUCT');
  const headerIndex = found >= 0 ? found : 1;
  const productRow = sheet.rows[headerIndex] ?? [];
  const bannerRow = headerIndex > 0 ? sheet.rows[headerIndex - 1] ?? [] : [];
  const width = Math.max(productRow.length, bannerRow.length);
  const header: (SheetCell | null)[] = Array.from({ length: width }, (_, i) => {
    const fromProduct = productRow[i];
    return fromProduct?.v !== null && fromProduct?.v !== undefined ? fromProduct : (bannerRow[i] ?? null);
  });
  const { columns, unit } = mapColumns(header);

  const rows: InvoiceRow[] = [];
  const totals = emptyRow('TOTAL');
  let ordersClosed = 0;

  const read = (row: (SheetCell | null)[], key: keyof InvoiceRow) => {
    const c = columns[key];
    return c === undefined ? 0 : num(row[c]);
  };

  for (let r = headerIndex + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r] ?? [];
    const label = norm(row[0]?.v);
    if (!label) continue;

    if (/ORDER CLOSE/.test(label)) {
      // The count sits in the next filled cell along.
      const cell = row.slice(1).find((c) => typeof c?.v === 'number');
      ordersClosed = typeof cell?.v === 'number' ? cell.v : 0;
      continue;
    }

    if (label === 'TOTAL') {
      for (const key of Object.keys(totals) as (keyof InvoiceRow)[]) {
        if (key === 'product') continue;
        (totals[key] as number) = read(row, key);
      }
      break; // a parts sub-table follows; the product block ends here
    }

    const entry = emptyRow(String(row[0]?.v ?? '').trim());
    let any = false;
    for (const key of Object.keys(entry) as (keyof InvoiceRow)[]) {
      if (key === 'product') continue;
      const v = read(row, key);
      (entry[key] as number) = v;
      if (v) any = true;
    }
    if (any) rows.push(entry);
  }

  // Fall back to adding the rows up if the sheet's own TOTAL was unreadable.
  if (!totals.pendingValue && rows.length) {
    for (const entry of rows) {
      for (const key of Object.keys(totals) as (keyof InvoiceRow)[]) {
        if (key === 'product') continue;
        (totals[key] as number) += entry[key] as number;
      }
    }
  }

  return { unit, rows, totals, ordersClosed };
}

export async function fetchDayReport(date: string): Promise<DayReport> {
  const session = await getSession();
  const companies: CompanyInvoiceDay[] = [];

  for (const company of productionCompanies(session)) {
    try {
      const artifact = await generateReport({
        report_type: INVOICE_REPORT,
        date_from: date,
        date_to: date,
        company_id: company.id,
      });
      const workbook = await parseWorkbook(artifact.buffer, artifact.filename);
      const sheet = workbook.sheets[0];
      if (!sheet) throw new OdooError('the report came back with no sheets');

      companies.push({ id: company.id, name: company.name, ...parseSheet(sheet) });
    } catch (err) {
      companies.push({
        id: company.id,
        name: company.name,
        unit: 'PCS',
        rows: [],
        totals: emptyRow('TOTAL'),
        ordersClosed: 0,
        error: (err as Error).message,
      });
    }
  }

  if (companies.every((c) => c.error)) {
    throw new OdooError(
      `No company returned an invoice report for ${date}. ${companies
        .map((c) => `${c.name}: ${c.error}`)
        .join(' · ')}`,
    );
  }

  return {
    date,
    reportType: INVOICE_REPORT,
    companies,
    generatedAt: new Date().toISOString(),
  };
}
