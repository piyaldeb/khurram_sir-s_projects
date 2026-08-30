import type { APIRoute } from 'astro';
import {
  COMPANIES,
  DIMENSIONS,
  availableFys,
  breakdown,
  byQuarter,
  fyLabel,
  getConversionFy,
  saKey,
  totalsOf,
  type CompanyKey,
  type Dimension,
  type SampleRow,
} from '~/lib/sampleconv';
import { OdooError } from '~/lib/odoo';

export const prerender = false;

/** A fiscal year runs to ~20,000 samples; the wire carries a page of them. */
const PAGE = 200;
const MAX_PAGE = 1000;

/**
 * Sample-to-bulk conversion for one fiscal year, by quarter.
 *
 * The quarter, buyer and headline figures are computed over everything the
 * filters match, not over the page — a conversion rate that changed when you
 * turned the page would be worthless. Only the sample rows are cut down.
 *
 * `?fy=2025&company=all&quarter=2025-Q2&only=converted&q=DEFACTO&offset=0`
 */
export const GET: APIRoute = async ({ url }) => {
  const p = url.searchParams;

  const fy = Number(p.get('fy') ?? availableFys().at(-1));
  if (!Number.isInteger(fy) || fy < 2015 || fy > 2100) {
    return json({ error: 'fy must be a year, e.g. 2026 for FY 26-27' }, 400);
  }

  const company = p.get('company') ?? 'all';
  const wanted: CompanyKey[] =
    company === 'all'
      ? COMPANIES.map((c) => c.key)
      : COMPANIES.filter((c) => c.key === company).map((c) => c.key);
  if (!wanted.length) return json({ error: 'company must be all, zipper or mt' }, 400);

  const quarter = p.get('quarter') ?? '';
  if (quarter && !/^\d{4}-Q[1-4]$/.test(quarter)) {
    return json({ error: 'quarter must look like 2025-Q2' }, 400);
  }

  try {
    const data = await getConversionFy(fy, wanted, p.get('refresh') === '1');

    // The search narrows everything, the quarter chip narrows everything except
    // the quarter table — which has to keep showing the quarters it is hiding,
    // or picking one would empty the picker you picked it from.
    let rows: SampleRow[] = data.rows;
    const query = (p.get('q') ?? '').trim();
    if (query) rows = rows.filter(matcher(query));

    const quarters = byQuarter(rows, fy, data.adoptedAt);

    if (quarter) {
      const [, q] = quarter.split('-Q');
      rows = rows.filter((r) => {
        const [y, m] = r.date.slice(0, 7).split('-').map(Number);
        const rowFy = m >= 4 ? y : y - 1;
        return `${rowFy}-Q${Math.floor(((m - 4 + 12) % 12) / 3) + 1}` === `${fy}-Q${q}`;
      });
    }

    // The headline figures and the breakdowns are computed BEFORE the outcome
    // filter, and only the listed rows after it. Quarter, unit and search are
    // scope — narrowing to one buyer should narrow the rate to that buyer — but
    // "show me the converted ones" is a way of reading the list, not a
    // different population. Filtering the totals by it would report a
    // conversion rate of 100%: true of the rows on screen, and useless.
    const totals = totalsOf(rows);

    // The unit's whole year, before any of the filters. The report card reads
    // the filtered figure against this, so "79.6%" arrives as "against 11.8%
    // for the unit" rather than as a number with nothing to lean on.
    const baseline = totalsOf(data.rows);

    // Every breakdown is computed, not just the one on screen: they are cheap
    // beside the year they are computed from, and the page switches between
    // them without another round trip. Generous by default, because the page
    // sorts them itself and a reader re-ordering by conversion rate must not be
    // re-ordering a list already cut down by a different measure.
    const top = Math.min(Math.max(Number(p.get('top') ?? 100) || 100, 5), 500);
    const breakdowns = Object.fromEntries(
      DIMENSIONS.map((d) => [d.key, breakdown(rows, d.key as Dimension, top)]),
    );

    const only = p.get('only') ?? 'all';
    if (only === 'converted') rows = rows.filter((r) => r.converted);
    else if (only === 'lost') rows = rows.filter((r) => !r.converted && r.mature);
    else if (only === 'open') rows = rows.filter((r) => !r.converted && !r.mature);
    else if (only !== 'all') return json({ error: `unknown filter "${only}"` }, 400);

    const sort = (p.get('sort') ?? 'date') as keyof SampleRow;
    const dir = p.get('dir') === 'asc' ? 1 : -1;
    rows = [...rows].sort((a, b) => compare(a[sort], b[sort]) * dir);

    const offset = Math.max(Number(p.get('offset') ?? 0) || 0, 0);
    const limit = Math.min(Math.max(Number(p.get('limit') ?? PAGE) || PAGE, 1), MAX_PAGE);

    return json({
      fy,
      label: fyLabel(fy),
      company,
      quarter,
      from: data.from,
      to: data.to,
      builtAt: data.builtAt,
      stale: data.stale,
      staleError: data.staleError,
      adoptedAt: data.adoptedAt,
      maturityDays: data.maturityDays,
      fiscalYears: availableFys().map((y) => ({ fy: y, label: fyLabel(y) })),
      companies: COMPANIES.map((c) => ({ key: c.key, name: c.name, refField: c.refField })),
      quarters,
      dimensions: DIMENSIONS,
      totals,
      baseline,
      breakdowns,
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
 * One box searches buyer, customer, team, salesperson, sample and bulk number.
 *
 * Order numbers are compared on their digits, so "44490", "SA044490" and
 * "sa 44490" all find the same sample; everything else is a plain substring.
 */
function matcher(query: string): (row: SampleRow) => boolean {
  const needle = query.toLowerCase();
  const digits = saKey(query) ?? query.replace(/\D/g, '').replace(/^0+/, '');

  return (row) => {
    if (
      row.buyer.toLowerCase().includes(needle) ||
      row.customer.toLowerCase().includes(needle) ||
      row.team.toLowerCase().includes(needle) ||
      row.salesperson.toLowerCase().includes(needle) ||
      row.marketer.toLowerCase().includes(needle) ||
      row.region.toLowerCase().includes(needle) ||
      row.no.toLowerCase().includes(needle)
    ) {
      return true;
    }
    if (!digits) return false;
    if (saKey(row.no) === digits) return true;
    return row.oas.some((oa) => oa.no.replace(/\D/g, '').replace(/^0+/, '') === digits);
  };
}

function compare(a: unknown, b: unknown): number {
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  // Rows with nothing in the sorted column sink, whichever way the sort runs.
  if (an || bn) return an && bn ? 0 : an ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
