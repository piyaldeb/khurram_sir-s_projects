/**
 * Customer complaints, in the site's rail-plus-full-sheet shape.
 *
 * The sheet groups by whichever dimension is chosen — how the complaint was
 * classified, what type it was, which department is thought responsible, which
 * team or customer or buyer it came from — and every row opens onto the
 * complaints themselves, with what the customer actually wrote.
 *
 * A complaint is closed only when it reaches `done`, which is the only state
 * Odoo ever sets a closing date on. Non-justified is a decision that it was not
 * our fault, not a closure, and 258 of those sitting open is a different
 * picture from 258 closed ones — so the states are shown, not just the two
 * buckets.
 */
import { barChart, bindChartTooltips, sparkline } from '../lib/charts';
import { skeleton } from '../lib/skeleton';

interface Ccr {
  id: number;
  name: string;
  raised: string;
  companyId: number;
  companyName: string;
  state: string;
  closed: boolean;
  closingDate: string | null;
  classification: string;
  type: string;
  department: string;
  team: string;
  customer: string;
  buyer: string;
  comment: string;
  justification: string;
  orderQty: number;
  rejectedQty: number;
  oa: string;
  invoice: string;
  raisedBy: string;
  totalLead: string;
}

interface CcrReport {
  rows: Ccr[];
  companies: { id: number; name: string }[];
  months: string[];
  fetchedAt: string;
}

const STATE_ORDER = ['inter', 'just', 'nonjust', 'ca', 'pa', 'done', 'cancel'];
const STATE_LABEL: Record<string, string> = {
  inter: 'Intermediate',
  just: 'Justified',
  nonjust: 'Non justified',
  ca: 'Corrective action',
  pa: 'Preventive action',
  done: 'Done',
  cancel: 'Cancelled',
};

const DIMENSIONS = [
  { key: 'classification', label: 'Classification', noun: 'classification' },
  { key: 'type', label: 'Type', noun: 'type' },
  { key: 'department', label: 'Department', noun: 'department' },
  { key: 'team', label: 'Team', noun: 'team' },
  { key: 'customer', label: 'Customer', noun: 'customer' },
  { key: 'buyer', label: 'Buyer', noun: 'buyer' },
] as const;

type DimKey = (typeof DIMENSIONS)[number]['key'];

const root = document.querySelector<HTMLElement>('.ccr');

if (root) {
  const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
  const el = {
    status: $<HTMLElement>('#ccr-status'),
    body: $<HTMLElement>('#ccr-body'),
    rail: $<HTMLElement>('#ccr-rail'),
    chips: $<HTMLElement>('#ccr-chips'),
    grid: $<HTMLElement>('#ccr-grid'),
    note: $<HTMLElement>('#ccr-note'),
    trend: $<HTMLElement>('#ccr-trend'),
    trendNote: $<HTMLElement>('#ccr-trend-note'),
    companySeg: $<HTMLElement>('#ccr-company'),
    periodSeg: $<HTMLElement>('#ccr-period'),
    monthPick: $<HTMLSelectElement>('#ccr-month'),
  };

  const state = {
    dimension: 'classification' as DimKey,
    company: 'all' as string,
    period: 'all' as string,
    month: '',
    query: '',
    open: null as string | null,
    report: null as CcrReport | null,
  };

  const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const qty = (v: number) => nf.format(Math.round(v));
  const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;
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
  const day = (iso: string | null) =>
    !iso
      ? '—'
      : new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
          day: '2-digit',
          month: 'short',
          year: '2-digit',
          timeZone: 'UTC',
        });

  /** April to March, the way the plant counts a year. */
  const fyOf = (month: string) => {
    const [y, m] = month.split('-').map(Number);
    return m >= 4 ? y : y - 1;
  };
  const fyLabel = (fy: number) => `FY ${String(fy).slice(2)}-${String(fy + 1).slice(2)}`;
  const dimension = () => DIMENSIONS.find((d) => d.key === state.dimension)!;

  /** Days a complaint has been open, or how long it took to close. */
  const ageOf = (c: Ccr) => {
    const from = new Date(`${c.raised}T00:00:00Z`).getTime();
    const to = c.closed && c.closingDate ? new Date(`${c.closingDate}T00:00:00Z`).getTime() : Date.now();
    return Math.max(Math.round((to - from) / 86_400_000), 0);
  };

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
    el.grid.innerHTML = skeleton.table(8, 10);

    try {
      const res = await fetch('/api/ccr', { signal: controller.signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      state.report = data as CcrReport;
      render();
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      el.body.hidden = true;
      el.status.hidden = false;
      el.status.classList.add('error');
      el.status.innerHTML = `<h2>Could not read the complaints</h2><p style="font-family:var(--mono);font-size:12.5px">${esc(
        (err as Error).message,
      )}</p>`;
    }
  }

  /* --------------------------------------------------------------- shaping */

  function periodMonths(r: CcrReport): string[] {
    const all = [...r.months].sort();
    if (state.period === 'all') return all;
    if (state.period === 'r12') return all.slice(-12);
    const fy = Number(state.period);
    return all.filter((m) => fyOf(m) === fy);
  }

  function pickedMonth(r: CcrReport): string | null {
    if (!state.month) return null;
    return periodMonths(r).includes(state.month) ? state.month : null;
  }

  function visibleMonths(r: CcrReport): string[] {
    const months = periodMonths(r);
    const month = pickedMonth(r);
    return month ? months.filter((m) => m === month) : months;
  }

  interface Row {
    name: string;
    count: number;
    open: number;
    closed: number;
    /** Complaints that were decided not to be our fault. */
    notOurs: number;
    /** Count per visible month, for the row's own trend. */
    series: number[];
    /** Mean days open, or to close. */
    age: number;
    members: Ccr[];
  }

  interface Shaped {
    months: string[];
    rows: Row[];
    all: Ccr[];
    total: { count: number; open: number; closed: number; notOurs: number };
    perMonth: number[];
    byCompany: { id: number; name: string; count: number; series: number[] }[];
    byState: { state: string; count: number }[];
  }

  function shape(r: CcrReport): Shaped {
    const months = visibleMonths(r);
    const index = new Map(months.map((m, i) => [m, i]));
    const id = state.company === 'all' ? null : Number(state.company);

    const all = r.rows.filter(
      (c) => index.has(c.raised.slice(0, 7)) && (id === null || c.companyId === id),
    );

    const rows = new Map<string, Row>();
    const companies = new Map<number, { id: number; name: string; count: number; series: number[] }>();
    const states = new Map<string, number>();
    const perMonth = months.map(() => 0);

    for (const c of all) {
      const i = index.get(c.raised.slice(0, 7))!;
      perMonth[i] += 1;
      states.set(c.state, (states.get(c.state) ?? 0) + 1);

      const co =
        companies.get(c.companyId) ??
        companies
          .set(c.companyId, {
            id: c.companyId,
            name: c.companyName,
            count: 0,
            series: months.map(() => 0),
          })
          .get(c.companyId)!;
      co.count += 1;
      co.series[i] += 1;

      const key = String(c[state.dimension] ?? '') || '(none)';
      let row = rows.get(key);
      if (!row) {
        row = {
          name: key,
          count: 0,
          open: 0,
          closed: 0,
          notOurs: 0,
          series: months.map(() => 0),
          age: 0,
          members: [],
        };
        rows.set(key, row);
      }
      row.count += 1;
      row.series[i] += 1;
      row.members.push(c);
      if (c.closed) row.closed += 1;
      else row.open += 1;
      if (c.state === 'nonjust') row.notOurs += 1;
    }

    for (const row of rows.values()) {
      row.age = row.members.length
        ? row.members.reduce((a, c) => a + ageOf(c), 0) / row.members.length
        : 0;
      // Newest first inside a row: a complaint raised today is the one someone
      // opening this is looking for.
      row.members.sort((a, b) => b.raised.localeCompare(a.raised));
    }

    const shaped = [...rows.values()].sort((a, b) => b.count - a.count);

    return {
      months,
      rows: shaped,
      all,
      total: {
        count: all.length,
        open: all.filter((c) => !c.closed).length,
        closed: all.filter((c) => c.closed).length,
        notOurs: all.filter((c) => c.state === 'nonjust').length,
      },
      perMonth,
      byCompany: [...companies.values()].sort((a, b) => a.id - b.id),
      byState: STATE_ORDER.filter((s) => states.has(s)).map((s) => ({
        state: s,
        count: states.get(s)!,
      })),
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
    if (s.months.length === 1 && state.month === s.months[0]) return monthLong(s.months[0]);
    if (state.period === 'all') return `${monthShort(s.months[0])} — ${monthShort(s.months.at(-1)!)}`;
    if (state.period === 'r12') return 'last 12 months';
    return fyLabel(Number(state.period));
  }

  function renderRail(s: Shaped) {
    const head = `<div class="rail-head">
      <p class="eyebrow">${esc(periodLabel(s))}</p>
      <h2 class="rail-title">What customers complained about</h2>
      <p class="rail-sub">One record per complaint raised against a delivery. A complaint is
      closed only when it reaches <em>Done</em> — that is the only state Odoo dates.</p>
    </div>`;

    const split = s.byCompany
      .map(
        (c, i) => `<div class="rail-split">
          <div class="rail-split-head">
            <span><i class="swatch s${i + 1}"></i>${esc(c.name)}</span>
            <b>${qty(c.count)} <span class="rail-of">${pct(
              s.total.count ? c.count / s.total.count : 0,
            )}</span></b>
          </div>
          ${bar(s.total.count ? (c.count / s.total.count) * 100 : 0, `s${i + 1}`)}
        </div>`,
      )
      .join('');

    const raised = railBlock(
      `Raised, ${periodLabel(s)}`,
      `<p class="rail-figure">${qty(s.total.count)}</p>
       <p class="rail-sub">${qty(s.rows.length)} ${esc(dimension().noun)}${
         s.rows.length === 1 ? '' : 's'
       } · ${qty(s.months.length)} month${s.months.length === 1 ? '' : 's'}</p>
       ${split}`,
    );

    /*
     * Closed is a small number and open is a large one, which is the finding
     * rather than a formatting problem. The states underneath say where the
     * open ones are stuck.
     */
    const closedShare = s.total.count ? s.total.closed / s.total.count : 0;
    const status = railBlock(
      'Open against closed',
      `<p class="rail-figure">${qty(s.total.open)} <span class="rail-of">still open</span></p>
       <p class="rail-sub">${qty(s.total.closed)} closed — ${pct(closedShare, 1)} of everything
       raised. ${qty(s.total.notOurs)} were decided not to be ours, which is a decision rather
       than a closure.</p>
       <div class="ccr-states">
         ${s.byState
           .map(
             (b) => `<div class="ccr-state-row">
               <span class="ccr-state-name">${esc(STATE_LABEL[b.state] ?? b.state)}</span>
               ${bar(s.total.count ? (b.count / s.total.count) * 100 : 0, b.state === 'done' ? 's2' : 's1')}
               <b>${qty(b.count)}</b>
             </div>`,
           )
           .join('')}
       </div>`,
    );

    const open = s.all.filter((c) => !c.closed);
    const ages = open.map(ageOf).sort((a, b) => a - b);
    const median = ages.length ? ages[Math.floor(ages.length / 2)] : 0;
    const stale = open.filter((c) => ageOf(c) >= 90).length;

    const ageing = ages.length
      ? railBlock(
          'How long they sit',
          `<p class="rail-figure">${qty(median)} <span class="rail-of">days, median</span></p>
           <p class="rail-sub">for a complaint still open. ${qty(stale)} have been open ninety
           days or more; the oldest is ${qty(ages.at(-1) ?? 0)} days.</p>`,
          'Measured from the day it was raised to today.',
        )
      : '';

    const top = s.rows[0];
    const concentration = top
      ? railBlock(
          'Concentration',
          `<p class="rail-figure">${pct(s.total.count ? top.count / s.total.count : 0)}</p>
           <p class="rail-sub">of complaints are <strong>${esc(top.name)}</strong> — ${qty(
             top.count,
           )} of ${qty(s.total.count)}.</p>`,
        )
      : '';

    el.rail.innerHTML = head + raised + status + ageing + concentration;
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

    const live = s.perMonth.filter((v) => v > 0);
    const average = live.length ? live.reduce((a, v) => a + v, 0) / live.length : 0;
    const marks = fyMarks(s.months);

    el.trend.innerHTML = barChart({
      categories: s.months.map(monthShort),
      width: Math.max(el.trend.clientWidth || 720, 480),
      height: 260,
      stacked: true,
      format: qty,
      dividers: marks.fyStarts,
      bandLabels: marks.fyLabels,
      reference: average ? { value: average, label: `average ${average.toFixed(1)}` } : undefined,
      series: s.byCompany.map((c, i) => ({
        name: c.name,
        color: `--series-${i + 1}`,
        values: c.series,
      })),
    });
    bindChartTooltips(el.trend);

    el.trendNote.textContent = `complaints raised · ${s.months.length} months · ${monthShort(
      s.months[0],
    )} — ${monthShort(s.months.at(-1)!)}`;
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
      `<span class="chip" aria-hidden="true">${qty(s.total.count)} CCRs</span>` +
      `<input class="chips-search" id="ccr-search" type="search" placeholder="Search complaints…" value="${esc(
        state.query,
      )}" />` +
      `<button class="chip" type="button" id="ccr-export">Export</button>`;
  }

  /* ------------------------------------------------------------ the sheet */

  const stateBadge = (c: Ccr) =>
    `<span class="ccr-badge ${c.closed ? 'closed' : c.state === 'nonjust' ? 'notours' : 'open'}">${esc(
      STATE_LABEL[c.state] ?? c.state,
    )}</span>`;

  /**
   * The complaints behind one row, opened underneath it.
   *
   * This is the point of the page: a count tells you there were forty
   * complaints about colour, and only the text tells you what went wrong.
   */
  function detailRow(row: Row, span: number): string {
    const query = state.query.trim().toLowerCase();
    const shown = query
      ? row.members.filter(
          (c) =>
            c.comment.toLowerCase().includes(query) ||
            c.name.toLowerCase().includes(query) ||
            c.customer.toLowerCase().includes(query),
        )
      : row.members;

    const body = shown
      .slice(0, 40)
      .map(
        (c) => `<li class="ccr-item">
          <div class="ccr-item-head">
            <span class="ccr-ref">${esc(c.name)}</span>
            <span class="ccr-when">${esc(day(c.raised))}</span>
            ${stateBadge(c)}
            <span class="ccr-who">${esc(c.customer)}${
              c.buyer && c.buyer !== '(no buyer)' ? ` · ${esc(c.buyer)}` : ''
            }</span>
            <span class="ccr-age">${qty(ageOf(c))}d</span>
          </div>
          <p class="ccr-comment">${esc(c.comment) || '<em>no comment recorded</em>'}</p>
          <div class="ccr-item-foot">
            ${c.oa ? `<span>${esc(c.oa)}</span>` : ''}
            ${c.invoice ? `<span>${esc(c.invoice)}</span>` : ''}
            ${c.department !== '(unassigned)' ? `<span>${esc(c.department)}</span>` : ''}
            ${c.type !== '(no type)' ? `<span>${esc(c.type)}</span>` : ''}
            ${c.raisedBy ? `<span>raised by ${esc(c.raisedBy)}</span>` : ''}
          </div>
        </li>`,
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
            <div class="oa-stat"><span class="oa-stat-label">Complaints</span><b class="oa-stat-figure">${qty(
              row.count,
            )}</b></div>
            <div class="oa-stat"><span class="oa-stat-label">Open</span><b class="oa-stat-figure">${qty(
              row.open,
            )}</b></div>
            <div class="oa-stat"><span class="oa-stat-label">Closed</span><b class="oa-stat-figure">${qty(
              row.closed,
            )}</b></div>
            <div class="oa-stat"><span class="oa-stat-label">Not ours</span><b class="oa-stat-figure">${qty(
              row.notOurs,
            )}</b><span class="oa-stat-note">decided non-justified</span></div>
            <div class="oa-stat"><span class="oa-stat-label">Average age</span><b class="oa-stat-figure">${qty(
              row.age,
            )}</b><span class="oa-stat-note">days</span></div>
          </div>
        </div>
        <ol class="ccr-list">${body}</ol>
        ${
          shown.length > 40
            ? `<p class="hint">Showing 40 of ${qty(shown.length)} — narrow it with the search.</p>`
            : shown.length
              ? ''
              : `<p class="oa-panel-empty">Nothing here matches “${esc(state.query)}”.</p>`
        }
      </div>
    </td></tr>`;
  }

  function renderGrid(s: Shaped) {
    const query = state.query.trim().toLowerCase();
    // A search looks inside the complaints, so a row survives if any of its
    // own complaints match — not only if its name does.
    const rows = query
      ? s.rows.filter(
          (r) =>
            r.name.toLowerCase().includes(query) ||
            r.members.some(
              (c) =>
                c.comment.toLowerCase().includes(query) ||
                c.name.toLowerCase().includes(query) ||
                c.customer.toLowerCase().includes(query),
            ),
        )
      : s.rows;
    const COLUMNS = 8;

    if (!rows.length) {
      el.grid.innerHTML = `<div class="state"><h2>${
        query ? `Nothing matches “${esc(state.query)}”` : 'No complaints here'
      }</h2><p>${
        query ? 'Clear the search to see every row.' : 'Nothing was raised for this company and period.'
      }</p></div>`;
      return;
    }

    const widest = Math.max(...rows.map((r) => r.count), 0);

    const body = rows
      .map((row) => {
        const open = state.open === row.name;
        const closedShare = row.count ? row.closed / row.count : 0;
        return (
          `<tr class="day-row can-open${open ? ' open' : ''}" data-row="${esc(
            row.name,
          )}" tabindex="0" role="button" aria-expanded="${open}">
            <td class="sticky-col"><span class="disclose" aria-hidden="true">${
              open ? '▾' : '▸'
            }</span>${esc(row.name)}</td>
            <td class="num tinted">${qty(row.count)}</td>
            <td class="bar-cell"><span class="mini-bar"><i style="width:${(
              widest ? (row.count / widest) * 100 : 0
            ).toFixed(1)}%"></i></span></td>
            <td class="num">${qty(row.open)}</td>
            <td class="num">${qty(row.closed)}</td>
            <td class="num ${closedShare < 0.05 ? 'behind' : ''}">${pct(closedShare, 1)}</td>
            <td class="num muted">${qty(row.notOurs)}</td>
            <td class="num">${qty(row.age)}</td>
            <td class="spark-cell">${sparkline(row.series)}</td>
          </tr>` + (open ? detailRow(row, COLUMNS + 1) : '')
        );
      })
      .join('');

    const total = `<tr class="grand-row">
      <td class="sticky-col">All ${qty(s.rows.length)} ${esc(dimension().noun)} rows</td>
      <td class="num">${qty(s.total.count)}</td>
      <td class="bar-cell"></td>
      <td class="num">${qty(s.total.open)}</td>
      <td class="num">${qty(s.total.closed)}</td>
      <td class="num">${pct(s.total.count ? s.total.closed / s.total.count : 0, 1)}</td>
      <td class="num muted">${qty(s.total.notOurs)}</td>
      <td class="num"></td>
      <td class="spark-cell"></td>
    </tr>`;

    el.grid.innerHTML = `<table class="grid day-grid oa-sheet">
      <thead>
        <tr class="sub-row">
          <th class="sticky-col">${esc(dimension().label)}</th>
          <th class="num">CCRs</th>
          <th class="bar-cell"></th>
          <th class="num">Open</th>
          <th class="num">Closed</th>
          <th class="num">Closed %</th>
          <th class="num">Not ours</th>
          <th class="num">Avg age</th>
          <th class="spark-cell">Trend</th>
        </tr>
      </thead>
      <tbody>${body}${query ? '' : total}</tbody>
    </table>`;

    el.note.textContent =
      'A complaint counts as closed only at Done, the one state Odoo sets a closing date on. ' +
      '"Not ours" is Non justified — a decision that the fault was not the plant’s, which leaves ' +
      'the case open rather than closing it. Age runs from the day it was raised to today, or to ' +
      'the closing date where there is one.';
  }

  /* ---------------------------------------------------------------- render */

  function renderControls(r: CcrReport) {
    el.companySeg.innerHTML =
      `<button class="seg" type="button" role="tab" data-company="all" aria-selected="${
        state.company === 'all'
      }">All companies</button>` +
      r.companies
        .map(
          (c) =>
            `<button class="seg" type="button" role="tab" data-company="${c.id}" aria-selected="${
              state.company === String(c.id)
            }">${esc(c.name)}</button>`,
        )
        .join('');

    const fys = [...new Set(r.months.map(fyOf))].sort((a, b) => b - a);
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

    const month = pickedMonth(r);
    const months = [...periodMonths(r)].reverse();
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
    renderRail(s);
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
    if (target.id === 'ccr-export') {
      exportCsv();
      return;
    }
    const dim = target.closest<HTMLElement>('[data-dim]');
    if (dim && dim.dataset.dim !== state.dimension) {
      state.dimension = dim.dataset.dim as DimKey;
      state.open = null;
      render();
    }
  });

  let searchTimer: number | undefined;
  el.chips.addEventListener('input', (event) => {
    const input = event.target as HTMLInputElement;
    if (input.id !== 'ccr-search') return;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      state.query = input.value;
      if (state.report) renderGrid(shape(state.report));
    }, 160);
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
    if (state.month && state.report && !periodMonths(state.report).includes(state.month)) {
      state.month = '';
    }
    render();
  });

  el.monthPick.addEventListener('change', () => {
    state.month = el.monthPick.value;
    render();
  });

  /** Every complaint in the window, comment and all. */
  function exportCsv() {
    const r = state.report;
    if (!r) return;
    const s = shape(r);
    const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

    const lines = [
      [
        'CCR',
        'Raised',
        'Company',
        'Status',
        'Closed',
        'Classification',
        'Type',
        'Department',
        'Team',
        'Customer',
        'Buyer',
        'OA',
        'Invoice',
        'Raised by',
        'Age days',
        'Comment',
      ].join(','),
      ...s.all.map((c) =>
        [
          cell(c.name),
          c.raised,
          cell(c.companyName),
          cell(STATE_LABEL[c.state] ?? c.state),
          c.closed ? 'Yes' : 'No',
          cell(c.classification),
          cell(c.type),
          cell(c.department),
          cell(c.team),
          cell(c.customer),
          cell(c.buyer),
          cell(c.oa),
          cell(c.invoice),
          cell(c.raisedBy),
          ageOf(c),
          cell(c.comment),
        ].join(','),
      ),
    ];

    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `CCR ${periodLabel(s)}.csv`;
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
      '<h2>Not connected</h2><p>Set the Odoo credentials in .env to read the complaints.</p>';
  } else {
    void load();
  }
}
