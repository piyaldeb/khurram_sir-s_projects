import { D as DEFAULT_SOURCE, e as emptyDoc, r as renumber } from './budget_eNAazx9n.mjs';
import { f as fetchMonthProduction } from './production_Cp_fWiPC.mjs';
import { g as getBudget, p as putBudget } from './storage_BFhx3OVS.mjs';

async function fillMonth(month, source = DEFAULT_SOURCE, skipCompanies) {
  const stored = await getBudget(month);
  const doc = stored ?? emptyDoc(month);
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
  const calendar = new Set(doc.days.map((d) => d.date));
  const unmatched = production.days.filter((d) => (d.zipper || d.mt) && !calendar.has(d.date)).map((d) => d.date);
  doc.source = { ...doc.source ?? source, lastFilledAt: production.fetchedAt };
  doc.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  await putBudget(month, doc);
  return {
    month,
    filled,
    zipper,
    mt,
    unmatched,
    deadCompanies: production.companies.filter((c) => c.error).map((c) => c.id)
  };
}
async function backfill(months, source = DEFAULT_SOURCE) {
  const results = [];
  const dead = /* @__PURE__ */ new Set();
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
        error: err.message
      });
    }
  }
  return {
    months: results,
    filledMonths: results.filter((r) => r.filled > 0).length,
    totalZipper: results.reduce((a, r) => a + r.zipper, 0),
    totalMt: results.reduce((a, r) => a + r.mt, 0),
    fetchedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}

export { backfill as b };
