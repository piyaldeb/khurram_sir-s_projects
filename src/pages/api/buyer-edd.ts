import type { APIRoute } from 'astro';
import { OdooError } from '~/lib/odoo';
import { availableFys } from '~/lib/sampletime';
import { eddReport } from '~/lib/buyeredd';

export const prerender = false;

/**
 * Buyer expectation against our own bulk lead time, for one fiscal year.
 *
 * The first call for a year builds Odoo's PPC bulk report, which takes a while;
 * the Lead time page caches it, so a year already looked at there is instant
 * here.
 */
export const GET: APIRoute = async ({ url }) => {
  const fy = Number(url.searchParams.get('fy') ?? availableFys().at(-1));
  if (!Number.isInteger(fy) || fy < 2015 || fy > 2100) {
    return json({ error: 'fy must be a year, e.g. 2026 for FY 26-27' }, 400);
  }

  try {
    const report = await eddReport(fy);
    return json({ ...report, fiscalYears: availableFys() });
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
