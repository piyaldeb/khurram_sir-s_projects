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
import { barChart, barChartH, bindChartTooltips, lineChart } from '../lib/charts';
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
  /** Value per month, aligned to the visible month list. */
  series: number[];
  /** Same, split by company id — the drill-down chart. */
  byCompany: Map<number, number[]>;
  companies: string[];
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
  };

  const state = {
    company: 'all' as string,
    period: 'all' as string,
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
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
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

  /** The months on screen, oldest first, after the period filter. */
  function visibleMonths(h: OaHistory): string[] {
    const all = h.months.map((m) => m.month).sort();
    if (state.period === 'all') return all;
    if (state.period === 'r12') return all.slice(-12);
    const fy = Number(state.period);
    return all.filter((m) => fyOf(m) === fy);
  }

  /** The company slices that count, for one month, under the current filter. */
  function slices(month: MonthOa): CompanyMonth[] {
    const id = companyId();
    return id === null ? month.companies : month.companies.filter((c) => c.id === id);
  }

  interface Shaped {
    months: string[];
    rows: ProductRow[];
    total: { value: number; qty: number; lines: number; orders: number };
    byCompany: { id: number; name: string; value: number; orders: number; series: number[] }[];
    perMonth: number[];
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
              series: months.map(() => 0),
              byCompany: new Map(),
              companies: [],
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
    shaped.sort((a, b) =>
      state.measure === 'value' ? b.value - a.value : b.qty - a.qty,
    );

    return {
      months,
      rows: shaped,
      total,
      byCompany: [...companies.values()].sort((a, b) => a.id - b.id),
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

  function periodLabel(s: Shaped): string {
    if (!s.months.length) return 'no months';
    if (state.period === 'all') return `${monthShort(s.months[0])} — ${monthShort(s.months.at(-1)!)}`;
    if (state.period === 'r12') return 'last 12 months';
    return fyLabel(Number(state.period));
  }

  function renderRail(h: OaHistory, s: Shaped) {
    const head = `<div class="rail-head">
      <p class="eyebrow">${esc(periodLabel(s))}${h.ready ? '' : ' · filling'}</p>
      <h2 class="rail-title">What has been let go to the floor</h2>
      <p class="rail-sub">Bulk orders whose release status is <em>released</em>, valued ex tax.
      This is the work the plant has been told to make, not what it has made.</p>
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
          <p class="rail-note">${qty(c.orders)} OA${c.orders === 1 ? '' : 's'}</p>
        </div>`,
      )
      .join('');

    const released = railBlock(
      'Released',
      `<p class="rail-figure">${usd(s.total.value)}</p>
       <p class="rail-sub">${qty(s.total.orders)} OAs · ${qty(s.total.lines)} lines · ${qty(
         s.rows.length,
       )} products</p>
       ${split}`,
    );

    const active = s.perMonth.filter((v) => v > 0);
    const run = active.length
      ? railBlock(
          'Monthly run rate',
          `<p class="rail-figure">${fmt(active.reduce((a, v) => a + v, 0) / active.length)}</p>
           <p class="rail-sub">average over ${qty(active.length)} month${
             active.length === 1 ? '' : 's'
           }. Best was ${fmt(Math.max(...active))}, thinnest ${fmt(Math.min(...active))}.</p>`,
        )
      : '';

    const top = s.rows[0];
    const topFive = s.rows.slice(0, 5).reduce((a, r) => a + r.share, 0);
    const concentration = top
      ? railBlock(
          'Concentration',
          `<p class="rail-figure">${pct(top.share)}</p>
           <p class="rail-sub">of ${state.measure === 'value' ? 'the value' : 'the quantity'} sits on
           <strong>${esc(top.name)}</strong> alone. The top five carry ${pct(topFive)} of
           ${qty(s.rows.length)} products.</p>`,
        )
      : '';

    const monthBars = `<section class="rail-block">
      <h2>Month by month</h2>
      <div class="rail-months" id="oa-rail-months"></div>
      ${
        h.pending.length
          ? `<p class="rail-note">${qty(h.months.length)} of ${qty(
              h.months.length + h.pending.length,
            )} months read — these figures are still partial.</p>`
          : ''
      }
    </section>`;

    el.rail.innerHTML = head + released + run + concentration + monthBars;

    const host = document.getElementById('oa-rail-months');
    if (host) {
      // A rail is narrow: a bar per month past a couple of years is a smear, so
      // it shows the recent run and the chart above carries the whole history.
      const shown = s.months.slice(-14);
      const offset = s.months.length - shown.length;
      host.innerHTML = shown.length
        ? barChartH({
            categories: shown.map(monthShort),
            width: host.clientWidth || 290,
            format: fmt,
            unit: state.measure === 'value' ? '$' : '',
            series: [
              {
                name: measureLabel(),
                color: '--series-1',
                values: shown.map((_, i) => s.perMonth[offset + i]),
              },
            ],
          })
        : '<p class="rail-sub">Nothing released yet.</p>';
    }
  }

  /* ----------------------------------------------------------------- trend */

  function renderTrend(s: Shaped) {
    if (!s.months.length) {
      el.trend.innerHTML = '<div class="state"><p>No months to show.</p></div>';
      el.trendNote.textContent = '';
      return;
    }

    const width = Math.max(el.trend.clientWidth || 720, 480);
    const categories = s.months.map(monthShort);

    // One company is one series and reads as a line; two are a split, and a
    // stack says both the total and the mix in the same bar.
    el.trend.innerHTML =
      s.byCompany.length > 1
        ? barChart({
            categories,
            width,
            height: 270,
            stacked: true,
            format: usd,
            unit: '$',
            series: s.byCompany.map((c, i) => ({
              name: c.name,
              color: `--series-${i + 1}`,
              values: c.series,
            })),
          })
        : lineChart({
            categories,
            width,
            height: 270,
            format: usd,
            unit: '$',
            series: [
              {
                name: s.byCompany[0]?.name ?? 'Released',
                color: '--series-1',
                values: s.byCompany[0]?.series ?? s.months.map(() => 0),
              },
            ],
          });
    bindChartTooltips(el.trend);

    el.trendNote.textContent = `released value by order date · ${categories.length} months`;
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
      `<span class="chip" aria-hidden="true">${qty(s.rows.length)} products</span>` +
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
  function detailRow(row: ProductRow, span: number): string {
    const detail = state.detail.get(row.name);
    const chartId = `oa-history-${row.name.replace(/[^A-Za-z0-9]+/g, '-')}`;
    const measured = state.measure === 'value' ? row.value : row.qty;
    const perMonth = row.months ? measured / row.months : 0;
    const loaded = detail && detail !== 'loading' ? detail : null;

    const head = `<div class="oa-detail-head">
      <div class="oa-detail-title">
        <p class="eyebrow">${esc(row.companies.join(' + '))}</p>
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

  /** Draws the open product's history chart once its row is in the document. */
  function drawOpenHistory(s: Shaped) {
    if (!state.open) return;
    const row = s.rows.find((r) => r.name === state.open);
    if (!row) return;
    const host = document.querySelector<HTMLElement>('.oa-history');
    if (!host) return;

    const width = Math.max(host.clientWidth || 640, 420);
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

  async function loadDetail(product: string) {
    if (state.detail.has(product)) return;
    state.detail.set(product, 'loading');
    try {
      const res = await fetch(
        `/api/oa-released?product=${encodeURIComponent(product)}&company=${state.company}`,
      );
      const data = await res.json();
      state.detail.set(
        product,
        res.ok ? (data as ProductDetail) : ({ ...data, error: data?.error } as ProductDetail),
      );
    } catch (err) {
      state.detail.set(product, {
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
    const COLUMNS = 8;
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

    let running = 0;
    const body = rows
      .map((row, i) => {
        const measured = state.measure === 'value' ? row.value : row.qty;
        running += row.share;
        const open = state.open === row.name;
        return (
          `<tr class="day-row can-open${open ? ' open' : ''}" data-product="${esc(
            row.name,
          )}" tabindex="0" role="button" aria-expanded="${open}">
            <td class="sticky-col"><span class="disclose" aria-hidden="true">${
              open ? '▾' : '▸'
            }</span><span class="oa-rank">${String(i + 1).padStart(2, '0')}</span>${esc(
              row.name,
            )}</td>
            <td class="co">${esc(row.companies.join(' + '))}</td>
            <td class="num tinted">${fmt(measured)}</td>
            <td class="num">${pct(row.share)}</td>
            <td class="bar-cell"><span class="mini-bar"><i style="width:${(
              widest ? (measured / widest) * 100 : 0
            ).toFixed(1)}%"></i></span></td>
            <td class="num muted">${pct(running)}</td>
            <td class="num">${qty(row.months)}</td>
            <td class="num">${qty(row.lines)}</td>
          </tr>` + (open ? detailRow(row, COLUMNS) : '')
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
      <td class="num">${qty(s.months.length)}</td>
      <td class="num">${qty(s.total.lines)}</td>
    </tr>`;

    el.grid.innerHTML = `<table class="grid day-grid">
      <thead>
        <tr class="sub-row">
          <th class="sticky-col">Product</th>
          <th class="text">Company</th>
          <th class="num">${measureLabel()}</th>
          <th class="num">Share</th>
          <th class="bar-cell"></th>
          <th class="num">Cumulative</th>
          <th class="num">Months</th>
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
        : '';
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

    el.status.hidden = true;
    el.body.hidden = false;
  }

  /* ---------------------------------------------------------------- events */

  function toggleProduct(product: string) {
    state.open = state.open === product ? null : product;
    if (state.open) void loadDetail(state.open);
    if (state.history) renderGrid(state.history, shape(state.history));
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
    // A detail is scoped to the company it was fetched for.
    state.detail.clear();
    if (state.open) void loadDetail(state.open);
    render();
  });

  el.periodSeg.addEventListener('click', (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLElement>('[data-period]');
    if (!btn) return;
    state.period = btn.dataset.period!;
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
