import { f as fetchMonthProduction } from '../../chunks/production_Cp_fWiPC.mjs';
import { D as DEFAULT_SOURCE } from '../../chunks/budget_eNAazx9n.mjs';
import { O as OdooError } from '../../chunks/odoo_B4sOaK5u.mjs';
export { renderers } from '../../renderers.mjs';

const prerender = false;
const MONTH = /^\d{4}-\d{2}$/;
const GET = async ({ url }) => {
  const month = url.searchParams.get("month") ?? "";
  if (!MONTH.test(month)) return json({ error: "month must look like 2026-08" }, 400);
  const source = {
    ...DEFAULT_SOURCE,
    reportType: url.searchParams.get("report_type") || DEFAULT_SOURCE.reportType,
    unit: url.searchParams.get("unit") ?? DEFAULT_SOURCE.unit
  };
  try {
    return json(await fetchMonthProduction(month, source));
  } catch (err) {
    const message = err instanceof OdooError ? err.message : err.message;
    return json({ error: message }, 502);
  }
};
function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

const _page = /*#__PURE__*/Object.freeze(/*#__PURE__*/Object.defineProperty({
  __proto__: null,
  GET,
  prerender
}, Symbol.toStringTag, { value: 'Module' }));

const page = () => _page;

export { page };
