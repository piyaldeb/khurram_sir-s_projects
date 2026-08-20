import { b as backfill } from '../../chunks/backfill_Da51PbYr.mjs';
import { p as plannedMonths, b as fyMonths, f as fyOf } from '../../chunks/budget_eNAazx9n.mjs';
import { a as getBudgets } from '../../chunks/storage_BFhx3OVS.mjs';
import { O as OdooError } from '../../chunks/odoo_B4sOaK5u.mjs';
export { renderers } from '../../renderers.mjs';

const FRESH_MINUTES = Number(process.env.ODOO_SYNC_FRESH_MINUTES || 15);
const CLOSE_GRACE_DAYS = 2;
const endOfMonth = (month) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1));
};
const currentMonth = () => {
  const now = /* @__PURE__ */ new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
};
function isStale(month, lastFilledAt) {
  if (!lastFilledAt) return true;
  const filled = new Date(lastFilledAt).getTime();
  if (!Number.isFinite(filled)) return true;
  if (month >= currentMonth()) {
    return Date.now() - filled > FRESH_MINUTES * 6e4;
  }
  return filled < endOfMonth(month).getTime() + CLOSE_GRACE_DAYS * 864e5;
}
let inFlight = null;
let lastRun = null;
async function syncStatus(months) {
  const list = months?.length ? months : plannedMonths();
  const stored = await getBudgets(list);
  const rows = list.map((month) => {
    const doc = stored.get(month);
    const lastFilledAt = doc?.source?.lastFilledAt ?? null;
    return {
      month,
      lastFilledAt,
      producingDays: (doc?.days ?? []).filter((d) => (d.zipper ?? 0) + (d.mt ?? 0) > 0).length,
      stale: isStale(month, lastFilledAt)
    };
  });
  const stamps = rows.map((r) => r.lastFilledAt).filter(Boolean);
  return {
    months: rows,
    lastSyncedAt: stamps.length ? stamps.sort().at(-1) : null,
    staleMonths: rows.filter((r) => r.stale).map((r) => r.month),
    syncing: inFlight !== null
  };
}
async function sync(options = {}) {
  const { mode = "auto", months } = options;
  const status = await syncStatus(months);
  const targets = mode === "all" ? status.months.map((m) => m.month) : status.staleMonths;
  if (!targets.length) {
    return { ran: false, skipped: true, months: [], result: null, status };
  }
  if (inFlight) {
    const result = await inFlight;
    return { ran: false, skipped: true, months: [], result, status: await syncStatus(months) };
  }
  inFlight = backfill(targets);
  try {
    const result = await inFlight;
    lastRun = { at: (/* @__PURE__ */ new Date()).toISOString(), result };
    return { ran: true, skipped: false, months: targets, result, status: await syncStatus(months) };
  } finally {
    inFlight = null;
  }
}
function fiscalYearMonths(fy) {
  const known = new Set(plannedMonths());
  return fyMonths(fy).filter((m) => known.has(m));
}
function monthsUpTo(month) {
  const known = new Set(plannedMonths());
  return fyMonths(fyOf(month)).filter((m) => known.has(m) && m <= month);
}

const prerender = false;
const MONTH = /^\d{4}-\d{2}$/;
const GET = async () => {
  try {
    return json(await syncStatus());
  } catch (err) {
    return json({ error: err.message }, 500);
  }
};
const POST = async ({ request }) => {
  let body = {};
  try {
    body = await request.json();
  } catch {
  }
  let months;
  if (Array.isArray(body.months)) {
    months = body.months.filter((m) => typeof m === "string" && MONTH.test(m));
  } else if (typeof body.ytd === "string" && MONTH.test(body.ytd)) {
    months = monthsUpTo(body.ytd);
  } else if (Number.isInteger(body.fy)) {
    months = fiscalYearMonths(body.fy);
  }
  try {
    return json(await sync({ mode: body.mode === "all" ? "all" : "auto", months }));
  } catch (err) {
    const message = err instanceof OdooError ? err.message : err.message;
    return json({ error: message }, 502);
  }
};
function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

const _page = /*#__PURE__*/Object.freeze(/*#__PURE__*/Object.defineProperty({
  __proto__: null,
  GET,
  POST,
  prerender
}, Symbol.toStringTag, { value: 'Module' }));

const page = () => _page;

export { page };
