import { y as yesterdayIso, f as fetchDayReport } from '../../chunks/dayReport_MD3F6fbr.mjs';
import { O as OdooError } from '../../chunks/odoo_B4sOaK5u.mjs';
export { renderers } from '../../renderers.mjs';

const prerender = false;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const GET = async ({ url }) => {
  const date = url.searchParams.get("date") || yesterdayIso();
  if (!DATE.test(date)) return json({ error: "date must look like 2026-08-19" }, 400);
  try {
    return json(await fetchDayReport(date));
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
