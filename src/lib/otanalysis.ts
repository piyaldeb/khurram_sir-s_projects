/**
 * The OT Cost sheet as a model: a month, a fiscal year, or a year to date.
 *
 * `otcost.ts` gets the raw per-section daily figures out of Odoo; this file is
 * the sheet's own arithmetic — the Manufacturing / Other Departments split, the
 * plan and budget it is measured against, and the reading that goes with it.
 *
 * Every figure below is USD.
 */
import {
  BU_LABEL,
  JOBS,
  bucketOf,
  fyOtMonths,
  monthLabel,
  otPeriod,
  rangeJobMonths,
  sectionDef,
  todayIso,
  type BuKey,
  type Bucket,
  type JobKey,
  type OtJobMonth,
  type Tag,
} from './otcost';
import { usdRate, type UsdRate } from './fxrate';
import budgetData from '../data/ot-budget.json';

const TARGETS = budgetData.months as Record<
  string,
  { plan?: { zipper: number; mt: number }; budget?: { zipper: number; mt: number } }
>;

export interface BuSplit {
  zipper: number;
  mt: number;
  total: number;
}

const split = (zipper: number, mt: number): BuSplit => ({ zipper, mt, total: zipper + mt });

/** Which business unit a report covers. */
export type BuScope = BuKey | 'all';

/** Zeroes the unit a filtered report is not about, so totals stay honest. */
const forBu = (zipper: number, mt: number, bu: BuScope): BuSplit =>
  bu === 'zipper' ? split(zipper, 0) : bu === 'mt' ? split(0, mt) : split(zipper, mt);

/** What one section spent on one day — the row behind a day's total. */
export interface DaySection {
  bu: BuKey;
  buLabel: string;
  section: string;
  department: string;
  tag: Tag;
  bucket: Bucket;
  cost: number;
  hours: number;
}

export interface OtDay {
  date: string;
  /** 1-based position in the OT month, as the sheet numbers its rows. */
  day: number;
  manufacturing: BuSplit;
  other: BuSplit;
  hours: BuSplit;
  total: number;
  /**
   * The sections that ran overtime that day, dearest first.
   *
   * Only the ones that actually spent — a plant has dozens of sections and
   * almost none of them run every day, so carrying the zeroes would multiply
   * the payload for rows nobody wants to read.
   */
  sections: DaySection[];
}

export interface SectionRow {
  bu: BuKey;
  buLabel: string;
  section: string;
  department: string;
  tag: Tag;
  bucket: Bucket;
  cost: number;
  hours: number;
  /** Share of the period's total OT cost. */
  share: number;
  cumShare: number;
  cls: 'A' | 'B' | 'C';
  rank: number;
}

export interface MonthPoint {
  month: string;
  label: string;
  from: string;
  to: string;
  manufacturing: BuSplit;
  other: BuSplit;
  hours: BuSplit;
  total: number;
  plan: BuSplit | null;
  budget: BuSplit | null;
  /** Days in the window that recorded any overtime. */
  activeDays: number;
  /** Days in the window that have happened. */
  elapsedDays: number;
  windowDays: number;
  complete: boolean;
  partial: boolean;
}

export interface Spike {
  date: string;
  total: number;
  /** How many times the period's typical active day it is. */
  ratio: number;
  topSections: { section: string; buLabel: string; cost: number }[];
}

export interface OtAnalysis {
  /** Manufacturing's share of total plant OT — the sheet's own headline. */
  manufacturingShare: number;
  /** USD per OT hour across the period. */
  costPerHour: number;
  /** Cost by value-add tag, over every section. */
  vaMix: { tag: Tag; label: string; cost: number; share: number }[];
  /** Spend per active day, and what that projects to by period end. */
  perActiveDay: number;
  projectedTotal: number | null;
  /** Sections carrying the first 80% of cost. */
  paretoCount: number;
  paretoShare: number;
  spikes: Spike[];
  /** Same fiscal months one year earlier — only when already cached. */
  previous: { fy: number; total: number; months: number } | null;
}

export interface OtReport {
  scope: 'month' | 'fy' | 'ytd';
  /** The business unit this report covers; 'all' is the whole plant. */
  company: BuScope;
  fy: number;
  label: string;
  months: string[];
  from: string;
  to: string;
  days: OtDay[];
  byMonth: MonthPoint[];
  sections: SectionRow[];
  totals: {
    manufacturing: BuSplit;
    other: BuSplit;
    hours: BuSplit;
    total: number;
  };
  plan: BuSplit | null;
  budget: BuSplit | null;
  /**
   * Actual spend over exactly the months that carry a plan (or budget).
   *
   * A fiscal year can hold months with no target on record, and dividing a full
   * year's spend by a seven-month plan reads as a 47% overrun that never
   * happened. Percentages use these; the headline figure stays the real total.
   */
  planActual: BuSplit | null;
  budgetActual: BuSplit | null;
  /** Months in the period that carry no plan figure. */
  planGaps: string[];
  budgetGaps: string[];
  analysis: OtAnalysis;
  unmapped: string[];
  errors: { month: string; job: JobKey; error: string }[];
  /** Job-months still to fetch. Non-empty means the figures are partial. */
  pending: { month: string; job: JobKey }[];
  ready: boolean;
  /** Taka per dollar used for every figure above. */
  usdRate: number;
  /** Where that rate came from, so the page can show it. */
  rate: UsdRate;
  generatedAt: string;
}

const TAG_LABEL: Record<Tag, string> = {
  'M-VA': 'Manufacturing — value adding',
  'M-NVA': 'Manufacturing — non value adding',
  'NM-NVA': 'Non-manufacturing',
};

/* ------------------------------------------------------------------ dates */

function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); ) {
    out.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 86_400_000);
  }
  return out;
}

function targetFor(
  months: string[],
  kind: 'plan' | 'budget',
  bu: BuScope,
): { value: BuSplit | null; gaps: string[] } {
  let zipper = 0;
  let mt = 0;
  let seen = 0;
  const gaps: string[] = [];
  for (const month of months) {
    const t = TARGETS[month]?.[kind];
    if (!t) {
      gaps.push(month);
      continue;
    }
    zipper += t.zipper;
    mt += t.mt;
    seen++;
  }
  return { value: seen ? forBu(zipper, mt, bu) : null, gaps };
}

/* -------------------------------------------------------------- building */

interface Accumulated {
  /** date -> bucket -> bu -> USD */
  byDate: Map<string, { mfg: [number, number]; oth: [number, number]; hrs: [number, number] }>;
  /** `${bu}::${section}` -> totals */
  bySection: Map<string, { bu: BuKey; section: string; cost: number; hours: number }>;
  /** date -> section key -> that day's spend, so a day can say where it went. */
  byDateSection: Map<string, Map<string, { cost: number; hours: number }>>;
  unmapped: Set<string>;
}

const BU_INDEX: Record<BuKey, 0 | 1> = { zipper: 0, mt: 1 };

function accumulate(entries: OtJobMonth[], rate: number, bu: BuScope = 'all'): Accumulated {
  const acc: Accumulated = {
    byDate: new Map(),
    bySection: new Map(),
    byDateSection: new Map(),
    unmapped: new Set(),
  };
  const buOf = new Map<JobKey, BuKey>(JOBS.map((j) => [j.key, j.bu]));

  for (const entry of entries) {
    const entryBu = buOf.get(entry.job);
    if (!entryBu) continue;
    // Filtering here rather than after the fact keeps every derived figure —
    // the value-add mix, the Pareto, the spikes — about the unit on screen.
    if (bu !== 'all' && entryBu !== bu) continue;
    const i = BU_INDEX[entryBu];

    for (const [rawSection, series] of Object.entries(entry.sections)) {
      const section = rawSection;
      if (!sectionDef(entryBu, section)) {
        acc.unmapped.add(`${BU_LABEL[entryBu]} · ${section}`);
      }
      const bucket = bucketOf(entryBu, section);

      const sectionKey = `${entryBu}::${section}`;
      const slot =
        acc.bySection.get(sectionKey) ?? { bu: entryBu, section, cost: 0, hours: 0 };

      entry.dates.forEach((date, d) => {
        const cost = (series.cost[d] ?? 0) / rate;
        const hours = series.hours[d] ?? 0;
        if (!cost && !hours) return;

        slot.cost += cost;
        slot.hours += hours;

        const day =
          acc.byDate.get(date) ?? { mfg: [0, 0] as [number, number], oth: [0, 0] as [number, number], hrs: [0, 0] as [number, number] };
        if (bucket === 'manufacturing') day.mfg[i] += cost;
        else day.oth[i] += cost;
        day.hrs[i] += hours;
        acc.byDate.set(date, day);

        const perSection =
          acc.byDateSection.get(date) ?? new Map<string, { cost: number; hours: number }>();
        const cell = perSection.get(sectionKey) ?? { cost: 0, hours: 0 };
        cell.cost += cost;
        cell.hours += hours;
        perSection.set(sectionKey, cell);
        acc.byDateSection.set(date, perSection);
      });

      acc.bySection.set(sectionKey, slot);
    }
  }

  return acc;
}

/**
 * One day's spend broken out by section, dearest first.
 *
 * The section key is `${bu}::${section}`; the same section name exists under
 * both units, so the unit has to come back out of the key rather than be
 * guessed from the name.
 */
function daySections(acc: Accumulated, date: string): DaySection[] {
  const perSection = acc.byDateSection.get(date);
  if (!perSection) return [];

  const rows: DaySection[] = [];
  for (const [key, cell] of perSection) {
    if (!cell.cost && !cell.hours) continue;
    const cut = key.indexOf('::');
    const bu = key.slice(0, cut) as BuKey;
    const section = key.slice(cut + 2);
    const def = sectionDef(bu, section);
    rows.push({
      bu,
      buLabel: BU_LABEL[bu],
      section,
      department: def?.department ?? '',
      tag: (def?.tag ?? 'M-NVA') as Tag,
      bucket: bucketOf(bu, section),
      cost: cell.cost,
      hours: cell.hours,
    });
  }
  return rows.sort((a, b) => b.cost - a.cost);
}

function rankSections(acc: Accumulated, total: number): SectionRow[] {
  const rows = [...acc.bySection.values()]
    .map((s) => {
      const def = sectionDef(s.bu, s.section);
      return {
        bu: s.bu,
        buLabel: BU_LABEL[s.bu],
        section: s.section,
        department: def?.department ?? '',
        tag: (def?.tag ?? 'M-NVA') as Tag,
        bucket: bucketOf(s.bu, s.section),
        cost: s.cost,
        hours: s.hours,
        share: 0,
        cumShare: 0,
        cls: 'C' as 'A' | 'B' | 'C',
        rank: 0,
      };
    })
    .filter((r) => r.cost !== 0 || r.hours !== 0)
    .sort((a, b) => b.cost - a.cost);

  let cum = 0;
  rows.forEach((row, i) => {
    cum += row.cost;
    row.rank = i + 1;
    row.share = total ? row.cost / total : 0;
    row.cumShare = total ? cum / total : 0;
    row.cls = row.cumShare <= 0.8 ? 'A' : row.cumShare <= 0.95 ? 'B' : 'C';
  });

  return rows;
}

function buildDays(acc: Accumulated, months: string[]): OtDay[] {
  const out: OtDay[] = [];
  for (const month of months) {
    const { from, to } = otPeriod(month);
    eachDate(from, to).forEach((date, i) => {
      const d = acc.byDate.get(date);
      const mfg = split(d?.mfg[0] ?? 0, d?.mfg[1] ?? 0);
      const oth = split(d?.oth[0] ?? 0, d?.oth[1] ?? 0);
      out.push({
        date,
        day: i + 1,
        manufacturing: mfg,
        other: oth,
        hours: split(d?.hrs[0] ?? 0, d?.hrs[1] ?? 0),
        total: mfg.total + oth.total,
        sections: daySections(acc, date),
      });
    });
  }
  return out;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function analyse(
  days: OtDay[],
  sections: SectionRow[],
  totals: OtReport['totals'],
  byMonth: MonthPoint[],
  previous: OtAnalysis['previous'],
): OtAnalysis {
  const active = days.filter((d) => d.total > 0);
  const perActiveDay = active.length ? totals.total / active.length : 0;

  // The median of the days that actually ran overtime — a mean would be dragged
  // up by the very spikes this is meant to find.
  const typical = median(active.map((d) => d.total));
  const spikes: Spike[] = active
    .filter((d) => typical > 0 && d.total >= typical * 2)
    .sort((a, b) => b.total - a.total)
    .slice(0, 5)
    .map((d) => ({
      date: d.date,
      total: d.total,
      ratio: d.total / typical,
      // The day already carries its own breakdown, sorted dearest first.
      topSections: d.sections
        .slice(0, 3)
        .map((s) => ({ section: s.section, buLabel: s.buLabel, cost: s.cost })),
    }));

  const vaTotals = new Map<Tag, number>();
  for (const s of sections) vaTotals.set(s.tag, (vaTotals.get(s.tag) ?? 0) + s.cost);
  const vaMix = (['M-VA', 'M-NVA', 'NM-NVA'] as Tag[]).map((tag) => ({
    tag,
    label: TAG_LABEL[tag],
    cost: vaTotals.get(tag) ?? 0,
    share: totals.total ? (vaTotals.get(tag) ?? 0) / totals.total : 0,
  }));

  const pareto = sections.filter((s) => s.cls === 'A');

  // Projection only means something while the period is still running. Days
  // left are scaled by how often a day has actually run overtime so far —
  // spending every remaining calendar day would assume no weekends or holidays.
  const remainingDays = byMonth.reduce((a, m) => a + (m.windowDays - m.elapsedDays), 0);
  const elapsedDays = byMonth.reduce((a, m) => a + m.elapsedDays, 0);
  const activeRate = elapsedDays ? active.length / elapsedDays : 0;
  const projectedTotal =
    remainingDays > 0 && active.length
      ? totals.total + perActiveDay * remainingDays * activeRate
      : null;

  return {
    manufacturingShare: totals.total ? totals.manufacturing.total / totals.total : 0,
    costPerHour: totals.hours.total ? totals.total / totals.hours.total : 0,
    vaMix,
    perActiveDay,
    projectedTotal,
    paretoCount: pareto.length,
    paretoShare: pareto.reduce((a, s) => a + s.share, 0),
    spikes,
    previous,
  };
}

/* ------------------------------------------------------------------ entry */

export interface BuildOptions {
  scope: 'month' | 'fy' | 'ytd';
  fy: number;
  months: string[];
  label: string;
  /** Narrow to one business unit; defaults to the whole plant. */
  company?: BuScope;
  budget?: number;
}

async function previousYearTotal(
  fy: number,
  months: string[],
  rate: number,
  bu: BuScope,
): Promise<OtAnalysis['previous']> {
  const shifted = months.map((m) => `${Number(m.slice(0, 4)) - 1}${m.slice(4)}`);
  // Budget 0: read whatever is cached, never start a fetch for the comparison.
  const { entries } = await rangeJobMonths(shifted, 0);
  const have = new Set(entries.filter((e) => !e.error && e.dates.length).map((e) => e.month));
  if (!have.size) return null;

  const acc = accumulate(entries.filter((e) => have.has(e.month)), rate, bu);
  let total = 0;
  for (const d of acc.byDate.values()) {
    total += d.mfg[0] + d.mfg[1] + d.oth[0] + d.oth[1];
  }
  return { fy: fy - 1, total, months: have.size };
}

export async function buildOtReport(opts: BuildOptions): Promise<OtReport> {
  const { months, scope, fy, label } = opts;
  const company: BuScope = opts.company ?? 'all';
  // The rate is looked up once per report and applied to the cached BDT
  // figures, so changing it never costs an Odoo refetch.
  const rate = await usdRate();
  const { entries, pending } = await rangeJobMonths(months, opts.budget);

  const acc = accumulate(entries, rate.rate, company);
  const days = buildDays(acc, months);

  const totalsManufacturing = split(
    days.reduce((a, d) => a + d.manufacturing.zipper, 0),
    days.reduce((a, d) => a + d.manufacturing.mt, 0),
  );
  const totalsOther = split(
    days.reduce((a, d) => a + d.other.zipper, 0),
    days.reduce((a, d) => a + d.other.mt, 0),
  );
  const totalsHours = split(
    days.reduce((a, d) => a + d.hours.zipper, 0),
    days.reduce((a, d) => a + d.hours.mt, 0),
  );
  const totals = {
    manufacturing: totalsManufacturing,
    other: totalsOther,
    hours: totalsHours,
    total: totalsManufacturing.total + totalsOther.total,
  };

  const today = todayIso();
  const failedMonths = new Set(entries.filter((e) => e.error).map((e) => e.month));
  const pendingMonths = new Set(pending.map((p) => p.month));

  const byMonth: MonthPoint[] = months.map((month) => {
    const { from, to } = otPeriod(month);
    const slice = days.filter((d) => d.date >= from && d.date <= to);
    const mfg = split(
      slice.reduce((a, d) => a + d.manufacturing.zipper, 0),
      slice.reduce((a, d) => a + d.manufacturing.mt, 0),
    );
    const oth = split(
      slice.reduce((a, d) => a + d.other.zipper, 0),
      slice.reduce((a, d) => a + d.other.mt, 0),
    );
    const windowDays = slice.length;
    const elapsedDays = slice.filter((d) => d.date <= today).length;
    const t = TARGETS[month];
    return {
      month,
      label: monthLabel(month),
      from,
      to,
      manufacturing: mfg,
      other: oth,
      hours: split(
        slice.reduce((a, d) => a + d.hours.zipper, 0),
        slice.reduce((a, d) => a + d.hours.mt, 0),
      ),
      total: mfg.total + oth.total,
      plan: t?.plan ? forBu(t.plan.zipper, t.plan.mt, company) : null,
      budget: t?.budget ? forBu(t.budget.zipper, t.budget.mt, company) : null,
      activeDays: slice.filter((d) => d.total > 0).length,
      elapsedDays,
      windowDays,
      complete: to < today,
      partial: failedMonths.has(month) || pendingMonths.has(month),
    };
  });

  const sections = rankSections(acc, totals.total);
  const plan = targetFor(months, 'plan', company);
  const budget = targetFor(months, 'budget', company);

  /** Spend over exactly the months that carry the given target. */
  const actualWhere = (kind: 'plan' | 'budget'): BuSplit | null => {
    const covered = byMonth.filter((m) => m[kind]);
    if (!covered.length) return null;
    return split(
      covered.reduce((a, m) => a + m.manufacturing.zipper + m.other.zipper, 0),
      covered.reduce((a, m) => a + m.manufacturing.mt + m.other.mt, 0),
    );
  };

  // The year-earlier comparison is a nicety; never let it fail the report.
  let previous: OtAnalysis['previous'] = null;
  try {
    previous = await previousYearTotal(fy, months, rate.rate, company);
  } catch {
    /* the comparison is optional */
  }

  return {
    scope,
    company,
    fy,
    label,
    months,
    from: otPeriod(months[0]).from,
    to: otPeriod(months[months.length - 1]).to,
    days,
    byMonth,
    sections,
    totals,
    plan: plan.value,
    budget: budget.value,
    planActual: actualWhere('plan'),
    budgetActual: actualWhere('budget'),
    planGaps: plan.gaps,
    budgetGaps: budget.gaps,
    analysis: analyse(days, sections, totals, byMonth, previous),
    unmapped: [...acc.unmapped].sort(),
    errors: entries
      .filter((e) => e.error)
      .map((e) => ({ month: e.month, job: e.job, error: e.error! })),
    pending,
    ready: pending.length === 0,
    usdRate: rate.rate,
    rate,
    generatedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------ convenience */

export function fyReportMonths(fy: number, scope: 'fy' | 'ytd', upTo: string): string[] {
  const all = fyOtMonths(fy);
  return scope === 'fy' ? all : all.filter((m) => m <= upTo);
}
