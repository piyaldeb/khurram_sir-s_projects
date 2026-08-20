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
}

export interface AbcDimension {
  rows: AbcRow[];
  counts: { A: number; B: number; C: number };
  total: number;
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

function classify(merged: Map<string, DimEntry>): AbcDimension {
  const total = [...merged.values()].reduce((a, e) => a + e.value, 0);
  const rows: AbcRow[] = [...merged.entries()]
    .map(([name, e]) => ({ name, value: e.value, lines: e.lines, share: 0, cumShare: 0, cls: 'C' as const }))
    .sort((a, b) => b.value - a.value);

  let cum = 0;
  const counts = { A: 0, B: 0, C: 0 };
  for (const row of rows) {
    cum += row.value;
    row.share = total ? row.value / total : 0;
    row.cumShare = total ? cum / total : 0;
    row.cls = row.cumShare <= 0.8 ? 'A' : row.cumShare <= 0.95 ? 'B' : 'C';
    counts[row.cls]++;
  }
  return { rows, counts, total };
}

function merge(
  months: MonthPacking[],
  pick: (m: MonthPacking) => Record<string, DimEntry>,
): Map<string, DimEntry> {
  const out = new Map<string, DimEntry>();
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
