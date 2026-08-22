import type { APIRoute } from 'astro';
import { getAgeingReport, getLotsForMonth } from '~/lib/ageing';
import { OdooError } from '~/lib/odoo';

export const prerender = false;

const MONTH = /^\d{4}-\d{2}$/;

/**
 * The 180+ report, or one month's lot detail.
 *
 * The report itself is built from seven Odoo reads and comes to a few hundred
 * KB — well inside one request, and every panel on the page is a different cut
 * of the same numbers, so splitting it would only mean fetching them again.
 *
 * Lot detail is the exception: ~800 rows per month over thirty months would be
 * megabytes, and only the month on screen is ever wanted. `?lots=YYYY-MM`
 * fetches that one month; `?refresh=1` skips the server-side caches.
 */
export const GET: APIRoute = async ({ url }) => {
  const lots = url.searchParams.get('lots');

  try {
    if (lots !== null) {
      if (!MONTH.test(lots)) return json({ error: 'lots must look like 2026-08' }, 400);
      return json({ month: lots, lots: await getLotsForMonth(lots) });
    }
    return json(await getAgeingReport(url.searchParams.get('refresh') === '1'));
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
