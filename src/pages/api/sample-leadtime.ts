import type { APIRoute } from 'astro';
import {
  COMPANIES,
  DATASETS,
  aggregate,
  availableFys,
  fyLabel,
  getLeadFy,
  normaliseNo,
  type CompanyKey,
  type Dataset,
  type LeadRow,
} from '~/lib/sampletime';
import { OdooError } from '~/lib/odoo';

export const prerender = false;

/** A fiscal year runs to ~22,000 samples; the wire carries a page of them. */
const PAGE = 200;
const MAX_PAGE = 1000;

/**
 * Sample lead time for one fiscal year, filtered and paged.
 *
 * Aggregates are computed over everything the filters match, not over the page
 * — a mean that changed when you turned the page would be worthless. Only the
 * rows are cut down, because a year of them is several megabytes.
 *
 * `?fy=2025&q=DEFACTO&only=negative&sort=lead&dir=asc&offset=0&limit=200`
 */
export const GET: APIRoute = async ({ url }) => {
  const p = url.searchParams;

  const fy = Number(p.get('fy') ?? availableFys().at(-1));
  if (!Number.isInteger(fy) || fy < 2015 || fy > 2100) {
    return json({ error: 'fy must be a year, e.g. 2026 for FY 26-27' }, 400);
  }

  const dataset = (p.get('dataset') ?? 'sample') as Dataset;
  if (!DATASETS.some((d) => d.key === dataset)) {
    return json({ error: 'dataset must be sample or bulk' }, 400);
  }

  const company = p.get('company') ?? 'all';
  const wanted: CompanyKey[] =
    company === 'all'
      ? COMPANIES.map((c) => c.key)
      : COMPANIES.filter((c) => c.key === company).map((c) => c.key);
  if (!wanted.length) return json({ error: 'company must be all, zipper or mt' }, 400);

  const month = p.get('month') ?? '';
  if (month && !/^\d{4}-\d{2}$/.test(month)) {
    return json({ error: 'month must look like 2026-08' }, 400);
  }

  try {
    const data = await getLeadFy(fy, dataset, wanted, p.get('refresh') === '1');

    // Every month of the year, before the month filter narrows it — the picker
    // has to keep offering the months the filter is hiding.
    const months = [...new Set(data.rows.map((r) => r.date.slice(0, 7)))].sort();
    const yearRows = data.rows.length;

    let rows: LeadRow[] = data.rows;
    if (month) rows = rows.filter((r) => r.date.startsWith(month));
    const query = (p.get('q') ?? '').trim();
    if (query) rows = rows.filter(matcher(query));

    const only = p.get('only') ?? 'all';
    if (only === 'negative') rows = rows.filter((r: LeadRow) => r.lead < 0);
    else if (only === 'pending') rows = rows.filter((r: LeadRow) => r.pending);
    else if (only === 'revised') rows = rows.filter((r: LeadRow) => r.revision);
    else if (only === 'late') rows = rows.filter((r: LeadRow) => r.lead > 7);
    else if (only !== 'all') return json({ error: `unknown filter "${only}"` }, 400);


    const totals = aggregate(rows);

    const sort = (p.get('sort') ?? 'date') as keyof LeadRow;
    const dir = p.get('dir') === 'asc' ? 1 : -1;
    rows = [...rows].sort((a, b) => compare(a[sort], b[sort]) * dir);

    const offset = Math.max(Number(p.get('offset') ?? 0) || 0, 0);
    const limit = Math.min(Math.max(Number(p.get('limit') ?? PAGE) || PAGE, 1), MAX_PAGE);

    return json({
      fy,
      label: fyLabel(fy),
      dataset,
      company,
      month,
      months,
      yearRows,
      datasets: DATASETS,
      companies: COMPANIES.map((c) => ({ key: c.key, name: c.name })),
      from: data.from,
      to: data.to,
      builtAt: data.builtAt,
      holidays: data.holidays.length,
      fiscalYears: availableFys().map((y) => ({ fy: y, label: fyLabel(y) })),
      totals,
      matched: rows.length,
      offset,
      limit,
      rows: rows.slice(offset, offset + limit),
    });
  } catch (err) {
    const message = err instanceof OdooError ? err.message : (err as Error).message;
    return json({ error: message }, 502);
  }
};

/**
 * One box searches customer, buyer, sample number and OA number.
 *
 * Sample and OA numbers are compared on their digits, so "42035", "SA042035"
 * and "sa 42035" all find the same row; everything else is a plain substring.
 */
function matcher(query: string): (row: LeadRow) => boolean {
  const needle = query.toLowerCase();
  const digits = normaliseNo(query);

  return (row) => {
    if (
      row.customer.toLowerCase().includes(needle) ||
      row.buyer.toLowerCase().includes(needle) ||
      row.shade.toLowerCase().includes(needle) ||
      row.style.toLowerCase().includes(needle) ||
      row.buyingHouse.toLowerCase().includes(needle) ||
      row.productType.toLowerCase().includes(needle)
    ) {
      return true;
    }
    if (!digits) return false;
    if (normaliseNo(row.no) === digits) return true;
    return row.oas.some((oa) => normaliseNo(oa) === digits);
  };
}

function compare(a: unknown, b: unknown): number {
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  // Rows with nothing in the sorted column sink, whichever way the sort runs.
  if (an || bn) return an && bn ? 0 : an ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
