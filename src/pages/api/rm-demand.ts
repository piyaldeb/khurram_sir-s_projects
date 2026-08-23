import type { APIRoute } from 'astro';
import { OdooError } from '~/lib/odoo';
import { demandReport, rowDetail } from '~/lib/rmdemand';

export const prerender = false;

const MONTH = /^\d{4}-\d{2}$/;

/**
 * The Zipper RM demand plan against Odoo.
 *
 * The plan ships with the site; consumption, stock and goods-in-transit are
 * read live for the plan's month so the sheet can be checked rather than
 * trusted. With `row`, the detail behind one line of it.
 */
export const GET: APIRoute = async ({ url }) => {
  try {
    const row = url.searchParams.get('row');
    if (row) {
      const kind = url.searchParams.get('kind');
      if (kind !== 'material' && kind !== 'slider') {
        return json({ error: 'kind must be "material" or "slider"' }, 400);
      }
      const month = url.searchParams.get('month') ?? '';
      if (!MONTH.test(month)) return json({ error: 'month must look like 2026-08' }, 400);
      return json(
        await rowDetail(kind, row, month, url.searchParams.get('group') || undefined),
      );
    }
    return json(await demandReport(url.searchParams.get('month') || undefined));
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
