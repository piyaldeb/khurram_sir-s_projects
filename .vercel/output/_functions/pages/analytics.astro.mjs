import { e as createComponent, k as renderComponent, r as renderTemplate, m as maybeRenderHead, g as addAttribute, l as renderScript } from '../chunks/astro/server_DfYfYe5M.mjs';
import 'piccolore';
import { $ as $$Base } from '../chunks/Base_Bjpz88A4.mjs';
import { g as getSession, c as config } from '../chunks/odoo_B4sOaK5u.mjs';
import { p as plannedMonths, f as fyOf, a as fyLabel } from '../chunks/budget_eNAazx9n.mjs';
export { renderers } from '../renderers.mjs';

const prerender = false;
const $$Analytics = createComponent(async ($$result, $$props, $$slots) => {
  let session = null;
  let odooError = null;
  try {
    session = await getSession();
  } catch (err) {
    odooError = err.message;
  }
  const fys = [...new Set(plannedMonths().map(fyOf))].sort((a, b) => b - a);
  const currentFy = fys[0] ?? (/* @__PURE__ */ new Date()).getFullYear();
  const connectionLabel = session ? `${session.userName} \xB7 ${session.db} \xB7 ${new URL(config.url).host}` : "Not connected";
  return renderTemplate`${renderComponent($$result, "Base", $$Base, { "title": "Production ABC \xB7 Odoo", "connected": !!session, "connectionLabel": connectionLabel }, { "default": async ($$result2) => renderTemplate` ${maybeRenderHead()}<main class="main abc"${addAttribute(String(currentFy), "data-fy")}${addAttribute(session ? "1" : "", "data-odoo")}> <header class="page-head"> <div class="page-head-text"> <p class="eyebrow">Manufacturing</p> <h1>Production ABC</h1> <p class="lede">
A full fiscal year of packing production, valued in USD from the line prices and
          ranked Pareto-style: class A carries the first 80% of value, B the next 15%, C the
          tail — by product, buyer, customer and company.
</p> </div> <div class="page-head-actions"> <div class="segmented" role="tablist" aria-label="Fiscal year"> ${fys.map((fy) => renderTemplate`<button class="seg" type="button" role="tab"${addAttribute(String(fy), "data-fy-pick")}${addAttribute(fy === currentFy ? "true" : "false", "aria-selected")}> ${fyLabel(fy)} </button>`)} </div> <div class="segmented" role="tablist" aria-label="Company" id="company-seg"> <button class="seg" type="button" role="tab" data-company="all" aria-selected="true">
Both companies
</button> </div> </div> </header> ${odooError && renderTemplate`<div class="panel state error banner"> <h2>Odoo is not connected</h2> <p>${odooError}</p> </div>`} <div class="panel state" id="abc-status"> <h2><span class="spinner"></span> Building the year</h2> <p>
The first run asks Odoo for each month's packing report and caches it — that can take a
        couple of minutes. After that, only the current month refreshes.
</p> </div> <div id="abc-body" hidden> <div class="kpis" id="abc-kpis"></div> <div class="chart-grid"> <section class="panel card"> <div class="card-head"> <h2>Monthly production value</h2> <span class="hint">Zipper and Metal Trims, stacked</span> </div> <div class="chart-host" id="chart-months"></div> </section> <section class="panel card"> <div class="card-head"> <h2>Top products</h2> <span class="hint" id="hint-item"></span> </div> <div class="chart-host" id="chart-item"></div> </section> </div> <div class="chart-grid"> <section class="panel card"> <div class="card-head"> <h2>Top buyers</h2> <span class="hint" id="hint-buyer"></span> </div> <div class="chart-host" id="chart-buyer"></div> </section> <section class="panel card"> <div class="card-head"> <h2>Top customers</h2> <span class="hint" id="hint-customer"></span> </div> <div class="chart-host" id="chart-customer"></div> </section> </div> <div id="abc-tables"></div> </div> </main> ${renderScript($$result2, "E:/Khurram sir project/src/pages/analytics.astro?astro&type=script&index=0&lang.ts")} ` })}`;
}, "E:/Khurram sir project/src/pages/analytics.astro", void 0);

const $$file = "E:/Khurram sir project/src/pages/analytics.astro";
const $$url = "/analytics";

const _page = /*#__PURE__*/Object.freeze(/*#__PURE__*/Object.defineProperty({
  __proto__: null,
  default: $$Analytics,
  file: $$file,
  prerender,
  url: $$url
}, Symbol.toStringTag, { value: 'Module' }));

const page = () => _page;

export { page };
