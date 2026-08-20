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
import { cacheGetMany, cacheSet, supabaseConfig } from './supabase';

const CACHE_DIR = resolve(process.env.DATA_DIR || 'data', 'analytics');
const FRESH_MINUTES = Number(process.env.ODOO_SYNC_FRESH_MINUTES || 15);

/**
 * How many months one request may fetch from Odoo.
 *
 * Each month is a report Odoo takes several seconds to build, and a serverless
 * function has a hard ceiling — so a cold year is filled over several requests
 * instead of one long one. The page polls until nothing is pending.
 */
export const FETCH_BUDGET = Number(process.env.ANALYTICS_FETCH_PER_REQUEST || 4);

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

const cacheKey = (month: string, companyId: number) => {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`bad month "${month}"`);
  return `packing-${month}-c${companyId}`;
};

function cachePath(key: string): string {
  return join(CACHE_DIR, `${key}.json`);
}

/**
 * Cache reads and writes go to Supabase when it is configured, and to disk
 * otherwise. Serverless has no writable filesystem, so on Vercel the Supabase
 * path is the only one that works.
 */
async function readCacheMany(keys: string[]): Promise<Map<string, MonthPacking>> {
  if (supabaseConfig.enabled) {
    try {
      return await cacheGetMany<MonthPacking>(keys);
    } catch (err) {
      // A missing or unreachable cache makes this slower, not broken.
      warnCacheOnce((err as Error).message);
      return new Map();
    }
  }

  const out = new Map<string, MonthPacking>();
  for (const key of keys) {
    try {
      out.set(key, JSON.parse(await readFile(cachePath(key), 'utf8')) as MonthPacking);
    } catch {
      /* not cached */
    }
  }
  return out;
}

let cacheWarned = false;
function warnCacheOnce(message: string) {
  if (cacheWarned) return;
  cacheWarned = true;
  console.warn(`[packing] cache unavailable, falling back to refetching: ${message}`);
}

async function writeCache(entry: MonthPacking): Promise<void> {
  const key = cacheKey(entry.month, entry.companyId);
  if (supabaseConfig.enabled) {
    try {
      await cacheSet(key, entry);
    } catch (err) {
      warnCacheOnce((err as Error).message);
    }
    return;
  }
  const path = cachePath(key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(entry), 'utf8');
}

function isFresh(entry: MonthPacking): boolean {
  // A failed fetch is retried on the same schedule as the current month.
  if (entry.error) {
    return Date.now() - new Date(entry.fetchedAt).getTime() < FRESH_MINUTES * 60_000;
  }
  // A closed month never changes; a future month has nothing to change into.
  if (entry.month < currentMonth()) return true;
  if (entry.month > currentMonth()) return true;
  // Only the month in progress ages out.
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

  // A month that has not started cannot have produced anything; asking Odoo
  // for it costs a full report build and always comes back empty.
  if (month > currentMonth()) {
    await writeCache(entry);
    return entry;
  }

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
 * Monthly aggregates for a range, filling at most `budget` missing months from
 * Odoo. Anything still missing comes back in `pending` so the caller can ask
 * again — that keeps every request inside a serverless timeout.
 */
export interface RangeResult {
  months: MonthPacking[];
  pending: { month: string; company: string }[];
  fetched: number;
}

export async function rangePacking(
  months: string[],
  budget = FETCH_BUDGET,
): Promise<RangeResult> {
  const session = await getSession();
  const companies = productionCompanies(session);

  const jobs = months.flatMap((month) => companies.map((company) => ({ month, company })));
  const cached = await readCacheMany(jobs.map((j) => cacheKey(j.month, j.company.id)));

  const have: MonthPacking[] = [];
  const missing: typeof jobs = [];

  for (const job of jobs) {
    const entry = cached.get(cacheKey(job.month, job.company.id));
    if (entry && isFresh(entry)) have.push(entry);
    else missing.push(job);
  }

  // Newest first: the recent months are the ones people look at.
  missing.sort((a, b) => b.month.localeCompare(a.month));

  const toFetch = missing.slice(0, Math.max(budget, 0));
  const pending = missing.slice(toFetch.length);

  // Two at a time: Odoo builds these slowly and parallelism past this just
  // trades one queue for another.
  const CONCURRENCY = 2;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, toFetch.length) }, async () => {
      while (next < toFetch.length) {
        const job = toFetch[next++];
        have.push(await fetchMonth(job.month, job.company));
      }
    }),
  );

  return {
    months: have,
    pending: pending.map((j) => ({ month: j.month, company: j.company.name })),
    fetched: toFetch.length,
  };
}
