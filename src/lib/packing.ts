/**
 * Line-level packing production, aggregated for analytics.
 *
 * Source: the one-sheet Packing Production Report (`dppr_`), which carries one
 * row per packed line with Buyer, Customer, Item, Product, Qty and Price.
 * Value = QTY x Price, and it ties out: July 2026 zipper sums to $1,556,399
 * against $1,556,406 invoiced — a $7 difference on 13,626 lines.
 *
 * A month is ~13k lines and takes Odoo several seconds to build, so a fiscal
 * year is fetched month-by-month and each month's AGGREGATE is cached on disk:
 * a closed month never changes, so it is fetched exactly once; the current
 * month refreshes after a TTL. Raw lines are never stored.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { getSession, productionCompanies, type OdooCompany } from './odoo';
import { generateReport } from './reports';
import { parseWorkbook, type SheetCell } from './xlsx';

const CACHE_DIR = resolve(process.env.DATA_DIR || 'data', 'analytics');
const FRESH_MINUTES = Number(process.env.ODOO_SYNC_FRESH_MINUTES || 15);

export interface DimEntry {
  value: number;
  lines: number;
}

export interface MonthPacking {
  month: string;
  companyId: number;
  companyName: string;
  totals: { value: number; lines: number };
  byItem: Record<string, DimEntry>;
  byBuyer: Record<string, DimEntry>;
  byCustomer: Record<string, DimEntry>;
  fetchedAt: string;
  error?: string;
}

const norm = (v: unknown) => String(v ?? '').trim();

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function cachePath(month: string, companyId: number): string {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`bad month "${month}"`);
  return join(CACHE_DIR, `packing-${month}-c${companyId}.json`);
}

async function readCache(month: string, companyId: number): Promise<MonthPacking | null> {
  try {
    return JSON.parse(await readFile(cachePath(month, companyId), 'utf8')) as MonthPacking;
  } catch {
    return null;
  }
}

async function writeCache(entry: MonthPacking): Promise<void> {
  const path = cachePath(entry.month, entry.companyId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(entry), 'utf8');
}

function isFresh(entry: MonthPacking): boolean {
  // A failed fetch is retried on the same schedule as the current month.
  if (entry.error) {
    return Date.now() - new Date(entry.fetchedAt).getTime() < FRESH_MINUTES * 60_000;
  }
  if (entry.month < currentMonth()) return true;
  return Date.now() - new Date(entry.fetchedAt).getTime() < FRESH_MINUTES * 60_000;
}

function lastDayOf(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

async function fetchMonth(month: string, company: OdooCompany): Promise<MonthPacking> {
  const entry: MonthPacking = {
    month,
    companyId: company.id,
    companyName: company.name,
    totals: { value: 0, lines: 0 },
    byItem: {},
    byBuyer: {},
    byCustomer: {},
    fetchedAt: new Date().toISOString(),
  };

  try {
    const artifact = await generateReport({
      report_type: 'dppr_',
      date_from: `${month}-01`,
      date_to: lastDayOf(month),
      company_id: company.id,
    });
    const workbook = await parseWorkbook(artifact.buffer, artifact.filename);
    const sheet = workbook.sheets[0];
    if (!sheet) return entry;

    const headerIndex = sheet.headerRow >= 0 ? sheet.headerRow : 0;
    const headers = (sheet.rows[headerIndex] ?? []).map((c) => norm(c?.v).toUpperCase());
    const col = (name: string) => headers.findIndex((h) => h === name);
    const qtyCol = col('QTY');
    const priceCol = col('PRICE');
    const itemCol = col('ITEM');
    const buyerCol = col('BUYER');
    const customerCol = col('CUSTOMER');

    const bump = (map: Record<string, DimEntry>, key: string, value: number) => {
      const name = key || '(unspecified)';
      const slot = (map[name] ??= { value: 0, lines: 0 });
      slot.value += value;
      slot.lines += 1;
    };

    const cellNum = (row: (SheetCell | null)[], c: number) =>
      c >= 0 && typeof row[c]?.v === 'number' ? (row[c]!.v as number) : null;

    for (let r = headerIndex + 1; r < sheet.rows.length; r++) {
      const row = sheet.rows[r] ?? [];
      if (norm(row[0]?.v).toUpperCase() === 'TOTAL') continue;
      const qty = cellNum(row, qtyCol);
      const price = cellNum(row, priceCol);
      if (qty === null || price === null) continue;
      const value = qty * price;

      entry.totals.value += value;
      entry.totals.lines += 1;
      bump(entry.byItem, norm(row[itemCol]?.v), value);
      bump(entry.byBuyer, norm(row[buyerCol]?.v), value);
      bump(entry.byCustomer, norm(row[customerCol]?.v), value);
    }
  } catch (err) {
    const message = (err as Error).message;
    // "No Data" is an empty month, not a failure.
    if (!/no data/i.test(message)) entry.error = message;
  }

  await writeCache(entry);
  return entry;
}

/**
 * A month's aggregate for one company, from cache when it is still valid.
 * Concurrent identical requests share one fetch.
 */
const inFlight = new Map<string, Promise<MonthPacking>>();

export async function monthPacking(month: string, company: OdooCompany): Promise<MonthPacking> {
  const cached = await readCache(month, company.id);
  if (cached && isFresh(cached)) return cached;

  const key = `${month}:${company.id}`;
  const running = inFlight.get(key);
  if (running) return running;

  const promise = fetchMonth(month, company).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

/** All months of a range for every production company; two fetches in flight at a time. */
export async function rangePacking(months: string[]): Promise<MonthPacking[]> {
  const session = await getSession();
  const companies = productionCompanies(session);

  const jobs = months.flatMap((month) => companies.map((company) => ({ month, company })));
  const results: MonthPacking[] = [];

  // Odoo builds these reports slowly; two at a time is polite and halves the wait.
  const CONCURRENCY = 2;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        results.push(await monthPacking(job.month, job.company));
      }
    }),
  );

  return results;
}
