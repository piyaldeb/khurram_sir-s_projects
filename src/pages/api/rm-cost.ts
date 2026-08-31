import type { APIRoute } from 'astro';
import { OdooError } from '~/lib/odoo';
import { costReport, EARLIEST_MONTH, todayMonth } from '~/lib/rmcost';

export const prerender = false;

const MONTH = /^\d{4}-\d{2}$/;

/**
 * Material cost against selling price, for one month or for all of them.
 *
 * `month` omitted, or `all`, reports every month that carries BOM data.
 * `refresh=1` rebuilds rather than trusting the cache.
 */
export const GET: APIRoute = async ({ url }) => {
  try {
    const raw = url.searchParams.get('month');
    const month = !raw || raw === 'all' ? null : raw;

    if (month !== null) {
      if (!MONTH.test(month)) return json({ error: 'month must look like 2026-08' }, 400);
      if (month < EARLIEST_MONTH || month > todayMonth()) {
        return json(
          { error: `month must fall between ${EARLIEST_MONTH} and ${todayMonth()}` },
          400,
        );
      }
    }

    return json(await costReport(month, url.searchParams.get('refresh') === '1'));
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
