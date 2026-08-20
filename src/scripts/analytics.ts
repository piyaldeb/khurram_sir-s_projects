/**
 * Production ABC: fiscal-year Pareto analysis of packing production value,
 * by product, buyer, customer and company.
 */
import { barChart, bindChartTooltips } from '../lib/charts';

interface AbcRow {
  name: string;
  value: number;
  lines: number;
  share: number;
  cumShare: number;
  cls: 'A' | 'B' | 'C';
}

interface AbcDimension {
  rows: AbcRow[];
  counts: { A: number; B: number; C: number };
  total: number;
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
}

const root = document.querySelector<HTMLElement>('.abc');

if (root) {
  const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
  const el = {
    status: $<HTMLElement>('#abc-status'),
    body: $<HTMLElement>('#abc-body'),
    kpis: $<HTMLElement>('#abc-kpis'),
    tables: $<HTMLElement>('#abc-tables'),
    chartMonths: $<HTMLElement>('#chart-months'),
    chartItem: $<HTMLElement>('#chart-item'),
    chartBuyer: $<HTMLElement>('#chart-buyer'),
    chartCustomer: $<HTMLElement>('#chart-customer'),
    companySeg: $<HTMLElement>('#company-seg'),
  };

  const state = {
    fy: Number(root.dataset.fy),
    company: 'all' as string,
    result: null as AnalyticsResult | null,
  };

  const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const usd = (v: number) => `$${nf.format(Math.round(v))}`;
  const qty = (v: number) => nf.format(Math.round(v));
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const esc = (s: string | number) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

  const monthShort = (iso: string) =>
    new Date(`${iso}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });

  const chartWidth = (host: HTMLElement) => Math.max(host.clientWidth || 620, 320);

  const tile = (label: string, value: string, sub: string) =>
    `<div class="kpi"><div class="label">${esc(label)}</div><div class="value">${esc(
      value,
    )}</div><div class="sub">${esc(sub)}</div></div>`;

  let inFlight: AbortController | null = null;

  async function load() {
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;

    el.body.hidden = true;
    el.status.hidden = false;

    try {
      const res = await fetch(`/api/analytics?fy=${state.fy}&company=${state.company}`, {
        signal: controller.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      state.result = data as AnalyticsResult;
      render();
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      el.status.innerHTML = `<h2>Could not build the analysis</h2><p style="font-family:var(--mono);font-size:12.5px">${esc(
        (err as Error).message,
      )}</p>`;
      el.status.classList.add('error');
    }
  }

  function render() {
    const r = state.result;
    if (!r) return;

    // Company toggle reflects what the data actually contains.
    el.companySeg.innerHTML =
      `<button class="seg" type="button" role="tab" data-company="all" aria-selected="${state.company === 'all'}">Both companies</button>` +
      r.companies
        .map(
          (c) =>
            `<button class="seg" type="button" role="tab" data-company="${c.id}" aria-selected="${state.company === String(c.id)}">${esc(c.name)}</button>`,
        )
        .join('');

    el.kpis.innerHTML = [
      tile('Production value', usd(r.totals.value), `${qty(r.totals.lines)} packed lines`),
      ...r.companies.map((c) =>
        tile(c.name, usd(c.value), `${pct(r.totals.value ? c.value / (r.companies.reduce((a, x) => a + x.value, 0) || 1) : 0)} of both companies`),
      ),
      tile('A-class products', qty(r.byItem.counts.A), `of ${qty(r.byItem.rows.length)} carry 80% of value`),
      tile('A-class buyers', qty(r.byBuyer.counts.A), `of ${qty(r.byBuyer.rows.length)}`),
      tile('A-class customers', qty(r.byCustomer.counts.A), `of ${qty(r.byCustomer.rows.length)}`),
    ].join('');

    // Monthly stacked by company.
    const companySeries = r.companies.map((c, i) => ({
      name: c.name,
      color: i === 0 ? '--series-1' : '--series-2',
      values: r.byMonth.map((m) => m.byCompany[c.id] ?? 0),
    }));
    el.chartMonths.innerHTML = barChart({
      categories: r.months.map(monthShort),
      width: chartWidth(el.chartMonths),
      height: 250,
      format: usd,
      unit: '$',
      stacked: true,
      series: companySeries.length ? companySeries : [{ name: 'Value', color: '--series-1', values: r.byMonth.map((m) => m.total) }],
    });

    renderDimensionChart(el.chartItem, 'hint-item', r.byItem);
    renderDimensionChart(el.chartBuyer, 'hint-buyer', r.byBuyer);
    renderDimensionChart(el.chartCustomer, 'hint-customer', r.byCustomer);
    [el.chartMonths, el.chartItem, el.chartBuyer, el.chartCustomer].forEach(bindChartTooltips);

    el.tables.innerHTML = [
      dimensionTable('Products', r.byItem),
      dimensionTable('Buyers', r.byBuyer),
      dimensionTable('Customers', r.byCustomer),
    ].join('');

    // Expand-to-all handlers.
    el.tables.querySelectorAll<HTMLElement>('[data-expand]').forEach((btn) =>
      btn.addEventListener('click', () => {
        btn.closest('section')!.querySelectorAll<HTMLElement>('tr[hidden]').forEach((tr) => (tr.hidden = false));
        btn.remove();
      }),
    );

    el.status.hidden = true;
    el.status.classList.remove('error');
    el.body.hidden = false;

    if (r.failed.length) {
      el.tables.insertAdjacentHTML(
        'beforeend',
        `<p class="hint" title="${esc(r.failed.map((f) => `${f.month} ${f.company}: ${f.error}`).join(' | '))}">
          ${r.failed.length} month-fetches failed — those figures are missing, not zero. Reload to retry.
        </p>`,
      );
    }
  }

  function renderDimensionChart(host: HTMLElement, hintId: string, dim: AbcDimension) {
    const top = dim.rows.slice(0, 10);
    document.getElementById(hintId)!.textContent = top.length
      ? `top ${top.length} of ${dim.rows.length} · A ${dim.counts.A} · B ${dim.counts.B} · C ${dim.counts.C}`
      : 'no data';

    host.innerHTML = barChart({
      categories: top.map((r) => (r.name.length > 13 ? `${r.name.slice(0, 12)}…` : r.name)),
      width: chartWidth(host),
      height: 250,
      format: usd,
      unit: '$',
      labelEvery: 1,
      series: [{ name: 'Value', color: '--series-1', values: top.map((r) => r.value) }],
    });
  }

  function dimensionTable(title: string, dim: AbcDimension): string {
    const LIMIT = 15;
    const rows = dim.rows
      .map(
        (r, i) => `<tr${i >= LIMIT ? ' hidden' : ''}>
          <td>${esc(r.name)}</td>
          <td class="num"><span class="abc-badge abc-${r.cls}">${r.cls}</span></td>
          <td class="num">${usd(r.value)}</td>
          <td class="num">${pct(r.share)}</td>
          <td class="num">${pct(r.cumShare)}</td>
          <td class="num">${qty(r.lines)}</td>
        </tr>`,
      )
      .join('');

    const more = dim.rows.length > LIMIT
      ? `<div class="row-cap">Showing the top ${LIMIT} of ${dim.rows.length}. <button class="chip" type="button" data-expand>Show all</button></div>`
      : '';

    return `<section class="panel card" style="margin-bottom:16px">
      <div class="card-head">
        <h2>${esc(title)} — ABC</h2>
        <span class="hint">A ${dim.counts.A} · B ${dim.counts.B} · C ${dim.counts.C} · total ${usd(dim.total)}</span>
      </div>
      <div class="table-scroll" style="max-height:none">
        <table class="grid day-table">
          <thead><tr><th>${esc(title.slice(0, -1))}</th><th class="num">Class</th><th class="num">Value</th><th class="num">Share</th><th class="num">Cum.</th><th class="num">Lines</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${more}
    </section>`;
  }

  /* --------------------------------------------------------------- events */

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

  if (root.dataset.odoo !== '1') {
    el.status.innerHTML =
      '<h2>Not connected</h2><p>Set the Odoo credentials in .env to build the analysis.</p>';
  } else {
    void load();
  }
}
