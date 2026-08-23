/**
 * OA released, in the site's rail-plus-full-sheet shape: the rail says how much
 * work came in and where it is concentrated, one trend chart carries the shape
 * of the order book over time, and the sheet lists every product.
 *
 * A product row opens in place. Underneath it goes its own history — the whole
 * run of months as a chart, split by company — plus what the roll-up threw
 * away: the internal codes, the variants, the customers and the last OAs. The
 * history is free (the page already holds every month); the rest is fetched
 * once per product and kept.
 */
import { barChart, bindChartTooltips, lineChart, sparkline } from '../lib/charts';
import { skeleton } from '../lib/skeleton';

interface ProductEntry {
  value: number;
  qty: number;
  lines: number;
  variants: number;
}

interface CompanyMonth {
  id: number;
  name: string;
  orders: number;
  value: number;
  qty: number;
  lines: number;
  byProduct: Record<string, ProductEntry>;
}

interface MonthOa {
  month: string;
  companies: CompanyMonth[];
  fetchedAt: string;
  error?: string;
}

interface OaHistory {
  months: MonthOa[];
  companies: { id: number; name: string }[];
  pending: string[];
  failed: { month: string; error: string }[];
  ready: boolean;
  firstMonth: string;
  fetchedAt: string;
}

interface Breakdown {
  name: string;
  value: number;
  qty: number;
  lines: number;
}

interface ProductDetail {
  product: string;
  byVariant: Breakdown[];
  byCode: Breakdown[];
  byCustomer: Breakdown[];
  recent: { order: string; date: string; customer: string; company: string; value: number }[];
  error?: string;
}

/** A product's whole run of months, already narrowed to the chosen company. */
interface ProductRow {
  name: string;
  value: number;
  qty: number;
  lines: number;
  orders: number;
  share: number;
  months: number;
  firstMonth: string;
  lastMonth: string;
  peak: { month: string; value: number };
  /** Cumulative share up to and including this row, once ranked. */
  cumShare: number;
  /** The 80 / 95 cut, the same language Production ABC uses. */
  cls: 'A' | 'B' | 'C';
  /** Value per month, aligned to the visible month list. */
  series: number[];
  /** Same, split by company id — the drill-down chart. */
  byCompany: Map<number, number[]>;
  companies: string[];
  /**
   * First and last month across ALL of history, not just the window. What makes
   * a product new or gone quiet is its whole life, not the slice on screen.
   */
  everFirst: string;
  everLast: string;
}

type Measure = 'value' | 'qty';

const root = document.querySelector<HTMLElement>('.oa');

if (root) {
  const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
  const el = {
    status: $<HTMLElement>('#oa-status'),
    body: $<HTMLElement>('#oa-body'),
    rail: $<HTMLElement>('#oa-rail'),
    chips: $<HTMLElement>('#oa-chips'),
    grid: $<HTMLElement>('#oa-grid'),
    note: $<HTMLElement>('#oa-note'),
    trend: $<HTMLElement>('#oa-trend'),
    trendNote: $<HTMLElement>('#oa-trend-note'),
    companySeg: $<HTMLElement>('#oa-company'),
    periodSeg: $<HTMLElement>('#oa-period'),
    monthPick: $<HTMLSelectElement>('#oa-month'),
  };

  const state = {
    company: 'all' as string,
    period: 'all' as string,
    /** A month inside the selected period, or '' for all of them. */
    month: '',
    measure: 'value' as Measure,
    query: '',
    open: null as string | null,
    history: null as OaHistory | null,
    detail: new Map<string, ProductDetail | 'loading'>(),
  };

  const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const usd = (v: number) => `$${nf.format(Math.round(v))}`;

  /**
   * Money at a glance, for the breakdown tables.
   *
   * Those columns sit three-across under a row and a full "$20,742,566" would
   * squeeze the name it belongs to off the side. The exact figures are on the
   * sheet above and in the export.
   */
  const usdShort = (v: number) => {
    const abs = Math.abs(v);
    if (abs >= 1e6) return `$${(v / 1e6).toFixed(abs >= 1e7 ? 1 : 2)}M`;
    if (abs >= 1e3) return `$${Math.round(v / 1e3)}k`;
    return `$${Math.round(v)}`;
  };
  const qty = (v: number) => nf.format(Math.round(v));
  const pct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;
  const esc = (s: string | number) =>
    String(s).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
    );

  const monthShort = (iso: string) =>
    new Date(`${iso}-01T00:00:00Z`).toLocaleDateString('en-GB', {
      month: 'short',
      year: '2-digit',
      timeZone: 'UTC',
    });
  const monthLong = (iso: string) =>
    new Date(`${iso}-01T00:00:00Z`).toLocaleDateString('en-GB', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });

  /** April to March, the way the plant counts a year. */
  const fyOf = (month: string) => {
    const [y, m] = month.split('-').map(Number);
    return m >= 4 ? y : y - 1;
  };
  const fyLabel = (fy: number) => `FY ${String(fy).slice(2)}-${String(fy + 1).slice(2)}`;

  const measureLabel = () => (state.measure === 'value' ? 'Value' : 'Quantity');
  const fmt = (v: number) => (state.measure === 'value' ? usd(v) : qty(v));

  let inFlight: AbortController | null = null;

  /* ------------------------------------------------------------------ load */

  function showSkeleton() {
    el.status.hidden = true;
    el.body.hidden = false;
    el.rail.innerHTML = skeleton.rail();
    el.trend.innerHTML = skeleton.chart();
    el.chips.innerHTML = skeleton.chips(5);
    el.grid.innerHTML = skeleton.table(9, 10);
    el.note.textContent = '';
  }

  async function load(fresh = true) {
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;

    if (fresh) showSkeleton();

    try {
      const res = await fetch('/api/oa-released', { signal: controller.signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);

      state.history = data as OaHistory;
      render();

      // The server fills a few months per request; keep asking while partial.
      if (!state.history.ready) void load(false);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      el.body.hidden = true;
      el.status.hidden = false;
      el.status.classList.add('error');
      el.status.innerHTML = `<h2>Could not read the order book</h2><p style="font-family:var(--mono);font-size:12.5px">${esc(
        (err as Error).message,
      )}</p>`;
    }
  }

  /* --------------------------------------------------------------- shaping */

  const companyId = () => (state.company === 'all' ? null : Number(state.company));

  /**
   * The months the selected period covers, oldest first — before the month
   * filter narrows it. This is also the list the month picker offers, so
   * picking FY 26-27 offers that year's months and nothing else.
   */
  function periodMonths(h: OaHistory): string[] {
    const all = h.months.map((m) => m.month).sort();
    if (state.period === 'all') return all;
    if (state.period === 'r12') return all.slice(-12);
    const fy = Number(state.period);
    return all.filter((m) => fyOf(m) === fy);
  }

  /** The month the sheet is narrowed to, if it is still inside the period. */
  function pickedMonth(h: OaHistory): string | null {
    if (!state.month) return null;
    return periodMonths(h).includes(state.month) ? state.month : null;
  }

  /** The months on screen, oldest first, after both filters. */
  function visibleMonths(h: OaHistory): string[] {
    const months = periodMonths(h);
    const month = pickedMonth(h);
    return month ? months.filter((m) => m === month) : months;
  }

  /**
   * The months the trend chart draws, which are not always the months the
   * sheet counts.
   *
   * Filtered to a single month, the sheet is right to show that month alone —
   * but a chart of one bar says nothing at all. So the chart keeps the year
   * running up to it, and its note says which month the sheet below is.
   */
  function chartMonths(h: OaHistory, visible: string[]): string[] {
    const month = pickedMonth(h);
    if (!month) return visible;
    // The run-up comes from the whole history, not from the period: a month at
    // the start of a fiscal year still has a year behind it.
    const all = h.months.map((m) => m.month).sort();
    const at = all.indexOf(month);
    return at < 0 ? visible : all.slice(Math.max(at - 12, 0), at + 1);
  }

  /** The company slices that count, for one month, under the current filter. */
  function slices(month: MonthOa): CompanyMonth[] {
    const id = companyId();
    return id === null ? month.companies : month.companies.filter((c) => c.id === id);
  }

  interface Band {
    cls: 'A' | 'B' | 'C';
    count: number;
    share: number;
  }

  interface Momentum {
    /** The month in progress, e.g. "1–22 Aug 26". */
    window: string;
    soFar: number;
    /** What this pace lands on by month end. */
    pace: number;
    /** The previous fiscal year's average month, and how it is labelled. */
    average: number;
    averageLabel: string;
    /** How many months of that year carried anything. */
    averageMonths: number;
    lastYear: number;
    lastYearMonth: string;
    delta: number;
  }

  interface Movement {
    fresh: ProductRow[];
    quiet: ProductRow[];
    /** What "new" was measured against, for the wording. */
    since: string;
    /** True when the window is everything, so "new" fell back to a rolling year. */
    rolling: boolean;
  }

  interface Shaped {
    months: string[];
    rows: ProductRow[];
    total: { value: number; qty: number; lines: number; orders: number };
    byCompany: { id: number; name: string; value: number; orders: number; series: number[] }[];
    perMonth: number[];
    /** The chart's own window and series — see chartMonths(). */
    chart: {
      months: string[];
      byCompany: { name: string; series: number[] }[];
      /** Index of the month the sheet is filtered to, or -1. */
      focus: number;
      /**
       * Each product over the same window. Narrowed to one month the sheet's
       * own series is a single point, which draws nothing — the row's trend
       * comes from here instead.
       */
      byProduct: Map<string, number[]>;
    };
    bands: Band[];
    momentum: Momentum | null;
    movement: Movement;
    /** Indices in `months` where a fiscal year opens — April, bar the first. */
    fyStarts: number[];
    fyLabels: Record<number, string>;
  }

  function shape(h: OaHistory): Shaped {
    const months = visibleMonths(h);
    const index = new Map(months.map((m, i) => [m, i]));
    const byMonth = new Map(h.months.map((m) => [m.month, m]));

    const rows = new Map<string, ProductRow>();
    const companies = new Map<
      number,
      { id: number; name: string; value: number; orders: number; series: number[] }
    >();
    const perMonth = months.map(() => 0);
    const total = { value: 0, qty: 0, lines: 0, orders: 0 };

    for (const month of months) {
      const i = index.get(month)!;
      const doc = byMonth.get(month);
      if (!doc) continue;

      for (const company of slices(doc)) {
        const held =
          companies.get(company.id) ??
          companies
            .set(company.id, {
              id: company.id,
              name: company.name,
              value: 0,
              orders: 0,
              series: months.map(() => 0),
            })
            .get(company.id)!;
        held.value += company.value;
        held.orders += company.orders;
        held.series[i] += company.value;

        total.value += company.value;
        total.qty += company.qty;
        total.lines += company.lines;
        total.orders += company.orders;
        perMonth[i] += state.measure === 'value' ? company.value : company.qty;

        for (const [name, entry] of Object.entries(company.byProduct)) {
          let row = rows.get(name);
          if (!row) {
            row = {
              name,
              value: 0,
              qty: 0,
              lines: 0,
              orders: 0,
              share: 0,
              months: 0,
              firstMonth: month,
              lastMonth: month,
              peak: { month, value: 0 },
              cumShare: 0,
              cls: 'C',
              series: months.map(() => 0),
              byCompany: new Map(),
              companies: [],
              everFirst: month,
              everLast: month,
            };
            rows.set(name, row);
          }
          row.value += entry.value;
          row.qty += entry.qty;
          row.lines += entry.lines;
          if (month < row.firstMonth) row.firstMonth = month;
          if (month > row.lastMonth) row.lastMonth = month;

          const measured = state.measure === 'value' ? entry.value : entry.qty;
          row.series[i] += measured;

          let series = row.byCompany.get(company.id);
          if (!series) row.byCompany.set(company.id, (series = months.map(() => 0)));
          series[i] += measured;

          if (!row.companies.includes(company.name)) row.companies.push(company.name);
        }
      }
    }

    const grand = state.measure === 'value' ? total.value : total.qty;
    const shaped = [...rows.values()];
    for (const row of shaped) {
      const measured = state.measure === 'value' ? row.value : row.qty;
      row.share = grand ? measured / grand : 0;
      row.months = row.series.filter((v) => v > 0).length;
      row.peak = row.series.reduce(
        (best, v, i) => (v > best.value ? { month: months[i], value: v } : best),
        { month: row.firstMonth, value: 0 },
      );
    }
    shaped.sort((a, b) => (state.measure === 'value' ? b.value - a.value : b.qty - a.qty));

    /*
     * The 80 / 95 cut, ranked - the same bands Production ABC uses, so a
     * product that is class A there and class C here says something rather
     * than just looking inconsistent.
     */
    let running = 0;
    for (const row of shaped) {
      running += row.share;
      row.cumShare = running;
      row.cls = running <= 0.8001 ? 'A' : running <= 0.9501 ? 'B' : 'C';
    }
    const bands: Band[] = (['A', 'B', 'C'] as const).map((cls) => {
      const members = shaped.filter((r) => r.cls === cls);
      return { cls, count: members.length, share: members.reduce((a, r) => a + r.share, 0) };
    });

    lifetimes(h, shaped);

    return {
      months,
      rows: shaped,
      total,
      byCompany: [...companies.values()].sort((a, b) => a.id - b.id),
      perMonth,
      chart: chartWindow(h, months),
      bands,
      momentum: momentumOf(h),
      movement: movementOf(h, shaped, months),
      ...fyMarks(months),
    };
  }

  /** Company totals over the chart's window, which may be wider than the sheet's. */
  function chartWindow(h: OaHistory, visible: string[]) {
    const months = chartMonths(h, visible);
    const byMonth = new Map(h.months.map((m) => [m.month, m]));
    const series = new Map<string, number[]>();
    const byProduct = new Map<string, number[]>();
    const measured = state.measure === 'value';

    months.forEach((month, i) => {
      const doc = byMonth.get(month);
      if (!doc) return;
      for (const company of slices(doc)) {
        let held = series.get(company.name);
        if (!held) series.set(company.name, (held = months.map(() => 0)));
        held[i] += company.value;

        for (const [name, entry] of Object.entries(company.byProduct)) {
          let run = byProduct.get(name);
          if (!run) byProduct.set(name, (run = months.map(() => 0)));
          run[i] += measured ? entry.value : entry.qty;
        }
      }
    });

    const month = pickedMonth(h);
    return {
      months,
      byCompany: [...series.entries()].map(([name, values]) => ({ name, series: values })),
      focus: month ? months.indexOf(month) : -1,
      byProduct,
    };
  }

  /**
   * When each product was first and last released, across everything Odoo
   * holds - not the window on screen.
   *
   * Whether a product is new or has gone quiet is a fact about its whole life.
   * Read off the visible slice instead, every product looks new the moment you
   * pick a fiscal year.
   */
  function lifetimes(h: OaHistory, rows: ProductRow[]) {
    const life = new Map<string, { first: string; last: string }>();
    for (const doc of h.months) {
      for (const company of slices(doc)) {
        for (const [name, entry] of Object.entries(company.byProduct)) {
          if (entry.value <= 0 && entry.qty <= 0) continue;
          const held = life.get(name);
          if (!held) life.set(name, { first: doc.month, last: doc.month });
          else {
            if (doc.month < held.first) held.first = doc.month;
            if (doc.month > held.last) held.last = doc.month;
          }
        }
      }
    }
    for (const row of rows) {
      const held = life.get(row.name);
      row.everFirst = held?.first ?? row.firstMonth;
      row.everLast = held?.last ?? row.lastMonth;
    }
  }

  /** Where the fiscal years break, for the dividers under the trend chart. */
  function fyMarks(months: string[]) {
    const fyStarts: number[] = [];
    const fyLabels: Record<number, string> = {};
    months.forEach((month, i) => {
      if (i > 0 && !month.endsWith('-04')) return;
      if (i > 0) fyStarts.push(i);
      fyLabels[i] = fyLabel(fyOf(month));
    });
    return { fyStarts, fyLabels };
  }

  /**
   * The month in progress, against the previous fiscal year's average month.
   *
   * The order book leads the floor by weeks, so the question this page is
   * opened with is "is work still coming in" - and a part-month total answers
   * it wrongly on its own. The pace projects the days elapsed across the whole
   * month, and an average month is what it gets judged against.
   *
   * That average is the last full fiscal year rather than a rolling twelve.
   * A rolling window is the more responsive measure, but it straddles two
   * years - in August it would run from the previous August - and every other
   * figure on this site is read against a fiscal year. A benchmark that means
   * something different from the year buttons above it is a benchmark people
   * misread. If the year is not complete in the data, it falls back to the
   * rolling twelve and says so on the card.
   *
   * Always the live month and always in money, whatever the filters say: it is
   * a reading of the business, not of the slice on screen.
   */
  function momentumOf(h: OaHistory): Momentum | null {
    const live = h.months.at(-1);
    if (!live) return null;

    const valueOf = (month: string) => {
      const doc = h.months.find((m) => m.month === month);
      return doc ? slices(doc).reduce((a, c) => a + c.value, 0) : 0;
    };

    const soFar = valueOf(live.month);
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const isCurrent = live.month === thisMonth;
    const [y, m] = live.month.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const elapsed = isCurrent ? Math.min(now.getDate(), daysInMonth) : daysInMonth;

    // The last full fiscal year: the one before the live month's.
    const prevFy = fyOf(live.month) - 1;
    const inPrevFy = h.months
      .filter((doc) => fyOf(doc.month) === prevFy)
      .map((doc) => slices(doc).reduce((a, c) => a + c.value, 0))
      .filter((v) => v > 0);

    // A part-year would flatter or punish the pace depending on which months
    // happened to be held, so it only counts when the year is whole.
    const usePrevFy = inPrevFy.length === 12;
    const benchmark = usePrevFy
      ? inPrevFy
      : h.months
          .slice(-13, -1)
          .map((doc) => slices(doc).reduce((a, c) => a + c.value, 0))
          .filter((v) => v > 0);
    const average = benchmark.length
      ? benchmark.reduce((a, v) => a + v, 0) / benchmark.length
      : 0;

    const lastYearMonth = `${y - 1}-${String(m).padStart(2, '0')}`;
    const pace = elapsed ? (soFar / elapsed) * daysInMonth : soFar;

    return {
      window: isCurrent
        ? `1-${elapsed} ${monthShort(live.month)}`
        : `all of ${monthShort(live.month)}`,
      soFar,
      pace,
      average,
      averageLabel: usePrevFy ? fyLabel(prevFy) : 'last 12 months',
      averageMonths: benchmark.length,
      lastYear: valueOf(lastYearMonth),
      lastYearMonth,
      delta: average ? pace / average - 1 : 0,
    };
  }

  /**
   * What has arrived and what has stopped.
   *
   * Both are derivable from what the page already holds and neither was
   * anywhere on it. Two rules earn the block its place:
   *
   *   New    - first released inside the window. Over ALL of history that is
   *            every product that did not exist in April 2023, which is most
   *            of the catalogue and says nothing, so the whole-history case
   *            falls back to a rolling twelve months and says which it used.
   *
   *   Quiet  - nothing released for three months or more, counting only the
   *            products inside the 95% cut. A class-C product going quiet is
   *            the tail behaving like a tail; a class-A one going quiet is the
   *            reason someone opens this page.
   */
  function movementOf(h: OaHistory, rows: ProductRow[], months: string[]): Movement {
    const all = h.months.map((m) => m.month).sort();
    const latest = all.at(-1) ?? months.at(-1) ?? '';
    const windowStart = months[0] ?? '';
    const wholeRun = windowStart <= (all[0] ?? '');

    const since = wholeRun ? shiftMonths(latest, -11) : windowStart;
    const cutoff = shiftMonths(latest, -3);

    return {
      since,
      rolling: wholeRun,
      // A product alive in the very first month Odoo holds is not "new" - that
      // is where the data starts, not where the product did.
      fresh: rows
        .filter((r) => r.everFirst >= since && r.everFirst > (all[0] ?? ''))
        .sort((a, b) => b.value - a.value),
      quiet: rows
        .filter((r) => r.cls !== 'C' && r.everLast <= cutoff)
        .sort((a, b) => b.value - a.value),
    };
  }

  function shiftMonths(month: string, by: number): string {
    const [y, m] = month.split('-').map(Number);
    const total = y * 12 + (m - 1) + by;
    return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
  }

  /* ------------------------------------------------------------------ rail */

  const railBlock = (label: string, body: string, note = '') =>
    `<section class="rail-block">
      <h2>${label}</h2>
      ${body}
      ${note ? `<p class="rail-note">${note}</p>` : ''}
    </section>`;

  const bar = (fillPct: number, cls = 'accent') =>
    `<div class="meter"><span class="meter-fill ${cls}" style="width:${Math.max(
      0,
      Math.min(fillPct, 100),
    ).toFixed(1)}%"></span></div>`;

  function periodLabel(s: Shaped): string {
    if (!s.months.length) return 'no months';
    // Narrowed to one month, the month IS the label — but it keeps the period
    // beside it, because that is what the figures are a share of.
    if (s.months.length === 1 && state.month === s.months[0]) {
      const within =
        state.period === 'all' ? '' : ` of ${state.period === 'r12' ? 'the last 12 months' : fyLabel(Number(state.period))}`;
      return monthLong(s.months[0]) + within;
    }
    if (state.period === 'all') return `${monthShort(s.months[0])} — ${monthShort(s.months.at(-1)!)}`;
    if (state.period === 'r12') return 'last 12 months';
    return fyLabel(Number(state.period));
  }

  /**
   * The month in progress, and whether work is still coming in.
   *
   * This leads the rail because it is the question the page is opened with.
   * The order book runs weeks ahead of the floor, so a thin month here is the
   * first warning the production report will give in six weeks' time.
   *
   * A part-month total on its own reads as a collapse every time you look at
   * it on the 3rd, so the figure that gets judged is the pace: what the days
   * elapsed so far project across the whole month. Money, always - the
   * quantity toggle mixes pieces with yards across the two companies, and a
   * pace built on that would compare nothing to nothing.
   */
  function momentumBlock(m: Momentum): string {
    const up = m.delta >= 0;
    // Both bars share a scale, so the pace can be read against the average
    // rather than each being a full bar that says nothing.
    const ceiling = Math.max(m.pace, m.average) * 1.15 || 1;

    return `<section class="rail-block oa-momentum">
      <div class="oa-momentum-head">
        <h2>Month in progress</h2>
        <span class="oa-momentum-window">${esc(m.window)}</span>
      </div>
      <p class="rail-figure">
        ${usd(m.soFar)}
        <span class="oa-delta ${up ? 'up' : 'down'}">${up ? '+' : ''}${(m.delta * 100).toFixed(
          0,
        )}% vs ${esc(m.averageLabel)}</span>
      </p>
      <p class="rail-sub">On this pace <strong>${usd(m.pace)}</strong> by month end. An average
      month of ${esc(m.averageLabel)} was ${usd(m.average)}${
        m.averageMonths === 12 ? '' : ` (${m.averageMonths} months)`
      }${
        m.lastYear ? `; ${esc(monthShort(m.lastYearMonth))} itself was ${usd(m.lastYear)}` : ''
      }.</p>
      <div class="oa-pace">
        <span class="oa-pace-fill" style="width:${((m.soFar / ceiling) * 100).toFixed(1)}%"></span>
        <span class="oa-pace-mark" style="left:${((m.average / ceiling) * 100).toFixed(
          1,
        )}%"></span>
      </div>
      <div class="oa-pace-key"><span>released so far</span><span>marker: ${esc(
        m.averageLabel,
      )} average month</span></div>
    </section>`;
  }

  /**
   * What has arrived and what has stopped.
   *
   * Every other block on this page is a total. This one is the only thing that
   * says something changed, which is usually why a report gets opened at all.
   */
  function movementBlock(s: Shaped): string {
    const names = (rows: ProductRow[], suffix?: (r: ProductRow) => string) =>
      rows
        .slice(0, 2)
        .map((r) => esc(r.name) + (suffix ? ` <span class="rail-of">${suffix(r)}</span>` : ''))
        .join(', ') + (rows.length > 2 ? ` and ${qty(rows.length - 2)} more` : '');

    const { fresh, quiet, since, rolling } = s.movement;
    const when = rolling ? `since ${monthShort(since)}` : 'in this period';

    return `<section class="rail-block">
      <h2>Movement</h2>
      <ul class="oa-movement">
        <li>
          <b class="oa-move-count up">+${qty(fresh.length)}</b>
          <span>${
            fresh.length
              ? `first released ${when} — ${names(fresh)}`
              : `nothing first released ${when}`
          }</span>
        </li>
        <li>
          <b class="oa-move-count ${quiet.length ? 'down' : ''}">${
            quiet.length ? `−${qty(quiet.length)}` : '0'
          }</b>
          <span>${
            quiet.length
              ? `inside the 95% cut, quiet three months or more — ${names(
                  quiet,
                  (r) => `last ${monthShort(r.everLast)}`,
                )}`
              : 'nothing inside the 95% cut has gone quiet'
          }</span>
        </li>
      </ul>
    </section>`;
  }

  function renderRail(h: OaHistory, s: Shaped) {
    const head = `<div class="rail-head">
      <p class="eyebrow">${esc(periodLabel(s))}${h.ready ? '' : ' · filling'}</p>
      <h2 class="rail-title">What has been let go to the floor</h2>
      <p class="rail-sub">Bulk orders whose release status is <em>released</em>, valued ex tax and
      dated by the order. This is what the plant has been told to make, not what it has made.</p>
    </div>`;

    const split = s.byCompany
      .map(
        (c, i) => `<div class="rail-split">
          <div class="rail-split-head">
            <span><i class="swatch s${i + 1}"></i>${esc(c.name)}</span>
            <b>${usd(c.value)} <span class="rail-of">${pct(
              s.total.value ? c.value / s.total.value : 0,
            )}</span></b>
          </div>
          ${bar(s.total.value ? (c.value / s.total.value) * 100 : 0, `s${i + 1}`)}
          <p class="rail-note">${qty(c.orders)} OA${c.orders === 1 ? '' : 's'} · ${usd(
            c.orders ? c.value / c.orders : 0,
          )} average</p>
        </div>`,
      )
      .join('');

    const released = railBlock(
      `Released, ${periodLabel(s)}`,
      `<p class="rail-figure">${fmt(state.measure === 'value' ? s.total.value : s.total.qty)}
         <span class="rail-of">${state.measure === 'value' ? 'ex tax' : 'in each line\u2019s own unit'}</span></p>
       <p class="rail-sub">${qty(s.total.orders)} OAs · ${qty(s.total.lines)} lines · ${qty(
         s.rows.length,
       )} products</p>
       ${split}`,
      h.pending.length
        ? `${qty(h.months.length)} of ${qty(
            h.months.length + h.pending.length,
          )} months read — these figures are still partial.`
        : '',
    );

    const top = s.rows[0];
    const bandOf = (cls: 'A' | 'B' | 'C') => s.bands.find((b) => b.cls === cls)!;
    const a = bandOf('A');
    const c = bandOf('C');
    const concentration = top
      ? railBlock(
          'Concentration',
          `<p class="rail-figure">${pct(top.share)} <span class="rail-of">on one product</span></p>
           <p class="rail-sub"><strong>${esc(top.name)}</strong> alone. Class A is ${qty(
             a.count,
           )} product${a.count === 1 ? '' : 's'} carrying ${pct(a.share)}; the tail is ${qty(
             c.count,
           )} products under ${pct(c.share)}.</p>`,
        )
      : '';

    // The rail used to carry fourteen months of bars, which was the trend chart
    // again in less room. The chart keeps that job; the rail answers questions
    // the chart cannot.
    el.rail.innerHTML =
      head +
      (s.momentum ? momentumBlock(s.momentum) : '') +
      released +
      concentration +
      movementBlock(s);
  }

  /* ----------------------------------------------------------------- trend */

  function renderTrend(s: Shaped) {
    if (!s.months.length) {
      el.trend.innerHTML = '<div class="state"><p>No months to show.</p></div>';
      el.trendNote.textContent = '';
      return;
    }

    const width = Math.max(el.trend.clientWidth || 720, 480);
    const window = s.chart;
    const categories = window.months.map(monthShort);

    // The average of the months that actually ran. Including the empty ones
    // would drag the line down and mark a level no month ever sat at.
    const totals = window.months.map((_, i) =>
      window.byCompany.reduce((a, c) => a + c.series[i], 0),
    );
    const live = totals.filter((v) => v > 0);
    const average = live.length ? live.reduce((a, v) => a + v, 0) / live.length : 0;

    const marks = fyMarks(window.months);
    const annotations = {
      dividers: marks.fyStarts,
      bandLabels: marks.fyLabels,
      reference: average ? { value: average, label: `average ${usd(average)}` } : undefined,
    };

    // One company is one series and reads as a line; two are a split, and a
    // stack says both the total and the mix in the same bar.
    el.trend.innerHTML =
      window.byCompany.length > 1
        ? barChart({
            ...annotations,
            categories,
            width,
            height: 280,
            stacked: true,
            format: usd,
            unit: '$',
            series: window.byCompany.map((c, i) => ({
              name: c.name,
              color: `--series-${i + 1}`,
              values: c.series,
            })),
          })
        : lineChart({
            categories,
            width,
            height: 280,
            format: usd,
            unit: '$',
            series: [
              {
                name: window.byCompany[0]?.name ?? 'Released',
                color: '--series-1',
                values: window.byCompany[0]?.series ?? window.months.map(() => 0),
              },
            ],
          });
    bindChartTooltips(el.trend);

    // Filtered to one month the chart is deliberately wider than the sheet, so
    // it has to say so rather than look like a mismatch.
    const focus = window.months[window.focus];
    el.trendNote.textContent = focus
      ? `released value by order date · the year up to ${monthLong(
          focus,
        )}, which is the month below`
      : `released value by order date · ${categories.length} months · ${monthShort(
          window.months[0],
        )} — ${monthShort(window.months.at(-1)!)}`;
  }

  /* ----------------------------------------------------------------- chips */

  function renderChips(s: Shaped) {
    el.chips.innerHTML =
      (['value', 'qty'] as Measure[])
        .map(
          (m) =>
            `<button class="chip toggle" type="button" data-measure="${m}" aria-pressed="${
              state.measure === m
            }">${m === 'value' ? 'Value $' : 'Quantity'}</button>`,
        )
        .join('') +
      `<span class="chip-count">${qty(s.rows.length)} products</span>` +
      `<input class="chips-search" id="oa-search" type="search" placeholder="Search products…" value="${esc(
        state.query,
      )}" />` +
      `<button class="chip" type="button" id="oa-export">Export</button>`;
  }

  /* ------------------------------------------------------------ drill-down */

  /** "COIL 5 ZIPPER ... (TEETH, Slider C#5 ...)" -> "TEETH, Slider C#5 ...". */
  function stripFamily(variant: string, family: string): string {
    const rest = variant.startsWith(family) ? variant.slice(family.length) : variant;
    return rest.replace(/^\s*\(/, '').replace(/\)\s*$/, '').trim() || variant;
  }

  /**
   * What actually tells a product's variants apart.
   *
   * A variant name is the product plus a comma-separated spec, and within one
   * product most of that spec is the same on every line — the same slider, the
   * same tape, the same finish. Printed in full, eight variants are eight
   * identical paragraphs and the one token that differs is lost in them.
   *
   * So the tokens every listed variant shares are lifted out and said once,
   * and each row keeps only what makes it itself.
   */
  function splitSpecs(variants: Breakdown[], family: string) {
    const specs = variants.map((v) =>
      stripFamily(v.name, family)
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    );
    if (!specs.length) return { shared: [] as string[], rows: [] as string[] };

    const shared = specs[0].filter((token) => specs.every((spec) => spec.includes(token)));
    const rows = specs.map((spec) => {
      const own = spec.filter((token) => !shared.includes(token));
      // A variant whose spec is entirely shared is only distinguishable by
      // something the name does not carry; say so rather than print nothing.
      return own.length ? own.join(', ') : '(same spec)';
    });
    return { shared, rows };
  }

  function variantPanel(variants: Breakdown[], row: ProductRow): string {
    if (!variants.length) return '';
    const shown = variants.slice(0, 10);
    const { shared, rows } = splitSpecs(shown, row.name);
    const widest = Math.max(...shown.map((v) => v.value), 0);

    const body = shown
      .map((v, i) => {
        const part = row.value ? v.value / row.value : 0;
        return `<li>
          <span class="oa-bd-name">${esc(rows[i])}</span>
          <span class="oa-bd-track"><i style="width:${(widest
            ? (v.value / widest) * 100
            : 0
          ).toFixed(1)}%"></i></span>
          <span class="oa-bd-value">${usdShort(v.value)}</span>
          <span class="oa-bd-share">${pct(part)}</span>
        </li>`;
      })
      .join('');

    return `<section class="oa-panel wide">
      <header>
        <h3>By variant</h3>
        <span>${esc(
          variants.length > shown.length
            ? `top ${shown.length} of ${qty(variants.length)}`
            : `all ${qty(variants.length)}`,
        )}</span>
      </header>
      ${
        shared.length
          ? `<p class="oa-shared">All ${shown.length} share <em>${esc(
              shared.join(', '),
            )}</em> — only what differs is listed.</p>`
          : ''
      }
      <ol class="oa-breakdown">${body}</ol>
    </section>`;
  }

  /** One figure, said plainly, in the strip above the chart. */
  const statTile = (label: string, figure: string, note = '') =>
    `<div class="oa-stat">
      <span class="oa-stat-label">${esc(label)}</span>
      <b class="oa-stat-figure">${figure}</b>
      ${note ? `<span class="oa-stat-note">${note}</span>` : ''}
    </div>`;

  /**
   * A ranked breakdown: name, figure, and a bar that reads against the biggest
   * row rather than against the product total, so a long tail stays visible.
   */
  function breakdownPanel(
    title: string,
    note: string,
    rows: Breakdown[],
    total: number,
    options: { rename?: (name: string) => string; limit?: number; wide?: boolean } = {},
  ) {
    if (!rows.length) {
      return `<section class="oa-panel${options.wide ? ' wide' : ''}">
        <header><h3>${esc(title)}</h3></header>
        <p class="oa-panel-empty">Nothing to show.</p>
      </section>`;
    }

    const shown = rows.slice(0, options.limit ?? 8);
    const widest = Math.max(...shown.map((r) => r.value), 0);

    const body = shown
      .map((r) => {
        const part = total ? r.value / total : 0;
        return `<li>
          <span class="oa-bd-name">${esc(options.rename ? options.rename(r.name) : r.name)}</span>
          <span class="oa-bd-track"><i style="width:${(widest ? (r.value / widest) * 100 : 0).toFixed(
            1,
          )}%"></i></span>
          <span class="oa-bd-value">${usdShort(r.value)}</span>
          <span class="oa-bd-share">${pct(part)}</span>
        </li>`;
      })
      .join('');

    return `<section class="oa-panel${options.wide ? ' wide' : ''}">
      <header>
        <h3>${esc(title)}</h3>
        <span>${esc(
          rows.length > shown.length ? `top ${shown.length} of ${qty(rows.length)}` : note,
        )}</span>
      </header>
      <ol class="oa-breakdown">${body}</ol>
    </section>`;
  }

  function recentPanel(detail: ProductDetail) {
    if (!detail.recent.length) return '';
    const body = detail.recent
      .slice(0, 8)
      .map(
        (o) => `<li>
          <span class="oa-oa-ref">${esc(o.order)}</span>
          <span class="oa-oa-when">${esc(o.date)}</span>
          <span class="oa-bd-name">${esc(o.customer)}</span>
          <span class="oa-bd-value">${usdShort(o.value)}</span>
        </li>`,
      )
      .join('');

    return `<section class="oa-panel">
      <header><h3>Latest OAs</h3><span>most recent first</span></header>
      <ol class="oa-breakdown recent">${body}</ol>
    </section>`;
  }

  /**
   * One product's own history, opened underneath its row.
   *
   * The chart is the point of the row — every month this product has been
   * released in, split the way the page above is split — so it sits at the top
   * under a strip of the figures that describe it, and the breakdowns follow.
   * It nests in the row rather than opening a dialog so the products around it
   * stay on screen to compare against, and so two can be opened at once.
   */
  function detailRow(row: ProductRow, s: Shaped, span: number): string {
    const detail = state.detail.get(detailKey(row.name, s));
    const chartId = `oa-history-${row.name.replace(/[^A-Za-z0-9]+/g, '-')}`;
    const measured = state.measure === 'value' ? row.value : row.qty;
    const perMonth = row.months ? measured / row.months : 0;
    const loaded = detail && detail !== 'loading' ? detail : null;

    const head = `<div class="oa-detail-head">
      <div class="oa-detail-title">
        <p class="eyebrow">${esc(row.companies.join(' + '))} · ${esc(periodLabel(s))}</p>
        <h2>${esc(row.name)}</h2>
      </div>
      <div class="oa-stats">
        ${statTile('Released', fmt(measured), `${pct(row.share)} of the period`)}
        ${statTile(
          'Run rate',
          fmt(perMonth),
          `a month over ${qty(row.months)} live month${row.months === 1 ? '' : 's'}`,
        )}
        ${statTile('Peak', fmt(row.peak.value), esc(monthLong(row.peak.month)))}
        ${statTile(
          'Span',
          `${esc(monthShort(row.firstMonth))} — ${esc(monthShort(row.lastMonth))}`,
          `${qty(row.lines)} order lines`,
        )}
        ${statTile(
          'Customers',
          loaded ? qty(loaded.byCustomer.length) : '—',
          loaded?.byCustomer.length ? `top one takes ${pct(
            row.value ? loaded.byCustomer[0].value / row.value : 0,
          )}` : 'reading…',
        )}
      </div>
    </div>`;

    const breakdowns = !loaded
      ? `<div class="oa-detail-loading"><span class="spinner"></span> Reading ${esc(
          row.name,
        )} from Odoo…</div>`
      : loaded.error
        ? `<p class="oa-panel-empty">${esc(loaded.error)}</p>`
        : `<div class="oa-panels">
            ${breakdownPanel('By internal code', 'the codes it ships under', loaded.byCode, row.value)}
            ${breakdownPanel('By customer', 'who it is made for', loaded.byCustomer, row.value)}
            ${recentPanel(loaded)}
          </div>
          ${variantPanel(loaded.byVariant, row)}`;

    return `<tr class="day-detail"><td colspan="${span}">
      <div class="oa-detail">
        ${head}
        <div class="chart-host oa-history" id="${chartId}" data-product="${esc(row.name)}"></div>
        ${breakdowns}
      </div>
    </td></tr>`;
  }

  /**
   * Draws the open product's history chart once its row is in the document.
   *
   * One month makes one bar, which says nothing — so a single-month sheet gets
   * the year running up to it here too, matching the trend chart above and the
   * run-up in the row.
   */
  function drawOpenHistory(s: Shaped) {
    if (!state.open) return;
    const row = s.rows.find((r) => r.name === state.open);
    if (!row) return;
    const host = document.querySelector<HTMLElement>('.oa-history');
    if (!host) return;

    const oneMonth = s.months.length === 1;
    const width = Math.max(host.clientWidth || 640, 420);

    if (oneMonth) {
      const months = s.chart.months;
      const values = s.chart.byProduct.get(row.name) ?? months.map(() => 0);
      host.innerHTML = barChart({
        categories: months.map(monthShort),
        width,
        height: 220,
        format: fmt,
        unit: state.measure === 'value' ? '$' : '',
        series: [{ name: measureLabel(), color: '--series-1', values }],
      });
      bindChartTooltips(host);
      return;
    }

    const categories = s.months.map(monthShort);
    const series = s.byCompany
      .map((c, i) => ({
        name: c.name,
        color: `--series-${i + 1}`,
        values: row.byCompany.get(c.id) ?? s.months.map(() => 0),
      }))
      .filter((sr) => sr.values.some((v) => v > 0));

    host.innerHTML = barChart({
      categories,
      width,
      height: 220,
      stacked: true,
      format: fmt,
      unit: state.measure === 'value' ? '$' : '',
      series: series.length
        ? series
        : [{ name: measureLabel(), color: '--series-1', values: row.series }],
    });
    bindChartTooltips(host);
  }

  /**
   * A detail belongs to one product AND one slice: change the company or the
   * period and the same product needs reading again, or its shares would be
   * of a total that is no longer on screen.
   */
  function detailKey(product: string, s: Shaped): string {
    return `${product}|${state.company}|${s.months[0] ?? ''}..${s.months.at(-1) ?? ''}`;
  }

  async function loadDetail(product: string, s: Shaped) {
    const key = detailKey(product, s);
    if (state.detail.has(key)) return;
    state.detail.set(key, 'loading');

    const range = s.months.length
      ? `&from=${s.months[0]}&to=${s.months[s.months.length - 1]}`
      : '';

    try {
      const res = await fetch(
        `/api/oa-released?product=${encodeURIComponent(product)}&company=${state.company}${range}`,
      );
      const data = await res.json();
      state.detail.set(
        key,
        res.ok ? (data as ProductDetail) : ({ ...data, error: data?.error } as ProductDetail),
      );
    } catch (err) {
      state.detail.set(key, {
        product,
        byVariant: [],
        byCode: [],
        byCustomer: [],
        recent: [],
        error: (err as Error).message,
      });
    }
    if (state.open === product && state.history) renderGrid(state.history, shape(state.history));
  }

  /* ------------------------------------------------------------------ grid */

  function renderGrid(h: OaHistory, s: Shaped) {
    const query = state.query.trim().toLowerCase();
    const rows = query ? s.rows.filter((r) => r.name.toLowerCase().includes(query)) : s.rows;
    /*
     * Narrowed to one month, "Months" can only ever say 1 and the row's own
     * series is a single point. So the column goes, and the trend is drawn
     * from the year running up to that month instead — which is the thing
     * worth knowing when you are looking at one month in isolation.
     */
    const oneMonth = s.months.length === 1;
    const COLUMNS = oneMonth ? 9 : 10;
    const grand = state.measure === 'value' ? s.total.value : s.total.qty;

    if (!rows.length) {
      el.grid.innerHTML = `<div class="state"><h2>${
        query ? `No product matches “${esc(state.query)}”` : 'Nothing released here'
      }</h2><p>${
        query
          ? 'Clear the search to see every product.'
          : 'No OA has been released for this company and period.'
      }</p></div>`;
      return;
    }

    // The bar reads against the biggest product on screen, so the tail is still
    // visible rather than every row past the first collapsing to a hairline.
    const widest = Math.max(
      ...rows.map((r) => (state.measure === 'value' ? r.value : r.qty)),
      0,
    );

    const body = rows
      .map((row, i) => {
        const measured = state.measure === 'value' ? row.value : row.qty;
        const open = state.open === row.name;
        // A rule where the band changes turns the ranked list into three
        // readable groups without a heading row for each.
        const bandEnd = rows[i + 1] && rows[i + 1].cls !== row.cls;
        return (
          `<tr class="day-row can-open${open ? ' open' : ''}${
            bandEnd ? ' band-end' : ''
          }" data-product="${esc(
            row.name,
          )}" tabindex="0" role="button" aria-expanded="${open}">
            <td class="sticky-col"><span class="disclose" aria-hidden="true">${
              open ? '▾' : '▸'
            }</span><span class="oa-rank">${String(i + 1).padStart(2, '0')}</span><span class="oa-name cls-${
              row.cls
            }">${esc(row.name)}</span></td>
            <td class="co">${esc(row.companies.join(' + '))}</td>
            <td class="num tinted">${fmt(measured)}</td>
            <td class="num">${pct(row.share)}</td>
            <td class="bar-cell"><span class="mini-bar"><i class="cls-${row.cls}" style="width:${(
              widest ? (measured / widest) * 100 : 0
            ).toFixed(1)}%"></i></span></td>
            <td class="num muted">${pct(row.cumShare, 0)}</td>
            <td class="cls-cell"><span class="abc-badge abc-${row.cls}">${row.cls}</span></td>
            <td class="spark-cell">${sparkline(
              oneMonth ? (s.chart.byProduct.get(row.name) ?? row.series) : row.series,
              { color: row.cls === 'C' ? '--ink-muted' : '--series-1' },
            )}</td>
            ${oneMonth ? '' : `<td class="num">${qty(row.months)}</td>`}
            <td class="num">${qty(row.lines)}</td>
          </tr>` + (open ? detailRow(row, s, COLUMNS) : '')
        );
      })
      .join('');

    const totalRow = `<tr class="grand-row">
      <td class="sticky-col" colspan="2">All ${qty(s.rows.length)} products
        <span class="rail-sub">· ${esc(periodLabel(s))}</span></td>
      <td class="num">${fmt(grand)}</td>
      <td class="num">100.0%</td>
      <td class="bar-cell"></td>
      <td class="num"></td>
      <td class="cls-cell muted">${s.bands
        .filter((b) => b.count)
        .map((b) => `${qty(b.count)}${b.cls}`)
        .join(' · ')}</td>
      <td class="spark-cell"></td>
      ${oneMonth ? '' : `<td class="num">${qty(s.months.length)}</td>`}
      <td class="num">${qty(s.total.lines)}</td>
    </tr>`;

    el.grid.innerHTML = `<table class="grid day-grid oa-sheet">
      <thead>
        <tr class="sub-row">
          <th class="sticky-col">Product</th>
          <th class="text">Company</th>
          <th class="num">${measureLabel()}</th>
          <th class="num">Share</th>
          <th class="bar-cell"></th>
          <th class="num">Cum.</th>
          <th class="cls-cell">Class</th>
          <th class="spark-cell">${oneMonth ? 'Run-up' : 'Trend'}</th>
          ${oneMonth ? '' : '<th class="num">Mths</th>'}
          <th class="num">Lines</th>
        </tr>
      </thead>
      <tbody>${body}${query ? '' : totalRow}</tbody>
    </table>`;

    drawOpenHistory(s);

    el.note.textContent = h.failed.length
      ? `${h.failed.length} month${
          h.failed.length === 1 ? '' : 's'
        } could not be read — those figures are missing, not zero. Reload to retry.`
      : h.pending.length
        ? `${h.pending.length} months still to read — the sheet grows as they arrive.`
        : `Every month Odoo holds a released OA for — ${monthShort(
            h.firstMonth,
          )} onward, ${qty(h.months.length)} months, grouped by the variant name\u2019s product ` +
          `family. Class A is the first 80% of the period, B the next 15%, C the tail. A month ` +
          `that has closed is read once and cached; only the month in progress refreshes.`;
  }

  /* ---------------------------------------------------------------- render */

  function renderControls(h: OaHistory) {
    el.companySeg.innerHTML =
      `<button class="seg" type="button" role="tab" data-company="all" aria-selected="${
        state.company === 'all'
      }">All companies</button>` +
      h.companies
        .map(
          (c) =>
            `<button class="seg" type="button" role="tab" data-company="${c.id}" aria-selected="${
              state.company === String(c.id)
            }">${esc(c.name)}</button>`,
        )
        .join('');

    const fys = [...new Set(h.months.map((m) => fyOf(m.month)))].sort((a, b) => b - a);
    el.periodSeg.innerHTML = [
      { key: 'all', label: 'All time' },
      { key: 'r12', label: 'Last 12 months' },
      ...fys.map((fy) => ({ key: String(fy), label: fyLabel(fy) })),
    ]
      .map(
        (p) =>
          `<button class="seg" type="button" role="tab" data-period="${p.key}" aria-selected="${
            state.period === p.key
          }">${esc(p.label)}</button>`,
      )
      .join('');

    /*
     * The month narrows the period rather than replacing it, so it offers the
     * months that period covers and nothing else — pick FY 26-27 and the list
     * is that year's five months. Forty-one months could never be segmented
     * buttons, so it is a select, sitting where the period leaves off.
     */
    const month = pickedMonth(h);
    const months = [...periodMonths(h)].reverse();
    el.monthPick.innerHTML =
      `<option value="">Every month</option>` +
      months
        .map(
          (m) =>
            `<option value="${m}"${m === month ? ' selected' : ''}>${esc(monthLong(m))}</option>`,
        )
        .join('');
    el.monthPick.classList.toggle('picked', !!month);
    el.monthPick.disabled = months.length < 2;
  }

  function render() {
    const h = state.history;
    if (!h) return;
    const s = shape(h);

    renderControls(h);
    renderRail(h, s);
    renderTrend(s);
    renderChips(s);
    renderGrid(h, s);

    // The open row survives a filter change, but its detail describes the old
    // slice — so the new one is fetched here rather than at every call site.
    if (state.open) void loadDetail(state.open, s);

    el.status.hidden = true;
    el.body.hidden = false;
  }

  /* ---------------------------------------------------------------- events */

  function toggleProduct(product: string) {
    state.open = state.open === product ? null : product;
    if (!state.history) return;
    const s = shape(state.history);
    if (state.open) void loadDetail(state.open, s);
    renderGrid(state.history, s);
  }

  el.grid.addEventListener('click', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('tr.day-row[data-product]');
    if (row?.dataset.product) toggleProduct(row.dataset.product);
  });

  el.grid.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = (event.target as HTMLElement).closest<HTMLElement>('tr.day-row[data-product]');
    if (!row?.dataset.product) return;
    event.preventDefault();
    toggleProduct(row.dataset.product);
  });

  el.chips.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.id === 'oa-export') {
      exportCsv();
      return;
    }
    const measure = target.closest<HTMLElement>('[data-measure]');
    if (measure) {
      state.measure = measure.dataset.measure as Measure;
      render();
    }
  });

  let searchTimer: number | undefined;
  el.chips.addEventListener('input', (event) => {
    const input = event.target as HTMLInputElement;
    if (input.id !== 'oa-search') return;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      state.query = input.value;
      // Grid only, so the caret stays put while the list narrows.
      if (state.history) renderGrid(state.history, shape(state.history));
    }, 140);
  });

  el.companySeg.addEventListener('click', (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLElement>('[data-company]');
    if (!btn) return;
    state.company = btn.dataset.company!;
    render();
  });

  el.periodSeg.addEventListener('click', (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLElement>('[data-period]');
    if (!btn) return;
    state.period = btn.dataset.period!;
    // A month from the old period would be silently dropped by pickedMonth();
    // clearing it here means the picker also stops showing it as selected.
    if (state.month && !periodMonths(state.history!).includes(state.month)) state.month = '';
    render();
  });

  el.monthPick.addEventListener('change', () => {
    state.month = el.monthPick.value;
    render();
  });

  function exportCsv() {
    const h = state.history;
    if (!h) return;
    const s = shape(h);
    const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

    const lines = [
      ['Product', 'Company', 'Value USD', 'Quantity', 'Lines', 'Share %', 'Months', 'First', 'Last']
        .concat(s.months.map(monthShort))
        .join(','),
      ...s.rows.map((row) =>
        [
          cell(row.name),
          cell(row.companies.join(' + ')),
          Math.round(row.value),
          Math.round(row.qty),
          row.lines,
          (row.share * 100).toFixed(2),
          row.months,
          row.firstMonth,
          row.lastMonth,
        ]
          .concat(row.series.map((v) => String(Math.round(v))))
          .join(','),
      ),
    ];

    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `OA released by product ${periodLabel(s)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // Charts are measured at render time, so a rotation or resize re-measures.
  let resizeTimer: number | undefined;
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (!state.history) return;
      const s = shape(state.history);
      renderRail(state.history, s);
      renderTrend(s);
      drawOpenHistory(s);
    }, 180);
  });

  if (root.dataset.odoo !== '1') {
    el.status.innerHTML =
      '<h2>Not connected</h2><p>Set the Odoo credentials in .env to read the order book.</p>';
  } else {
    void load();
  }
}
