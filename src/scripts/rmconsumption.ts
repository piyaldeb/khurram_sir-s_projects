/**
 * RM consumption history, in the site's rail-plus-full-sheet shape.
 *
 * The ledger it reads is a chain — opening + received − consumed = closing —
 * so the page says so in the open, above the chart, rather than presenting
 * consumption as a figure with no context. What was bought and what is left
 * are the two things that make a consumption number mean anything. Where a
 * snapshot restates itself, that shows as its own step; see renderLedger().
 *
 * Everything aggregated is money. The ledger mixes twenty-one units of
 * measure, so a quantity total across categories would be kilos added to
 * gross; quantity appears only inside a drill-down whose products share a unit.
 */
import { barChart, bindChartTooltips, lineChart, sparkline } from '../lib/charts';
import { skeleton } from '../lib/skeleton';

interface LedgerMonth {
  month: string;
  companyId: number;
  opening: number;
  receive: number;
  issue: number;
  closing: number;
  rows: number;
}

interface DimensionRow {
  label: string;
  issue: Record<number, number[]>;
  closing: Record<number, number[]>;
}

interface RmHistory {
  dimension: string;
  months: string[];
  companies: { id: number; name: string }[];
  ledger: LedgerMonth[];
  rows: DimensionRow[];
  fetchedAt: string;
}

interface Breakdown {
  name: string;
  issue: number;
  closing: number;
  qty: number;
  unit: string | null;
  rows: number;
}

interface MemberDetail {
  member: string;
  byProduct: Breakdown[];
  byVendor: Breakdown[];
  byLine: Breakdown[];
  unit: string | null;
  error?: string;
}

/** One category as the sheet sees it, already narrowed to the chosen company. */
interface Row {
  name: string;
  issue: number;
  share: number;
  cumShare: number;
  cls: 'A' | 'B' | 'C';
  /** Consumption per month, aligned to the visible months. */
  series: number[];
  byCompany: Map<number, number[]>;
  companies: string[];
  months: number;
  /** Stock left at the end of the window. */
  closing: number;
  /** Months of cover: closing ÷ average monthly consumption. */
  cover: number | null;
  everFirst: string;
  everLast: string;
}

const DIMENSIONS = [
  { key: 'category', label: 'Product category', noun: 'category' },
  { key: 'item', label: 'Item type', noun: 'item type' },
  { key: 'line', label: 'Product line', noun: 'product line' },
  { key: 'vendor', label: 'Vendor', noun: 'vendor' },
];

const root = document.querySelector<HTMLElement>('.rm');

if (root) {
  const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
  const el = {
    status: $<HTMLElement>('#rm-status'),
    body: $<HTMLElement>('#rm-body'),
    rail: $<HTMLElement>('#rm-rail'),
    ledger: $<HTMLElement>('#rm-ledger'),
    chips: $<HTMLElement>('#rm-chips'),
    grid: $<HTMLElement>('#rm-grid'),
    note: $<HTMLElement>('#rm-note'),
    trend: $<HTMLElement>('#rm-trend'),
    trendNote: $<HTMLElement>('#rm-trend-note'),
    companySeg: $<HTMLElement>('#rm-company'),
    periodSeg: $<HTMLElement>('#rm-period'),
    monthPick: $<HTMLSelectElement>('#rm-month'),
  };

  const state = {
    dimension: 'category',
    company: 'all' as string,
    period: 'all' as string,
    month: '',
    query: '',
    open: null as string | null,
    history: null as RmHistory | null,
    detail: new Map<string, MemberDetail | 'loading'>(),
  };

  const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const usd = (v: number) => `$${nf.format(Math.round(v))}`;
  const qty = (v: number) => nf.format(Math.round(v));
  const pct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;
  const esc = (s: string | number) =>
    String(s).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
    );

  const usdShort = (v: number) => {
    const a = Math.abs(v);
    if (a >= 1e6) return `$${(v / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
    if (a >= 1e3) return `$${Math.round(v / 1e3)}k`;
    return `$${Math.round(v)}`;
  };

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

  const fyOf = (month: string) => {
    const [y, m] = month.split('-').map(Number);
    return m >= 4 ? y : y - 1;
  };
  const fyLabel = (fy: number) => `FY ${String(fy).slice(2)}-${String(fy + 1).slice(2)}`;
  const dimension = () => DIMENSIONS.find((d) => d.key === state.dimension)!;

  const shiftMonths = (month: string, by: number) => {
    const [y, m] = month.split('-').map(Number);
    const total = y * 12 + (m - 1) + by;
    return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
  };

  let inFlight: AbortController | null = null;

  /* ------------------------------------------------------------------ load */

  function showSkeleton() {
    el.status.hidden = true;
    el.body.hidden = false;
    el.rail.innerHTML = skeleton.rail();
    el.ledger.innerHTML = skeleton.chips(4);
    el.trend.innerHTML = skeleton.chart();
    el.chips.innerHTML = skeleton.chips(5);
    el.grid.innerHTML = skeleton.table(10, 10);
    el.note.textContent = '';
  }

  async function load(fresh = true) {
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;

    if (fresh) showSkeleton();

    try {
      const res = await fetch(`/api/rm-consumption?dim=${state.dimension}`, {
        signal: controller.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      state.history = data as RmHistory;
      render();
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      el.body.hidden = true;
      el.status.hidden = false;
      el.status.classList.add('error');
      el.status.innerHTML = `<h2>Could not read the ledger</h2><p style="font-family:var(--mono);font-size:12.5px">${esc(
        (err as Error).message,
      )}</p>`;
    }
  }

  /* --------------------------------------------------------------- shaping */

  const companyId = () => (state.company === 'all' ? null : Number(state.company));

  function periodMonths(h: RmHistory): string[] {
    const all = [...h.months].sort();
    if (state.period === 'all') return all;
    if (state.period === 'r12') return all.slice(-12);
    const fy = Number(state.period);
    return all.filter((m) => fyOf(m) === fy);
  }

  function pickedMonth(h: RmHistory): string | null {
    if (!state.month) return null;
    return periodMonths(h).includes(state.month) ? state.month : null;
  }

  function visibleMonths(h: RmHistory): string[] {
    const months = periodMonths(h);
    const month = pickedMonth(h);
    return month ? months.filter((m) => m === month) : months;
  }

  /** A single month makes a one-bar chart, so the chart keeps a year of run-up. */
  function chartMonths(h: RmHistory, visible: string[]): string[] {
    const month = pickedMonth(h);
    if (!month) return visible;
    const all = [...h.months].sort();
    const at = all.indexOf(month);
    return at < 0 ? visible : all.slice(Math.max(at - 12, 0), at + 1);
  }

  interface Band {
    cls: 'A' | 'B' | 'C';
    count: number;
    share: number;
  }

  interface Momentum {
    window: string;
    soFar: number;
    pace: number;
    average: number;
    lastYear: number;
    lastYearMonth: string;
    delta: number;
  }

  interface Shaped {
    months: string[];
    rows: Row[];
    /** The ledger for the window, added across the chosen companies. */
    ledger: {
      opening: number;
      receive: number;
      issue: number;
      closing: number;
      rows: number;
      /**
       * What closing carries that no movement explains — see renderLedger().
       * Positive means stock appeared between snapshots.
       */
      restated: number;
      /** How many month-company snapshots carry part of it. */
      restatedMonths: number;
    };
    byCompany: { id: number; name: string; issue: number; closing: number; series: number[] }[];
    perMonth: number[];
    bands: Band[];
    momentum: Momentum | null;
    /** Months of cover across everything on screen. */
    cover: number | null;
    chart: { months: string[]; byCompany: { name: string; series: number[] }[]; focus: number };
  }

  function slicesOf(h: RmHistory): number[] {
    const id = companyId();
    return h.companies.filter((c) => id === null || c.id === id).map((c) => c.id);
  }

  function shape(h: RmHistory): Shaped {
    const months = visibleMonths(h);
    const all = [...h.months].sort();
    const offset = all.indexOf(months[0] ?? '');
    const ids = slicesOf(h);
    const last = months.length - 1;

    /*
     * Opening is the FIRST month's opening and closing the LAST month's
     * closing — they are levels, not flows, so adding them across months
     * would count the same stock once per month.
     */
    const ledger = {
      opening: 0,
      receive: 0,
      issue: 0,
      closing: 0,
      rows: 0,
      restated: 0,
      restatedMonths: 0,
    };
    const byCompany = h.companies
      .filter((c) => ids.includes(c.id))
      .map((c) => ({ id: c.id, name: c.name, issue: 0, closing: 0, series: months.map(() => 0) }));

    const ledgerAt = new Map(h.ledger.map((l) => [`${l.month}|${l.companyId}`, l]));
    months.forEach((month, i) => {
      for (const company of byCompany) {
        const entry = ledgerAt.get(`${month}|${company.id}`);
        if (!entry) continue;
        ledger.receive += entry.receive;
        ledger.issue += entry.issue;
        ledger.rows += entry.rows;
        if (i === 0) ledger.opening += entry.opening;
        if (i === last) {
          ledger.closing += entry.closing;
          company.closing = entry.closing;
        }
        company.issue += entry.issue;
        company.series[i] += entry.issue;

        // Each snapshot's own arithmetic. Where it does not close, the
        // difference is a restatement, and it is counted rather than hidden.
        const own = entry.opening + entry.receive - entry.issue - entry.closing;
        if (Math.abs(own) >= 1) ledger.restatedMonths += 1;

        // Between snapshots, a month's opening need not equal the previous
        // month's closing either; that gap belongs to the same figure.
        if (i > 0) {
          const before = ledgerAt.get(`${months[i - 1]}|${company.id}`);
          if (before) ledger.restated += entry.opening - before.closing;
        }
        ledger.restated -= own;
      }
    });

    const perMonth = months.map((_, i) => byCompany.reduce((a, c) => a + c.series[i], 0));

    const rows: Row[] = [];
    for (const raw of h.rows) {
      const series = months.map(() => 0);
      const byCo = new Map<number, number[]>();
      const companies: string[] = [];
      let closing = 0;
      let everFirst = '';
      let everLast = '';

      for (const company of byCompany) {
        const issued = raw.issue[company.id];
        const held = raw.closing[company.id];
        if (!issued) continue;

        const own = months.map((_, i) => issued[offset + i] ?? 0);
        if (own.some((v) => v !== 0)) companies.push(company.name);
        own.forEach((v, i) => (series[i] += v));
        byCo.set(company.id, own);
        if (held) closing += held[offset + last] ?? 0;

        // First and last across ALL of history, not the window — what makes a
        // category dormant is its whole life, not the slice on screen.
        issued.forEach((v, i) => {
          if (!v) return;
          const month = all[i];
          if (!everFirst || month < everFirst) everFirst = month;
          if (month > everLast) everLast = month;
        });
      }

      const issue = series.reduce((a, v) => a + v, 0);
      if (!issue) continue;
      const live = series.filter((v) => v > 0).length;

      rows.push({
        name: raw.label,
        issue,
        share: 0,
        cumShare: 0,
        cls: 'C',
        series,
        byCompany: byCo,
        companies,
        months: live,
        closing,
        // Cover only means something against a rate, so it needs a month that
        // actually consumed something to average over.
        cover: live ? closing / (issue / live) : null,
        everFirst,
        everLast,
      });
    }

    rows.sort((a, b) => b.issue - a.issue);
    const grand = rows.reduce((a, r) => a + r.issue, 0);
    let running = 0;
    for (const row of rows) {
      row.share = grand ? row.issue / grand : 0;
      running += row.share;
      row.cumShare = running;
      row.cls = running <= 0.8001 ? 'A' : running <= 0.9501 ? 'B' : 'C';
    }
    const bands: Band[] = (['A', 'B', 'C'] as const).map((cls) => {
      const members = rows.filter((r) => r.cls === cls);
      return { cls, count: members.length, share: members.reduce((a, r) => a + r.share, 0) };
    });

    const liveMonths = perMonth.filter((v) => v > 0);
    const rate = liveMonths.length
      ? liveMonths.reduce((a, v) => a + v, 0) / liveMonths.length
      : 0;

    return {
      months,
      rows,
      ledger,
      byCompany,
      perMonth,
      bands,
      momentum: momentumOf(h, ids),
      cover: rate ? ledger.closing / rate : null,
      chart: chartWindow(h, months, ids),
    };
  }

  function chartWindow(h: RmHistory, visible: string[], ids: number[]) {
    const months = chartMonths(h, visible);
    const ledgerAt = new Map(h.ledger.map((l) => [`${l.month}|${l.companyId}`, l]));
    const byCompany = h.companies
      .filter((c) => ids.includes(c.id))
      .map((c) => ({
        name: c.name,
        series: months.map((m) => ledgerAt.get(`${m}|${c.id}`)?.issue ?? 0),
      }));
    const month = pickedMonth(h);
    return { months, byCompany, focus: month ? months.indexOf(month) : -1 };
  }

  /**
   * The month in progress, against the twelve behind it.
   *
   * Consumption is the one figure here that can be acted on this week, so it
   * leads. A part-month total reads as a collapse every time you look at it on
   * the 3rd, so the pace projects the days elapsed across the whole month and
   * the trailing average is what it gets judged against.
   */
  function momentumOf(h: RmHistory, ids: number[]): Momentum | null {
    const all = [...h.months].sort();
    const live = all.at(-1);
    if (!live) return null;

    const ledgerAt = new Map(h.ledger.map((l) => [`${l.month}|${l.companyId}`, l]));
    const valueOf = (month: string) =>
      ids.reduce((a, id) => a + (ledgerAt.get(`${month}|${id}`)?.issue ?? 0), 0);

    const soFar = valueOf(live);
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const isCurrent = live === thisMonth;
    const [y, m] = live.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const elapsed = isCurrent ? Math.min(now.getDate(), daysInMonth) : daysInMonth;

    const trailing = all
      .slice(-13, -1)
      .map(valueOf)
      .filter((v) => v > 0);
    const average = trailing.length ? trailing.reduce((a, v) => a + v, 0) / trailing.length : 0;
    const lastYearMonth = shiftMonths(live, -12);

    return {
      window: isCurrent ? `1–${elapsed} ${monthShort(live)}` : `all of ${monthShort(live)}`,
      soFar,
      pace: elapsed ? (soFar / elapsed) * daysInMonth : soFar,
      average,
      lastYear: valueOf(lastYearMonth),
      lastYearMonth,
      delta: average ? (elapsed ? (soFar / elapsed) * daysInMonth : soFar) / average - 1 : 0,
    };
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
    if (s.months.length === 1 && state.month === s.months[0]) {
      const within =
        state.period === 'all'
          ? ''
          : ` of ${state.period === 'r12' ? 'the last 12 months' : fyLabel(Number(state.period))}`;
      return monthLong(s.months[0]) + within;
    }
    if (state.period === 'all') return `${monthShort(s.months[0])} — ${monthShort(s.months.at(-1)!)}`;
    if (state.period === 'r12') return 'last 12 months';
    return fyLabel(Number(state.period));
  }

  /** Cover reads in months, and rounds differently once it is long. */
  const coverLabel = (v: number | null) =>
    v === null ? '—' : v >= 10 ? `${Math.round(v)} mth` : `${v.toFixed(1)} mth`;

  function momentumBlock(m: Momentum): string {
    // Consuming faster than usual is not good or bad on its own — it tracks
    // how much the plant is making — so the badge is coloured as movement,
    // not as a verdict.
    const up = m.delta >= 0;
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
        )}% vs 12-mth</span>
      </p>
      <p class="rail-sub">On this pace <strong>${usd(m.pace)}</strong> consumed by month end. The
      trailing twelve months average ${usd(m.average)}${
        m.lastYear ? `; ${esc(monthShort(m.lastYearMonth))} was ${usd(m.lastYear)}` : ''
      }.</p>
      <div class="oa-pace">
        <span class="oa-pace-fill" style="width:${((m.soFar / ceiling) * 100).toFixed(1)}%"></span>
        <span class="oa-pace-mark" style="left:${((m.average / ceiling) * 100).toFixed(1)}%"></span>
      </div>
      <div class="oa-pace-key"><span>consumed so far</span><span>marker: 12-month average</span></div>
    </section>`;
  }

  function renderRail(s: Shaped) {
    const head = `<div class="rail-head">
      <p class="eyebrow">${esc(periodLabel(s))}</p>
      <h2 class="rail-title">What the plant has burned</h2>
      <p class="rail-sub">Raw material issued to production, valued at the ledger's own cost.
      Every figure here is money — the ledger mixes twenty-one units of measure, so a quantity
      total across categories would mean nothing.</p>
    </div>`;

    const split = s.byCompany
      .map(
        (c, i) => `<div class="rail-split">
          <div class="rail-split-head">
            <span><i class="swatch s${i + 1}"></i>${esc(c.name)}</span>
            <b>${usd(c.issue)} <span class="rail-of">${pct(
              s.ledger.issue ? c.issue / s.ledger.issue : 0,
            )}</span></b>
          </div>
          ${bar(s.ledger.issue ? (c.issue / s.ledger.issue) * 100 : 0, `s${i + 1}`)}
          <p class="rail-note">${usd(c.closing)} left at ${esc(
            monthShort(s.months.at(-1) ?? ''),
          )}</p>
        </div>`,
      )
      .join('');

    const consumed = railBlock(
      `Consumed, ${periodLabel(s)}`,
      `<p class="rail-figure">${usd(s.ledger.issue)}</p>
       <p class="rail-sub">${qty(s.rows.length)} ${esc(
         dimension().noun,
       )}${s.rows.length === 1 ? '' : 'es'.slice(0, dimension().noun.endsWith('y') ? 0 : 1)} moved
       across ${qty(s.months.length)} month${s.months.length === 1 ? '' : 's'}</p>
       ${split}`,
    );

    /*
     * Cover is the question the ledger exists to answer: at the rate the plant
     * has been burning this, how long does what is left last? It is the one
     * figure here that is forward-looking.
     */
    const cover = railBlock(
      'Cover',
      `<p class="rail-figure">${coverLabel(s.cover)} <span class="rail-of">of stock</span></p>
       <p class="rail-sub">${usd(s.ledger.closing)} on hand against
       ${usd(s.months.length ? s.ledger.issue / Math.max(s.perMonth.filter((v) => v > 0).length, 1) : 0)}
       consumed in an average month.</p>`,
      'At the rate over this window, not a forecast.',
    );

    const top = s.rows[0];
    const bandOf = (cls: 'A' | 'B' | 'C') => s.bands.find((b) => b.cls === cls)!;
    const a = bandOf('A');
    const c = bandOf('C');
    const concentration = top
      ? railBlock(
          'Concentration',
          `<p class="rail-figure">${pct(top.share)} <span class="rail-of">on one ${esc(
            dimension().noun,
          )}</span></p>
           <p class="rail-sub"><strong>${esc(top.name)}</strong> alone. Class A is ${qty(
             a.count,
           )} carrying ${pct(a.share)}; the tail is ${qty(c.count)} under ${pct(c.share)}.</p>`,
        )
      : '';

    el.rail.innerHTML =
      head + (s.momentum ? momentumBlock(s.momentum) : '') + consumed + cover + concentration;
  }

  /* ---------------------------------------------------------------- ledger */

  /**
   * opening + received − consumed = closing, in the open.
   *
   * Consumption on its own is a number with no context; what was bought and
   * what is left are what make it mean something, so the chain leads the page.
   *
   * Over one month the identity holds to the cent. Over a run of them it does
   * not, and that is a property of the source rather than a fault: the ledger
   * is a monthly snapshot, so a revaluation or a correction lands in the next
   * month's OPENING instead of appearing as a movement. Concentrated in the
   * 2021 migration and tailing to near nothing since.
   *
   * Calling that "does not reconcile" would be alarming and wrong. It is shown
   * as its own step, so the arithmetic on screen adds up and the amount that
   * never flowed through production is visible rather than buried in closing.
   */
  function renderLedger(s: Shaped) {
    const { opening, receive, issue, closing, restated, restatedMonths } = s.ledger;
    const shown = Math.abs(restated) >= 1;

    const step = (label: string, value: number, sign: string, tone = '') =>
      `<div class="rm-step ${tone}">
        ${sign ? `<span class="rm-sign">${sign}</span>` : ''}
        <span class="rm-step-label">${esc(label)}</span>
        <b class="rm-step-figure">${usd(value)}</b>
      </div>`;

    el.ledger.innerHTML = `<div class="rm-ledger-row">
      ${step(`Opening · ${monthShort(s.months[0] ?? '')}`, opening, '')}
      ${step('Received', receive, '+', 'in')}
      ${step('Consumed', issue, '−', 'out')}
      ${
        shown
          ? step('Restated', Math.abs(restated), restated >= 0 ? '+' : '−', 'restated')
          : ''
      }
      ${step(`Closing · ${monthShort(s.months.at(-1) ?? '')}`, closing, '=', 'end')}
      <div class="rm-check ${shown ? 'note' : ''}">${
        shown
          ? `${qty(restatedMonths)} snapshot${
              restatedMonths === 1 ? '' : 's'
            } restated · ${qty(s.ledger.rows)} ledger rows`
          : `reconciles · ${qty(s.ledger.rows)} ledger rows`
      }</div>
    </div>`;
  }

  /* ----------------------------------------------------------------- trend */

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

  function renderTrend(s: Shaped) {
    if (!s.months.length) {
      el.trend.innerHTML = '<div class="state"><p>No months to show.</p></div>';
      el.trendNote.textContent = '';
      return;
    }

    const width = Math.max(el.trend.clientWidth || 720, 480);
    const w = s.chart;
    const categories = w.months.map(monthShort);
    const totals = w.months.map((_, i) => w.byCompany.reduce((a, c) => a + c.series[i], 0));
    const live = totals.filter((v) => v > 0);
    const average = live.length ? live.reduce((a, v) => a + v, 0) / live.length : 0;

    const marks = fyMarks(w.months);
    const annotations = {
      dividers: marks.fyStarts,
      bandLabels: marks.fyLabels,
      reference: average ? { value: average, label: `average ${usd(average)}` } : undefined,
    };

    el.trend.innerHTML =
      w.byCompany.length > 1
        ? barChart({
            ...annotations,
            categories,
            width,
            height: 280,
            stacked: true,
            format: usd,
            unit: '$',
            series: w.byCompany.map((c, i) => ({
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
                name: w.byCompany[0]?.name ?? 'Consumed',
                color: '--series-1',
                values: w.byCompany[0]?.series ?? w.months.map(() => 0),
              },
            ],
          });
    bindChartTooltips(el.trend);

    const focus = w.months[w.focus];
    el.trendNote.textContent = focus
      ? `consumed at ledger cost · the year up to ${monthLong(focus)}, which is the month below`
      : `consumed at ledger cost · ${categories.length} months · ${monthShort(
          w.months[0],
        )} — ${monthShort(w.months.at(-1)!)}`;
  }

  /* ----------------------------------------------------------------- chips */

  function renderChips(s: Shaped) {
    el.chips.innerHTML =
      DIMENSIONS.map(
        (d) =>
          `<button class="chip toggle" type="button" data-dim="${d.key}" aria-pressed="${
            state.dimension === d.key
          }">${esc(d.label)}</button>`,
      ).join('') +
      `<span class="chip" aria-hidden="true">${qty(s.rows.length)} rows</span>` +
      `<input class="chips-search" id="rm-search" type="search" placeholder="Search ${esc(
        dimension().noun,
      )}…" value="${esc(state.query)}" />` +
      `<button class="chip" type="button" id="rm-export">Export</button>`;
  }

  /* ------------------------------------------------------------ drill-down */

  function detailKey(member: string, s: Shaped): string {
    return `${state.dimension}|${member}|${state.company}|${s.months[0] ?? ''}..${
      s.months.at(-1) ?? ''
    }`;
  }

  async function loadDetail(member: string, s: Shaped) {
    const key = detailKey(member, s);
    if (state.detail.has(key)) return;
    state.detail.set(key, 'loading');

    const range = s.months.length
      ? `&from=${s.months[0]}&to=${s.months[s.months.length - 1]}`
      : '';

    try {
      const res = await fetch(
        `/api/rm-consumption?dim=${state.dimension}&member=${encodeURIComponent(
          member,
        )}&company=${state.company}${range}`,
      );
      const data = await res.json();
      state.detail.set(
        key,
        res.ok ? (data as MemberDetail) : ({ ...data, error: data?.error } as MemberDetail),
      );
    } catch (err) {
      state.detail.set(key, {
        member,
        byProduct: [],
        byVendor: [],
        byLine: [],
        unit: null,
        error: (err as Error).message,
      });
    }
    if (state.open === member && state.history) renderGrid(shape(state.history));
  }

  const statTile = (label: string, figure: string, note = '') =>
    `<div class="oa-stat">
      <span class="oa-stat-label">${esc(label)}</span>
      <b class="oa-stat-figure">${figure}</b>
      ${note ? `<span class="oa-stat-note">${note}</span>` : ''}
    </div>`;

  function breakdownPanel(title: string, note: string, rows: Breakdown[], total: number) {
    if (!rows.length) {
      return `<section class="oa-panel">
        <header><h3>${esc(title)}</h3></header>
        <p class="oa-panel-empty">Nothing to show.</p>
      </section>`;
    }
    const shown = rows.slice(0, 8);
    const widest = Math.max(...shown.map((r) => r.issue), 0);

    const body = shown
      .map(
        (r) => `<li>
          <span class="oa-bd-name">${esc(r.name)}</span>
          <span class="oa-bd-track"><i style="width:${(widest
            ? (r.issue / widest) * 100
            : 0
          ).toFixed(1)}%"></i></span>
          <span class="oa-bd-value">${usdShort(r.issue)}</span>
          <span class="oa-bd-share">${pct(total ? r.issue / total : 0)}</span>
        </li>`,
      )
      .join('');

    return `<section class="oa-panel">
      <header>
        <h3>${esc(title)}</h3>
        <span>${esc(rows.length > shown.length ? `top ${shown.length} of ${qty(rows.length)}` : note)}</span>
      </header>
      <ol class="oa-breakdown">${body}</ol>
    </section>`;
  }

  function detailRow(row: Row, s: Shaped, span: number): string {
    const detail = state.detail.get(detailKey(row.name, s));
    const loaded = detail && detail !== 'loading' ? detail : null;
    const perMonth = row.months ? row.issue / row.months : 0;
    const chartId = `rm-history-${row.name.replace(/[^A-Za-z0-9]+/g, '-')}`;

    // Quantity is only shown when every item underneath shares one unit —
    // otherwise it would be kilos added to gross.
    const topItem = loaded?.byProduct[0];
    const qtyNote =
      loaded?.unit && topItem
        ? statTile(
            'Quantity',
            `${qty(loaded.byProduct.reduce((a, r) => a + r.qty, 0))}`,
            `${esc(loaded.unit)} consumed`,
          )
        : '';

    const head = `<div class="oa-detail-head">
      <div class="oa-detail-title">
        <p class="eyebrow">${esc(row.companies.join(' + ') || '—')} · ${esc(periodLabel(s))}</p>
        <h2>${esc(row.name)}</h2>
      </div>
      <div class="oa-stats">
        ${statTile('Consumed', usd(row.issue), `${pct(row.share)} of the period`)}
        ${statTile(
          'Run rate',
          usdShort(perMonth),
          `a month over ${qty(row.months)} live month${row.months === 1 ? '' : 's'}`,
        )}
        ${statTile('On hand', usdShort(row.closing), `at ${esc(monthShort(s.months.at(-1) ?? ''))}`)}
        ${statTile('Cover', coverLabel(row.cover), 'at this rate')}
        ${statTile(
          'Span',
          `${esc(monthShort(row.everFirst || row.name))} — ${esc(monthShort(row.everLast || ''))}`,
          'across all of the ledger',
        )}
        ${qtyNote}
      </div>
    </div>`;

    const panels = !loaded
      ? `<div class="oa-detail-loading"><span class="spinner"></span> Reading ${esc(
          row.name,
        )} from Odoo…</div>`
      : loaded.error
        ? `<p class="oa-panel-empty">${esc(loaded.error)}</p>`
        : `<div class="oa-panels">
            ${breakdownPanel('By item', 'the items it covers', loaded.byProduct, row.issue)}
            ${breakdownPanel('By vendor', 'who supplied it', loaded.byVendor, row.issue)}
            ${breakdownPanel('By product line', 'what it feeds', loaded.byLine, row.issue)}
          </div>`;

    return `<tr class="day-detail"><td colspan="${span}">
      <div class="oa-detail">
        ${head}
        <div class="chart-host oa-history" id="${chartId}"></div>
        ${panels}
      </div>
    </td></tr>`;
  }

  function drawOpenHistory(s: Shaped) {
    if (!state.open) return;
    const row = s.rows.find((r) => r.name === state.open);
    if (!row) return;
    const host = document.querySelector<HTMLElement>('.oa-history');
    if (!host) return;

    const width = Math.max(host.clientWidth || 640, 420);
    const series = s.byCompany
      .map((c, i) => ({
        name: c.name,
        color: `--series-${i + 1}`,
        values: row.byCompany.get(c.id) ?? s.months.map(() => 0),
      }))
      .filter((sr) => sr.values.some((v) => v > 0));

    host.innerHTML = barChart({
      categories: s.months.map(monthShort),
      width,
      height: 220,
      stacked: true,
      format: usd,
      unit: '$',
      series: series.length
        ? series
        : [{ name: 'Consumed', color: '--series-1', values: row.series }],
    });
    bindChartTooltips(host);
  }

  /* ------------------------------------------------------------------ grid */

  function renderGrid(s: Shaped) {
    const query = state.query.trim().toLowerCase();
    const rows = query ? s.rows.filter((r) => r.name.toLowerCase().includes(query)) : s.rows;
    const oneMonth = s.months.length === 1;
    const COLUMNS = oneMonth ? 10 : 11;

    if (!rows.length) {
      el.grid.innerHTML = `<div class="state"><h2>${
        query ? `Nothing matches “${esc(state.query)}”` : 'Nothing consumed here'
      }</h2><p>${
        query
          ? 'Clear the search to see every row.'
          : 'No raw material was issued for this company and period.'
      }</p></div>`;
      return;
    }

    const widest = Math.max(...rows.map((r) => r.issue), 0);

    const body = rows
      .map((row, i) => {
        const open = state.open === row.name;
        const bandEnd = rows[i + 1] && rows[i + 1].cls !== row.cls;
        return (
          `<tr class="day-row can-open${open ? ' open' : ''}${
            bandEnd ? ' band-end' : ''
          }" data-member="${esc(row.name)}" tabindex="0" role="button" aria-expanded="${open}">
            <td class="sticky-col"><span class="disclose" aria-hidden="true">${
              open ? '▾' : '▸'
            }</span><span class="oa-rank">${String(i + 1).padStart(2, '0')}</span><span class="oa-name cls-${
              row.cls
            }">${esc(row.name)}</span></td>
            <td class="co">${esc(row.companies.join(' + '))}</td>
            <td class="num tinted">${usd(row.issue)}</td>
            <td class="num">${pct(row.share)}</td>
            <td class="bar-cell"><span class="mini-bar"><i class="cls-${row.cls}" style="width:${(
              widest ? (row.issue / widest) * 100 : 0
            ).toFixed(1)}%"></i></span></td>
            <td class="num muted">${pct(row.cumShare, 0)}</td>
            <td class="cls-cell"><span class="abc-badge abc-${row.cls}">${row.cls}</span></td>
            <td class="spark-cell">${sparkline(row.series, {
              color: row.cls === 'C' ? '--ink-muted' : '--series-1',
            })}</td>
            ${oneMonth ? '' : `<td class="num">${qty(row.months)}</td>`}
            <td class="num">${usd(row.closing)}</td>
            <td class="num ${row.cover !== null && row.cover >= 12 ? 'behind' : ''}">${coverLabel(
              row.cover,
            )}</td>
          </tr>` + (open ? detailRow(row, s, COLUMNS) : '')
        );
      })
      .join('');

    const totalRow = `<tr class="grand-row">
      <td class="sticky-col" colspan="2">All ${qty(s.rows.length)} ${esc(dimension().noun)} rows
        <span class="rail-sub">· ${esc(periodLabel(s))}</span></td>
      <td class="num">${usd(s.ledger.issue)}</td>
      <td class="num">100.0%</td>
      <td class="bar-cell"></td>
      <td class="num"></td>
      <td class="cls-cell muted">${s.bands
        .filter((b) => b.count)
        .map((b) => `${qty(b.count)}${b.cls}`)
        .join(' · ')}</td>
      <td class="spark-cell"></td>
      ${oneMonth ? '' : `<td class="num">${qty(s.months.length)}</td>`}
      <td class="num">${usd(s.ledger.closing)}</td>
      <td class="num">${coverLabel(s.cover)}</td>
    </tr>`;

    el.grid.innerHTML = `<table class="grid day-grid oa-sheet">
      <thead>
        <tr class="sub-row">
          <th class="sticky-col">${esc(dimension().label)}</th>
          <th class="text">Company</th>
          <th class="num">Consumed</th>
          <th class="num">Share</th>
          <th class="bar-cell"></th>
          <th class="num">Cum.</th>
          <th class="cls-cell">Class</th>
          <th class="spark-cell">Trend</th>
          ${oneMonth ? '' : '<th class="num">Mths</th>'}
          <th class="num">On hand</th>
          <th class="num">Cover</th>
        </tr>
      </thead>
      <tbody>${body}${query ? '' : totalRow}</tbody>
    </table>`;

    drawOpenHistory(s);

    el.note.textContent =
      `Odoo's monthly raw material ledger, ${qty(s.months.length)} of ${qty(
        state.history?.months.length ?? 0,
      )} months. Consumption is the issue column, sign-flipped; cover is what is on hand ` +
      `divided by an average month's consumption over this window. Class A is the first 80% of ` +
      `the period, B the next 15%, C the tail.`;
  }

  /* ---------------------------------------------------------------- render */

  function renderControls(h: RmHistory) {
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

    const fys = [...new Set(h.months.map(fyOf))].sort((a, b) => b - a);
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
    renderRail(s);
    renderLedger(s);
    renderTrend(s);
    renderChips(s);
    renderGrid(s);

    if (state.open) void loadDetail(state.open, s);

    el.status.hidden = true;
    el.body.hidden = false;
  }

  /* ---------------------------------------------------------------- events */

  function toggleMember(member: string) {
    state.open = state.open === member ? null : member;
    if (!state.history) return;
    const s = shape(state.history);
    if (state.open) void loadDetail(state.open, s);
    renderGrid(s);
  }

  el.grid.addEventListener('click', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('tr.day-row[data-member]');
    if (row?.dataset.member) toggleMember(row.dataset.member);
  });

  el.grid.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = (event.target as HTMLElement).closest<HTMLElement>('tr.day-row[data-member]');
    if (!row?.dataset.member) return;
    event.preventDefault();
    toggleMember(row.dataset.member);
  });

  el.chips.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.id === 'rm-export') {
      exportCsv();
      return;
    }
    const dim = target.closest<HTMLElement>('[data-dim]');
    if (dim && dim.dataset.dim !== state.dimension) {
      state.dimension = dim.dataset.dim!;
      // A different cut has different rows, so nothing carries over.
      state.open = null;
      state.query = '';
      void load();
    }
  });

  let searchTimer: number | undefined;
  el.chips.addEventListener('input', (event) => {
    const input = event.target as HTMLInputElement;
    if (input.id !== 'rm-search') return;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      state.query = input.value;
      if (state.history) renderGrid(shape(state.history));
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
    if (state.month && state.history && !periodMonths(state.history).includes(state.month)) {
      state.month = '';
    }
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
      [dimension().label, 'Company', 'Consumed USD', 'Share %', 'Months', 'On hand USD', 'Cover months']
        .concat(s.months.map(monthShort))
        .join(','),
      ...s.rows.map((row) =>
        [
          cell(row.name),
          cell(row.companies.join(' + ')),
          Math.round(row.issue),
          (row.share * 100).toFixed(2),
          row.months,
          Math.round(row.closing),
          row.cover === null ? '' : row.cover.toFixed(1),
        ]
          .concat(row.series.map((v) => String(Math.round(v))))
          .join(','),
      ),
    ];

    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `RM consumption by ${dimension().label} ${periodLabel(s)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  let resizeTimer: number | undefined;
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (!state.history) return;
      const s = shape(state.history);
      renderTrend(s);
      drawOpenHistory(s);
    }, 180);
  });

  if (root.dataset.odoo !== '1') {
    el.status.innerHTML =
      '<h2>Not connected</h2><p>Set the Odoo credentials in .env to read the ledger.</p>';
  } else {
    void load();
  }
}
