/**
 * Fills a run of months with production read from Odoo and saves each one.
 *
 * The per-month button fills the sheet you are looking at; this is what makes a
 * whole fiscal year real, so the FY and YTD views have something to show for
 * April onwards rather than a column of zeros.
 */
import { DEFAULT_SOURCE, emptyDoc, renumber, type BudgetDoc, type BudgetSource } from './budget';
import { fetchMonthProduction } from './production';
import { getBudget, putBudget } from './storage';

export interface MonthFillResult {
  month: string;
  filled: number;
  zipper: number;
  mt: number;
  /** Dates Odoo reported that the month's working calendar does not contain. */
  unmatched: string[];
  /** Companies whose report failed, so later months can skip them. */
  deadCompanies?: number[];
  error?: string;
}

export interface BackfillResult {
  months: MonthFillResult[];
  filledMonths: number;
  totalZipper: number;
  totalMt: number;
  fetchedAt: string;
}

/** Applies Odoo's figures to one month and saves it. */
export async function fillMonth(
  month: string,
  source: BudgetSource = DEFAULT_SOURCE,
  skipCompanies?: Set<number>,
): Promise<MonthFillResult> {
  const stored = await getBudget<BudgetDoc>(month);
  const doc: BudgetDoc = stored ?? emptyDoc(month);
  doc.days = renumber(doc.days);

  const production = await fetchMonthProduction(month, source, skipCompanies);
  const byDate = new Map(production.days.map((d) => [d.date, d]));

  let filled = 0;
  let zipper = 0;
  let mt = 0;
  for (const day of doc.days) {
    const hit = byDate.get(day.date);
    if (!hit) continue;
    day.zipper = hit.zipper;
    day.mt = hit.mt;
    day.auto = true;
    zipper += hit.zipper;
    mt += hit.mt;
    filled++;
  }

  // Production on a day the calendar does not list is worth surfacing: it means
  // the working calendar and the invoicing disagree.
  const calendar = new Set(doc.days.map((d) => d.date));
  const unmatched = production.days
    .filter((d) => (d.zipper || d.mt) && !calendar.has(d.date))
    .map((d) => d.date);

  doc.source = { ...(doc.source ?? source), lastFilledAt: production.fetchedAt };
  doc.updatedAt = new Date().toISOString();
  await putBudget(month, doc);

  return {
    month,
    filled,
    zipper,
    mt,
    unmatched,
    deadCompanies: production.companies.filter((c) => c.error).map((c) => c.id),
  };
}

export async function backfill(
  months: string[],
  source: BudgetSource = DEFAULT_SOURCE,
): Promise<BackfillResult> {
  const results: MonthFillResult[] = [];
  // Companies that produced nothing on the first month are not going to start.
  const dead = new Set<number>();

  // Sequential on purpose - each month is several Odoo report builds, and
  // hammering the server in parallel is how you get timeouts.
  for (const month of months) {
    try {
      const result = await fillMonth(month, source, dead);
      for (const id of result.deadCompanies ?? []) dead.add(id);
      results.push(result);
    } catch (err) {
      results.push({
        month,
        filled: 0,
        zipper: 0,
        mt: 0,
        unmatched: [],
        error: (err as Error).message,
      });
    }
  }

  return {
    months: results,
    filledMonths: results.filter((r) => r.filled > 0).length,
    totalZipper: results.reduce((a, r) => a + r.zipper, 0),
    totalMt: results.reduce((a, r) => a + r.mt, 0),
    fetchedAt: new Date().toISOString(),
  };
}
