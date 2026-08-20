/** Rolls monthly budget documents up into a fiscal-year or year-to-date view. */
import {
  computeBudget,
  emptyDoc,
  fyLabel,
  fyMonths,
  fyOf,
  monthLabel,
  planFor,
  plannedMonths,
  ytdMonths,
  type BudgetDoc,
} from './budget';
import { getBudgets } from './storage';

export interface MonthRollup {
  month: string;
  label: string;
  short: string;
  planZipper: number;
  planMt: number;
  planTotal: number;
  doneZipper: number;
  doneMt: number;
  doneTotal: number;
  workingDays: number;
  daysProduced: number;
  achievedPct: number;
  gap: number;
  stored: boolean;
}

export interface PeriodSummary {
  key: string;
  label: string;
  months: MonthRollup[];
  totals: {
    planZipper: number;
    planMt: number;
    planTotal: number;
    doneZipper: number;
    doneMt: number;
    doneTotal: number;
    achievedPct: number;
    gap: number;
    workingDays: number;
    daysProduced: number;
    monthsWithProduction: number;
    runRate: number;
  };
}

function rollup(month: string, stored: BudgetDoc | undefined): MonthRollup {
  const doc = stored ?? emptyDoc(month);
  const { summary } = computeBudget(doc);
  const label = monthLabel(month);

  return {
    month,
    label,
    short: label.split(' ')[0].slice(0, 3),
    planZipper: doc.zipperPlan,
    planMt: doc.mtPlan,
    planTotal: summary.budget,
    doneZipper: summary.zipperDone,
    doneMt: summary.mtDone,
    doneTotal: summary.totalDone,
    workingDays: summary.workingDays,
    daysProduced: summary.daysEntered,
    achievedPct: summary.prodDonePct,
    gap: summary.budget - summary.totalDone,
    stored: !!stored,
  };
}

export async function summarise(months: string[], key: string, label: string): Promise<PeriodSummary> {
  // One read for the whole period rather than one per month.
  const stored = await getBudgets<BudgetDoc>(months);
  const rows = months.map((month) => rollup(month, stored.get(month)));
  const sum = (pick: (r: MonthRollup) => number) => rows.reduce((a, r) => a + pick(r), 0);

  const planTotal = sum((r) => r.planTotal);
  const doneTotal = sum((r) => r.doneTotal);
  const daysProduced = sum((r) => r.daysProduced);
  const monthsWithProduction = rows.filter((r) => r.doneTotal > 0).length;

  return {
    key,
    label,
    months: rows,
    totals: {
      planZipper: sum((r) => r.planZipper),
      planMt: sum((r) => r.planMt),
      planTotal,
      doneZipper: sum((r) => r.doneZipper),
      doneMt: sum((r) => r.doneMt),
      doneTotal,
      achievedPct: planTotal ? doneTotal / planTotal : 0,
      gap: planTotal - doneTotal,
      workingDays: sum((r) => r.workingDays),
      daysProduced,
      monthsWithProduction,
      runRate: daysProduced ? doneTotal / daysProduced : 0,
    },
  };
}

export async function fiscalYearSummary(fy: number): Promise<PeriodSummary> {
  const known = new Set(plannedMonths());
  // Only show months the shared workbook actually plans for.
  const months = fyMonths(fy).filter((m) => known.has(m));
  return summarise(months.length ? months : fyMonths(fy), `fy-${fy}`, fyLabel(fy));
}

export async function yearToDateSummary(upTo: string): Promise<PeriodSummary> {
  const known = new Set(plannedMonths());
  const months = ytdMonths(upTo).filter((m) => known.has(m));
  return summarise(
    months.length ? months : ytdMonths(upTo),
    `ytd-${upTo}`,
    `${fyLabel(fyOf(upTo))} year to date`,
  );
}

/** Fiscal years the shared workbook covers, newest first. */
export function availableFiscalYears(): number[] {
  return [...new Set(plannedMonths().map(fyOf))].sort((a, b) => b - a);
}

export function availableMonths(): string[] {
  return plannedMonths().sort((a, b) => b.localeCompare(a));
}

export { planFor };
