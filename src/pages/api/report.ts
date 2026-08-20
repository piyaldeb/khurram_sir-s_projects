import type { APIRoute } from 'astro';
import { runReport, type ReportRequest } from '~/lib/reports';
import { OdooError } from '~/lib/odoo';

export const prerender = false;

function toInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400);
  }

  if (!body?.report_type) return json({ error: 'report_type is required.' }, 400);

  const req: ReportRequest = {
    report_type: String(body.report_type),
    date_from: body.date_from || null,
    date_to: body.date_to || null,
    buyer_id: toInt(body.buyer_id),
    challan_id: toInt(body.challan_id),
  };

  try {
    const started = Date.now();
    const result = await runReport(req);
    return json({ ...result, elapsedMs: Date.now() - started });
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
