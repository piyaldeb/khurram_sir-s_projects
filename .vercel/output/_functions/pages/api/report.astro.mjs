import { r as runReport } from '../../chunks/reports_B3AU53Bt.mjs';
import { O as OdooError } from '../../chunks/odoo_B4sOaK5u.mjs';
export { renderers } from '../../renderers.mjs';

const prerender = false;
function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
const POST = async ({ request }) => {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Expected a JSON body." }, 400);
  }
  if (!body?.report_type) return json({ error: "report_type is required." }, 400);
  const req = {
    report_type: String(body.report_type),
    date_from: body.date_from || null,
    date_to: body.date_to || null,
    buyer_id: toInt(body.buyer_id),
    challan_id: toInt(body.challan_id)
  };
  try {
    const started = Date.now();
    const result = await runReport(req);
    return json({ ...result, elapsedMs: Date.now() - started });
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
