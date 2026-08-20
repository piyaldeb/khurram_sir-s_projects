import { b as fyMonths } from '../../chunks/budget_eNAazx9n.mjs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { g as getSession, p as productionCompanies, O as OdooError } from '../../chunks/odoo_B4sOaK5u.mjs';
import { g as generateReport, p as parseWorkbook } from '../../chunks/reports_B3AU53Bt.mjs';
import { s as supabaseConfig, c as cacheGetMany, a as cacheSet } from '../../chunks/supabase_C8i5aIv3.mjs';
export { renderers } from '../../renderers.mjs';

const CACHE_DIR = resolve(process.env.DATA_DIR || "data", "analytics");
const FRESH_MINUTES = Number(process.env.ODOO_SYNC_FRESH_MINUTES || 15);
const FETCH_BUDGET = Number(process.env.ANALYTICS_FETCH_PER_REQUEST || 4);
const norm = (v) => String(v ?? "").trim();
function currentMonth() {
  const now = /* @__PURE__ */ new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}
const cacheKey = (month, companyId) => {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`bad month "${month}"`);
  return `packing-${month}-c${companyId}`;
};
function cachePath(key) {
  return join(CACHE_DIR, `${key}.json`);
}
async function readCacheMany(keys) {
  if (supabaseConfig.enabled) return cacheGetMany(keys);
  const out = /* @__PURE__ */ new Map();
  for (const key of keys) {
    try {
      out.set(key, JSON.parse(await readFile(cachePath(key), "utf8")));
    } catch {
    }
  }
  return out;
}
async function writeCache(entry) {
  const key = cacheKey(entry.month, entry.companyId);
  if (supabaseConfig.enabled) {
    await cacheSet(key, entry);
    return;
  }
  const path = cachePath(key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(entry), "utf8");
}
function isFresh(entry) {
  if (entry.error) {
    return Date.now() - new Date(entry.fetchedAt).getTime() < FRESH_MINUTES * 6e4;
  }
  if (entry.month < currentMonth()) return true;
  return Date.now() - new Date(entry.fetchedAt).getTime() < FRESH_MINUTES * 6e4;
}
function lastDayOf(month) {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}
async function fetchMonth(month, company) {
  const entry = {
    month,
    companyId: company.id,
    companyName: company.name,
    totals: { value: 0, lines: 0 },
    byItem: {},
    byBuyer: {},
    byCustomer: {},
    fetchedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  try {
    const artifact = await generateReport({
      report_type: "dppr_",
      date_from: `${month}-01`,
      date_to: lastDayOf(month),
      company_id: company.id
    });
    const workbook = await parseWorkbook(artifact.buffer, artifact.filename);
    const sheet = workbook.sheets[0];
    if (!sheet) return entry;
    const headerIndex = sheet.headerRow >= 0 ? sheet.headerRow : 0;
    const headers = (sheet.rows[headerIndex] ?? []).map((c) => norm(c?.v).toUpperCase());
    const col = (name) => headers.findIndex((h) => h === name);
    const qtyCol = col("QTY");
    const priceCol = col("PRICE");
    const itemCol = col("ITEM");
    const buyerCol = col("BUYER");
    const customerCol = col("CUSTOMER");
    const bump = (map, key, value) => {
      const name = key || "(unspecified)";
      const slot = map[name] ??= { value: 0, lines: 0 };
      slot.value += value;
      slot.lines += 1;
    };
    const cellNum = (row, c) => c >= 0 && typeof row[c]?.v === "number" ? row[c].v : null;
    for (let r = headerIndex + 1; r < sheet.rows.length; r++) {
      const row = sheet.rows[r] ?? [];
      if (norm(row[0]?.v).toUpperCase() === "TOTAL") continue;
      const qty = cellNum(row, qtyCol);
      const price = cellNum(row, priceCol);
      if (qty === null || price === null) continue;
      const value = qty * price;
      entry.totals.value += value;
      entry.totals.lines += 1;
      bump(entry.byItem, norm(row[itemCol]?.v), value);
      bump(entry.byBuyer, norm(row[buyerCol]?.v), value);
      bump(entry.byCustomer, norm(row[customerCol]?.v), value);
    }
  } catch (err) {
    const message = err.message;
    if (!/no data/i.test(message)) entry.error = message;
  }
  await writeCache(entry);
  return entry;
}
async function rangePacking(months, budget = FETCH_BUDGET) {
  const session = await getSession();
  const companies = productionCompanies(session);
  const jobs = months.flatMap((month) => companies.map((company) => ({ month, company })));
  const cached = await readCacheMany(jobs.map((j) => cacheKey(j.month, j.company.id)));
  const have = [];
  const missing = [];
  for (const job of jobs) {
    const entry = cached.get(cacheKey(job.month, job.company.id));
    if (entry && isFresh(entry)) have.push(entry);
    else missing.push(job);
  }
  missing.sort((a, b) => b.month.localeCompare(a.month));
  const toFetch = missing.slice(0, Math.max(budget, 0));
  const pending = missing.slice(toFetch.length);
  const CONCURRENCY = 2;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, toFetch.length) }, async () => {
      while (next < toFetch.length) {
        const job = toFetch[next++];
        have.push(await fetchMonth(job.month, job.company));
      }
    })
  );
  return {
    months: have,
    pending: pending.map((j) => ({ month: j.month, company: j.company.name })),
    fetched: toFetch.length
  };
}

function classify(merged) {
  const total = [...merged.values()].reduce((a, e) => a + e.value, 0);
  const rows = [...merged.entries()].map(([name, e]) => ({ name, value: e.value, lines: e.lines, share: 0, cumShare: 0, cls: "C" })).sort((a, b) => b.value - a.value);
  let cum = 0;
  const counts = { A: 0, B: 0, C: 0 };
  for (const row of rows) {
    cum += row.value;
    row.share = total ? row.value / total : 0;
    row.cumShare = total ? cum / total : 0;
    row.cls = row.cumShare <= 0.8 ? "A" : row.cumShare <= 0.95 ? "B" : "C";
    counts[row.cls]++;
  }
  return { rows, counts, total };
}
function merge(months, pick) {
  const out = /* @__PURE__ */ new Map();
  for (const m of months) {
    for (const [name, e] of Object.entries(pick(m))) {
      const slot = out.get(name) ?? { value: 0, lines: 0 };
      slot.value += e.value;
      slot.lines += e.lines;
      out.set(name, slot);
    }
  }
  return out;
}
async function fiscalYearAnalytics(fy, companyFilter = "all", budget) {
  const months = fyMonths(fy);
  const { months: all, pending } = await rangePacking(months, budget);
  const companies = /* @__PURE__ */ new Map();
  for (const m of all) {
    const slot = companies.get(m.companyId) ?? {
      id: m.companyId,
      name: m.companyName,
      value: 0,
      lines: 0
    };
    slot.value += m.totals.value;
    slot.lines += m.totals.lines;
    companies.set(m.companyId, slot);
  }
  const scoped = companyFilter === "all" ? all : all.filter((m) => m.companyId === companyFilter);
  const byMonth = months.map((month) => {
    const slice = scoped.filter((m) => m.month === month);
    const byCompany = {};
    for (const m of slice) byCompany[m.companyId] = (byCompany[m.companyId] ?? 0) + m.totals.value;
    return { month, byCompany, total: slice.reduce((a, m) => a + m.totals.value, 0) };
  });
  return {
    fy,
    months,
    companyFilter,
    companies: [...companies.values()].sort((a, b) => b.value - a.value),
    totals: {
      value: scoped.reduce((a, m) => a + m.totals.value, 0),
      lines: scoped.reduce((a, m) => a + m.totals.lines, 0)
    },
    byItem: classify(merge(scoped, (m) => m.byItem)),
    byBuyer: classify(merge(scoped, (m) => m.byBuyer)),
    byCustomer: classify(merge(scoped, (m) => m.byCustomer)),
    byMonth,
    failed: all.filter((m) => m.error).map((m) => ({ month: m.month, company: m.companyName, error: m.error })),
    pending,
    ready: pending.length === 0,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}

const prerender = false;
const GET = async ({ url }) => {
  const fy = Number(url.searchParams.get("fy"));
  if (!Number.isInteger(fy) || fy < 2e3 || fy > 2100) {
    return json({ error: "fy must be a year, e.g. 2025 for FY 25-26" }, 400);
  }
  const companyRaw = url.searchParams.get("company") ?? "all";
  const company = companyRaw === "all" ? "all" : Number(companyRaw);
  if (company !== "all" && !Number.isInteger(company)) {
    return json({ error: 'company must be "all" or a company id' }, 400);
  }
  try {
    const budget = Number(url.searchParams.get("batch"));
    return json(
      await fiscalYearAnalytics(fy, company, Number.isFinite(budget) && budget > 0 ? budget : void 0)
    );
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
  prerender
}, Symbol.toStringTag, { value: 'Module' }));

const page = () => _page;

export { page };
