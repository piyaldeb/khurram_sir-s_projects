import { e as createComponent, k as renderComponent, r as renderTemplate, m as maybeRenderHead, g as addAttribute, l as renderScript } from '../chunks/astro/server_DfYfYe5M.mjs';
import 'piccolore';
import { $ as $$Base } from '../chunks/Base_Bjpz88A4.mjs';
import { b as getWizardFields } from '../chunks/reports_B3AU53Bt.mjs';
import { g as getSession, c as config } from '../chunks/odoo_B4sOaK5u.mjs';
export { renderers } from '../renderers.mjs';

const prerender = false;
const $$Reports = createComponent(async ($$result, $$props, $$slots) => {
  let fields = null;
  let session = null;
  let error = null;
  try {
    session = await getSession();
    fields = await getWizardFields();
  } catch (err) {
    error = err.message;
  }
  const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + "01";
  const defaults = {
    report_type: fields?.defaults.report_type ?? "",
    date_from: fields?.defaults.date_from || monthStart,
    date_to: fields?.defaults.date_to || today
  };
  const grouped = (fields?.groups ?? []).map((group) => ({
    group,
    items: (fields?.reports ?? []).filter((r) => r.group === group)
  }));
  const connectionLabel = session ? `${session.userName} \xB7 ${session.db} \xB7 ${new URL(config.url).host}` : "Not connected";
  return renderTemplate`${renderComponent($$result, "Base", $$Base, { "title": "Report console \xB7 Odoo", "connected": !!session, "connectionLabel": connectionLabel }, { "default": async ($$result2) => renderTemplate`${error ? renderTemplate`${maybeRenderHead()}<main class="setup panel"> <h1 style="margin-top:0;font-size:20px">Connect this site to Odoo</h1> <p style="color:var(--ink-2)">
The report console talks to Odoo with the same JSON-RPC calls the web client uses. It
          needs a user that can open <code>MRP Reports</code>. Create a <code>.env</code> file next
          to <code>package.json</code>:
</p> <pre>${`ODOO_URL=https://taps.odoo.com
ODOO_DB=your-database-name
ODOO_LOGIN=you@example.com
ODOO_PASSWORD=your-password-or-api-key
ODOO_TZ=Asia/Dhaka`}</pre> <p style="color:var(--ink-2)">
An Odoo API key (Preferences → Account Security → New API Key) works in place of the
          password and is the safer choice.
</p> <div class="state error panel" style="margin-top:18px"> <h2>Odoo said</h2> <p style="font-family:var(--mono);font-size:12.5px">${error.trim()}</p> </div> </main>` : renderTemplate`<div class="layout"> <nav class="rail" aria-label="Report types"> <input class="rail-search" id="rail-search" type="search" placeholder="Filter reports…" autocomplete="off"> ${grouped.map(({ group, items }) => renderTemplate`<div class="rail-group"${addAttribute(group, "data-group")}> <h3>${group}</h3> ${items.map((r) => renderTemplate`<button class="rail-item" type="button"${addAttribute(r.value, "data-report")}${addAttribute(r.label, "data-label")}${addAttribute(String(r.dateFrom), "data-date-from")}${addAttribute(String(r.dateTo), "data-date-to")}${addAttribute(String(r.challan), "data-challan")}${addAttribute(String(r.buyer), "data-buyer")}${addAttribute(r.value === defaults.report_type ? "true" : "false", "aria-current")}> <span class="tick">✓</span> <span>${r.label}</span> </button>`)} </div>`)} </nav> <main class="main"> <section class="panel filters"> <div class="filters-head"> <div> <h1 id="report-title">${fields?.reports.find((r) => r.value === defaults.report_type)?.label ?? "Select a report"}</h1> <p id="report-sub">Pick a report on the left, set the range, then run it.</p> </div> <div class="topbar-spacer"></div> <button class="btn primary" id="run" type="button">Run report</button> <button class="btn" id="download" type="button">Download Excel</button> </div> <div class="field-row"> <div class="field" id="f-date-from"> <label for="date_from">Date from</label> <input type="date" id="date_from"${addAttribute(defaults.date_from, "value")}> </div> <div class="field" id="f-date-to"> <label for="date_to">Date to</label> <input type="date" id="date_to"${addAttribute(defaults.date_to, "value")}> </div> <div class="field" id="f-buyer" hidden> <label for="buyer_id">Buyer</label> <select id="buyer_id"><option value="">All buyers</option></select> </div> <div class="field" id="f-challan" hidden> <label for="challan_id">Challan</label> <select id="challan_id"><option value="">Loading…</option></select> </div> </div> <div class="presets" role="group" aria-label="Quick ranges"> <button class="chip" type="button" data-range="today">Today</button> <button class="chip" type="button" data-range="7">Last 7 days</button> <button class="chip" type="button" data-range="30">Last 30 days</button> <button class="chip" type="button" data-range="mtd">Month to date</button> <button class="chip" type="button" data-range="prev-month">Previous month</button> <button class="chip" type="button" data-range="ytd">Year to date</button> </div> </section> <div class="kpis" id="kpis" hidden></div> <section class="panel results" id="results"> <div class="state"> <h2>No report run yet</h2> <p>
Choose a report and press <strong>Run report</strong>. The site asks Odoo to build
                the file, then renders it here — the same numbers the Excel export contains.
</p> </div> </section> <details class="panel" style="margin-top:16px;padding:14px 18px"> <summary style="cursor:pointer;font-weight:600">Work centres</summary> <div id="workcenters" style="margin-top:12px;color:var(--ink-2)">Loading…</div> </details> </main> </div>`}${renderScript($$result2, "E:/Khurram sir project/src/pages/reports.astro?astro&type=script&index=0&lang.ts")} ` })}`;
}, "E:/Khurram sir project/src/pages/reports.astro", void 0);

const $$file = "E:/Khurram sir project/src/pages/reports.astro";
const $$url = "/reports";

const _page = /*#__PURE__*/Object.freeze(/*#__PURE__*/Object.defineProperty({
  __proto__: null,
  default: $$Reports,
  file: $$file,
  prerender,
  url: $$url
}, Symbol.toStringTag, { value: 'Module' }));

const page = () => _page;

export { page };
