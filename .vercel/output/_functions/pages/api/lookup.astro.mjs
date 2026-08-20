import { l as listWorkcenters, a as availableChallans, s as searchBuyers } from '../../chunks/reports_B3AU53Bt.mjs';
import { O as OdooError } from '../../chunks/odoo_B4sOaK5u.mjs';
export { renderers } from '../../renderers.mjs';

const prerender = false;
const GET = async ({ url }) => {
  const kind = url.searchParams.get("kind");
  try {
    switch (kind) {
      case "buyers":
        return json(await searchBuyers(url.searchParams.get("q") ?? ""));
      case "challans":
        return json(await availableChallans(url.searchParams.get("report_type") ?? ""));
      case "workcenters":
        return json(await listWorkcenters());
      default:
        return json({ error: "kind must be one of: buyers, challans, workcenters" }, 400);
    }
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
