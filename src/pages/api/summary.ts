import type { APIRoute } from 'astro';
import { availableFiscalYears, fiscalYearSummary, yearToDateSummary } from '~/lib/summary';
import { availableMonths } from '~/lib/summary';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const fy = url.searchParams.get('fy');
  const ytd = url.searchParams.get('ytd');

  try {
    if (ytd) {
      if (!/^\d{4}-\d{2}$/.test(ytd)) return json({ error: 'ytd must look like 2026-08' }, 400);
      return json(await yearToDateSummary(ytd));
    }
    if (fy) {
      const year = Number(fy);
      if (!Number.isInteger(year)) return json({ error: 'fy must be a year, e.g. 2025' }, 400);
      return json(await fiscalYearSummary(year));
    }
    return json({ fiscalYears: availableFiscalYears(), months: availableMonths() });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
};

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
