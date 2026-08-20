import { p as plannedMonths, f as fyOf, y as ytdMonths, a as fyLabel, b as fyMonths, e as emptyDoc, c as computeBudget, m as monthLabel } from './budget_eNAazx9n.mjs';
import { a as getBudgets } from './storage_BFhx3OVS.mjs';

function rollup(month, stored) {
  const doc = stored ?? emptyDoc(month);
  const { summary } = computeBudget(doc);
  const label = monthLabel(month);
  return {
    month,
    label,
    short: label.split(" ")[0].slice(0, 3),
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
    stored: !!stored
  };
}
async function summarise(months, key, label) {
  const stored = await getBudgets(months);
  const rows = months.map((month) => rollup(month, stored.get(month)));
  const sum = (pick) => rows.reduce((a, r) => a + pick(r), 0);
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
      runRate: daysProduced ? doneTotal / daysProduced : 0
    }
  };
}
async function fiscalYearSummary(fy) {
  const known = new Set(plannedMonths());
  const months = fyMonths(fy).filter((m) => known.has(m));
  return summarise(months.length ? months : fyMonths(fy), `fy-${fy}`, fyLabel(fy));
}
async function yearToDateSummary(upTo) {
  const known = new Set(plannedMonths());
  const months = ytdMonths(upTo).filter((m) => known.has(m));
  return summarise(
    months.length ? months : ytdMonths(upTo),
    `ytd-${upTo}`,
    `${fyLabel(fyOf(upTo))} year to date`
  );
}
function availableFiscalYears() {
  return [...new Set(plannedMonths().map(fyOf))].sort((a, b) => b - a);
}
function availableMonths() {
  return plannedMonths().sort((a, b) => b.localeCompare(a));
}

export { availableMonths as a, availableFiscalYears as b, fiscalYearSummary as f, yearToDateSummary as y };
