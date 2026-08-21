/**
 * Turns the workbook Odoo streams back from `/report/xlsx/...` into plain JSON
 * the page can render: a faithful grid (merges, title rows and all) plus a
 * detected header row so the table can be sorted, searched and summarised.
 */
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { evaluateFormula, type Grid } from './formula';

export interface SheetCell {
  /** Display value. */
  v: string | number | null;
  /** True when the underlying value is numeric (drives alignment + summaries). */
  n?: boolean;
  /** Bold in the source workbook. */
  b?: boolean;
  rs?: number;
  cs?: number;
}

export interface Sheet {
  name: string;
  rows: SheetCell[][];
  /** 0-based index of the row that looks like the column header, or -1. */
  headerRow: number;
  columnCount: number;
  rowCount: number;
  /** Column widths from the workbook, in Excel character units. */
  widths: number[];
}

export interface Workbook {
  sheets: Sheet[];
  filename: string;
}

const COVERED = Symbol('covered');

function colToIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseRange(range: string): { r1: number; c1: number; r2: number; c2: number } | null {
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range.replace(/\$/g, '').toUpperCase());
  if (!m) return null;
  return {
    c1: colToIndex(m[1]),
    r1: Number(m[2]) - 1,
    c2: colToIndex(m[3]),
    r2: Number(m[4]) - 1,
  };
}

function normalise(value: unknown): { v: string | number | null; n: boolean; f?: string } {
  if (value === null || value === undefined) return { v: null, n: false };
  if (typeof value === 'number') return { v: value, n: true };
  if (typeof value === 'boolean') return { v: value ? 'Yes' : 'No', n: false };
  if (value instanceof Date) return { v: value.toISOString().slice(0, 10), n: false };
  if (typeof value === 'object') {
    const o = value as any;
    if (Array.isArray(o.richText)) return { v: o.richText.map((r: any) => r.text).join(''), n: false };
    if (o.formula || o.sharedFormula) {
      // Odoo writes totals as formulas with no cached result - keep the text so
      // the second pass can work them out.
      const inner = 'result' in o && o.result !== null && o.result !== undefined ? normalise(o.result) : null;
      if (inner && inner.v !== null) return inner;
      return { v: null, n: true, f: String(o.formula ?? o.sharedFormula) };
    }
    if ('result' in o) return normalise(o.result);
    if ('text' in o) return { v: String(o.text), n: false };
    if ('error' in o) return { v: String(o.error), n: false };
    return { v: String(o), n: false };
  }
  const s = String(value).trim();
  return { v: s === '' ? null : s, n: false };
}

/**
 * Odoo's xlsx reports lead with merged title/filter rows. The header is the
 * first row in the top slice that fills the most columns with text.
 */
function detectHeaderRow(rows: SheetCell[][], columnCount: number): number {
  let best = -1;
  let bestScore = 0;
  const scan = Math.min(rows.length, 15);
  for (let r = 0; r < scan; r++) {
    const row = rows[r];
    const filled = row.filter((c) => c && c.v !== null && c.v !== undefined).length;
    const textual = row.filter((c) => c && c.v !== null && !c.n).length;
    if (filled < 2) continue;
    // Prefer wide, all-text rows that are followed by at least one data row.
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

/**
 * Drops merge ranges that overlap an earlier one.
 *
 * Some Odoo reports write two merges over the same header - the Invoice report
 * has both `M1:V1` and `M1:Y1` - and ExcelJS refuses the whole workbook with
 * "Cannot merge already merged cells". Excel itself just keeps the first, so
 * that is what this does.
 */
async function dropOverlappingMerges(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(buffer as any);

  const toBox = (ref: string) => {
    const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref.toUpperCase());
    if (!m) return null;
    const col = (s: string) => [...s].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
    return { c1: col(m[1]), r1: Number(m[2]), c2: col(m[3]), r2: Number(m[4]) };
  };

  for (const name of Object.keys(zip.files)) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue;
    const xml = await zip.file(name)!.async('string');

    const kept: string[] = [];
    const keptBoxes: NonNullable<ReturnType<typeof toBox>>[] = [];
    let dropped = 0;

    for (const match of xml.matchAll(/<mergeCell ref="([^"]+)"\s*\/>/g)) {
      const box = toBox(match[1]);
      if (!box) continue;
      const clashes = keptBoxes.some(
        (k) => box.c1 <= k.c2 && k.c1 <= box.c2 && box.r1 <= k.r2 && k.r1 <= box.r2,
      );
      if (clashes) {
        dropped++;
        continue;
      }
      keptBoxes.push(box);
      kept.push(match[1]);
    }

    if (!dropped) continue;
    const block = `<mergeCells count="${kept.length}">${kept
      .map((ref) => `<mergeCell ref="${ref}"/>`)
      .join('')}</mergeCells>`;
    zip.file(name, xml.replace(/<mergeCells[\s\S]*?<\/mergeCells>/, block));
  }

  return zip.generateAsync({ type: 'arraybuffer' }) as Promise<ArrayBuffer>;
}

/**
 * ExcelJS over Odoo's bytes, repairing the overlapping merges it refuses.
 *
 * Exported because not every caller wants the full grid — the OT report only
 * needs two rows per section off one sheet, but it hits the same bad merges.
 */
export async function loadWorkbook(buffer: ArrayBuffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as any);
    return wb;
  } catch (err) {
    if (!/already merged/i.test((err as Error).message)) throw err;
    // Repair only when it is actually needed.
    const repaired = new ExcelJS.Workbook();
    await repaired.xlsx.load((await dropOverlappingMerges(buffer)) as any);
    return repaired;
  }
}

export async function parseWorkbook(buffer: ArrayBuffer, filename: string): Promise<Workbook> {
  const wb = await loadWorkbook(buffer);

  const sheets: Sheet[] = [];

  wb.eachSheet((ws) => {
    const merges: string[] = (ws as any).model?.merges ?? [];
    const spanAt = new Map<string, { rs: number; cs: number }>();
    const covered = new Set<string>();

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
    const rows: SheetCell[][] = [];
    const pending: { r: number; c: number; formula: string }[] = [];

    ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const r = rowNumber - 1;
      const out: SheetCell[] = [];
      for (let c = 0; c < columnCount; c++) {
        if (covered.has(`${r}:${c}`)) {
          out.push({ v: null, [COVERED as any]: true } as SheetCell);
          continue;
        }
        const cell = row.getCell(c + 1);
        const { v, n, f } = normalise(cell.value);
        const span = spanAt.get(`${r}:${c}`);
        const item: SheetCell = { v };
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

    // eachRow skips gaps entirely; backfill so indices stay aligned.
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i]) rows[i] = Array.from({ length: columnCount }, () => ({ v: null }));
    }

    // Second pass: work out the formulas Odoo left without a cached result.
    if (pending.length) {
      const grid: Grid = rows.map((row) =>
        row.map((cell) => (typeof cell?.v === 'number' ? cell.v : null)),
      );
      for (const { r, c, formula } of pending) {
        const value = evaluateFormula(formula, grid);
        if (value !== null && Number.isFinite(value)) {
          rows[r][c].v = Math.round(value * 1e6) / 1e6;
          grid[r][c] = value;
        }
      }
    }

    // Drop trailing empty rows.
    while (rows.length && rows[rows.length - 1].every((c) => c.v === null)) rows.pop();

    const widths: number[] = [];
    for (let c = 1; c <= columnCount; c++) widths.push(ws.getColumn(c).width ?? 0);

    // Strip the marker symbol before serialising (JSON drops symbols anyway,
    // but the covered cells must not render).
    const cleaned = rows.map((row) =>
      row.map((cell) => ((cell as any)[COVERED] ? null : cell)),
    ) as unknown as SheetCell[][];

    sheets.push({
      name: ws.name,
      rows: cleaned,
      headerRow: detectHeaderRow(cleaned, columnCount),
      columnCount,
      rowCount: cleaned.length,
      widths,
    });
  });

  return { sheets, filename };
}
