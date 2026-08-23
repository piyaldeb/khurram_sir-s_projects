import type { APIRoute } from 'astro';
import { OdooError } from '~/lib/odoo';
import { oaHistory, productDetail, type MonthRange } from '~/lib/oarelease';

export const prerender = false;

const MONTH = /^\d{4}-\d{2}$/;

/**
 * OA released, by product and company.
 *
 * Without parameters: every month Odoo holds, from the cache. A cold cache is
 * filled a few months per call, so the page keeps asking while `ready` is
 * false. With `product`: the variants, codes, customers and recent OAs behind
 * one product, read live — the month history the page already has.
 */
export const GET: APIRoute = async ({ url }) => {
  const product = url.searchParams.get('product');

  try {
    if (product) {
      const raw = url.searchParams.get('company');
      const company = raw && raw !== 'all' ? Number(raw) : null;
      if (company !== null && !Number.isInteger(company)) {
        return json({ error: 'company must be "all" or a company id' }, 400);
      }

      // Both or neither: half a range would silently read from 2023.
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      let range: MonthRange | null = null;
      if (from || to) {
        if (!from || !to || !MONTH.test(from) || !MONTH.test(to) || from > to) {
          return json({ error: 'from and to must both look like 2026-08, from first' }, 400);
        }
        range = { from, to };
      }

      return json(await productDetail(product, company, range));
    }

    const batch = Number(url.searchParams.get('batch'));
    return json(await oaHistory(Number.isFinite(batch) && batch > 0 ? batch : undefined));
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
