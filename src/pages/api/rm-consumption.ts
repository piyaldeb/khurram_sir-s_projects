import type { APIRoute } from 'astro';
import { OdooError } from '~/lib/odoo';
import { DEFAULT_DIMENSION, isDimension, memberDetail, rmHistory } from '~/lib/rmconsumption';

export const prerender = false;

const MONTH = /^\d{4}-\d{2}$/;

/**
 * RM consumption, from Odoo's monthly raw-material ledger.
 *
 * Without `member`: every month, cut by one dimension. With `member`: the
 * items, vendors and product lines behind one row of that cut, scoped to the
 * same months and company the row is counting.
 */
export const GET: APIRoute = async ({ url }) => {
  const dim = url.searchParams.get('dim') ?? DEFAULT_DIMENSION;
  if (!isDimension(dim)) return json({ error: `unknown dimension "${dim}"` }, 400);

  const raw = url.searchParams.get('company');
  const company = raw && raw !== 'all' ? Number(raw) : null;
  if (company !== null && !Number.isInteger(company)) {
    return json({ error: 'company must be "all" or a company id' }, 400);
  }

  // Both or neither: half a range would silently read from 2021.
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (from || to) {
    if (!from || !to || !MONTH.test(from) || !MONTH.test(to) || from > to) {
      return json({ error: 'from and to must both look like 2026-08, from first' }, 400);
    }
  }

  try {
    const member = url.searchParams.get('member');
    if (member) {
      const range = from && to ? { from, to } : null;
      return json(await memberDetail(dim, member, company, range));
    }
    return json(await rmHistory(dim));
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
