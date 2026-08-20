import type { APIRoute } from 'astro';
import { fiscalYearMonths, monthsUpTo, sync, syncStatus } from '~/lib/sync';
import { OdooError } from '~/lib/odoo';

export const prerender = false;

const MONTH = /^\d{4}-\d{2}$/;

/** Current freshness of every stored month — cheap, no Odoo calls. */
export const GET: APIRoute = async () => {
  try {
    return json(await syncStatus());
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
};

/**
 * Runs a sync. `mode: "auto"` (the default) fetches only the months that have
 * gone stale, which is what a page load asks for; `mode: "all"` re-fetches the
 * lot, which is what the manual button asks for.
 */
export const POST: APIRoute = async ({ request }) => {
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    /* defaults are fine */
  }

  let months: string[] | undefined;
  if (Array.isArray(body.months)) {
    months = body.months.filter((m: unknown) => typeof m === 'string' && MONTH.test(m));
  } else if (typeof body.ytd === 'string' && MONTH.test(body.ytd)) {
    months = monthsUpTo(body.ytd);
  } else if (Number.isInteger(body.fy)) {
    months = fiscalYearMonths(body.fy);
  }

  try {
    return json(await sync({ mode: body.mode === 'all' ? 'all' : 'auto', months }));
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
