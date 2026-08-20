import { g as getSession, p as productionCompanies, O as OdooError } from './odoo_B4sOaK5u.mjs';
import { g as generateReport, p as parseWorkbook } from './reports_B3AU53Bt.mjs';

const INVOICE_REPORT = "dpr";
const norm = (v) => String(v ?? "").trim().toUpperCase().replace(/\s+/g, " ");
const num = (cell) => typeof cell?.v === "number" ? cell.v : 0;
function yesterdayIso() {
  const d = /* @__PURE__ */ new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}
const emptyRow = (product) => ({
  product,
  packingQty: 0,
  packingValue: 0,
  pendingQty: 0,
  pendingValue: 0,
  cumProduction: 0,
  cumInvoicing: 0,
  todayReleasedQty: 0,
  todayReleasedValue: 0,
  cumReleasedQty: 0,
  cumReleasedValue: 0,
  pendingOa: 0
});
function mapColumns(header) {
  const columns = {};
  let unit = "PCS";
  header.forEach((cell, i) => {
    const name = norm(cell?.v);
    if (!name) return;
    const isValue = /VALUE|USD|\$/.test(name);
    if (name === "PRODUCT") columns.product = i;
    else if (/^PACKING/.test(name)) {
      if (isValue) columns.packingValue = i;
      else {
        columns.packingQty = i;
        const m = /PACKING (\w+)/.exec(name);
        if (m) unit = m[1];
      }
    } else if (/^PENDING OA/.test(name)) columns.pendingOa = i;
    else if (/^PENDING/.test(name)) {
      if (isValue) columns.pendingValue = i;
      else columns.pendingQty = i;
    } else if (/PRODUCTION/.test(name)) columns.cumProduction = i;
    else if (/INVOIC/.test(name)) columns.cumInvoicing = i;
    else if (/TODAY RELEASED/.test(name)) {
      if (isValue) columns.todayReleasedValue = i;
      else columns.todayReleasedQty = i;
    } else if (/RELEASED/.test(name)) {
      if (isValue) columns.cumReleasedValue = i;
      else columns.cumReleasedQty = i;
    }
  });
  return { columns, unit };
}
function parseSheet(sheet) {
  const found = sheet.rows.findIndex((row) => norm(row?.[0]?.v) === "PRODUCT");
  const headerIndex = found >= 0 ? found : 1;
  const productRow = sheet.rows[headerIndex] ?? [];
  const bannerRow = headerIndex > 0 ? sheet.rows[headerIndex - 1] ?? [] : [];
  const width = Math.max(productRow.length, bannerRow.length);
  const header = Array.from({ length: width }, (_, i) => {
    const fromProduct = productRow[i];
    return fromProduct?.v !== null && fromProduct?.v !== void 0 ? fromProduct : bannerRow[i] ?? null;
  });
  const { columns, unit } = mapColumns(header);
  const rows = [];
  const totals = emptyRow("TOTAL");
  let ordersClosed = 0;
  const read = (row, key) => {
    const c = columns[key];
    return c === void 0 ? 0 : num(row[c]);
  };
  for (let r = headerIndex + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r] ?? [];
    const label = norm(row[0]?.v);
    if (!label) continue;
    if (/ORDER CLOSE/.test(label)) {
      const cell = row.slice(1).find((c) => typeof c?.v === "number");
      ordersClosed = typeof cell?.v === "number" ? cell.v : 0;
      continue;
    }
    if (label === "TOTAL") {
      for (const key of Object.keys(totals)) {
        if (key === "product") continue;
        totals[key] = read(row, key);
      }
      break;
    }
    const entry = emptyRow(String(row[0]?.v ?? "").trim());
    let any = false;
    for (const key of Object.keys(entry)) {
      if (key === "product") continue;
      const v = read(row, key);
      entry[key] = v;
      if (v) any = true;
    }
    if (any) rows.push(entry);
  }
  if (!totals.pendingValue && rows.length) {
    for (const entry of rows) {
      for (const key of Object.keys(totals)) {
        if (key === "product") continue;
        totals[key] += entry[key];
      }
    }
  }
  return { unit, rows, totals, ordersClosed };
}
async function fetchDayReport(date) {
  const session = await getSession();
  const companies = [];
  for (const company of productionCompanies(session)) {
    try {
      const artifact = await generateReport({
        report_type: INVOICE_REPORT,
        date_from: date,
        date_to: date,
        company_id: company.id
      });
      const workbook = await parseWorkbook(artifact.buffer, artifact.filename);
      const sheet = workbook.sheets[0];
      if (!sheet) throw new OdooError("the report came back with no sheets");
      companies.push({ id: company.id, name: company.name, ...parseSheet(sheet) });
    } catch (err) {
      companies.push({
        id: company.id,
        name: company.name,
        unit: "PCS",
        rows: [],
        totals: emptyRow("TOTAL"),
        ordersClosed: 0,
        error: err.message
      });
    }
  }
  if (companies.every((c) => c.error)) {
    throw new OdooError(
      `No company returned an invoice report for ${date}. ${companies.map((c) => `${c.name}: ${c.error}`).join(" · ")}`
    );
  }
  return {
    date,
    reportType: INVOICE_REPORT,
    companies,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}

export { fetchDayReport as f, yesterdayIso as y };
