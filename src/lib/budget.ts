/**
 * Monthly Budget vs Achievement - the "<Month>-26- Automation" sheet, ported.
 *
 * Every derived value below names the cell it comes from in
 * `Monthly Budget follow up sheet.xlsx`, so the two stay comparable.
 * Three formulas are generalised rather than copied literally, because the
 * workbook hard-codes values that have to move with the month:
 *   - G11 divides by a literal 9 -> divided by the remaining working days
 *   - J6  divides by C28 (a fixed row) -> divided by the days actually entered
 *   - E38/F38/G38 sum E13:E36, which misses the last working-day row -> sums all rows
 */

export interface BudgetDay {
  /** Working day number - column C. */
  day: number;
  /** ISO date - column D (user input). */
  date: string;
  /** Zipper production - column E. */
  zipper: number | null;
  /** Metal Trims production - column F. */
  mt: number | null;
  /** True when the figures came from Odoo rather than being typed in. */
  auto?: boolean;
}

/**
 * Which Odoo report columns feed Zipper and Metal Trims.
 *
 * Columns are matched by header NAME, not position, so the mapping survives a
 * report whose columns move. The Metal Trims names below are the six the
 * workbook's Dashboard sheet breaks out; everything else on the sheet is zipper.
 */
export interface BudgetSource {
  reportType: string;
  /** Row filter, e.g. only the USD rows of the Invoice Summary. */
  unit: string | null;
  /** Header names counted as Metal Trims; the rest of the data columns are Zipper. */
  mtColumns: string[];
  /** Columns never counted on either side. */
  ignoreColumns: string[];
  lastFilledAt?: string;
}

/** Metal Trims categories, per the workbook's Dashboard sheet. */
export const MT_CATEGORIES = [
  'SHANK BUTTON',
  'RIVET',
  'SNAP BUTTON',
  'EYELET',
  'ALLOY',
  'OTHERS',
];

/**
 * "OTHERS" only means Metal Trims when it sits beside the other categories.
 * The zipper company's report ends with its own catch-all column of the same
 * name, and that one is zipper.
 */
export const MT_AMBIGUOUS = ['OTHERS'];

/**
 * The workbook's daily figures are the USD rows of the Invoice Summary, summed
 * across every company the user can see (zipper and metal trims are invoiced by
 * different companies). Verified against Aug-26: every day matches to within
 * rounding.
 */
export const DEFAULT_SOURCE: BudgetSource = {
  reportType: 'invs',
  unit: 'USD',
  mtColumns: MT_CATEGORIES,
  ignoreColumns: ['DATE', 'TOTAL'],
};

/**
 * A day Odoo invoiced on that the working calendar does not list.
 *
 * Usually it means the factory opened on a day the plan called a holiday. The
 * sync records them so the sheet can offer the date back for adding rather than
 * leaving the production silently uncounted.
 */
export interface OffCalendarDay {
  date: string;
  zipper: number;
  mt: number;
}

export interface BudgetDoc {
  /** "YYYY-MM". */
  month: string;
  /** E7 - user input. */
  zipperPlan: number;
  /** E9 - user input. */
  mtPlan: number;
  days: BudgetDay[];
  /** Production Odoo reported on dates `days` does not cover. */
  offCalendar?: OffCalendarDay[];
  source?: BudgetSource | null;
  updatedAt?: string;
}

export interface BudgetRow extends BudgetDay {
  /** G = E + F. */
  total: number;
  /** H - running total. */
  cumulative: number;
  /** I = per-day requirement x working day number. */
  cumTarget: number;
  /** J = cumulative target - cumulative production (positive = behind). */
  lagging: number;
  /** Has any figure been entered for this day? */
  entered: boolean;
  /** Did the day actually produce? Days pre-filled with 0 have not happened yet. */
  produced: boolean;
  /** Is this day complete enough to count? Today is not — its shift is running. */
  counted: boolean;
}

export interface BudgetSummary {
  workingDays: number;
  /** Working days that have actually produced - the sheet's C28. */
  daysEntered: number;
  daysRemaining: number;
  /** E5 */
  budget: number;
  /** E6 */
  perDayRequired: number;
  /** E8 */
  zipperPerDay: number;
  /** E10 */
  mtPerDay: number;
  /** E38 / F38 / G38 */
  zipperDone: number;
  mtDone: number;
  totalDone: number;
  /** G11 - null once the month is finished. */
  runRateRequired: number | null;
  /** J5 */
  prodDonePct: number;
  /** J6 */
  averageProduction: number;
  /** J7 */
  zipperAchievedPct: number;
  /** J8 */
  mtAchievedPct: number;
  /** J9 */
  expectedMonthProduction: number;
  /** J10 */
  zipperRemaining: number;
  /** J11 */
  mtRemaining: number;
  /** Last day included in the figures — today is excluded while it is running. */
  countedThrough: string | null;
  /** Production already invoiced today, carried but not counted. */
  pendingTotal: number;
  pendingDate: string | null;
}

export interface BudgetView {
  rows: BudgetRow[];
  summary: BudgetSummary;
}

const num = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

import planCalendar from '../data/plan-calendar.json';

export interface MonthPlan {
  sheet: string;
  zipperPlan: number;
  mtPlan: number;
  workingDays: string[];
}

/** Targets and working calendar for a month, taken from the shared workbook. */
export function planFor(month: string): MonthPlan | null {
  return (planCalendar as Record<string, MonthPlan>)[month] ?? null;
}

export function plannedMonths(): string[] {
  return Object.keys(planCalendar as Record<string, MonthPlan>).sort();
}

/** Today, as an ISO date in local time. */
export function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

export interface ComputeOptions {
  /**
   * The day the numbers are read on. Everything is counted up to the day
   * *before* this, because today's shift is still running — an incomplete day
   * would drag the average and the run rate down and understate achievement
   * per day. Today's figures are still carried on the row, just not counted.
   */
  asOf?: string;
}

export function computeBudget(doc: BudgetDoc, options: ComputeOptions = {}): BudgetView {
  const days = [...doc.days].sort((a, b) => a.day - b.day);
  const workingDays = days.length;
  const asOf = options.asOf ?? todayIso();

  const budget = num(doc.zipperPlan) + num(doc.mtPlan); // E5
  const perDayRequired = workingDays ? budget / workingDays : 0; // E6

  let cumulative = 0;
  const rows: BudgetRow[] = days.map((d) => {
    const total = num(d.zipper) + num(d.mt); // G
    const entered = d.zipper !== null || d.mt !== null;
    // Days already past always count. Today and later only count when the
    // figure was typed in: Odoo's reading of a day still in progress is
    // incomplete, but a number someone entered is a deliberate statement and
    // the sheet has to recalculate around it. A later sync overwrites it with
    // Odoo's own figure, and it drops back out until the day closes.
    const counted = d.date < asOf || (entered && !d.auto);
    if (counted) cumulative += total; // H
    const cumTarget = perDayRequired * d.day; // I
    return {
      ...d,
      total,
      cumulative,
      cumTarget,
      lagging: cumTarget - cumulative, // J
      entered,
      counted,
      produced: counted && total > 0,
    };
  });

  const counted = rows.filter((r) => r.counted);
  const zipperDone = counted.reduce((a, r) => a + num(r.zipper), 0); // E38
  const mtDone = counted.reduce((a, r) => a + num(r.mt), 0); // F38
  const totalDone = zipperDone + mtDone; // G38

  // The sheet's C28 is the last row that produced; rows for days still to come
  // sit at 0, so counting non-empty cells would overstate it.
  const daysEntered = rows.filter((r) => r.produced).length;
  const daysRemaining = Math.max(workingDays - daysEntered, 0);
  const averageProduction = daysEntered ? totalDone / daysEntered : 0; // J6

  const pending = rows.filter((r) => !r.counted && r.total > 0);
  const countedThrough = counted.length ? counted[counted.length - 1].date : null;

  return {
    rows,
    summary: {
      workingDays,
      daysEntered,
      daysRemaining,
      budget,
      perDayRequired,
      zipperPerDay: workingDays ? num(doc.zipperPlan) / workingDays : 0, // E8
      mtPerDay: workingDays ? num(doc.mtPlan) / workingDays : 0, // E10
      zipperDone,
      mtDone,
      totalDone,
      runRateRequired: daysRemaining > 0 ? (budget - totalDone) / daysRemaining : null, // G11
      prodDonePct: budget ? totalDone / budget : 0, // J5
      averageProduction,
      zipperAchievedPct: num(doc.zipperPlan) ? zipperDone / num(doc.zipperPlan) : 0, // J7
      mtAchievedPct: num(doc.mtPlan) ? mtDone / num(doc.mtPlan) : 0, // J8
      expectedMonthProduction: averageProduction * workingDays, // J9
      zipperRemaining: num(doc.zipperPlan) - zipperDone, // J10
      mtRemaining: num(doc.mtPlan) - mtDone, // J11
      countedThrough,
      pendingTotal: pending.reduce((a, r) => a + r.total, 0),
      pendingDate: pending.length ? pending[0].date : null,
    },
  };
}

/** Every calendar day of the month, numbered - the user prunes the holidays. */
export function defaultDays(month: string): BudgetDay[] {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const days: BudgetDay[] = [];
  for (let d = 1; d <= last; d++) {
    days.push({
      day: days.length + 1,
      date: `${month}-${String(d).padStart(2, '0')}`,
      zipper: null,
      mt: null,
    });
  }
  return days;
}

export function renumber(days: BudgetDay[]): BudgetDay[] {
  return [...days]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d, i) => ({ ...d, day: i + 1 }));
}

/** Does this ISO date fall inside "YYYY-MM"? */
export function inMonth(date: string, month: string): boolean {
  return date.slice(0, 7) === month;
}

/**
 * Adds a working day the plan left out - a Friday the factory opened, say.
 *
 * The day lands in date order and every row is renumbered, so the working-day
 * count, the per-day requirement and each row's cumulative target all move with
 * it. Adding a date that is already there changes nothing.
 */
export function addDay(
  days: BudgetDay[],
  date: string,
  figures?: { zipper: number; mt: number },
): BudgetDay[] {
  if (days.some((d) => d.date === date)) return renumber(days);
  return renumber([
    ...days,
    {
      day: 0, // renumber assigns the real one
      date,
      zipper: figures?.zipper ?? null,
      mt: figures?.mt ?? null,
      // Figures carried over from a sync are still Odoo's, not typed in.
      auto: !!figures,
    },
  ]);
}

/** Drops a working day. Its production leaves the totals with it. */
export function removeDay(days: BudgetDay[], date: string): BudgetDay[] {
  return renumber(days.filter((d) => d.date !== date));
}

export function emptyDoc(month: string): BudgetDoc {
  const plan = planFor(month);
  return {
    month,
    zipperPlan: plan?.zipperPlan ?? 0,
    mtPlan: plan?.mtPlan ?? 0,
    days: plan
      ? plan.workingDays.map((date, i) => ({ day: i + 1, date, zipper: null, mt: null }))
      : defaultDays(month),
    source: DEFAULT_SOURCE,
  };
}

/* ------------------------------------------------------- fiscal year (Apr-Mar) */

/** The fiscal year a month belongs to, named by its starting calendar year. */
export function fyOf(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return m >= 4 ? y : y - 1;
}

/** "FY 25-26" */
export function fyLabel(fy: number): string {
  return `FY ${String(fy).slice(2)}-${String(fy + 1).slice(2)}`;
}

/** The twelve months of a fiscal year, April first. */
export function fyMonths(fy: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < 12; i++) {
    const m = 4 + i;
    const year = m > 12 ? fy + 1 : fy;
    const month = m > 12 ? m - 12 : m;
    out.push(`${year}-${String(month).padStart(2, '0')}`);
  }
  return out;
}

/** Fiscal months from April up to and including `upTo`. */
export function ytdMonths(upTo: string): string[] {
  return fyMonths(fyOf(upTo)).filter((m) => m <= upTo);
}

export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Normalises whatever the browser posted into a doc we are willing to store. */
export function sanitiseDoc(input: any, month: string): BudgetDoc {
  const toNum = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const toCell = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const days: BudgetDay[] = Array.isArray(input?.days)
    ? input.days
        .filter((d: any) => typeof d?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.date))
        .map((d: any) => ({
          day: Number(d.day) || 0,
          date: d.date,
          zipper: toCell(d.zipper),
          mt: toCell(d.mt),
          auto: !!d.auto,
        }))
    : defaultDays(month);

  const src = input?.source;
  const source: BudgetSource =
    src && typeof src.reportType === 'string'
      ? {
          reportType: src.reportType,
          unit: src.unit ? String(src.unit) : null,
          mtColumns: (src.mtColumns ?? MT_CATEGORIES).map(String),
          ignoreColumns: (src.ignoreColumns ?? DEFAULT_SOURCE.ignoreColumns).map(String),
          lastFilledAt: src.lastFilledAt ? String(src.lastFilledAt) : undefined,
        }
      : DEFAULT_SOURCE;

  // Written by the sync, round-tripped by the browser: kept so the "add a day"
  // picker can still say which skipped dates Odoo actually invoiced on.
  const offCalendar: OffCalendarDay[] = Array.isArray(input?.offCalendar)
    ? input.offCalendar
        .filter((d: any) => typeof d?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.date))
        .map((d: any) => ({ date: d.date, zipper: toNum(d.zipper), mt: toNum(d.mt) }))
    : [];

  return {
    month,
    zipperPlan: toNum(input?.zipperPlan),
    mtPlan: toNum(input?.mtPlan),
    days: renumber(days),
    offCalendar,
    source,
    updatedAt: new Date().toISOString(),
  };
}
