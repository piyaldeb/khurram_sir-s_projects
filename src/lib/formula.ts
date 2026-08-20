/**
 * A very small spreadsheet formula evaluator.
 *
 * Odoo's xlsx reports write TOTAL columns as `SUM(...)` formulas *without* a
 * cached result, so a plain reader shows blanks where the totals should be.
 * Only the shapes those reports actually emit are supported: cell references,
 * ranges inside SUM/AVERAGE/COUNT/MIN/MAX, numbers, and + - * / ( ).
 */

export type Grid = (number | null)[][];

const REF = /(\$?[A-Z]{1,3}\$?\d{1,7})/g;
const FUNC = /\b(SUM|AVERAGE|COUNT|MIN|MAX)\(\s*(\$?[A-Z]{1,3}\$?\d{1,7})\s*:\s*(\$?[A-Z]{1,3}\$?\d{1,7})\s*\)/gi;
const SAFE = /^[\d\s.+\-*/()]*$/;

function refToRC(ref: string): { r: number; c: number } {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(ref);
  if (!m) return { r: -1, c: -1 };
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { r: Number(m[2]) - 1, c: c - 1 };
}

const valueAt = (grid: Grid, ref: string): number => {
  const { r, c } = refToRC(ref);
  return grid[r]?.[c] ?? 0;
};

function rangeValues(grid: Grid, from: string, to: string): number[] {
  const a = refToRC(from);
  const b = refToRC(to);
  const out: number[] = [];
  for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++) {
    for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c++) {
      const v = grid[r]?.[c];
      if (typeof v === 'number') out.push(v);
    }
  }
  return out;
}

/** Recursive-descent arithmetic over an already-numeric expression. */
function evalArithmetic(expr: string): number | null {
  if (!SAFE.test(expr)) return null;
  let i = 0;
  const skip = () => {
    while (expr[i] === ' ') i++;
  };
  const number = (): number | null => {
    skip();
    if (expr[i] === '(') {
      i++;
      const v = additive();
      skip();
      if (expr[i] !== ')') return null;
      i++;
      return v;
    }
    if (expr[i] === '-') {
      i++;
      const v = number();
      return v === null ? null : -v;
    }
    if (expr[i] === '+') {
      i++;
      return number();
    }
    const start = i;
    while (i < expr.length && /[\d.]/.test(expr[i])) i++;
    if (i === start) return null;
    const v = Number(expr.slice(start, i));
    return Number.isFinite(v) ? v : null;
  };
  const multiplicative = (): number | null => {
    let left = number();
    for (;;) {
      skip();
      const op = expr[i];
      if (op !== '*' && op !== '/') return left;
      i++;
      const right = number();
      if (left === null || right === null) return null;
      left = op === '*' ? left * right : right === 0 ? 0 : left / right;
    }
  };
  const additive = (): number | null => {
    let left = multiplicative();
    for (;;) {
      skip();
      const op = expr[i];
      if (op !== '+' && op !== '-') return left;
      i++;
      const right = multiplicative();
      if (left === null || right === null) return null;
      left = op === '+' ? left + right : left - right;
    }
  };
  const value = additive();
  skip();
  return i === expr.length ? value : null;
}

/** Returns the formula's numeric value, or null when it is out of scope. */
export function evaluateFormula(formula: string, grid: Grid): number | null {
  let expr = formula.trim().replace(/^=/, '');
  if (!expr) return null;

  expr = expr.replace(FUNC, (_m, fn: string, from: string, to: string) => {
    const values = rangeValues(grid, from, to);
    switch (fn.toUpperCase()) {
      case 'SUM':
        return String(values.reduce((a, b) => a + b, 0));
      case 'AVERAGE':
        return String(values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
      case 'COUNT':
        return String(values.length);
      case 'MIN':
        return String(values.length ? Math.min(...values) : 0);
      case 'MAX':
        return String(values.length ? Math.max(...values) : 0);
      default:
        return '0';
    }
  });

  if (/[A-Za-z]\s*\(/.test(expr)) return null; // an unsupported function remains
  expr = expr.replace(REF, (ref) => String(valueAt(grid, ref)));

  return evalArithmetic(expr);
}
