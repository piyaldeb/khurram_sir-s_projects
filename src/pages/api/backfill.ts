import type { APIRoute } from 'astro';
import { backfill } from '~/lib/backfill';
import { fyMonths, plannedMonths, ytdMonths } from '~/lib/budget';
import { OdooError } from '~/lib/odoo';

export const prerender = false;

const MONTH = /^\d{4}-\d{2}$/;

/** Fetches and saves production for a whole fiscal year, YTD, or month list. */
export const POST: APIRoute = async ({ request }) => {
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    /* an empty body is fine - the query decides */
  }

  const known = new Set(plannedMonths());
  let months: string[] = [];

  if (Array.isArray(body.months)) {
    months = body.months.filter((m: unknown) => typeof m === 'string' && MONTH.test(m));
  } else if (body.ytd && MONTH.test(body.ytd)) {
    months = ytdMonths(body.ytd).filter((m) => known.has(m));
  } else if (Number.isInteger(body.fy)) {
    months = fyMonths(body.fy).filter((m) => known.has(m));
  }

  if (!months.length) {
    return json({ error: 'Nothing to fetch — pass fy, ytd, or a months array.' }, 400);
  }

  try {
    return json(await backfill(months));
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
