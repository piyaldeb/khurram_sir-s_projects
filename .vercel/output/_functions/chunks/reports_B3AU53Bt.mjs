import { g as getSession, a as callKw, b as buildContext, O as OdooError, d as callButton, f as fetchBinary, w as webSearchRead } from './odoo_B4sOaK5u.mjs';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

const REF = /(\$?[A-Z]{1,3}\$?\d{1,7})/g;
const FUNC = /\b(SUM|AVERAGE|COUNT|MIN|MAX)\(\s*(\$?[A-Z]{1,3}\$?\d{1,7})\s*:\s*(\$?[A-Z]{1,3}\$?\d{1,7})\s*\)/gi;
const SAFE = /^[\d\s.+\-*/()]*$/;
function refToRC(ref) {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(ref);
  if (!m) return { r: -1, c: -1 };
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { r: Number(m[2]) - 1, c: c - 1 };
}
const valueAt = (grid, ref) => {
  const { r, c } = refToRC(ref);
  return grid[r]?.[c] ?? 0;
};
function rangeValues(grid, from, to) {
  const a = refToRC(from);
  const b = refToRC(to);
  const out = [];
  for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++) {
    for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c++) {
      const v = grid[r]?.[c];
      if (typeof v === "number") out.push(v);
    }
  }
  return out;
}
function evalArithmetic(expr) {
  if (!SAFE.test(expr)) return null;
  let i = 0;
  const skip = () => {
    while (expr[i] === " ") i++;
  };
  const number = () => {
    skip();
    if (expr[i] === "(") {
      i++;
      const v2 = additive();
      skip();
      if (expr[i] !== ")") return null;
      i++;
      return v2;
    }
    if (expr[i] === "-") {
      i++;
      const v2 = number();
      return v2 === null ? null : -v2;
    }
    if (expr[i] === "+") {
      i++;
      return number();
    }
    const start = i;
    while (i < expr.length && /[\d.]/.test(expr[i])) i++;
    if (i === start) return null;
    const v = Number(expr.slice(start, i));
    return Number.isFinite(v) ? v : null;
  };
  const multiplicative = () => {
    let left = number();
    for (; ; ) {
      skip();
      const op = expr[i];
      if (op !== "*" && op !== "/") return left;
      i++;
      const right = number();
      if (left === null || right === null) return null;
      left = op === "*" ? left * right : right === 0 ? 0 : left / right;
    }
  };
  const additive = () => {
    let left = multiplicative();
    for (; ; ) {
      skip();
      const op = expr[i];
      if (op !== "+" && op !== "-") return left;
      i++;
      const right = multiplicative();
      if (left === null || right === null) return null;
      left = op === "+" ? left + right : left - right;
    }
  };
  const value = additive();
  skip();
  return i === expr.length ? value : null;
}
function evaluateFormula(formula, grid) {
  let expr = formula.trim().replace(/^=/, "");
  if (!expr) return null;
  expr = expr.replace(FUNC, (_m, fn, from, to) => {
    const values = rangeValues(grid, from, to);
    switch (fn.toUpperCase()) {
      case "SUM":
        return String(values.reduce((a, b) => a + b, 0));
      case "AVERAGE":
        return String(values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
      case "COUNT":
        return String(values.length);
      case "MIN":
        return String(values.length ? Math.min(...values) : 0);
      case "MAX":
        return String(values.length ? Math.max(...values) : 0);
      default:
        return "0";
    }
  });
  if (/[A-Za-z]\s*\(/.test(expr)) return null;
  expr = expr.replace(REF, (ref) => String(valueAt(grid, ref)));
  return evalArithmetic(expr);
}

const COVERED = Symbol("covered");
function colToIndex(ref) {
  let n = 0;
  for (const ch of ref) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function parseRange(range) {
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range.replace(/\$/g, "").toUpperCase());
  if (!m) return null;
  return {
    c1: colToIndex(m[1]),
    r1: Number(m[2]) - 1,
    c2: colToIndex(m[3]),
    r2: Number(m[4]) - 1
  };
}
function normalise(value) {
  if (value === null || value === void 0) return { v: null, n: false };
  if (typeof value === "number") return { v: value, n: true };
  if (typeof value === "boolean") return { v: value ? "Yes" : "No", n: false };
  if (value instanceof Date) return { v: value.toISOString().slice(0, 10), n: false };
  if (typeof value === "object") {
    const o = value;
    if (Array.isArray(o.richText)) return { v: o.richText.map((r) => r.text).join(""), n: false };
    if (o.formula || o.sharedFormula) {
      const inner = "result" in o && o.result !== null && o.result !== void 0 ? normalise(o.result) : null;
      if (inner && inner.v !== null) return inner;
      return { v: null, n: true, f: String(o.formula ?? o.sharedFormula) };
    }
    if ("result" in o) return normalise(o.result);
    if ("text" in o) return { v: String(o.text), n: false };
    if ("error" in o) return { v: String(o.error), n: false };
    return { v: String(o), n: false };
  }
  const s = String(value).trim();
  return { v: s === "" ? null : s, n: false };
}
function detectHeaderRow(rows, columnCount) {
  let best = -1;
  let bestScore = 0;
  const scan = Math.min(rows.length, 15);
  for (let r = 0; r < scan; r++) {
    const row = rows[r];
    const filled = row.filter((c) => c && c.v !== null && c.v !== void 0).length;
    const textual = row.filter((c) => c && c.v !== null && !c.n).length;
    if (filled < 2) continue;
    const next = rows[r + 1];
    const nextFilled = next ? next.filter((c) => c && c.v !== null).length : 0;
    const score = textual / Math.max(columnCount, 1) + (textual === filled ? 0.35 : 0) + (nextFilled >= filled * 0.5 ? 0.25 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return bestScore >= 0.5 ? best : -1;
}
async function dropOverlappingMerges(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const toBox = (ref) => {
    const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref.toUpperCase());
    if (!m) return null;
    const col = (s) => [...s].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
    return { c1: col(m[1]), r1: Number(m[2]), c2: col(m[3]), r2: Number(m[4]) };
  };
  for (const name of Object.keys(zip.files)) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue;
    const xml = await zip.file(name).async("string");
    const kept = [];
    const keptBoxes = [];
    let dropped = 0;
    for (const match of xml.matchAll(/<mergeCell ref="([^"]+)"\s*\/>/g)) {
      const box = toBox(match[1]);
      if (!box) continue;
      const clashes = keptBoxes.some(
        (k) => box.c1 <= k.c2 && k.c1 <= box.c2 && box.r1 <= k.r2 && k.r1 <= box.r2
      );
      if (clashes) {
        dropped++;
        continue;
      }
      keptBoxes.push(box);
      kept.push(match[1]);
    }
    if (!dropped) continue;
    const block = `<mergeCells count="${kept.length}">${kept.map((ref) => `<mergeCell ref="${ref}"/>`).join("")}</mergeCells>`;
    zip.file(name, xml.replace(/<mergeCells[\s\S]*?<\/mergeCells>/, block));
  }
  return zip.generateAsync({ type: "arraybuffer" });
}
async function loadWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
    return wb;
  } catch (err) {
    if (!/already merged/i.test(err.message)) throw err;
    const repaired = new ExcelJS.Workbook();
    await repaired.xlsx.load(await dropOverlappingMerges(buffer));
    return repaired;
  }
}
async function parseWorkbook(buffer, filename) {
  const wb = await loadWorkbook(buffer);
  const sheets = [];
  wb.eachSheet((ws) => {
    const merges = ws.model?.merges ?? [];
    const spanAt = /* @__PURE__ */ new Map();
    const covered = /* @__PURE__ */ new Set();
    for (const range of merges) {
      const r = parseRange(range);
      if (!r) continue;
      spanAt.set(`${r.r1}:${r.c1}`, { rs: r.r2 - r.r1 + 1, cs: r.c2 - r.c1 + 1 });
      for (let rr = r.r1; rr <= r.r2; rr++) {
        for (let cc = r.c1; cc <= r.c2; cc++) {
          if (rr !== r.r1 || cc !== r.c1) covered.add(`${rr}:${cc}`);
        }
      }
    }
    const columnCount = Math.max(ws.columnCount, 1);
    const rows = [];
    const pending = [];
    ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const r = rowNumber - 1;
      const out = [];
      for (let c = 0; c < columnCount; c++) {
        if (covered.has(`${r}:${c}`)) {
          out.push({ v: null, [COVERED]: true });
          continue;
        }
        const cell = row.getCell(c + 1);
        const { v, n, f } = normalise(cell.value);
        const span = spanAt.get(`${r}:${c}`);
        const item = { v };
        if (f) pending.push({ r, c, formula: f });
        if (n) item.n = true;
        if (cell.font?.bold) item.b = true;
        if (span) {
          if (span.rs > 1) item.rs = span.rs;
          if (span.cs > 1) item.cs = span.cs;
        }
        out.push(item);
      }
      rows[r] = out;
    });
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i]) rows[i] = Array.from({ length: columnCount }, () => ({ v: null }));
    }
    if (pending.length) {
      const grid = rows.map(
        (row) => row.map((cell) => typeof cell?.v === "number" ? cell.v : null)
      );
      for (const { r, c, formula } of pending) {
        const value = evaluateFormula(formula, grid);
        if (value !== null && Number.isFinite(value)) {
          rows[r][c].v = Math.round(value * 1e6) / 1e6;
          grid[r][c] = value;
        }
      }
    }
    while (rows.length && rows[rows.length - 1].every((c) => c.v === null)) rows.pop();
    const widths = [];
    for (let c = 1; c <= columnCount; c++) widths.push(ws.getColumn(c).width ?? 0);
    const cleaned = rows.map(
      (row) => row.map((cell) => cell[COVERED] ? null : cell)
    );
    sheets.push({
      name: ws.name,
      rows: cleaned,
      headerRow: detectHeaderRow(cleaned, columnCount),
      columnCount,
      rowCount: cleaned.length,
      widths
    });
  });
  return { sheets, filename };
}

const WIZARD_MODEL = "mrp.report.custom";
const WIZARD_ACTION_ID = 1943;
const SPEC = {
  report_type: {},
  available_challan_ids: { fields: {} },
  challan_record_id: { fields: { display_name: {} } },
  challan_no: {},
  date_from: {},
  date_to: {},
  buyer_name_filter: { fields: { display_name: {} } }
};
const NO_DATE_FROM = /* @__PURE__ */ new Set([
  "s_pir",
  "s_pir_coil",
  "p_bo",
  "pir_buying_house",
  "daily_sample_report",
  "avail_metarial"
]);
const NO_DATE_TO = /* @__PURE__ */ new Set(["s_pir", "s_pir_coil", "p_bo", "pir_buying_house", "avail_metarial"]);
const NEEDS_CHALLAN = /* @__PURE__ */ new Set(["painting_invoice", "plating_invoice"]);
const NEEDS_BUYER = /* @__PURE__ */ new Set(["pir", "pi_file_dying"]);
const GROUPS = {
  "PI Files": ["pir", "pi_file_dying", "pir_buying_house", "s_pir", "s_pir_coil", "pird", "pic", "s_pic", "pis", "p_s"],
  Production: ["dpcl", "dppr", "dppr_", "t_qc", "packing_details", "pack_ytd", "avail_metarial"],
  "Invoicing": ["dpr", "invs", "s_invs", "r_invs", "p_invs", "painting_invoice", "plating_invoice"],
  "Orders & BO": ["p_bo", "c_bo", "monthly_bo", "bo_details", "oa_d", "oa_ds", "cos", "opo", "r_ord"],
  Sampling: ["daily_sample_report", "monthly_sample_report", "sample_delivery"]
};
function groupOf(value) {
  for (const [group, members] of Object.entries(GROUPS)) {
    if (members.includes(value)) return group;
  }
  return "Other";
}
let fieldsCache = null;
const FIELDS_TTL_MS = 10 * 60 * 1e3;
async function getWizardFields() {
  if (fieldsCache && Date.now() - fieldsCache.at < FIELDS_TTL_MS) return fieldsCache.value;
  const session = await getSession();
  const views = await callKw(WIZARD_MODEL, "get_views", {
    kwargs: {
      context: buildContext(session),
      views: [[false, "form"]],
      options: { action_id: WIZARD_ACTION_ID, load_filters: false, toolbar: false }
    }
  });
  const selection = views?.models?.[WIZARD_MODEL]?.report_type?.selection ?? [];
  const reports = selection.map(([value2, label]) => ({
    value: value2,
    label,
    group: groupOf(value2),
    dateFrom: !NO_DATE_FROM.has(value2),
    dateTo: !NO_DATE_TO.has(value2),
    challan: NEEDS_CHALLAN.has(value2),
    buyer: NEEDS_BUYER.has(value2)
  }));
  if (!reports.length) throw new OdooError("The MRP report wizard exposed no report types.");
  const onchange = await callKw(WIZARD_MODEL, "onchange", {
    args: [[], {}, [], SPEC],
    kwargs: { context: buildContext(session) }
  });
  const value = onchange?.value ?? {};
  const order = Object.keys(GROUPS);
  const rank = (g) => order.indexOf(g) < 0 ? order.length : order.indexOf(g);
  const groups = [...new Set(reports.map((r) => r.group))].sort((a, b) => rank(a) - rank(b));
  const result = {
    reports,
    groups,
    defaults: {
      report_type: value.report_type ?? reports[0].value,
      date_from: value.date_from ?? "",
      date_to: value.date_to ?? ""
    }
  };
  fieldsCache = { at: Date.now(), value: result };
  return result;
}
function normaliseDate(value) {
  if (!value) return false;
  return value.slice(0, 10);
}
async function generateReport(req) {
  const session = await getSession();
  const company = req.company_id ?? void 0;
  const def = (await getWizardFields()).reports.find((r) => r.value === req.report_type);
  if (!def) throw new OdooError(`Unknown report type "${req.report_type}".`);
  const values = {
    report_type: def.value,
    challan_record_id: def.challan ? req.challan_id ?? false : false,
    challan_no: false,
    date_from: def.dateFrom ? normaliseDate(req.date_from) : false,
    date_to: def.dateTo ? normaliseDate(req.date_to) : false,
    buyer_name_filter: def.buyer ? req.buyer_id ?? false : false
  };
  const saved = await callKw(WIZARD_MODEL, "web_save", {
    args: [[], values],
    kwargs: { context: buildContext(session, {}, company), specification: SPEC }
  });
  const wizardId = saved?.[0]?.id;
  if (!wizardId) throw new OdooError("Odoo did not create the report wizard record.");
  const action = await callButton(
    WIZARD_MODEL,
    "action_generate_xlsx_report",
    [wizardId],
    buildContext(session, {}, company)
  );
  if (!action || action.type !== "ir.actions.report") {
    const hint = action?.params?.message || action?.type || "the button returned nothing (usually means the filters matched no data)";
    throw new OdooError(`Odoo did not return a report for "${def.label}" - ${hint}.`);
  }
  const converter = action.report_type === "xlsx" ? "xlsx" : "pdf";
  const context = {
    ...buildContext(session, {}, company),
    ...action.context ?? {},
    active_model: WIZARD_MODEL,
    active_id: wizardId,
    active_ids: [wizardId]
  };
  const query = new URLSearchParams();
  if (action.data) query.set("options", JSON.stringify(action.data));
  query.set("context", JSON.stringify(context));
  const downloadPath = `/report/${converter}/${action.report_name}?${query.toString()}`;
  const file = await fetchBinary(downloadPath);
  return {
    action,
    wizardId,
    downloadPath,
    filename: file.filename,
    contentType: file.contentType,
    buffer: file.buffer
  };
}
async function runReport(req) {
  const def = (await getWizardFields()).reports.find((r) => r.value === req.report_type);
  const artifact = await generateReport(req);
  if (!artifact.contentType.includes("spreadsheet")) {
    throw new OdooError(
      `"${def?.label ?? req.report_type}" is produced as ${artifact.action.report_type}, not a spreadsheet - use the download button instead.`
    );
  }
  const workbook = await parseWorkbook(artifact.buffer, artifact.filename);
  return {
    reportType: req.report_type,
    reportLabel: def?.label ?? req.report_type,
    reportName: artifact.action.name ?? artifact.action.report_name,
    filename: artifact.filename,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    filters: req,
    workbook,
    sizeBytes: artifact.buffer.byteLength
  };
}
async function searchBuyers(query, limit = 30) {
  const domain = [["buyer_rank", "=", 1]];
  if (query.trim()) domain.push(["display_name", "ilike", query.trim()]);
  const { records } = await webSearchRead("res.partner", {
    domain,
    specification: { display_name: {} },
    limit,
    order: "display_name asc"
  });
  return records.map((r) => ({ id: r.id, name: r.display_name }));
}
async function availableChallans(reportType) {
  const session = await getSession();
  const res = await callKw(WIZARD_MODEL, "onchange", {
    args: [
      [],
      {
        report_type: reportType,
        available_challan_ids: [],
        challan_record_id: false,
        challan_no: false,
        date_from: false,
        date_to: false,
        buyer_name_filter: false
      },
      ["report_type"],
      SPEC
    ],
    kwargs: { context: buildContext(session) }
  });
  const ids = (res?.value?.available_challan_ids ?? []).map((entry) => Array.isArray(entry) ? entry[1] : entry?.id ?? entry).filter((v) => typeof v === "number");
  if (!ids.length) return [];
  const { records } = await webSearchRead(
    "operation.details",
    { domain: [["id", "in", ids]], specification: { display_name: {} }, limit: 200 }
  );
  return records.map((r) => ({ id: r.id, name: r.display_name }));
}
async function listWorkcenters() {
  const { records } = await webSearchRead("mrp.workcenter", {
    specification: {
      name: {},
      color: {},
      workorder_count: {},
      working_state: {},
      oee_target: {},
      order_toproduce_count: {},
      order_tooutput_count: {},
      order_toqc_count: {}
    },
    limit: 200,
    order: "name asc"
  });
  return records;
}

export { availableChallans as a, getWizardFields as b, generateReport as g, listWorkcenters as l, parseWorkbook as p, runReport as r, searchBuyers as s };
