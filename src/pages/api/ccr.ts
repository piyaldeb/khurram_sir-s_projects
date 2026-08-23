import type { APIRoute } from 'astro';
import { OdooError } from '~/lib/odoo';
import { ccrReport } from '~/lib/ccr';

export const prerender = false;

/**
 * Every customer complaint Odoo holds.
 *
 * The table is around a thousand rows, so it goes over in one cached read and
 * the page does its own filtering and grouping.
 */
export const GET: APIRoute = async () => {
  try {
    return json(await ccrReport());
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
