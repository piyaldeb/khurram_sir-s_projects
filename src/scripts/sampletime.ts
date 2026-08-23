/**
 * Sample lead time — client rendering.
 *
 * A fiscal year is ~22,000 samples, far more than belongs on the wire, so the
 * server does the filtering and paging and answers with aggregates over
 * everything that matched plus one page of rows. Every control here therefore
 * refetches rather than re-projecting a payload, and the search is debounced
 * because each keystroke is a request.
 *
 * The row that matters most is the one whose lead time is negative: the sample
 * finished before its own SA date, which only happens when the SA was revised
 * afterwards. Those rows expand to show the revision behind them.
 */
import { lineChart, bindChartTooltips } from '../lib/charts';
import { skeleton } from '../lib/skeleton';

interface Bucket {
  label: string;
  count: number;
}

interface RevisionInfo {
  order: string;
  revised: boolean;
  number: string | null;
  cause: string | null;
  lastRevisedAt: string | null;
  chain: {
    number: string | null;
    from: string | null;
    at: string | null;
    qtyFrom: number;
    qtyTo: number;
  }[];
}

interface LeadRow {
  kind: 'sample' | 'bulk';
  company: string;
  no: string;
  order: string | null;
  date: string;
  buyer: string;
  customer: string;
  productType: string;
  shade: string;
  style: string;
  buyingHouse: string;
  qty: number;
  readyQty: number | null;
  balanceQty: number | null;
  completedOn: string | null;
  status: string;
  remarks: string;
  holidays: number;
  lead: number;
  pending: boolean;
  oas: string[];
  revision: RevisionInfo | null;
  trueLead: number | null;
}

interface Ranked {
  name: string;
  count: number;
  meanLead: number;
  negative: number;
  pending: number;
}

interface Result {
  fy: number;
  label: string;
  dataset: 'sample' | 'bulk';
  company: string;
  month: string;
  months: string[];
  yearRows: number;
  from: string;
  to: string;
  builtAt: string;
  stale?: boolean;
  staleError?: string | null;
  holidays: number;
  totals: {
    rows: number;
    pending: number;
    negative: number;
    meanLead: number;
    medianLead: number;
    withinWeek: number;
    distribution: Bucket[];
    statusMix: Bucket[];
    byMonth: { month: string; count: number; meanLead: number; negative: number; pending: number }[];
    topBuyers: Ranked[];
    topCustomers: Ranked[];
    byCompany: Ranked[];
  };
  matched: number;
  offset: number;
  limit: number;
  rows: LeadRow[];
  error?: string;
}

const root = document.querySelector<HTMLElement>('.leadtime');

if (root?.dataset.odoo) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T | null;

  const state = {
    fy: Number(root.dataset.fy),
    dataset: 'sample',
    company: 'all',
    month: '',
    only: 'all',
    q: '',
    sort: 'date',
    dir: 'desc',
    offset: 0,
    limit: 200,
    result: null as Result | null,
    /** SA numbers whose revision detail is open. */
    open: new Set<string>(),
  };

  let inFlight: AbortController | null = null;
  let searchTimer: number | undefined;

  /* ---------------------------------------------------------- formatting */

  const nf = new Intl.NumberFormat('en-US');
  const days = (v: number) => `${v > 0 ? '' : ''}${v.toFixed(v % 1 ? 1 : 0)}d`;
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const esc = (s: unknown) =>
    String(s ?? '').replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
    );

  const monthLabel = (m: string) => {
    const [y, mm] = m.split('-');
    const d = new Date(Number(y), Number(mm) - 1, 1);
    return Number.isNaN(d.getTime()) ? m : d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
  };

  const dayLabel = (iso: string | null) =>
    iso
      ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
          day: '2-digit',
          month: 'short',
          year: '2-digit',
          timeZone: 'UTC',
        })
      : '—';

  /* --------------------------------------------------------------- fetch */

  function query(): string {
    const p = new URLSearchParams({
      fy: String(state.fy),
      dataset: state.dataset,
      company: state.company,
      only: state.only,
      sort: state.sort,
      dir: state.dir,
      offset: String(state.offset),
      limit: String(state.limit),
    });
    if (state.month) p.set('month', state.month);
    if (state.q.trim()) p.set('q', state.q.trim());
    return p.toString();
  }

  async function load(fresh = true, refresh = false) {
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;

    // A cold fiscal year is a half-minute Odoo build; say so rather than
    // leaving the page looking hung behind a skeleton.
    const cold = fresh && !state.result;
    if (cold) {
      const title = $('lt-status-title');
      if (title) {
        const unit =
          state.company === 'all'
            ? 'both units'
            : state.company === 'zipper'
              ? 'Zipper'
              : 'Metal Trims';
        title.textContent = `Building ${state.dataset === 'bulk' ? 'bulk' : 'sample'} lead time · ${unit} · FY ${String(
          state.fy,
        ).slice(2)}-${String(state.fy + 1).slice(2)}`;
      }
      $('lt-status')!.hidden = false;
      $('lt-body')!.hidden = true;
    } else if (fresh) {
      showSkeleton();
    }

    try {
      const res = await fetch(`/api/sample-leadtime?${query()}${refresh ? '&refresh=1' : ''}`, {
        signal: controller.signal,
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? `Request failed (${res.status})`);

      state.result = data as Result;
      $('lt-status')!.hidden = true;
      $('lt-body')!.hidden = false;
      $('error-banner')!.hidden = true;
      render();
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      $('lt-status')!.hidden = true;
      $('lt-body')!.hidden = false;
      const banner = $('error-banner')!;
      banner.textContent = `Could not read the ${state.dataset} report — ${(err as Error).message}`;
      banner.hidden = false;
      // The table still holds the previous selection's rows, which would read
      // as the answer to the one that just failed. Clear it rather than lie.
      if (!state.result) {
        for (const id of ['lt-grid', 'month-grid', 'company-grid', 'buyer-grid', 'customer-grid']) {
          const host = $(id);
          if (host) host.innerHTML = '';
        }
        $('kpis')!.innerHTML = '';
        $('lt-pager')!.hidden = true;
      }
    }
  }

  function showSkeleton() {
    const kpis = $('kpis');
    if (kpis) {
      kpis.innerHTML = Array.from(
        { length: 6 },
        () =>
          `<div class="kpi" aria-hidden="true"><span class="sk sk-line" style="width:60%;height:10px"></span>` +
          `<span class="sk sk-line" style="width:75%;height:24px"></span></div>`,
      ).join('');
    }
    for (const id of ['chart-trend', 'chart-dist']) {
      const host = $(id);
      if (host) host.innerHTML = skeleton.chart(230);
    }
    for (const id of ['buyer-grid', 'customer-grid']) {
      const host = $(id);
      if (host) host.innerHTML = skeleton.table(4, 6);
    }
    const grid = $('lt-grid');
    if (grid) grid.innerHTML = skeleton.table(9, 10);
  }

  /* -------------------------------------------------------------- render */

  function render() {
    const r = state.result;
    if (!r) return;
    syncControls(r);
    renderAsOf(r);
    renderQuality(r);
    renderKpis(r);
    renderTrend(r);
    renderDistribution(r);
    fillMonths(r);
    renderMonths(r);
    renderRanked('company-grid', r.totals.byCompany, 'Unit', (name) => {
      // The unit is its own filter, so clicking one drives the control that
      // owns it rather than typing the name into the search box.
      const key = name === 'Zipper' ? 'zipper' : 'mt';
      $(`co-seg`)
        ?.querySelector<HTMLElement>(`[data-co="${state.company === key ? 'all' : key}"]`)
        ?.click();
    });
    renderRanked('buyer-grid', r.totals.topBuyers, 'Buyer');
    renderRanked('customer-grid', r.totals.topCustomers, 'Customer');
    renderRows(r);
    document.querySelectorAll<HTMLElement>('.chart-host').forEach(bindChartTooltips);
  }

  /**
   * Points every control at what actually came back.
   *
   * Driving the segmented controls from the click alone lets them drift from
   * the table: a restored page, a raced switch or a failed build leaves "Bulk"
   * lit above a table full of samples. The response echoes the dataset, unit
   * and year it answered for, so that — not the click — is what the buttons
   * are set from.
   */
  function syncControls(r: Result) {
    const pick = (group: string, attr: string, value: string) =>
      document.querySelectorAll<HTMLElement>(`#${group} .seg`).forEach((seg) =>
        seg.setAttribute('aria-selected', String(seg.dataset[attr] === value)),
      );

    pick('ds-seg', 'ds', r.dataset);
    pick('co-seg', 'co', r.company);
    pick('fy-seg', 'fy', String(r.fy));

    // Local state follows too, so the next request cannot repeat the drift.
    state.dataset = r.dataset;
    state.company = r.company;
    state.fy = r.fy;
    state.month = r.month;
  }

  function renderAsOf(r: Result) {
    const el = $('as-of');
    if (!el) return;
    const built = new Date(r.builtAt);
    const noun = r.dataset === 'bulk' ? 'bulk orders' : 'samples';
    const unit =
      r.company === 'all' ? 'both units' : r.company === 'zipper' ? 'Zipper' : 'Metal Trims';
    el.textContent =
      `${r.label} · ${unit} · ${nf.format(r.yearRows)} ${noun} · ${dayLabel(r.from)} to ${dayLabel(r.to)} · ` +
      (r.dataset === 'bulk'
        ? 'calendar days, Odoo deducts no holidays from bulk'
        : `${r.holidays} holidays deducted`) +
      ` · read ${built.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;

    // The figures are real either way; what changes is which moment they are
    // true of, and that is worth saying plainly rather than hiding.
    el.classList.toggle('is-stale', !!r.stale);
    if (r.stale) {
      el.textContent += ' — Odoo is not answering, so this is the last good copy';
      el.title = r.staleError ?? '';
    } else {
      el.removeAttribute('title');
    }
  }

  /**
   * Warns when a slice is almost entirely open.
   *
   * Metal Trims samples carry no completion date in Odoo at all — every row
   * comes back "Pending" — so its mean is the age of the backlog, not how long
   * a sample takes. Printing 276 days beside Zipper's 3.6 without saying that
   * would read as a catastrophe rather than a gap in the source.
   */
  function renderQuality(r: Result) {
    const banner = $('quality');
    if (!banner) return;
    const t = r.totals;
    const share = t.rows ? t.pending / t.rows : 0;

    if (t.rows < 20 || share < 0.9) {
      banner.hidden = true;
      return;
    }
    const noun = r.dataset === 'bulk' ? 'bulk orders' : 'samples';
    banner.innerHTML =
      `<strong>${pct(share)} of these ${esc(noun)} have no completion date in Odoo.</strong> ` +
      `Their lead time is measured against today, so the mean below is how long the backlog has ` +
      `been open — not how long the work takes. Treat it as a gap in the source, not a result.`;
    banner.hidden = false;
  }

  function renderKpis(r: Result) {
    const host = $('kpis');
    if (!host) return;
    const t = r.totals;

    const cards = [
      { label: 'Samples', value: nf.format(t.rows), sub: state.q || state.only !== 'all' ? 'matching the filter' : 'in the year' },
      { label: 'Mean lead time', value: days(t.meanLead), sub: 'negative rows excluded' },
      { label: 'Median', value: days(t.medianLead), sub: 'the typical sample' },
      {
        label: 'Within a week',
        value: pct(t.withinWeek),
        sub: 'completed in 7 days or less',
        tone: t.withinWeek >= 0.9 ? 'good' : '',
      },
      {
        label: 'Negative',
        value: nf.format(t.negative),
        sub: 'finished before their SA date',
        tone: t.negative ? 'bad' : '',
      },
      { label: 'Still open', value: nf.format(t.pending), sub: 'ageing against today' },
    ];

    host.innerHTML = cards
      .map(
        (c) =>
          `<div class="kpi${c.tone ? ` tone-${c.tone}` : ''}">
            <span class="label">${esc(c.label)}</span>
            <div class="value">${esc(c.value)}</div>
            <div class="sub">${esc(c.sub)}</div>
          </div>`,
      )
      .join('');
  }

  function renderTrend(r: Result) {
    const host = $('chart-trend');
    if (!host) return;
    const months = r.totals.byMonth;
    if (!months.length) {
      host.innerHTML = `<p class="empty">Nothing to plot.</p>`;
      return;
    }

    host.innerHTML = lineChart({
      categories: months.map((m) => monthLabel(m.month)),
      series: [
        { name: 'Mean days', color: '--series-1', values: months.map((m) => m.meanLead) },
      ],
      width: 620,
      height: 230,
      format: (v) => `${v.toFixed(1)} days`,
    });

    const note = $('trend-note');
    if (note) {
      const best = months.reduce((a, b) => (b.meanLead < a.meanLead ? b : a));
      const worst = months.reduce((a, b) => (b.meanLead > a.meanLead ? b : a));
      note.textContent = `Best ${monthLabel(best.month)} at ${days(best.meanLead)}, worst ${monthLabel(worst.month)} at ${days(worst.meanLead)}`;
    }
  }

  /**
   * The spread of lead times as horizontal bars.
   *
   * Ordered slowest-last because the buckets are a scale, not categories, and
   * the negative bucket keeps the alert colour: it is the one to act on.
   */
  function renderDistribution(r: Result) {
    const host = $('chart-dist');
    if (!host) return;
    const dist = r.totals.distribution;
    const total = dist.reduce((a, b) => a + b.count, 0);
    const max = Math.max(...dist.map((b) => b.count), 1);

    host.innerHTML = `<div class="profile">${dist
      .map((b, i) => {
        const share = total ? b.count / total : 0;
        const bad = b.label === 'Negative';
        const tip =
          `<strong>${esc(b.label)}</strong>` +
          `<span><i style="background:var(${bad ? '--critical' : '--accent'})"></i>Samples<b>${nf.format(b.count)}</b></span>` +
          `<span><i style="background:transparent"></i>Share<b>${pct(share)}</b></span>`;
        return `<div class="prof-row${bad ? ' aged' : ''}" data-tip="${esc(tip)}">
          <span class="prof-label">${esc(b.label)}</span>
          <div class="prof-track">
            <div class="prof-bar" style="width:${((b.count / max) * 100).toFixed(2)}%;opacity:${(0.5 + (i / Math.max(dist.length - 1, 1)) * 0.5).toFixed(2)}"></div>
          </div>
          <span class="prof-value">${nf.format(b.count)}</span>
          <span class="prof-share">${pct(share)}</span>
        </div>`;
      })
      .join('')}</div>`;

    const note = $('dist-note');
    if (note) note.textContent = `${nf.format(total)} samples across ${dist.length} bands`;
  }

  /**
   * Month by month, and clicking one filters the whole page to it.
   *
   * The picker above does the same thing; this is the version you land on when
   * a month in the trend looks wrong and you want to know what is in it.
   */
  function renderMonths(r: Result) {
    const host = $('month-grid');
    if (!host) return;
    const months = r.totals.byMonth;
    if (!months.length) {
      host.innerHTML = `<p class="empty">Nothing to break down.</p>`;
      return;
    }
    const slowest = Math.max(...months.map((m) => m.meanLead), 1);

    host.innerHTML = `<table class="grid">
      <thead><tr>
        <th class="text">Month</th><th class="num">Orders</th><th class="num">Mean lead</th>
        <th class="num">Negative</th><th class="num">Open</th><th></th>
      </tr></thead>
      <tbody>${months
        .map(
          (m) => `<tr class="rank-row${state.month === m.month ? ' open' : ''}" data-month="${esc(m.month)}">
            <td>${esc(monthLabel(m.month))}</td>
            <td class="num">${nf.format(m.count)}</td>
            <td class="num">${days(m.meanLead)}</td>
            <td class="num${m.negative ? ' up' : ''}">${m.negative || '—'}</td>
            <td class="num">${m.pending || '—'}</td>
            <td class="bar-cell"><span class="mini-bar"><i style="width:${((m.meanLead / slowest) * 100).toFixed(1)}%"></i></span></td>
          </tr>`,
        )
        .join('')}</tbody>
    </table>`;

    host.querySelectorAll<HTMLElement>('[data-month]').forEach((row) => {
      row.addEventListener('click', () => {
        const m = row.dataset.month!;
        state.month = state.month === m ? '' : m;
        state.offset = 0;
        const sel = $<HTMLSelectElement>('month-select');
        if (sel) sel.value = state.month;
        void load(false);
      });
    });
  }

  /** Keeps the month picker in step with the year on screen. */
  function fillMonths(r: Result) {
    const sel = $<HTMLSelectElement>('month-select');
    if (!sel) return;
    const wanted = ['', ...r.months].join('|');
    if (sel.dataset.filled === wanted) {
      sel.value = state.month;
      return;
    }
    sel.dataset.filled = wanted;
    sel.innerHTML =
      `<option value="">Whole year</option>` +
      r.months.map((m) => `<option value="${esc(m)}">${esc(monthLabel(m))}</option>`).join('');
    sel.value = state.month;
  }

  /**
   * Buyers, customers or units, ranked by volume, with what it costs in days.
   *
   * A row is a way into the table below, but not always the same way: a buyer
   * or customer is a text search, while a business unit is its own filter and
   * has to switch that instead. Searching for "Zipper" finds the customers with
   * "zipper" in their name, which is not what clicking the unit means.
   */
  function renderRanked(
    id: string,
    rows: Ranked[],
    heading: string,
    onPick?: (name: string) => void,
  ) {
    const host = $(id);
    if (!host) return;
    if (!rows.length) {
      host.innerHTML = `<p class="empty">Nothing to rank.</p>`;
      return;
    }
    const slowest = Math.max(...rows.map((r) => r.meanLead), 1);

    host.innerHTML = `<table class="grid">
      <thead><tr>
        <th class="text">${esc(heading)}</th>
        <th class="num">Samples</th>
        <th class="num">Mean lead</th>
        <th class="num">Negative</th>
        <th class="num">Open</th>
        <th></th>
      </tr></thead>
      <tbody>${rows
        .map(
          (r) => `<tr class="rank-row" data-name="${esc(r.name)}">
            <td>${esc(r.name)}</td>
            <td class="num">${nf.format(r.count)}</td>
            <td class="num">${days(r.meanLead)}</td>
            <td class="num${r.negative ? ' up' : ''}">${r.negative || '—'}</td>
            <td class="num">${r.pending || '—'}</td>
            <td class="bar-cell"><span class="mini-bar"><i style="width:${((r.meanLead / slowest) * 100).toFixed(1)}%"></i></span></td>
          </tr>`,
        )
        .join('')}</tbody>
    </table>`;

    // Clicking a name narrows the table — the ranking is a way in, not a dead end.
    host.querySelectorAll<HTMLElement>('.rank-row').forEach((row) => {
      row.addEventListener('click', () => {
        const name = row.dataset.name ?? '';
        if (onPick) {
          onPick(name);
          return;
        }
        state.q = name;
        state.offset = 0;
        const box = $<HTMLInputElement>('lt-search');
        if (box) box.value = name;
        void load(false);
      });
    });
  }

  function renderRows(r: Result) {
    const host = $('lt-grid');
    if (!host) return;

    // Bulk and sample are the same shape apart from a few columns each keeps
    // to itself, so the header is built from the dataset on screen.
    const bulk = r.dataset === 'bulk';
    const cols: { key: string; label: string; num?: boolean }[] = [
      { key: 'date', label: bulk ? 'OA date' : 'SA date' },
      { key: 'no', label: bulk ? 'OA no.' : 'SA no.' },
      { key: 'buyer', label: 'Buyer' },
      { key: 'customer', label: 'Customer' },
      ...(bulk ? [{ key: 'style', label: 'Style' }] : []),
      { key: 'productType', label: 'Product' },
      { key: 'shade', label: bulk ? 'Shades' : 'Shade' },
      { key: 'qty', label: 'Qty', num: true },
      ...(bulk
        ? [
            { key: 'readyQty', label: 'Ready', num: true },
            { key: 'balanceQty', label: 'Balance', num: true },
          ]
        : []),
      { key: 'completedOn', label: 'Completed' },
      { key: 'lead', label: 'Lead', num: true },
      { key: 'status', label: 'Status' },
      ...(bulk
        ? [{ key: 'buyingHouse', label: 'Buying house' }]
        : [{ key: 'oas', label: 'OA' }]),
      { key: 'company', label: 'Unit' },
    ];

    const head = cols
      .map(
        (c) =>
          `<th class="${c.num ? 'num' : 'text'}" data-sort="${c.key}"${
            state.sort === c.key ? ` data-dir="${state.dir === 'asc' ? 1 : -1}"` : ''
          }>${esc(c.label)}<span class="arrow">${state.dir === 'asc' ? '▲' : '▼'}</span></th>`,
      )
      .join('');

    const body = r.rows
      .map((row) => {
        const open = state.open.has(rowKey(row));
        const canOpen = !!row.revision;
        return (
          `<tr class="lt-row${canOpen ? ' can-open' : ''}${open ? ' open' : ''}${row.lead < 0 ? ' is-neg' : ''}"${
            canOpen ? ` data-key="${esc(rowKey(row))}" tabindex="0" role="button" aria-expanded="${open}"` : ''
          }>
            <td>${canOpen ? `<span class="disclose" aria-hidden="true">${open ? '▾' : '▸'}</span>` : ''}${esc(dayLabel(row.date))}</td>
            <td class="mono">${esc(row.order ?? row.no)}</td>
            <td>${esc(row.buyer)}</td>
            <td>${esc(row.customer)}</td>
            ${bulk ? `<td title="${esc(row.style)}">${esc(row.style)}</td>` : ''}
            <td>${esc(row.productType)}</td>
            <td title="${esc(row.shade)}">${esc(row.shade)}</td>
            <td class="num">${nf.format(row.qty)}</td>
            ${
              bulk
                ? `<td class="num">${nf.format(row.readyQty ?? 0)}</td>` +
                  `<td class="num${row.balanceQty ? ' up' : ''}">${nf.format(row.balanceQty ?? 0)}</td>`
                : ''
            }
            <td>${esc(dayLabel(row.completedOn))}${row.pending ? ' <span class="badge warn">open</span>' : ''}</td>
            <td class="num ${row.lead < 0 ? 'up' : row.lead <= 7 ? 'down' : ''}">${row.lead}${
              row.holidays ? `<small title="${row.holidays} holidays deducted"> −${row.holidays}h</small>` : ''
            }</td>
            <td>${esc(row.status)}</td>
            ${
              bulk
                ? `<td>${esc(row.buyingHouse || '—')}</td>`
                : `<td class="mono">${row.oas.length ? esc(row.oas.slice(0, 2).join(', ')) + (row.oas.length > 2 ? ` +${row.oas.length - 2}` : '') : '—'}</td>`
            }
            <td>${row.company === 'zipper' ? 'Zipper' : 'Metal Trims'}</td>
          </tr>` + (open ? revisionRow(row, cols.length) : '')
        );
      })
      .join('');

    host.innerHTML = `<table class="grid lt-grid">
      <thead><tr>${head}</tr></thead>
      <tbody>${
        body ||
        `<tr><td colspan="${cols.length}" class="empty">${emptyReason(r)}</td></tr>`
      }</tbody>
    </table>`;

    host.querySelectorAll<HTMLElement>('th[data-sort]').forEach((th) => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort!;
        state.dir = state.sort === key && state.dir === 'desc' ? 'asc' : 'desc';
        state.sort = key;
        state.offset = 0;
        void load(false);
      });
    });

    host.querySelectorAll<HTMLElement>('.lt-row[data-key]').forEach((row) => {
      const toggle = () => {
        const key = row.dataset.key!;
        state.open.has(key) ? state.open.delete(key) : state.open.add(key);
        renderRows(state.result!);
        $('lt-grid')?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus();
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (e) => {
        const k = (e as KeyboardEvent).key;
        if (k !== 'Enter' && k !== ' ') return;
        e.preventDefault();
        toggle();
      });
    });

    const note = $('rows-note');
    if (note) {
      note.textContent = `${nf.format(r.matched)} matching · showing ${
        r.rows.length ? nf.format(r.offset + 1) : 0
      }–${nf.format(r.offset + r.rows.length)}`;
    }

    const pager = $('lt-pager');
    if (pager) {
      pager.hidden = r.matched <= r.limit;
      $<HTMLButtonElement>('page-prev')!.disabled = r.offset === 0;
      $<HTMLButtonElement>('page-next')!.disabled = r.offset + r.limit >= r.matched;
      $('page-label')!.textContent = `Page ${Math.floor(r.offset / r.limit) + 1} of ${Math.max(
        Math.ceil(r.matched / r.limit),
        1,
      )}`;
    }
  }

  /**
   * Why the table is empty, in the terms the reader just used.
   *
   * A filter that legitimately matches nothing looks identical to one that is
   * broken, so the empty state names the filter that emptied it — and, for the
   * negative one, says where the negatives actually are.
   */
  function emptyReason(r: Result): string {
    const noun = r.dataset === 'bulk' ? 'bulk orders' : 'samples';
    const unit =
      r.company === 'all' ? '' : r.company === 'zipper' ? ' for Zipper' : ' for Metal Trims';
    const when = r.month ? ` in ${esc(monthLabel(r.month))}` : '';
    const scope = `${esc(r.label)}${unit}${when}`;

    if (state.q.trim()) {
      return `No ${noun} in ${scope} match “${esc(state.q.trim())}”.`;
    }
    switch (state.only) {
      case 'negative':
        return (
          `No ${noun} in ${scope} finished before their own date — which is the good outcome. ` +
          `Negative lead times are the ones caused by a revision moving the date afterwards.`
        );
      case 'late':
        return `No ${noun} in ${scope} took longer than 7 days.`;
      case 'revised':
        return `No ${noun} in ${scope} carry a revision in the sales module.`;
      case 'pending':
        return `Every ${noun.replace(/s$/, '')} in ${scope} has a completion date.`;
      default:
        return `No ${noun} in ${scope}.`;
    }
  }

  /** A row can repeat per line, so the key has to include what varies. */
  const rowKey = (r: LeadRow) => `${r.kind}|${r.no}|${r.date}|${r.shade}|${r.productType}`;

  /**
   * Why this sample's lead time reads the way it does.
   *
   * The chain's first entry carries the date the order held before any
   * revision, which is the date the sample was actually worked to — so a
   * negative lead time and a sensible one can sit side by side and the
   * difference is the revision, stated.
   */
  function revisionRow(row: LeadRow, span: number): string {
    const rev = row.revision!;
    const chain = rev.chain.length
      ? `<table class="grid mini">
          <thead><tr>
            <th class="text">Revision</th><th class="text">Order date before</th>
            <th class="text">Revised on</th><th class="num">Qty before</th><th class="num">Qty after</th>
          </tr></thead>
          <tbody>${rev.chain
            .map(
              (c) => `<tr>
                <td>${esc(c.number ?? '—')}</td>
                <td>${esc(dayLabel(c.from))}</td>
                <td>${esc(dayLabel(c.at))}</td>
                <td class="num">${nf.format(c.qtyFrom)}</td>
                <td class="num">${nf.format(c.qtyTo)}</td>
              </tr>`,
            )
            .join('')}</tbody>
        </table>`
      : `<p class="hint" style="margin:6px 0 0">
           Odoo records the revision on the order but keeps no dated chain for it,
           so the original SA date cannot be recovered here.
         </p>`;

    return `<tr class="day-detail"><td colspan="${span}">
      <div class="day-detail-box">
        <div class="day-detail-head">
          <strong>${esc(rev.order)}</strong>
          <span>${rev.number ? `Revision ${esc(rev.number)}` : 'Revised'}</span>
          ${rev.lastRevisedAt ? `<span>last revised ${esc(dayLabel(rev.lastRevisedAt.slice(0, 10)))}</span>` : ''}
          ${
            row.trueLead !== null
              ? `<span class="true-lead">Measured from the original date: <b>${row.trueLead} days</b></span>`
              : ''
          }
        </div>
        <p class="rev-cause">${
          rev.cause
            ? `<span class="rev-label">Reason</span> ${esc(rev.cause)}`
            : `<span class="rev-label">Reason</span> <em>none recorded on the order</em>`
        }</p>
        ${chain}
      </div>
    </td></tr>`;
  }

  /* -------------------------------------------------------------- wiring */

  segHandler('fy-seg', 'fy', (v) => {
    state.fy = Number(v);
    // Months belong to the year; drop the filter and let it refill.
    const sel = $<HTMLSelectElement>('month-select');
    if (sel) delete sel.dataset.filled;
    state.month = '';
  });

  /**
   * Dataset, unit and year each name a different Odoo build, so each is a cold
   * load: the held result is dropped so the page shows the building state
   * rather than half of the previous year's figures.
   */
  function segHandler(group: string, attr: string, set: (v: string) => void) {
    $(group)?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>(`[data-${attr}]`);
      if (!btn) return;
      document
        .querySelectorAll<HTMLElement>(`#${group} .seg`)
        .forEach((seg) => seg.setAttribute('aria-selected', String(seg === btn)));
      set(btn.dataset[attr]!);
      state.offset = 0;
      state.open.clear();
      state.result = null;
      void load();
    });
  }

  segHandler('ds-seg', 'ds', (v) => {
    state.dataset = v;
    // The month list belongs to the year and dataset on screen; force a rebuild.
    const sel = $<HTMLSelectElement>('month-select');
    if (sel) delete sel.dataset.filled;
    state.month = '';
  });
  segHandler('co-seg', 'co', (v) => (state.company = v));

  $<HTMLSelectElement>('month-select')?.addEventListener('change', (e) => {
    state.month = (e.target as HTMLSelectElement).value;
    state.offset = 0;
    void load(false);
  });

  $('lt-filters')?.addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-only]');
    if (!chip) return;
    state.only = chip.dataset.only!;
    state.offset = 0;
    document
      .querySelectorAll<HTMLElement>('#lt-filters .chip')
      .forEach((c) => c.classList.toggle('active', c === chip));
    void load(false);
  });

  // Each keystroke is a request, so wait for the typing to settle.
  $<HTMLInputElement>('lt-search')?.addEventListener('input', (e) => {
    state.q = (e.target as HTMLInputElement).value;
    state.offset = 0;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void load(false), 250);
  });

  $('page-prev')?.addEventListener('click', () => {
    state.offset = Math.max(state.offset - state.limit, 0);
    void load(false);
  });
  $('page-next')?.addEventListener('click', () => {
    state.offset += state.limit;
    void load(false);
  });

  $('refresh')?.addEventListener('click', () => void load(true, true));

  void load();
}
