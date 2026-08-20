/**
 * Production ABC in the 3a shape: a Pareto rail carrying the judgment, one
 * Pareto chart, and a grid holding every ranked item grouped by class with its
 * own subtotal — the same rail-plus-full-sheet pattern as the production and
 * budget pages.
 *
 * Items / buyers / customers are the same table on different fields, switched
 * from the chips row.
 */
import { paretoChart, bindChartTooltips, barChartH } from '../lib/charts';
import { skeleton } from '../lib/skeleton';

interface AbcRow {
  name: string;
  value: number;
  lines: number;
  share: number;
  cumShare: number;
  cls: 'A' | 'B' | 'C';
  rank: number;
  companies: string[];
}

interface ClassBand {
  cls: 'A' | 'B' | 'C';
  count: number;
  value: number;
  share: number;
  lines: number;
}

interface AbcDimension {
  rows: AbcRow[];
  counts: { A: number; B: number; C: number };
  bands: ClassBand[];
  total: number;
  lines: number;
}

interface AnalyticsResult {
  fy: number;
  months: string[];
  companies: { id: number; name: string; value: number; lines: number }[];
  totals: { value: number; lines: number };
  byItem: AbcDimension;
  byBuyer: AbcDimension;
  byCustomer: AbcDimension;
  byMonth: { month: string; byCompany: Record<number, number>; total: number }[];
  failed: { month: string; company: string; error: string }[];
  pending: { month: string; company: string }[];
  ready: boolean;
}

type DimKey = 'byItem' | 'byBuyer' | 'byCustomer';

const root = document.querySelector<HTMLElement>('.abc');

if (root) {
  const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
  const el = {
    status: $<HTMLElement>('#abc-status'),
    body: $<HTMLElement>('#abc-body'),
    rail: $<HTMLElement>('#abc-rail'),
    chips: $<HTMLElement>('#abc-chips'),
    grid: $<HTMLElement>('#abc-grid'),
    note: $<HTMLElement>('#abc-note'),
    pareto: $<HTMLElement>('#chart-pareto'),
    paretoNote: $<HTMLElement>('#pareto-note'),
    companySeg: $<HTMLElement>('#company-seg'),
  };

  const state = {
    fy: Number(root.dataset.fy),
    company: 'all' as string,
    dim: 'byItem' as DimKey,
    query: '',
    result: null as AnalyticsResult | null,
  };

  const DIM_LABEL: Record<DimKey, [string, string]> = {
    byItem: ['Items', 'item'],
    byBuyer: ['Buyers', 'buyer'],
    byCustomer: ['Customers', 'customer'],
  };

  const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const usd = (v: number) => `$${nf.format(Math.round(v))}`;
  const qty = (v: number) => nf.format(Math.round(v));
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const esc = (s: string | number) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

  const fyLabel = (fy: number) => `FY ${String(fy).slice(2)}-${String(fy + 1).slice(2)}`;
  const monthShort = (iso: string) =>
    new Date(`${iso}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });

  let inFlight: AbortController | null = null;

  function showSkeleton() {
    el.status.hidden = true;
    el.body.hidden = false;
    el.rail.innerHTML = skeleton.rail();
    el.chips.innerHTML = skeleton.chips(4);
    el.pareto.innerHTML = skeleton.chart();
    el.grid.innerHTML = skeleton.table(9, 8);
    el.note.textContent = '';
  }

  async function load(fresh = true) {
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;

    if (fresh) showSkeleton();

    try {
      const res = await fetch(`/api/analytics?fy=${state.fy}&company=${state.company}`, {
        signal: controller.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);

      const result = data as AnalyticsResult;
      const wantedFy = state.fy;
      state.result = result;
      render();

      if (!result.ready && wantedFy === state.fy) {
        // The server fills a few months per request; keep asking while partial.
        void load(false);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      el.body.hidden = true;
      el.status.hidden = false;
      el.status.innerHTML = `<h2>Could not build the analysis</h2><p style="font-family:var(--mono);font-size:12.5px">${esc(
        (err as Error).message,
      )}</p>`;
      el.status.classList.add('error');
    }
  }

  /* ---------------------------------------------------------------- rail */

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

  function renderRail(r: AnalyticsResult) {
    const dim = r[state.dim];
    const [dimPlural, dimWord] = DIM_LABEL[state.dim];
    const bandOf = (cls: 'A' | 'B' | 'C') => dim.bands.find((b) => b.cls === cls)!;
    const a = bandOf('A');

    const head = `<div class="rail-head">
      <p class="eyebrow">${esc(fyLabel(r.fy))}${r.ready ? '' : ' · filling'}</p>
      <h2 class="rail-title">What actually earns</h2>
      <p class="rail-sub">Packing value by ${esc(dimWord)}, ranked. Class A is everything inside
      the first 80% of value, B the next 15%, C the tail.</p>
    </div>`;

    const total = r.companies.reduce((acc, x) => acc + x.value, 0);
    const companySplit = r.companies
      .map(
        (c, i) => `<div class="rail-split">
          <div class="rail-split-head">
            <span><i class="swatch s${i + 1}"></i>${esc(c.name)}</span>
            <b>${usd(c.value)} <span class="rail-of">${pct(total ? c.value / total : 0)}</span></b>
          </div>
          ${bar(total ? (c.value / total) * 100 : 0, `s${i + 1}`)}
        </div>`,
      )
      .join('');

    const totalBlock = railBlock(
      'Value, year to date',
      `<p class="rail-figure">${usd(dim.total)}</p>
       <p class="rail-sub">${qty(dim.lines)} lines</p>
       ${companySplit}`,
    );

    const cut = railBlock(
      'The 80% cut',
      `<p class="rail-figure">${qty(a.count)} ${esc(dimPlural.toLowerCase())} <span class="rail-of">of ${qty(
        dim.rows.length,
      )}</span></p>
       <p class="rail-sub">carry ${usd(a.value)} — ${pct(a.share)} of everything</p>
       <div class="rail-compare bands">
         ${dim.bands
           .map(
             (b) =>
               `<span>${b.cls}</span>${bar(b.share * 100, `band-${b.cls}`)}<b>${pct(
                 b.share,
               )} <span class="rail-of">${qty(b.count)}</span></b>`,
           )
           .join('')}
       </div>`,
    );

    const top = dim.rows[0];
    const concentration = top
      ? railBlock(
          'Concentration',
          `<p class="rail-figure">${pct(top.share)}</p>
           <p class="rail-sub">of the year sits on <strong>${esc(top.name)}</strong> alone.
           The ${qty(bandOf('C').count)} class-C ${esc(dimPlural.toLowerCase())} together are ${pct(
             bandOf('C').share,
           )}.</p>`,
        )
      : '';

    const reads = r.months.length * Math.max(r.companies.length, 1);
    const monthBars = `<section class="rail-block">
      <h2>Month by month</h2>
      <div class="rail-months" id="rail-months"></div>
      ${
        r.pending.length
          ? `<p class="rail-note">${qty(reads - r.pending.length)} of ${qty(
              reads,
            )} month-company reads done — these figures are partial.</p>`
          : ''
      }
    </section>`;

    el.rail.innerHTML = head + totalBlock + cut + concentration + monthBars;

    const host = document.getElementById('rail-months');
    if (host) {
      const active = r.byMonth.filter((m) => m.total > 0);
      host.innerHTML = active.length
        ? barChartH({
            categories: active.map((m) => monthShort(m.month)),
            width: host.clientWidth || 290,
            format: usd,
            unit: '$',
            series: [{ name: 'Value', color: '--series-1', values: active.map((m) => m.total) }],
          })
        : '<p class="rail-sub">No production yet.</p>';
    }
  }

  /* ---------------------------------------------------------------- chips */

  function renderChips(r: AnalyticsResult) {
    el.chips.innerHTML =
      (Object.keys(DIM_LABEL) as DimKey[])
        .map(
          (key) =>
            `<button class="chip toggle" type="button" data-dim="${key}" aria-pressed="${
              state.dim === key
            }">${DIM_LABEL[key][0]} · ${qty(r[key].rows.length)}</button>`,
        )
        .join('') +
      `<input class="chips-search" id="abc-search" type="search" placeholder="Search ${DIM_LABEL[
        state.dim
      ][0].toLowerCase()}…" value="${esc(state.query)}" />
       <button class="chip" type="button" id="abc-export">Export</button>`;
  }

  /* ---------------------------------------------------------------- chart */

  function renderPareto(r: AnalyticsResult) {
    const dim = r[state.dim];
    // Every A and B item individually; the C tail past this is in the table.
    const MAX_BARS = 60;
    const items = dim.rows.slice(0, MAX_BARS).map((row) => ({
      name: row.name,
      share: row.share,
      cumShare: row.cumShare,
      cls: row.cls,
      detail: `${usd(row.value)} · ${qty(row.lines)} lines`,
    }));

    el.pareto.innerHTML = items.length
      ? paretoChart({
          // Below ~26px a bar cannot carry a readable name, so the plot keeps
          // its own width and the host scrolls sideways instead of crushing.
          items,
          width: Math.max(el.pareto.clientWidth || 720, items.length * 26 + 96),
          height: 250,
        })
      : '<div class="state"><p>No data yet.</p></div>';
    bindChartTooltips(el.pareto);

    el.paretoNote.textContent =
      dim.rows.length > MAX_BARS
        ? `first ${MAX_BARS} of ${dim.rows.length} ranked — the rest are class C`
        : `all ${dim.rows.length} ranked`;
  }

  /* ----------------------------------------------------------------- grid */

  const CLASS_HEADING: Record<'A' | 'B' | 'C', string> = {
    A: 'Class A — the first 80% of value',
    B: 'Class B — the next 15%',
    C: 'Class C — the tail',
  };

  function renderGrid(r: AnalyticsResult) {
    const dim = r[state.dim];
    const [dimPlural, dimWord] = DIM_LABEL[state.dim];
    const query = state.query.trim().toLowerCase();
    const rows = query ? dim.rows.filter((row) => row.name.toLowerCase().includes(query)) : dim.rows;

    const head = `<thead>
      <tr class="group-row">
        <th class="sticky-col" colspan="3">${esc(dimPlural)}</th>
        <th colspan="2" class="group-head">Packing value</th>
        <th colspan="2" class="group-head">Cumulative</th>
        <th class="group-head">Lines</th>
      </tr>
      <tr class="sub-row">
        <th class="sticky-col">#</th>
        <th>Name</th>
        <th>Company</th>
        <th class="num">Value</th>
        <th class="num">Share</th>
        <th class="num">Share</th>
        <th class="num">To 100%</th>
        <th class="num">Count</th>
      </tr>
    </thead>`;

    const section = (cls: 'A' | 'B' | 'C') => {
      const band = dim.bands.find((b) => b.cls === cls)!;
      const bandRows = rows.filter((row) => row.cls === cls);
      if (!bandRows.length) return '';

      const heading = `<tr class="company-row"><td class="sticky-col" colspan="8">${esc(
        CLASS_HEADING[cls],
      )}</td></tr>`;

      const body = bandRows
        .map(
          (row) => `<tr>
            <td class="sticky-col num">${String(row.rank).padStart(2, '0')}</td>
            <td><span class="abc-badge abc-${row.cls}">${row.cls}</span> ${esc(row.name)}</td>
            <td class="co">${esc(row.companies.join(' + '))}</td>
            <td class="num">${usd(row.value)}</td>
            <td class="num">${pct(row.share)}</td>
            <td class="num">${pct(row.cumShare)}</td>
            <td class="num muted">${pct(1 - row.cumShare)}</td>
            <td class="num">${qty(row.lines)}</td>
          </tr>`,
        )
        .join('');

      // The subtotal is the whole band, even while a search narrows the rows.
      const subtotal = `<tr class="total-row">
        <td class="sticky-col" colspan="3">Class ${cls} <span class="rail-sub">· ${qty(
          band.count,
        )} ${esc(dimPlural.toLowerCase())}${query ? ', whole year' : ''}</span></td>
        <td class="num">${usd(band.value)}</td>
        <td class="num">${pct(band.share)}</td>
        <td class="num" colspan="2"></td>
        <td class="num">${qty(band.lines)}</td>
      </tr>`;

      return heading + body + subtotal;
    };

    const grand = `<tr class="grand-row">
      <td class="sticky-col" colspan="3">All ${qty(dim.rows.length)} ${esc(
        dimPlural.toLowerCase(),
      )} <span class="rail-sub">· ${esc(fyLabel(r.fy))} to date</span></td>
      <td class="num">${usd(dim.total)}</td>
      <td class="num">100.0%</td>
      <td class="num" colspan="2"><span class="rail-sub">${qty(dim.counts.A)} A · ${qty(
        dim.counts.B,
      )} B · ${qty(dim.counts.C)} C</span></td>
      <td class="num">${qty(dim.lines)}</td>
    </tr>`;

    el.grid.innerHTML = rows.length
      ? `<table class="grid day-grid abc-grid">${head}<tbody>${section('A')}${section('B')}${section(
          'C',
        )}${grand}</tbody></table>`
      : `<div class="state"><h2>No ${esc(dimWord)} matches “${esc(
          state.query,
        )}”</h2><p>Clear the search to see every ${esc(dimWord)}.</p></div>`;

    el.note.textContent = r.failed.length
      ? `${r.failed.length} month-fetches failed — those figures are missing, not zero. Reload to retry.`
      : '';
  }

  function render() {
    const r = state.result;
    if (!r) return;

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

    renderRail(r);
    renderChips(r);
    renderPareto(r);
    renderGrid(r);

    el.status.hidden = true;
    el.body.hidden = false;
  }

  /* --------------------------------------------------------------- events */

  el.chips.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.id === 'abc-export') {
      exportCsv();
      return;
    }
    const dimBtn = target.closest<HTMLElement>('[data-dim]');
    if (dimBtn) {
      state.dim = dimBtn.dataset.dim as DimKey;
      state.query = '';
      render();
    }
  });

  let searchTimer: number | undefined;
  el.chips.addEventListener('input', (event) => {
    const input = event.target as HTMLInputElement;
    if (input.id !== 'abc-search') return;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      state.query = input.value;
      if (state.result) renderGrid(state.result); // grid only — the caret stays put
    }, 140);
  });

  function exportCsv() {
    const r = state.result;
    if (!r) return;
    const dim = r[state.dim];
    const lines = [
      'Rank,Class,Name,Company,Value,Share,Cumulative,Lines',
      ...dim.rows.map((row) =>
        [
          row.rank,
          row.cls,
          /[",\r\n]/.test(row.name) ? `"${row.name.replace(/"/g, '""')}"` : row.name,
          row.companies.join(' + '),
          Math.round(row.value),
          (row.share * 100).toFixed(2),
          (row.cumShare * 100).toFixed(2),
          row.lines,
        ].join(','),
      ),
    ];
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Production ABC ${DIM_LABEL[state.dim][0]} FY${r.fy}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  document.querySelectorAll<HTMLElement>('[data-fy-pick]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.fy = Number(btn.dataset.fyPick);
      document
        .querySelectorAll<HTMLElement>('[data-fy-pick]')
        .forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
      void load();
    }),
  );

  el.companySeg.addEventListener('click', (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLElement>('[data-company]');
    if (!btn) return;
    state.company = btn.dataset.company!;
    el.companySeg
      .querySelectorAll<HTMLElement>('[data-company]')
      .forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
    void load();
  });

  // Charts are measured at render time, so a rotation or resize re-measures.
  let resizeTimer: number | undefined;
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (!state.result) return;
      renderRail(state.result);
      renderPareto(state.result);
    }, 180);
  });

  if (root.dataset.odoo !== '1') {
    el.status.innerHTML =
      '<h2>Not connected</h2><p>Set the Odoo credentials in .env to build the analysis.</p>';
  } else {
    void load();
  }
}
