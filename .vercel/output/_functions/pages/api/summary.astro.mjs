import { y as yearToDateSummary, f as fiscalYearSummary, a as availableMonths, b as availableFiscalYears } from '../../chunks/summary_D8M14kWi.mjs';
export { renderers } from '../../renderers.mjs';

const prerender = false;
const GET = async ({ url }) => {
  const fy = url.searchParams.get("fy");
  const ytd = url.searchParams.get("ytd");
  try {
    if (ytd) {
      if (!/^\d{4}-\d{2}$/.test(ytd)) return json({ error: "ytd must look like 2026-08" }, 400);
      return json(await yearToDateSummary(ytd));
    }
    if (fy) {
      const year = Number(fy);
      if (!Number.isInteger(year)) return json({ error: "fy must be a year, e.g. 2025" }, 400);
      return json(await fiscalYearSummary(year));
    }
    return json({ fiscalYears: availableFiscalYears(), months: availableMonths() });
  } catch (err) {
    return json({ error: err.message }, 500);
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
