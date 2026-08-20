import type { APIRoute } from 'astro';
import { emptyDoc, sanitiseDoc, computeBudget, type BudgetDoc } from '~/lib/budget';
import { getBudget, putBudget, storedMonths } from '~/lib/storage';

export const prerender = false;

const MONTH = /^\d{4}-\d{2}$/;

export const GET: APIRoute = async ({ url }) => {
  if (url.searchParams.get('list') !== null) {
    return json(await storedMonths());
  }

  const month = url.searchParams.get('month') ?? '';
  if (!MONTH.test(month)) return json({ error: 'month must look like 2026-08' }, 400);

  const stored = await getBudget<BudgetDoc>(month);
  const doc = stored ?? emptyDoc(month);
  return json({ doc, view: computeBudget(doc), stored: !!stored });
};

export const POST: APIRoute = async ({ request, url }) => {
  const month = url.searchParams.get('month') ?? '';
  if (!MONTH.test(month)) return json({ error: 'month must look like 2026-08' }, 400);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400);
  }

  const doc = sanitiseDoc(body, month);
  await putBudget(month, doc);
  return json({ doc, view: computeBudget(doc), saved: true });
};

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
