import type { APIRoute } from 'astro';
import { fetchMonthProduction } from '~/lib/production';
import { DEFAULT_SOURCE, type BudgetSource } from '~/lib/budget';
import { OdooError } from '~/lib/odoo';

export const prerender = false;

const MONTH = /^\d{4}-\d{2}$/;

/** Reads a month's daily Zipper / Metal Trims production out of Odoo. */
export const GET: APIRoute = async ({ url }) => {
  const month = url.searchParams.get('month') ?? '';
  if (!MONTH.test(month)) return json({ error: 'month must look like 2026-08' }, 400);

  const source: BudgetSource = {
    ...DEFAULT_SOURCE,
    reportType: url.searchParams.get('report_type') || DEFAULT_SOURCE.reportType,
    unit: url.searchParams.get('unit') ?? DEFAULT_SOURCE.unit,
  };

  try {
    return json(await fetchMonthProduction(month, source));
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
