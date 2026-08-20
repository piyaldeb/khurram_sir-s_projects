import { g as getSession, p as productionCompanies, O as OdooError } from './odoo_B4sOaK5u.mjs';
import { g as generateReport, p as parseWorkbook } from './reports_B3AU53Bt.mjs';
import { D as DEFAULT_SOURCE, M as MT_AMBIGUOUS } from './budget_eNAazx9n.mjs';

const norm = (s) => String(s ?? "").trim().toUpperCase();
function parseReportDate(value) {
  if (value === null || value === void 0 || typeof value === "number") return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /^(\d{1,2})[-/ ]([A-Za-z]{3,})[-/ ](\d{4})$/.exec(s);
  if (m) {
    const month = (/* @__PURE__ */ new Date(`${m[2]} 1, 2000`)).getMonth();
    if (Number.isNaN(month)) return null;
    return `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
function planSheet(sheet, source) {
  const headerRow = sheet.headerRow >= 0 ? sheet.headerRow : 0;
  const headers = (sheet.rows[headerRow] ?? []).map(
    (c, i) => c?.v !== null && c?.v !== void 0 ? String(c.v) : `Column ${i + 1}`
  );
  const body = sheet.rows.slice(headerRow + 1);
  const mt = new Set(source.mtColumns.map(norm));
  const ignore = new Set(source.ignoreColumns.map(norm));
  let dateColumn = 0;
  for (let c = 0; c < headers.length; c++) {
    if (body.some((row) => parseReportDate(row[c]?.v))) {
      dateColumn = c;
      break;
    }
  }
  let unitColumn = null;
  if (source.unit) {
    const wanted = norm(source.unit);
    for (let c = 0; c < headers.length; c++) {
      if (body.some((row) => norm(row[c]?.v) === wanted)) {
        unitColumn = c;
        break;
      }
    }
  }
  const zipperColumns = [];
  const mtColumns = [];
  const ignored = [];
  const dataColumns = [];
  for (let c = 0; c < headers.length; c++) {
    if (c === dateColumn || c === unitColumn) continue;
    if (ignore.has(norm(headers[c]))) {
      ignored.push(headers[c]);
      continue;
    }
    dataColumns.push(c);
  }
  const ambiguous = new Set(MT_AMBIGUOUS.map(norm));
  const hasNamedMt = dataColumns.some((c) => {
    const name = norm(headers[c]);
    return mt.has(name) && !ambiguous.has(name);
  });
  const claimed = /* @__PURE__ */ new Set();
  for (const c of dataColumns) {
    const name = norm(headers[c]);
    const isMt = mt.has(name) && (hasNamedMt || !ambiguous.has(name)) && !claimed.has(name);
    if (isMt) {
      claimed.add(name);
      mtColumns.push(c);
      continue;
    }
    if (body.some((row) => typeof row[c]?.v === "number")) zipperColumns.push(c);
  }
  return { headers, dateColumn, unitColumn, zipperColumns, mtColumns, ignored };
}
function aggregate(sheet, source) {
  const plan = planSheet(sheet, source);
  const headerRow = sheet.headerRow >= 0 ? sheet.headerRow : 0;
  const body = sheet.rows.slice(headerRow + 1);
  const wanted = source.unit ? norm(source.unit) : null;
  const totals = /* @__PURE__ */ new Map();
  let rows = 0;
  let carriedDate = null;
  for (const row of body) {
    const parsed = parseReportDate(row[plan.dateColumn]?.v);
    if (parsed) carriedDate = parsed;
    if (!carriedDate) continue;
    if (wanted && plan.unitColumn !== null && norm(row[plan.unitColumn]?.v) !== wanted) continue;
    const sum = (cols) => cols.reduce((acc, c) => {
      const v = row[c]?.v;
      return acc + (typeof v === "number" ? v : 0);
    }, 0);
    const entry = totals.get(carriedDate) ?? { zipper: 0, mt: 0 };
    entry.zipper += sum(plan.zipperColumns);
    entry.mt += sum(plan.mtColumns);
    totals.set(carriedDate, entry);
    rows++;
  }
  return { totals, rows, plan };
}
async function fetchMonthProduction(month, source = DEFAULT_SOURCE, skipCompanies) {
  const [y, m] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const dateFrom = `${month}-01`;
  const dateTo = `${month}-${String(lastDay).padStart(2, "0")}`;
  const session = await getSession();
  const combined = /* @__PURE__ */ new Map();
  const diagnostics = [];
  const columns = { zipper: [], mt: [], ignored: [] };
  let anySucceeded = false;
  for (const company of productionCompanies(session)) {
    if (skipCompanies?.has(company.id)) continue;
    try {
      const artifact = await generateReport({
        report_type: source.reportType,
        date_from: dateFrom,
        date_to: dateTo,
        company_id: company.id
      });
      const workbook = await parseWorkbook(artifact.buffer, artifact.filename);
      const sheet = workbook.sheets[0];
      if (!sheet) throw new OdooError("the report came back with no sheets");
      const { totals, rows, plan } = aggregate(sheet, source);
      let zipper = 0;
      let mt = 0;
      for (const [date, value] of totals) {
        zipper += value.zipper;
        mt += value.mt;
        const entry = combined.get(date) ?? { zipper: 0, mt: 0 };
        entry.zipper += value.zipper;
        entry.mt += value.mt;
        combined.set(date, entry);
      }
      for (const c of plan.zipperColumns) {
        if (!columns.zipper.includes(plan.headers[c])) columns.zipper.push(plan.headers[c]);
      }
      for (const c of plan.mtColumns) {
        if (!columns.mt.includes(plan.headers[c])) columns.mt.push(plan.headers[c]);
      }
      for (const name of plan.ignored) {
        if (!columns.ignored.includes(name)) columns.ignored.push(name);
      }
      diagnostics.push({ id: company.id, name: company.name, rows, zipper, mt });
      anySucceeded = true;
    } catch (err) {
      diagnostics.push({
        id: company.id,
        name: company.name,
        rows: 0,
        zipper: 0,
        mt: 0,
        error: err.message
      });
    }
  }
  if (!anySucceeded) {
    const reasons = diagnostics.map((d) => `${d.name}: ${d.error}`).join(" · ");
    throw new OdooError(`Odoo returned no production for ${month}. ${reasons}`);
  }
  const days = [...combined.entries()].map(([date, v]) => ({ date, zipper: Math.round(v.zipper), mt: Math.round(v.mt) })).sort((a, b) => a.date.localeCompare(b.date));
  return {
    days,
    companies: diagnostics,
    columns,
    unit: source.unit,
    reportType: source.reportType,
    fetchedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}

export { fetchMonthProduction as f };
