import type { APIRoute } from 'astro';
import { fetchDayReport, yesterdayIso } from '~/lib/dayReport';
import { OdooError } from '~/lib/odoo';

export const prerender = false;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One day's MRP Invoice report, per company. Defaults to yesterday. */
export const GET: APIRoute = async ({ url }) => {
  const date = url.searchParams.get('date') || yesterdayIso();
  if (!DATE.test(date)) return json({ error: 'date must look like 2026-08-19' }, 400);

  try {
    return json(await fetchDayReport(date));
  } catch (err) {
    const message = err instanceof OdooError ? err.message : (err as Error).message;
    return json({ error: message }, 502);
  }
};

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
