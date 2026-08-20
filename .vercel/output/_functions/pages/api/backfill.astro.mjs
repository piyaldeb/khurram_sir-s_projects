import { b as backfill } from '../../chunks/backfill_Da51PbYr.mjs';
import { p as plannedMonths, y as ytdMonths, b as fyMonths } from '../../chunks/budget_eNAazx9n.mjs';
import { O as OdooError } from '../../chunks/odoo_B4sOaK5u.mjs';
export { renderers } from '../../renderers.mjs';

const prerender = false;
const MONTH = /^\d{4}-\d{2}$/;
const POST = async ({ request }) => {
  let body = {};
  try {
    body = await request.json();
  } catch {
  }
  const known = new Set(plannedMonths());
  let months = [];
  if (Array.isArray(body.months)) {
    months = body.months.filter((m) => typeof m === "string" && MONTH.test(m));
  } else if (body.ytd && MONTH.test(body.ytd)) {
    months = ytdMonths(body.ytd).filter((m) => known.has(m));
  } else if (Number.isInteger(body.fy)) {
    months = fyMonths(body.fy).filter((m) => known.has(m));
  }
  if (!months.length) {
    return json({ error: "Nothing to fetch — pass fy, ytd, or a months array." }, 400);
  }
  try {
    return json(await backfill(months));
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
  POST,
  prerender
}, Symbol.toStringTag, { value: 'Module' }));

const page = () => _page;

export { page };
