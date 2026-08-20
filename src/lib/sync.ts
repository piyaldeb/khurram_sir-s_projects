/**
 * Keeping the stored months in step with Odoo.
 *
 * Opening the site triggers a sync, but re-fetching a year of reports on every
 * page load would be both slow and pointless: a month that has closed does not
 * change. So a month is only re-fetched when it is actually stale —
 *
 *   - never synced                    -> stale
 *   - the current month               -> stale once the last sync ages out
 *   - a past month synced before it   -> stale (the sync caught a part-month)
 *     had safely closed
 *   - anything else                   -> fresh, skipped
 *
 * In practice the first visit fills the whole year and later visits refresh
 * just the current month.
 */
import { backfill, type BackfillResult } from './backfill';
import { fyOf, fyMonths, plannedMonths, type BudgetDoc } from './budget';
import { getBudgets } from './storage';

/** How long the current month's figures are treated as fresh. */
const FRESH_MINUTES = Number(process.env.ODOO_SYNC_FRESH_MINUTES || 15);

/** Grace period after a month ends before its last sync is trusted as final. */
const CLOSE_GRACE_DAYS = 2;

export interface MonthStatus {
  month: string;
  lastFilledAt: string | null;
  producingDays: number;
  stale: boolean;
}

export interface SyncStatus {
  months: MonthStatus[];
  /** The most recent sync across all months. */
  lastSyncedAt: string | null;
  staleMonths: string[];
  syncing: boolean;
}

const endOfMonth = (month: string): Date => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1));
};

const currentMonth = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

function isStale(month: string, lastFilledAt: string | null): boolean {
  if (!lastFilledAt) return true;
  const filled = new Date(lastFilledAt).getTime();
  if (!Number.isFinite(filled)) return true;

  if (month >= currentMonth()) {
    return Date.now() - filled > FRESH_MINUTES * 60_000;
  }
  // A past month is settled once it was synced after it closed.
  return filled < endOfMonth(month).getTime() + CLOSE_GRACE_DAYS * 86_400_000;
}

let inFlight: Promise<BackfillResult> | null = null;
let lastRun: { at: string; result: BackfillResult } | null = null;

export async function syncStatus(months?: string[]): Promise<SyncStatus> {
  const list = months?.length ? months : plannedMonths();
  const stored = await getBudgets<BudgetDoc>(list);

  const rows: MonthStatus[] = list.map((month) => {
    const doc = stored.get(month);
    const lastFilledAt = doc?.source?.lastFilledAt ?? null;
    return {
      month,
      lastFilledAt,
      producingDays: (doc?.days ?? []).filter((d) => (d.zipper ?? 0) + (d.mt ?? 0) > 0).length,
      stale: isStale(month, lastFilledAt),
    };
  });

  const stamps = rows.map((r) => r.lastFilledAt).filter(Boolean) as string[];

  return {
    months: rows,
    lastSyncedAt: stamps.length ? stamps.sort().at(-1)! : null,
    staleMonths: rows.filter((r) => r.stale).map((r) => r.month),
    syncing: inFlight !== null,
  };
}

export interface SyncOptions {
  /** 'auto' fetches only stale months; 'all' re-fetches every listed month. */
  mode?: 'auto' | 'all';
  /** Restrict to these months; defaults to everything the workbook plans. */
  months?: string[];
}

export interface SyncOutcome {
  ran: boolean;
  skipped: boolean;
  months: string[];
  result: BackfillResult | null;
  status: SyncStatus;
}

/**
 * Runs a sync. Concurrent callers share one run rather than each starting their
 * own — two people opening the page at once should not double the load on Odoo.
 */
export async function sync(options: SyncOptions = {}): Promise<SyncOutcome> {
  const { mode = 'auto', months } = options;
  const status = await syncStatus(months);
  const targets = mode === 'all' ? status.months.map((m) => m.month) : status.staleMonths;

  if (!targets.length) {
    return { ran: false, skipped: true, months: [], result: null, status };
  }

  if (inFlight) {
    const result = await inFlight;
    return { ran: false, skipped: true, months: [], result, status: await syncStatus(months) };
  }

  inFlight = backfill(targets);
  try {
    const result = await inFlight;
    lastRun = { at: new Date().toISOString(), result };
    return { ran: true, skipped: false, months: targets, result, status: await syncStatus(months) };
  } finally {
    inFlight = null;
  }
}

/** Months of one fiscal year that the workbook plans for. */
export function fiscalYearMonths(fy: number): string[] {
  const known = new Set(plannedMonths());
  return fyMonths(fy).filter((m) => known.has(m));
}

export function monthsUpTo(month: string): string[] {
  const known = new Set(plannedMonths());
  return fyMonths(fyOf(month)).filter((m) => known.has(m) && m <= month);
}

export function lastSyncRun() {
  return lastRun;
}
