import { g as generateReport } from '../../chunks/reports_B3AU53Bt.mjs';
import { O as OdooError } from '../../chunks/odoo_B4sOaK5u.mjs';
export { renderers } from '../../renderers.mjs';

const prerender = false;
const GET = async ({ url }) => {
  const reportType = url.searchParams.get("report_type");
  if (!reportType) return new Response("report_type is required", { status: 400 });
  try {
    const artifact = await generateReport({
      report_type: reportType,
      date_from: url.searchParams.get("date_from"),
      date_to: url.searchParams.get("date_to"),
      buyer_id: Number(url.searchParams.get("buyer_id")) || null,
      challan_id: Number(url.searchParams.get("challan_id")) || null
    });
    return new Response(artifact.buffer, {
      headers: {
        "content-type": artifact.contentType,
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`,
        "cache-control": "no-store"
      }
    });
  } catch (err) {
    const message = err instanceof OdooError ? err.message : err.message;
    return new Response(message, { status: 502, headers: { "content-type": "text/plain" } });
  }
};

const _page = /*#__PURE__*/Object.freeze(/*#__PURE__*/Object.defineProperty({
  __proto__: null,
  GET,
  prerender
}, Symbol.toStringTag, { value: 'Module' }));

const page = () => _page;

export { page };
