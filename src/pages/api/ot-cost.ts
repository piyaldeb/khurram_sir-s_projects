import type { APIRoute } from 'astro';
import { buildOtReport, fyReportMonths, type BuScope, type OtReport } from '~/lib/otanalysis';
import {
  EARLIEST_MONTH,
  fyLabel,
  fyOfMonth,
  monthLabel,
  otMonthOf,
  todayIso,
} from '~/lib/otcost';
import { OdooError } from '~/lib/odoo';

export const prerender = false;

const MONTH = /^\d{4}-\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * OT cost for one OT month, one fiscal year, or a fiscal year to date.
 *
 * A cold fiscal year is 36 Odoo report builds at ~8s each, far more than one
 * request allows, so this fills a few per call and reports what is still
 * pending; the page polls until nothing is.
 *
 * `?day=YYYY-MM-DD` returns just that day's per-section breakdown. It is a
 * drill-down opened one day at a time, and carrying every day's sections in the
 * main payload made them 93% of it — 850KB of a 914KB year-to-date response.
 */
export const GET: APIRoute = async ({ url }) => {
  const scope = (url.searchParams.get('scope') ?? 'ytd') as 'month' | 'fy' | 'ytd';
  if (!['month', 'fy', 'ytd'].includes(scope)) {
    return json({ error: 'scope must be month, fy or ytd' }, 400);
  }

  const company = companyOf(url);
  if (company === null) {
    return json({ error: 'company must be all, zipper or mt (1 and 3 also work)' }, 400);
  }

  const day = url.searchParams.get('day');
  if (day !== null && !DATE.test(day)) {
    return json({ error: 'day must look like 2026-08-14' }, 400);
  }

  const currentMonth = otMonthOf(todayIso());

  try {
    if (scope === 'month') {
      const month = url.searchParams.get('month') ?? currentMonth;
      if (!MONTH.test(month)) return json({ error: 'month must look like 2026-08' }, 400);
      if (month < EARLIEST_MONTH) {
        return json({ error: `Odoo has no OT data before ${monthLabel(EARLIEST_MONTH)}.` }, 400);
      }
      return respond(
        await buildOtReport({
          scope,
          fy: fyOfMonth(month),
          months: [month],
          label: monthLabel(month),
          company,
          budget: batchOf(url),
        }),
        day,
      );
    }

    const fy = Number(url.searchParams.get('fy') ?? fyOfMonth(currentMonth));
    if (!Number.isInteger(fy) || fy < 2000 || fy > 2100) {
      return json({ error: 'fy must be a year, e.g. 2026 for FY 26-27' }, 400);
    }

    // Never ask Odoo for months outside what it holds, or for months that have
    // not started — both cost a full report build and come back empty.
    const months = fyReportMonths(fy, scope, currentMonth).filter((m) => m >= EARLIEST_MONTH);
    if (!months.length) {
      return json({ error: `${fyLabel(fy)} is outside the range Odoo holds OT data for.` }, 400);
    }

    return respond(
      await buildOtReport({
        scope,
        fy,
        months,
        label: scope === 'fy' ? fyLabel(fy) : `${fyLabel(fy)} to date`,
        company,
        budget: batchOf(url),
      }),
      day,
    );
  } catch (err) {
    const message = err instanceof OdooError ? err.message : (err as Error).message;
    return json({ error: message }, 502);
  }
};

/**
 * One day's breakdown, or the report with every day's breakdown left out.
 *
 * The report is rebuilt either way — the parsed job-months behind it are cached,
 * so that is fast — and only the shape of the answer differs.
 */
function respond(report: OtReport, day: string | null) {
  if (day !== null) {
    const found = report.days.find((d) => d.date === day);
    if (!found) return json({ error: `${day} is not in ${report.label}.` }, 404);
    return json({ date: found.date, total: found.total, sections: found.sections });
  }

  return json({
    ...report,
    days: report.days.map(({ sections, ...rest }) => rest),
  });
}

/**
 * The business unit to scope to.
 *
 * Odoo company ids are accepted too, because that is what the rest of the site
 * uses to name these two: 1 is Zipper, 3 is Metal Trims.
 */
function companyOf(url: URL): BuScope | null {
  const raw = (url.searchParams.get('company') ?? 'all').trim().toLowerCase();
  if (raw === 'all') return 'all';
  if (raw === 'zipper' || raw === '1') return 'zipper';
  if (raw === 'mt' || raw === 'metal trims' || raw === '3') return 'mt';
  return null;
}

/** Lets a caller (or a warm-up script) widen how much one request may fetch. */
function batchOf(url: URL): number | undefined {
  const param = url.searchParams.get('batch');
  if (param === null) return undefined;
  const raw = Number(param);
  return Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
