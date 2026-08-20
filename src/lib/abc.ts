/**
 * ABC (Pareto) analysis over the packing aggregates.
 *
 * Rank a dimension's entries by USD value; the entries carrying the first 80%
 * of value are class A, the next 15% class B, the tail class C. The classic
 * cut for "which products/buyers/customers actually matter".
 */
import { fyMonths } from './budget';
import { rangePacking, type DimEntry, type MonthPacking } from './packing';

export interface AbcRow {
  name: string;
  value: number;
  lines: number;
  /** Share of the dimension's total value. */
  share: number;
  cumShare: number;
  cls: 'A' | 'B' | 'C';
  /** Rank by value, 1-based. */
  rank: number;
  /** Companies this entry earned in, biggest first. */
  companies: string[];
}

export interface ClassBand {
  cls: 'A' | 'B' | 'C';
  count: number;
  value: number;
  share: number;
  lines: number;
}

export interface AbcDimension {
  rows: AbcRow[];
  counts: { A: number; B: number; C: number };
  bands: ClassBand[];
  total: number;
  lines: number;
}

export interface MonthPoint {
  month: string;
  /** Value per company id. */
  byCompany: Record<number, number>;
  total: number;
}

export interface AnalyticsResult {
  fy: number;
  months: string[];
  companyFilter: number | 'all';
  companies: { id: number; name: string; value: number; lines: number }[];
  totals: { value: number; lines: number };
  byItem: AbcDimension;
  byBuyer: AbcDimension;
  byCustomer: AbcDimension;
  byMonth: MonthPoint[];
  /** Months whose fetch failed — their figures are missing, not zero. */
  failed: { month: string; company: string; error: string }[];
  /** Months still to fetch. Non-empty means the figures below are partial. */
  pending: { month: string; company: string }[];
  /** True once nothing is pending. */
  ready: boolean;
  generatedAt: string;
}

function classify(merged: Map<string, MergedEntry>): AbcDimension {
  const total = [...merged.values()].reduce((a, e) => a + e.value, 0);
  const rows: AbcRow[] = [...merged.entries()]
    .map(([name, e]) => ({
      name,
      value: e.value,
      lines: e.lines,
      share: 0,
      cumShare: 0,
      cls: 'C' as const,
      rank: 0,
      // Biggest earner first, so the label names where the value actually came from.
      companies: [...e.byCompany.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n),
    }))
    .sort((a, b) => b.value - a.value);

  let cum = 0;
  const counts = { A: 0, B: 0, C: 0 };
  const bands = new Map<'A' | 'B' | 'C', ClassBand>([
    ['A', { cls: 'A', count: 0, value: 0, share: 0, lines: 0 }],
    ['B', { cls: 'B', count: 0, value: 0, share: 0, lines: 0 }],
    ['C', { cls: 'C', count: 0, value: 0, share: 0, lines: 0 }],
  ]);

  rows.forEach((row, i) => {
    cum += row.value;
    row.rank = i + 1;
    row.share = total ? row.value / total : 0;
    row.cumShare = total ? cum / total : 0;
    // The band an item falls in is where its cumulative share lands.
    row.cls = row.cumShare <= 0.8 ? 'A' : row.cumShare <= 0.95 ? 'B' : 'C';
    counts[row.cls]++;

    const band = bands.get(row.cls)!;
    band.count++;
    band.value += row.value;
    band.lines += row.lines;
  });

  for (const band of bands.values()) band.share = total ? band.value / total : 0;

  return {
    rows,
    counts,
    bands: [...bands.values()],
    total,
    lines: rows.reduce((a, r) => a + r.lines, 0),
  };
}

interface MergedEntry extends DimEntry {
  /** Value earned per company, so a row can name where it came from. */
  byCompany: Map<string, number>;
}

function merge(
  months: MonthPacking[],
  pick: (m: MonthPacking) => Record<string, DimEntry>,
): Map<string, MergedEntry> {
  const out = new Map<string, MergedEntry>();
  for (const m of months) {
    for (const [name, e] of Object.entries(pick(m))) {
      const slot = out.get(name) ?? { value: 0, lines: 0, byCompany: new Map<string, number>() };
      slot.value += e.value;
      slot.lines += e.lines;
      slot.byCompany.set(m.companyName, (slot.byCompany.get(m.companyName) ?? 0) + e.value);
      out.set(name, slot);
    }
  }
  return out;
}

export async function fiscalYearAnalytics(
  fy: number,
  companyFilter: number | 'all' = 'all',
  budget?: number,
): Promise<AnalyticsResult> {
  const months = fyMonths(fy);
  const { months: all, pending } = await rangePacking(months, budget);

  const companies = new Map<number, { id: number; name: string; value: number; lines: number }>();
  for (const m of all) {
    const slot = companies.get(m.companyId) ?? {
      id: m.companyId,
      name: m.companyName,
      value: 0,
      lines: 0,
    };
    slot.value += m.totals.value;
    slot.lines += m.totals.lines;
    companies.set(m.companyId, slot);
  }

  const scoped = companyFilter === 'all' ? all : all.filter((m) => m.companyId === companyFilter);

  const byMonth: MonthPoint[] = months.map((month) => {
    const slice = scoped.filter((m) => m.month === month);
    const byCompany: Record<number, number> = {};
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
      lines: scoped.reduce((a, m) => a + m.totals.lines, 0),
    },
    byItem: classify(merge(scoped, (m) => m.byItem)),
    byBuyer: classify(merge(scoped, (m) => m.byBuyer)),
    byCustomer: classify(merge(scoped, (m) => m.byCustomer)),
    byMonth,
    failed: all
      .filter((m) => m.error)
      .map((m) => ({ month: m.month, company: m.companyName, error: m.error! })),
    pending,
    ready: pending.length === 0,
    generatedAt: new Date().toISOString(),
  };
}
