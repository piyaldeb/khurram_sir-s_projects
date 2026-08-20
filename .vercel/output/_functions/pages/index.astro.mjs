import { e as createComponent, k as renderComponent, r as renderTemplate, m as maybeRenderHead, g as addAttribute, l as renderScript } from '../chunks/astro/server_DfYfYe5M.mjs';
import 'piccolore';
import { $ as $$Base } from '../chunks/Base_Bjpz88A4.mjs';
import { g as getSession, c as config } from '../chunks/odoo_B4sOaK5u.mjs';
import { y as yesterdayIso } from '../chunks/dayReport_MD3F6fbr.mjs';
export { renderers } from '../renderers.mjs';

const prerender = false;
const $$Index = createComponent(async ($$result, $$props, $$slots) => {
  let session = null;
  let odooError = null;
  try {
    session = await getSession();
  } catch (err) {
    odooError = err.message;
  }
  const date = yesterdayIso();
  const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const connectionLabel = session ? `${session.userName} \xB7 ${session.db} \xB7 ${new URL(config.url).host}` : "Not connected";
  return renderTemplate`${renderComponent($$result, "Base", $$Base, { "title": "Production report \xB7 Odoo", "connected": !!session, "connectionLabel": connectionLabel }, { "default": async ($$result2) => renderTemplate` ${maybeRenderHead()}<main class="main production"${addAttribute(date, "data-date")}${addAttribute(today, "data-today")}${addAttribute(session ? "1" : "", "data-odoo")}> <header class="page-head"> <div class="page-head-text"> <p class="eyebrow">Manufacturing</p> <h1>Production report</h1> <p class="lede">
The daily MRP Invoice report, read live from Odoo for each company — packing,
          pending, released, and open order acknowledgements. Opens on yesterday, because
          today's shift is still running.
</p> </div> <div class="page-head-actions"> <div class="period-picker"> <button class="step" type="button" id="day-prev" aria-label="Previous day">‹</button> <input type="date" id="day"${addAttribute(date, "value")}${addAttribute(today, "max")}> <button class="step" type="button" id="day-next" aria-label="Next day">›</button> </div> <button class="chip" type="button" id="day-yesterday">Yesterday</button> <button class="btn" id="day-refresh" type="button">Refresh</button> </div> </header> ${odooError && renderTemplate`<div class="panel state error banner"> <h2>Odoo is not connected</h2> <p>${odooError}</p> </div>`} <div class="kpis" id="day-kpis"></div> <div id="day-companies"></div> </main> ${renderScript($$result2, "E:/Khurram sir project/src/pages/index.astro?astro&type=script&index=0&lang.ts")} ` })}`;
}, "E:/Khurram sir project/src/pages/index.astro", void 0);

const $$file = "E:/Khurram sir project/src/pages/index.astro";
const $$url = "";

const _page = /*#__PURE__*/Object.freeze(/*#__PURE__*/Object.defineProperty({
  __proto__: null,
  default: $$Index,
  file: $$file,
  prerender,
  url: $$url
}, Symbol.toStringTag, { value: 'Module' }));

const page = () => _page;

export { page };
