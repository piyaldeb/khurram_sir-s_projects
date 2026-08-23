/**
 * Buyer expectation against our own bulk lead time.
 *
 * Every buyer tells us how many days they expect an order to take, and the
 * figure differs for a standard item and a non-standard one. The sheet groups
 * the year's orders by buyer, by item, by slider or by that standard split, and
 * every row opens onto the orders themselves.
 *
 * The one number that matters is the gap: days taken minus days expected. Late
 * is the one that costs a relationship, so late is red.
 *
 * An order still open counts against today and keeps growing. That is the
 * honest reading — it is already that late — but it means a pending order can
 * never be "on time" until it ships, so the rail says how many are still open.
 */
import { barChart, bindChartTooltips, sparkline } from '../lib/charts';
import { skeleton } from '../lib/skeleton';

interface EddRow {
  no: string;
  order: string | null;
  date: string;
  buyer: string;
  customer: string;
  item: string;
  style: string;
  qty: number;
  status: string;
  pending: boolean;
  slider: string;
  mixedSliders: boolean;
  standard: 'standard' | 'non-standard' | 'unknown';
  expected: number | null;
  actual: number;
  gap: number | null;
  onTime: boolean | null;
  note: string | null;
  basis: string | null;
  unknownBuyer: boolean;
}

interface EddReport {
  fy: number;
  label: string;
  from: string;
  to: string;
  rows: EddRow[];
  missingBuyers: string[];
  source: string;
  fiscalYears: number[];
}

const DIMENSIONS = [
  { key: 'buyer', label: 'Buyer', noun: 'buyer' },
  { key: 'item', label: 'Item', noun: 'item' },
  { key: 'slider', label: 'Slider', noun: 'slider' },
  { key: 'standard', label: 'Standard split', noun: 'class' },
  { key: 'customer', label: 'Customer', noun: 'customer' },
] as const;

type DimKey = (typeof DIMENSIONS)[number]['key'];

const root = document.querySelector<HTMLElement>('.edd');

if (root) {
  const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
  const el = {
    status: $<HTMLElement>('#edd-status'),
    body: $<HTMLElement>('#edd-body'),
    rail: $<HTMLElement>('#edd-rail'),
    chips: $<HTMLElement>('#edd-chips'),
    grid: $<HTMLElement>('#edd-grid'),
    note: $<HTMLElement>('#edd-note'),
    trend: $<HTMLElement>('#edd-trend'),
    trendNote: $<HTMLElement>('#edd-trend-note'),
    fySeg: $<HTMLElement>('#edd-fy'),
    monthPick: $<HTMLSelectElement>('#edd-month'),
  };

  const state = {
    fy: 0,
    /** A month inside the chosen year, or '' for all of them. */
    month: '',
    dimension: 'buyer' as DimKey,
    /** 'all' | 'late' | 'ontime' | 'pending' */
    only: 'all',
    query: '',
    open: null as string | null,
    report: null as EddReport | null,
  };

  const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const qty = (v: number) => nf.format(Math.round(v));
  const days = (v: number | null) => (v === null || v === undefined ? '—' : `${Math.round(v)}d`);
  const signed = (v: number | null) =>
    v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${Math.round(v)}d`;
  const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;
  const esc = (s: string | number) =>
    String(s).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
    );

  const fyLabel = (fy: number) => `FY ${String(fy).slice(2)}-${String(fy + 1).slice(2)}`;
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
  const day = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: '2-digit',
      timeZone: 'UTC',
    });
  const dimension = () => DIMENSIONS.find((d) => d.key === state.dimension)!;

  let inFlight: AbortController | null = null;

  /* ------------------------------------------------------------------ load */

  async function load() {
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;

    el.status.hidden = true;
    el.body.hidden = false;
    el.rail.innerHTML = skeleton.rail();
    el.trend.innerHTML = skeleton.chart();
    el.chips.innerHTML = skeleton.chips(6);
    el.grid.innerHTML = skeleton.table(9, 10);

    try {
      const res = await fetch(`/api/buyer-edd${state.fy ? `?fy=${state.fy}` : ''}`, {
        signal: controller.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      state.report = data as EddReport;
      state.fy = state.report.fy;
      render();
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      el.body.hidden = true;
      el.status.hidden = false;
      el.status.classList.add('error');
      el.status.innerHTML = `<h2>Could not build the year</h2><p style="font-family:var(--mono);font-size:12.5px">${esc(
        (err as Error).message,
      )}</p>`;
    }
  }

  /* --------------------------------------------------------------- shaping */

  interface Row {
    name: string;
    /** What the workbook wrote where a number was expected. */
    note: string | null;
    /** How the expectation was worked out, where it was not simply read. */
    basis: string | null;
    count: number;
    /** Orders the workbook could judge. */
    judged: number;
    onTime: number;
    late: number;
    pending: number;
    expected: number;
    actual: number;
    /** Mean gap over the judged orders. */
    gap: number;
    /** The worst single order in the row. */
    worst: number;
    series: number[];
    members: EddRow[];
  }

  interface Shaped {
    months: string[];
    rows: Row[];
    all: EddRow[];
    total: {
      count: number;
      judged: number;
      onTime: number;
      late: number;
      pending: number;
      gap: number;
      expected: number;
      actual: number;
    };
    /** Mean gap per month, and how many were late in it. */
    perMonth: { late: number; onTime: number }[];
  }

  /**
   * The months the loaded year covers, oldest first, before any narrowing.
   *
   * Taken from the orders rather than generated from the year, so the picker
   * only ever offers months that actually carry orders — and picking FY 26-27
   * offers that year's months and nothing else.
   */
  function yearMonths(r: EddReport) {
    return [...new Set(r.rows.map((x) => x.date.slice(0, 7)))].sort();
  }

  /** The month the sheet is narrowed to, if it is still inside the year. */
  function pickedMonth(r: EddReport) {
    if (!state.month) return null;
    return yearMonths(r).includes(state.month) ? state.month : null;
  }

  function shape(r: EddReport): Shaped {
    const month = pickedMonth(r);

    const filtered = r.rows.filter((row) => {
      if (month && row.date.slice(0, 7) !== month) return false;
      if (state.only === 'late') return row.onTime === false;
      if (state.only === 'ontime') return row.onTime === true;
      if (state.only === 'pending') return row.pending;
      return true;
    });

    const months = [...new Set(filtered.map((x) => x.date.slice(0, 7)))].sort();
    const index = new Map(months.map((m, i) => [m, i]));
    const perMonth = months.map(() => ({ late: 0, onTime: 0 }));

    const rows = new Map<string, Row>();

    for (const x of filtered) {
      const i = index.get(x.date.slice(0, 7))!;
      if (x.onTime === true) perMonth[i].onTime += 1;
      else if (x.onTime === false) perMonth[i].late += 1;

      const key = String(x[state.dimension] ?? '') || '(none)';
      let row = rows.get(key);
      if (!row) {
        row = {
          name: key,
          note: null,
          basis: null,
          count: 0,
          judged: 0,
          onTime: 0,
          late: 0,
          pending: 0,
          expected: 0,
          actual: 0,
          gap: 0,
          worst: 0,
          series: months.map(() => 0),
          members: [],
        };
        rows.set(key, row);
      }
      row.count += 1;
      row.series[i] += 1;
      row.members.push(x);
      row.actual += x.actual;
      if (!row.note && x.note) row.note = x.note;
      if (!row.basis && x.basis) row.basis = x.basis;
      if (x.pending) row.pending += 1;
      if (x.gap !== null && x.expected !== null) {
        row.judged += 1;
        row.expected += x.expected;
        row.gap += x.gap;
        if (x.gap > row.worst) row.worst = x.gap;
        if (x.onTime) row.onTime += 1;
        else row.late += 1;
      }
    }

    for (const row of rows.values()) {
      /*
       * Taken is averaged over every order, because Odoo knows how long each
       * one took whether or not the workbook has an expectation to judge it
       * against. Averaging it over the judged ones only threw away a figure we
       * hold — which is how H&M, the largest buyer at over a thousand orders,
       * came to show a dash for a lead time that is perfectly well known.
       */
      if (row.count) row.actual /= row.count;
      if (row.judged) {
        row.expected /= row.judged;
        row.gap /= row.judged;
      }
      // Worst first inside a row: the order that blew the expectation is the
      // one someone opening this came to find.
      row.members.sort((a, b) => (b.gap ?? -Infinity) - (a.gap ?? -Infinity));
    }

    const judged = filtered.filter((x) => x.gap !== null);
    const shaped = [...rows.values()].sort((a, b) => b.count - a.count);

    return {
      months,
      rows: shaped,
      all: filtered,
      total: {
        count: filtered.length,
        judged: judged.length,
        onTime: judged.filter((x) => x.onTime).length,
        late: judged.filter((x) => !x.onTime).length,
        pending: filtered.filter((x) => x.pending).length,
        gap: judged.length ? judged.reduce((a, x) => a + (x.gap ?? 0), 0) / judged.length : 0,
        expected: judged.length
          ? judged.reduce((a, x) => a + (x.expected ?? 0), 0) / judged.length
          : 0,
        actual: filtered.length ? filtered.reduce((a, x) => a + x.actual, 0) / filtered.length : 0,
      },
      perMonth,
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

  function renderRail(r: EddReport, s: Shaped) {
    const rate = s.total.judged ? s.total.onTime / s.total.judged : 0;

    const head = `<div class="rail-head">
      <p class="eyebrow">${esc(r.label)} · Zipper bulk</p>
      <h2 class="rail-title">Kept, or not</h2>
      <p class="rail-sub">Days taken against the days the buyer expects. The expectation is
      hand-kept in the EDD workbook; everything it is measured against is read from Odoo.</p>
    </div>`;

    const onTime = railBlock(
      'On time',
      `<p class="rail-figure">${pct(rate, 1)}</p>
       <p class="rail-sub">${qty(s.total.onTime)} of ${qty(
         s.total.judged,
       )} orders met the expectation. ${qty(s.total.late)} did not.</p>
       ${bar(rate * 100, rate >= 0.9 ? 's2' : 's1')}`,
      s.total.count > s.total.judged
        ? `${qty(s.total.count - s.total.judged)} orders could not be judged — the buyer or the slider is not in the workbook.`
        : '',
    );

    /*
     * The average gap is the one figure that says whether we are structurally
     * fast or slow, rather than lucky on a given order.
     */
    const late = s.total.gap > 0;
    const gap = railBlock(
      'Against expectation',
      `<p class="rail-figure">
        <span class="edd-gap ${late ? 'late' : 'early'}">${signed(s.total.gap)}</span>
      </p>
       <p class="rail-sub">on average — ${days(s.total.actual)} taken against ${days(
         s.total.expected,
       )} expected.</p>`,
      'A day early is a day of goodwill; a day late is the one that costs.',
    );

    // The buyers who are worst off, whatever dimension the sheet is showing.
    const byBuyer = new Map<string, { late: number; judged: number; gap: number }>();
    for (const x of s.all) {
      if (x.gap === null) continue;
      const held = byBuyer.get(x.buyer) ?? { late: 0, judged: 0, gap: 0 };
      held.judged += 1;
      held.gap += x.gap;
      if (!x.onTime) held.late += 1;
      byBuyer.set(x.buyer, held);
    }
    const worst = [...byBuyer.entries()]
      .filter(([, v]) => v.judged >= 10)
      .map(([name, v]) => ({ name, rate: v.late / v.judged, gap: v.gap / v.judged, n: v.judged }))
      .sort((a, b) => b.rate - a.rate)
      .slice(0, 5);

    const worstBlock = worst.length
      ? railBlock(
          'Missed most often',
          `<div class="edd-worst">
            ${worst
              .map(
                (w) => `<div class="edd-worst-row">
                  <span>${esc(w.name)}</span>
                  ${bar(w.rate * 100, 's1')}
                  <b>${pct(w.rate)}</b>
                </div>`,
              )
              .join('')}
          </div>`,
          'Buyers with at least ten judged orders.',
        )
      : '';

    const pending = s.total.pending
      ? railBlock(
          'Still open',
          `<p class="rail-figure">${qty(s.total.pending)}</p>
           <p class="rail-sub">orders have not shipped. Their lead time counts against today and
           grows every day, so they can only get later.</p>`,
        )
      : '';

    el.rail.innerHTML = head + onTime + gap + worstBlock + pending;
  }

  /* ----------------------------------------------------------------- trend */

  function renderTrend(s: Shaped) {
    if (!s.months.length) {
      el.trend.innerHTML = '<div class="state"><p>No orders to show.</p></div>';
      el.trendNote.textContent = '';
      return;
    }

    el.trend.innerHTML = barChart({
      categories: s.months.map(monthShort),
      width: Math.max(el.trend.clientWidth || 720, 480),
      height: 250,
      stacked: true,
      format: qty,
      series: [
        { name: 'On time', color: '--series-2', values: s.perMonth.map((m) => m.onTime) },
        { name: 'Late', color: '--series-1', values: s.perMonth.map((m) => m.late) },
      ],
    });
    bindChartTooltips(el.trend);

    el.trendNote.textContent = `orders judged against the buyer's expectation · ${s.months.length} months`;
  }

  /* ----------------------------------------------------------------- chips */

  const FILTERS = [
    { key: 'all', label: 'All' },
    { key: 'late', label: 'Late only' },
    { key: 'ontime', label: 'On time only' },
    { key: 'pending', label: 'Still open' },
  ];

  function renderChips(s: Shaped) {
    el.chips.innerHTML =
      DIMENSIONS.map(
        (d) =>
          `<button class="chip toggle" type="button" data-dim="${d.key}" aria-pressed="${
            state.dimension === d.key
          }">${esc(d.label)}</button>`,
      ).join('') +
      `<span class="chips-divide"></span>` +
      FILTERS.map(
        (f) =>
          `<button class="chip toggle" type="button" data-only="${f.key}" aria-pressed="${
            state.only === f.key
          }">${esc(f.label)}</button>`,
      ).join('') +
      `<span class="chip-count">${qty(s.total.count)} OAs</span>` +
      `<input class="chips-search" id="edd-search" type="search" placeholder="Search OA, buyer, style…" value="${esc(
        state.query,
      )}" />` +
      `<button class="chip" type="button" id="edd-export">Export</button>`;
  }

  /* ------------------------------------------------------------ the orders */

  const gapCell = (gap: number | null) => {
    if (gap === null) return '<td class="num muted">—</td>';
    if (gap > 0) return `<td class="num"><span class="edd-gap late">${signed(gap)}</span></td>`;
    return `<td class="num"><span class="edd-gap early">${signed(gap)}</span></td>`;
  };

  function detailRow(row: Row, span: number): string {
    const query = state.query.trim().toLowerCase();
    const shown = query
      ? row.members.filter(
          (x) =>
            x.no.includes(query) ||
            (x.order ?? '').toLowerCase().includes(query) ||
            x.buyer.toLowerCase().includes(query) ||
            x.customer.toLowerCase().includes(query) ||
            x.style.toLowerCase().includes(query),
        )
      : row.members;

    // Every order, not a top slice: the point of opening a row is to see what
    // it is made of. The table sits in its own scroll box, so a buyer with a
    // thousand OAs costs height inside that box rather than down the page.
    const body = shown
      .map(
        (x) => `<tr>
          <td class="text mono">${esc(x.order ?? x.no)}</td>
          <td class="text">${esc(day(x.date))}</td>
          <td class="text">${esc(x.buyer)}</td>
          <td class="text">${esc(x.item)}</td>
          <td class="text mono">${esc(x.slider)}${
            x.mixedSliders ? '<span class="edd-mixed" title="This order has more than one slider; the one with the most quantity decides.">mixed</span>' : ''
          }</td>
          <td class="text"><span class="edd-class ${x.standard}">${esc(x.standard)}</span></td>
          <td class="num">${qty(x.qty)}</td>
          <td class="num">${days(x.expected)}</td>
          <td class="num">${days(x.actual)}</td>
          <td class="num">${
            x.gap === null
              ? '—'
              : `<span class="edd-gap ${x.gap > 0 ? 'late' : 'early'}">${signed(x.gap)}</span>`
          }</td>
          <td class="text">${esc(x.status)}</td>
        </tr>`,
      )
      .join('');

    return `<tr class="day-detail"><td colspan="${span}">
      <div class="oa-detail">
        <div class="oa-detail-head">
          <div class="oa-detail-title">
            <p class="eyebrow">${esc(dimension().label)}</p>
            <h2>${esc(row.name)}</h2>
          </div>
          <div class="oa-stats">
            <div class="oa-stat"><span class="oa-stat-label">Orders</span><b class="oa-stat-figure">${qty(
              row.count,
            )}</b></div>
            <div class="oa-stat"><span class="oa-stat-label">Expected</span><b class="oa-stat-figure">${days(
              row.judged ? row.expected : null,
            )}</b><span class="oa-stat-note">average</span></div>
            <div class="oa-stat"><span class="oa-stat-label">Taken</span><b class="oa-stat-figure">${days(
              row.count ? row.actual : null,
            )}</b><span class="oa-stat-note">average of all ${qty(row.count)}</span></div>
            <div class="oa-stat"><span class="oa-stat-label">Gap</span><b class="oa-stat-figure"><span class="edd-gap ${
              row.gap > 0 ? 'late' : 'early'
            }">${signed(row.judged ? row.gap : null)}</span></b></div>
            <div class="oa-stat"><span class="oa-stat-label">Worst</span><b class="oa-stat-figure">${signed(
              row.judged ? row.worst : null,
            )}</b><span class="oa-stat-note">single order</span></div>
          </div>
        </div>
        <div class="rmd-ship-scroll">
          <table class="grid mini edd-orders">
            <thead><tr>
              <th class="text">OA</th><th class="text">Date</th><th class="text">Buyer</th>
              <th class="text">Item</th><th class="text">Slider</th><th class="text">Class</th>
              <th class="num">Qty</th><th class="num">Expected</th><th class="num">Taken</th>
              <th class="num">Gap</th><th class="text">Status</th>
            </tr></thead>
            <tbody>${body}</tbody>
          </table>
        </div>
        <p class="hint">${
          query
            ? `${qty(shown.length)} of ${qty(row.members.length)} orders match the search`
            : `all ${qty(shown.length)} orders, worst gap first`
        }</p>
      </div>
    </td></tr>`;
  }

  /* ----------------------------------------------------------------- sheet */

  function renderGrid(s: Shaped) {
    const query = state.query.trim().toLowerCase();
    const rows = query
      ? s.rows.filter(
          (r) =>
            r.name.toLowerCase().includes(query) ||
            r.members.some(
              (x) =>
                x.no.includes(query) ||
                (x.order ?? '').toLowerCase().includes(query) ||
                x.customer.toLowerCase().includes(query) ||
                x.style.toLowerCase().includes(query),
            ),
        )
      : s.rows;
    const COLUMNS = 10;

    if (!rows.length) {
      el.grid.innerHTML = `<div class="state"><h2>${
        query ? `Nothing matches “${esc(state.query)}”` : 'No orders here'
      }</h2><p>Clear the filters to see the year.</p></div>`;
      return;
    }

    const widest = Math.max(...rows.map((r) => r.count), 0);

    const body = rows
      .map((row) => {
        const open = state.open === row.name;
        const rate = row.judged ? row.onTime / row.judged : null;
        return (
          `<tr class="day-row can-open${open ? ' open' : ''}" data-row="${esc(
            row.name,
          )}" tabindex="0" role="button" aria-expanded="${open}">
            <td class="sticky-col"><span class="disclose" aria-hidden="true">${
              open ? '▾' : '▸'
            }</span>${esc(row.name)}${
              row.note
                ? `<span class="edd-policy" title="${esc(
                    row.note,
                  )}">policy</span>`
                : ''
            }${
              row.basis
                ? `<span class="edd-policy derived" title="${esc(
                    row.basis,
                  )}">derived</span>`
                : ''
            }${
              row.judged === 0 && row.count
                ? '<span class="edd-policy" title="The workbook gives no day count for this buyer, so these orders are counted but not judged.">not judged</span>'
                : ''
            }</td>
            <td class="num tinted">${qty(row.count)}</td>
            <td class="bar-cell"><span class="mini-bar"><i style="width:${(
              widest ? (row.count / widest) * 100 : 0
            ).toFixed(1)}%"></i></span></td>
            <td class="num">${days(row.judged ? row.expected : null)}</td>
            <td class="num">${days(row.count ? row.actual : null)}</td>
            ${gapCell(row.judged ? row.gap : null)}
            <td class="num">${qty(row.onTime)}</td>
            <td class="num">${qty(row.late)}</td>
            <td class="num ${rate !== null && rate < 0.8 ? 'behind' : rate !== null ? 'ahead' : ''}">${
              rate === null ? '—' : pct(rate)
            }</td>
            <td class="spark-cell">${sparkline(row.series)}</td>
          </tr>` + (open ? detailRow(row, COLUMNS) : '')
        );
      })
      .join('');

    const rate = s.total.judged ? s.total.onTime / s.total.judged : null;
    const total = `<tr class="grand-row">
      <td class="sticky-col">All ${qty(s.rows.length)} ${esc(dimension().noun)} rows</td>
      <td class="num">${qty(s.total.count)}</td>
      <td class="bar-cell"></td>
      <td class="num">${days(s.total.expected)}</td>
      <td class="num">${days(s.total.actual)}</td>
      ${gapCell(s.total.gap)}
      <td class="num">${qty(s.total.onTime)}</td>
      <td class="num">${qty(s.total.late)}</td>
      <td class="num">${rate === null ? '—' : pct(rate)}</td>
      <td class="spark-cell"></td>
    </tr>`;

    el.grid.innerHTML = `<table class="grid day-grid oa-sheet">
      <thead>
        <tr class="sub-row">
          <th class="sticky-col">${esc(dimension().label)}</th>
          <th class="num">OAs</th>
          <th class="bar-cell"></th>
          <th class="num">Expected</th>
          <th class="num">Taken</th>
          <th class="num">Gap</th>
          <th class="num">On time</th>
          <th class="num">Late</th>
          <th class="num">On time %</th>
          <th class="spark-cell">Trend</th>
        </tr>
      </thead>
      <tbody>${body}${query ? '' : total}</tbody>
    </table>`;

    const r = state.report;
    const missing = r?.missingBuyers.length ?? 0;
    el.note.textContent =
      `Expected days come from ${r?.source ?? 'the EDD workbook'}; a standard item gets the ` +
      `buyer's shorter figure and anything else the longer one, decided by the slider Odoo ` +
      `records on the order. Taken is Odoo's own bulk lead time in calendar days, counted ` +
      `against today while an order is still open. ` +
      (missing
        ? `${missing} buyers in the year are not in the workbook, so their orders cannot be judged: ${r!.missingBuyers
            .slice(0, 8)
            .join(', ')}${missing > 8 ? ', …' : ''}. `
        : '') +
      'A buyer marked "policy" wrote a sentence rather than a day count — hover it to read what ' +
      'they actually asked for. "Derived" means that sentence was turned into a figure: hover it ' +
      'to see how — working days convert at a six-day week.';
  }

  /* ---------------------------------------------------------------- render */

  function renderControls(r: EddReport) {
    el.fySeg.innerHTML = [...r.fiscalYears]
      .sort((a, b) => b - a)
      .map(
        (fy) =>
          `<button class="seg" type="button" role="tab" data-fy="${fy}" aria-selected="${
            fy === r.fy
          }">${esc(fyLabel(fy))}</button>`,
      )
      .join('');

    const months = yearMonths(r);
    const month = pickedMonth(r);
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
    const r = state.report;
    if (!r) return;
    const s = shape(r);
    renderControls(r);
    renderRail(r, s);
    renderTrend(s);
    renderChips(s);
    renderGrid(s);
    el.status.hidden = true;
    el.body.hidden = false;
  }

  /* ---------------------------------------------------------------- events */

  function toggleRow(name: string) {
    state.open = state.open === name ? null : name;
    if (state.report) renderGrid(shape(state.report));
  }

  el.grid.addEventListener('click', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('tr.day-row[data-row]');
    if (row?.dataset.row) toggleRow(row.dataset.row);
  });

  el.grid.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = (event.target as HTMLElement).closest<HTMLElement>('tr.day-row[data-row]');
    if (!row?.dataset.row) return;
    event.preventDefault();
    toggleRow(row.dataset.row);
  });

  el.chips.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.id === 'edd-export') {
      exportCsv();
      return;
    }
    const dim = target.closest<HTMLElement>('[data-dim]');
    if (dim && dim.dataset.dim !== state.dimension) {
      state.dimension = dim.dataset.dim as DimKey;
      state.open = null;
      render();
      return;
    }
    const only = target.closest<HTMLElement>('[data-only]');
    if (only && only.dataset.only !== state.only) {
      state.only = only.dataset.only!;
      state.open = null;
      render();
    }
  });

  let searchTimer: number | undefined;
  el.chips.addEventListener('input', (event) => {
    const input = event.target as HTMLInputElement;
    if (input.id !== 'edd-search') return;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      state.query = input.value;
      if (state.report) renderGrid(shape(state.report));
    }, 160);
  });

  el.fySeg.addEventListener('click', (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLElement>('[data-fy]');
    if (!btn || Number(btn.dataset.fy) === state.fy) return;
    state.fy = Number(btn.dataset.fy);
    state.month = '';
    state.open = null;
    void load();
  });

  el.monthPick.addEventListener('change', () => {
    state.month = el.monthPick.value;
    state.open = null;
    render();
  });

  function exportCsv() {
    const r = state.report;
    if (!r) return;
    const s = shape(r);
    const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

    const lines = [
      ['OA', 'Date', 'Buyer', 'Customer', 'Item', 'Slider', 'Class', 'Style', 'Qty',
       'Expected days', 'Taken days', 'Gap days', 'On time', 'Status'].join(','),
      ...s.all.map((x) =>
        [
          cell(x.order ?? x.no),
          x.date,
          cell(x.buyer),
          cell(x.customer),
          cell(x.item),
          cell(x.slider),
          x.standard,
          cell(x.style),
          Math.round(x.qty),
          x.expected ?? '',
          x.actual,
          x.gap ?? '',
          x.onTime === null ? '' : x.onTime ? 'Yes' : 'No',
          cell(x.status),
        ].join(','),
      ),
    ];

    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Buyer expectation ${r.label}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  let resizeTimer: number | undefined;
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (state.report) renderTrend(shape(state.report));
    }, 180);
  });

  if (root.dataset.odoo !== '1') {
    el.status.innerHTML =
      '<h2>Not connected</h2><p>Set the Odoo credentials in .env to build the year.</p>';
  } else {
    void load();
  }
}
