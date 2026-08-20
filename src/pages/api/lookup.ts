import type { APIRoute } from 'astro';
import { availableChallans, listWorkcenters, searchBuyers } from '~/lib/reports';
import { OdooError } from '~/lib/odoo';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const kind = url.searchParams.get('kind');
  try {
    switch (kind) {
      case 'buyers':
        return json(await searchBuyers(url.searchParams.get('q') ?? ''));
      case 'challans':
        return json(await availableChallans(url.searchParams.get('report_type') ?? ''));
      case 'workcenters':
        return json(await listWorkcenters());
      default:
        return json({ error: 'kind must be one of: buyers, challans, workcenters' }, 400);
    }
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
