import type { APIRoute } from 'astro';
import { fiscalYearAnalytics } from '~/lib/abc';
import { OdooError } from '~/lib/odoo';

export const prerender = false;

/**
 * ABC analytics for one fiscal year.
 *
 * The first call for a year builds up to 24 monthly packing reports in Odoo
 * and can take a couple of minutes; every later call reads the cache and only
 * refreshes the current month.
 */
export const GET: APIRoute = async ({ url }) => {
  const fy = Number(url.searchParams.get('fy'));
  if (!Number.isInteger(fy) || fy < 2000 || fy > 2100) {
    return json({ error: 'fy must be a year, e.g. 2025 for FY 25-26' }, 400);
  }

  const companyRaw = url.searchParams.get('company') ?? 'all';
  const company = companyRaw === 'all' ? ('all' as const) : Number(companyRaw);
  if (company !== 'all' && !Number.isInteger(company)) {
    return json({ error: 'company must be "all" or a company id' }, 400);
  }

  try {
    return json(await fiscalYearAnalytics(fy, company));
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
