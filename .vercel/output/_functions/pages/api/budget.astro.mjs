import { e as emptyDoc, c as computeBudget, s as sanitiseDoc } from '../../chunks/budget_eNAazx9n.mjs';
import { s as storedMonths, g as getBudget, p as putBudget } from '../../chunks/storage_BFhx3OVS.mjs';
export { renderers } from '../../renderers.mjs';

const prerender = false;
const MONTH = /^\d{4}-\d{2}$/;
const GET = async ({ url }) => {
  if (url.searchParams.get("list") !== null) {
    return json(await storedMonths());
  }
  const month = url.searchParams.get("month") ?? "";
  if (!MONTH.test(month)) return json({ error: "month must look like 2026-08" }, 400);
  const stored = await getBudget(month);
  const doc = stored ?? emptyDoc(month);
  return json({ doc, view: computeBudget(doc), stored: !!stored });
};
const POST = async ({ request, url }) => {
  const month = url.searchParams.get("month") ?? "";
  if (!MONTH.test(month)) return json({ error: "month must look like 2026-08" }, 400);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Expected a JSON body." }, 400);
  }
  const doc = sanitiseDoc(body, month);
  await putBudget(month, doc);
  return json({ doc, view: computeBudget(doc), saved: true });
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
  POST,
  prerender
}, Symbol.toStringTag, { value: 'Module' }));

const page = () => _page;

export { page };
