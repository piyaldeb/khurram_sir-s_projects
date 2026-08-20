import { e as createComponent, k as renderComponent, r as renderTemplate, m as maybeRenderHead, g as addAttribute, l as renderScript } from '../chunks/astro/server_DfYfYe5M.mjs';
import 'piccolore';
import { $ as $$Base } from '../chunks/Base_Bjpz88A4.mjs';
import { g as getSession, c as config } from '../chunks/odoo_B4sOaK5u.mjs';
import { f as fyOf, m as monthLabel, a as fyLabel } from '../chunks/budget_eNAazx9n.mjs';
import { a as availableMonths, b as availableFiscalYears } from '../chunks/summary_D8M14kWi.mjs';
export { renderers } from '../renderers.mjs';

const prerender = false;
const $$Budget = createComponent(async ($$result, $$props, $$slots) => {
  let session = null;
  let odooError = null;
  try {
    session = await getSession();
  } catch (err) {
    odooError = err.message;
  }
  const now = /* @__PURE__ */ new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const months = availableMonths();
  const month = months.includes(thisMonth) ? thisMonth : months[0] ?? thisMonth;
  const fiscalYears = availableFiscalYears();
  const currentFy = fyOf(month);
  const connectionLabel = session ? `${session.userName} \xB7 ${session.db} \xB7 ${new URL(config.url).host}` : "Not connected";
  return renderTemplate`${renderComponent($$result, "Base", $$Base, { "title": `Budget follow-up \xB7 ${monthLabel(month)}`, "connected": !!session, "connectionLabel": connectionLabel }, { "default": async ($$result2) => renderTemplate` ${maybeRenderHead()}<main class="main budget"${addAttribute(month, "data-month")}${addAttribute(String(currentFy), "data-fy")}${addAttribute(session ? "1" : "", "data-odoo")}> <header class="page-head"> <div class="page-head-text"> <p class="eyebrow">Manufacturing</p> <h1>Budget vs Achievement</h1> <p class="lede" id="page-lede">
Targets and the working calendar come from the planning workbook. Production is read
          live from Odoo.
</p> </div> <div class="page-head-actions"> <div class="segmented" role="tablist" aria-label="Period"> <button class="seg" type="button" role="tab" data-view="month" aria-selected="true">
Month
</button> <button class="seg" type="button" role="tab" data-view="fy" aria-selected="false">
Fiscal year
</button> <button class="seg" type="button" role="tab" data-view="ytd" aria-selected="false">
Year to date
</button> </div> <div class="period-picker" id="picker-month"> <button class="step" type="button" id="month-prev" aria-label="Previous month">‹</button> <select id="month-select" aria-label="Month"> ${months.map((m) => renderTemplate`<option${addAttribute(m, "value")}${addAttribute(m === month, "selected")}> ${monthLabel(m)} </option>`)} </select> <button class="step" type="button" id="month-next" aria-label="Next month">›</button> </div> <div class="period-picker" id="picker-fy" hidden> <select id="fy-select" aria-label="Fiscal year"> ${fiscalYears.map((fy) => renderTemplate`<option${addAttribute(String(fy), "value")}${addAttribute(fy === currentFy, "selected")}> ${fyLabel(fy)} </option>`)} </select> </div> </div> </header> <div class="syncbar panel" id="syncbar"> <span class="sync-dot" id="sync-dot"></span> <div class="sync-text"> <strong id="sync-title">Checking Odoo…</strong> <span class="hint" id="sync-note">Last synced —</span> </div> <div class="toolbar-spacer"></div> <button class="btn" id="sync-now" type="button">Sync now</button> </div> ${odooError && renderTemplate`<div class="panel state error banner"> <h2>Odoo is not connected</h2> <p> ${odooError} Production figures stay empty until the connection works; targets and the
            working calendar still come from the workbook.
</p> </div>`} <!-- ------------------------------------------------------------- month --> <section id="view-month"> <div class="toolbar panel"> <div class="field"> <label for="zipperPlan">Zipper Plan <span class="input-flag">input</span></label> <input type="number" id="zipperPlan" min="0" step="1000"> </div> <div class="field"> <label for="mtPlan">MT Plan <span class="input-flag">input</span></label> <input type="number" id="mtPlan" min="0" step="1000"> </div> <div class="toolbar-spacer"></div> <span class="save-state" id="save-state"></span> <button class="btn" id="export" type="button">Export CSV</button> <button class="btn primary" id="save" type="button">Save</button> </div> <div class="kpis" id="budget-kpis"></div> <div class="chart-grid"> <section class="panel card"> <div class="card-head"> <h2>Cumulative production vs target</h2> <span class="hint">Working days of the month</span> </div> <div class="chart-host" id="chart-cumulative"></div> </section> <section class="panel card"> <div class="card-head"> <h2>Daily production</h2> <span class="hint">Zipper and Metal Trims, stacked</span> </div> <div class="chart-host" id="chart-daily"></div> </section> </div> <div class="budget-grid"> <section class="panel card plan-card"> <div class="card-head"><h2>Plan</h2></div> <table class="plan"><tbody id="plan-rows"></tbody></table> <div class="presets"> <button class="chip" type="button" id="reset-days">Reset calendar</button> <button class="chip" type="button" id="drop-empty">Drop non-producing days</button> <button class="chip" type="button" id="add-day">Add a day</button> </div> </section> <section class="panel card results"> <div class="results-bar"> <strong id="days-title">Working days</strong> <span class="hint" id="days-hint"></span> <div class="toolbar-spacer"></div> <span class="hint">
Type into Zipper Prod or MT Prod to model a figure — Sync now puts Odoo's back
</span> </div> <div class="table-scroll" style="max-height:none"> <table class="grid budget-table"> <thead> <tr> <th>Working Day</th> <th>Date</th> <th>Zipper Prod</th> <th>MT Prod</th> <th>Total</th> <th>Cumu Prod</th> <th>Cum target</th> <th>Cum Target Lagging</th> <th aria-label="Remove"></th> </tr> </thead> <tbody id="budget-rows"></tbody> <tfoot id="budget-foot"></tfoot> </table> </div> </section> </div> </section> <!-- ------------------------------------------------------- fy  /  ytd --> <section id="view-period" hidden> <div class="toolbar panel"> <div> <strong id="period-heading">Fiscal year</strong> <p class="hint" id="period-sub" style="margin:2px 0 0">
Months without production have not been fetched from Odoo yet.
</p> </div> <div class="toolbar-spacer"></div> <span class="save-state" id="period-state"></span> <button class="btn" id="backfill" type="button">Re-fetch this year</button> </div> <div class="kpis" id="period-kpis"></div> <div class="chart-grid"> <section class="panel card"> <div class="card-head"> <h2>Monthly achievement against budget</h2> <span class="hint">Budget shown as the neutral reference</span> </div> <div class="chart-host" id="chart-months"></div> </section> <section class="panel card"> <div class="card-head"> <h2>Cumulative achievement vs budget</h2> <span class="hint">Running totals across the year</span> </div> <div class="chart-host" id="chart-period-cum"></div> </section> </div> <section class="panel card"> <div class="card-head"> <h2>Split by company</h2> <span class="hint">Zipper and Metal Trims per month</span> </div> <div class="chart-host" id="chart-split"></div> </section> <section class="panel card results" style="margin-top:16px"> <div class="results-bar"> <strong id="period-title">Months</strong> <div class="toolbar-spacer"></div> <button class="chip" type="button" id="period-export">Export CSV</button> </div> <div class="table-scroll" style="max-height:none"> <table class="grid period-table"> <thead> <tr> <th>Month</th> <th>Zipper Plan</th> <th>MT Plan</th> <th>Budget</th> <th>Zipper Done</th> <th>MT Done</th> <th>Achievement</th> <th>Achieved %</th> <th>Gap</th> <th>Days</th> </tr> </thead> <tbody id="period-rows"></tbody> <tfoot id="period-foot"></tfoot> </table> </div> </section> </section> </main> ${renderScript($$result2, "E:/Khurram sir project/src/pages/budget.astro?astro&type=script&index=0&lang.ts")} ` })}`;
}, "E:/Khurram sir project/src/pages/budget.astro", void 0);

const $$file = "E:/Khurram sir project/src/pages/budget.astro";
const $$url = "/budget";

const _page = /*#__PURE__*/Object.freeze(/*#__PURE__*/Object.defineProperty({
  __proto__: null,
  default: $$Budget,
  file: $$file,
  prerender,
  url: $$url
}, Symbol.toStringTag, { value: 'Module' }));

const page = () => _page;

export { page };
