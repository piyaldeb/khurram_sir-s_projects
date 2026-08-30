/**
 * Sample to bulk conversion — the page.
 *
 * One fiscal year at a time, split into its four fiscal quarters. The server
 * does the matching and the roll-ups; this draws them and keeps the filters,
 * the quarter picker and the row table in step.
 *
 * The two honesty markers from the data layer are carried all the way to the
 * screen rather than being smoothed over: a quarter whose samples are too
 * recent to have converted is marked open and left out of the headline rate,
 * and a quarter from before its unit started recording the reference is marked
 * unrecorded, because "nobody wrote it down" must not read as "nothing sold".
 */
import { bindChartTooltips, barChart } from '../lib/charts';
import { skeleton } from '../lib/skeleton';

const root = document.querySelector<HTMLElement>('.sampleconv');

if (root) {
  const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

  const el = {
    body: $<HTMLElement>('#sc-body'),
    status: $<HTMLElement>('#sc-status'),
    statusTitle: $<HTMLElement>('#sc-status-title'),
    asOf: $<HTMLElement>('#as-of'),
    errorBanner: $<HTMLElement>('#error-banner'),
    quality: $<HTMLElement>('#quality'),
    kpis: $<HTMLElement>('#kpis'),
    chartTrend: $<HTMLElement>('#chart-trend'),
    chartValue: $<HTMLElement>('#chart-value'),
    trendNote: $<HTMLElement>('#trend-note'),
    valueNote: $<HTMLElement>('#value-note'),
    quarterGrid: $<HTMLElement>('#quarter-grid'),
    dimChips: $<HTMLElement>('#dim-chips'),
    dimGrid: $<HTMLElement>('#dim-grid'),
    dimNote: $<HTMLElement>('#dim-note'),
    grid: $<HTMLElement>('#sc-grid'),
    rowsNote: $<HTMLElement>('#rows-note'),
    search: $<HTMLInputElement>('#sc-search'),
    filters: $<HTMLElement>('#sc-filters'),
    pager: $<HTMLElement>('#sc-pager'),
    pageLabel: $<HTMLElement>('#page-label'),
    prev: $<HTMLButtonElement>('#page-prev'),
    next: $<HTMLButtonElement>('#page-next'),
    refresh: $<HTMLButtonElement>('#refresh'),
    exportBtn: $<HTMLButtonElement>('#export'),
  };

  const state = {
    fy: Number(root.dataset.fy ?? new Date().getFullYear()),
    company: 'all',
    quarter: '',
    /** Which of buyer / team / salesperson / marketer / region is on screen. */
    dimension: 'buyer',
    /** How the breakdown is ordered, and which way. */
    dimSort: 'raised' as 'raised' | 'converted' | 'rate' | 'bulkValue' | 'medianLag' | 'name',
    dimDir: -1,
    // Converted by default: the list is here to show what the samples won, and
    // the figures above already say how many did not. The other two chips are
    // kept because "what did we develop and never sell" is the question the
    // buyer table raises and this is where it gets answered.
    only: 'converted',
    q: '',
    offset: 0,
    limit: 200,
    data: null as any,
    loading: false,
  };

  const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const money = (v: number) => `$${nf.format(Math.round(v))}`;
  const count = (v: number) => nf.format(Math.round(v));
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const esc = (s: unknown) =>
    String(s ?? '').replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
    );

  const shortDate = (iso: string) => {
    const d = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(d.getTime())
      ? iso
      : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  };

  /** With the year, for dates that may be several years back. */
  const fullDate = (iso: string) => {
    const d = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(d.getTime())
      ? iso
      : d.toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          timeZone: 'UTC',
        });
  };

  const tile = (label: string, value: string, sub: string, tone?: 'warn' | 'good') =>
    `<div class="kpi${tone ? ` ${tone}` : ''}"><div class="label">${esc(
      label,
    )}</div><div class="value">${esc(value)}</div><div class="sub">${sub}</div></div>`;

  /* ------------------------------------------------------------ fetching */

  function query(): string {
    const p = new URLSearchParams({
      fy: String(state.fy),
      company: state.company,
      offset: String(state.offset),
      limit: String(state.limit),
      only: state.only,
    });
    if (state.quarter) p.set('quarter', state.quarter);
    if (state.q) p.set('q', state.q);
    return p.toString();
  }

  async function load(refresh = false) {
    if (state.loading) return;
    state.loading = true;
    el.status.hidden = false;
    el.statusTitle.textContent = refresh
      ? 'Re-reading the fiscal year from Odoo'
      : 'Building the fiscal year';
    el.errorBanner.hidden = true;
    if (!state.data) {
      el.kpis.innerHTML = skeleton.chips(5);
      el.chartTrend.innerHTML = skeleton.chart();
      el.chartValue.innerHTML = skeleton.chart();
    }

    try {
      const res = await fetch(`/api/sample-conversion?${query()}${refresh ? '&refresh=1' : ''}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      state.data = data;
      render();
    } catch (err) {
      el.errorBanner.hidden = false;
      el.errorBanner.className = 'banner error';
      el.errorBanner.textContent = `Could not load: ${(err as Error).message}`;
    } finally {
      state.loading = false;
      el.status.hidden = true;
    }
  }

  /** Everything except the rows is unchanged by paging, so paging only re-renders rows. */
  async function loadPage() {
    const res = await fetch(`/api/sample-conversion?${query()}`);
    const data = await res.json();
    if (!res.ok) return;
    state.data = data;
    renderRows();
  }

  /* ------------------------------------------------------------ rendering */

  function render() {
    const d = state.data;
    if (!d) return;

    el.asOf.textContent =
      `${d.label} · ${count(d.totals.raised)} samples` +
      (d.stale ? ` · showing the copy from ${new Date(d.builtAt).toLocaleString()}` : '') +
      (d.quarter ? ` · ${d.quarter.replace('-', ' ')} only` : '');

    renderQuality();
    renderKpis();
    renderCharts();
    renderQuarters();
    renderDimension();
    renderRows();
  }

  /**
   * What the figures cannot say, said plainly above them.
   *
   * Both caveats change how the number should be read, so neither is a
   * footnote: an unrecorded quarter is not a bad quarter, and an open quarter
   * is not a lost one.
   */
  function renderQuality() {
    const d = state.data;
    const notes: string[] = [];

    const unrecorded = d.quarters.filter((q: any) => !q.recorded && q.raised > 0);
    if (unrecorded.length) {
      const starts = Object.entries(d.adoptedAt)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k === 'zipper' ? 'Zipper' : 'Metal Trims'} from ${fullDate(String(v))}`)
        .join(', ');
      notes.push(
        `<strong>${unrecorded
          .map((q: any) => q.label)
          .join(
            ', ',
          )} pre-dates the sample number being written on bulk orders</strong> (${esc(
          starts,
        )}). Conversions found through a shared PLM number still count, so those quarters are a floor: the true rate is at least what is shown, never less.`,
      );
    }

    const open = d.quarters.filter((q: any) => !q.mature && q.raised > 0);
    if (open.length) {
      const days = Math.max(...(Object.values(d.maturityDays) as number[]).map(Number), 0);
      notes.push(
        `<strong>${open
          .map((q: any) => q.label)
          .join(', ')} is still open.</strong> Nine conversions in ten land within ${count(
          days,
        )} days of the sample, so its rate can only rise. The headline rate below counts only samples older than that.`,
      );
    }

    el.quality.hidden = !notes.length;
    el.quality.innerHTML = notes.map((n) => `<p>${n}</p>`).join('');
  }

  function renderKpis() {
    const t = state.data.totals;
    el.kpis.innerHTML = [
      tile('Samples raised', count(t.raised), state.data.label),
      tile(
        'Converted to bulk',
        count(t.converted),
        `${pct(t.rate)} of every sample raised`,
        t.converted ? 'good' : undefined,
      ),
      tile(
        'Conversion rate',
        pct(t.matureRate),
        t.pending
          ? `of the ${count(t.matureRaised)} old enough to judge · ${count(t.pending)} still open`
          : 'every sample is old enough to judge',
      ),
      tile('Bulk value won', money(t.bulkValue), 'ex tax, from the orders naming a sample'),
      tile(
        'Sample to order',
        t.medianLag === null ? '—' : `${count(t.medianLag)} days`,
        'median, sample raised to first bulk order',
      ),
    ].join('');
  }

  function renderCharts() {
    const quarters = state.data.quarters as any[];
    // Only a quarter with no samples at all has nothing to draw. A quarter
    // from before the sample number was recorded still has its PLM-found
    // conversions, and they are real; the note under the chart says the bar is
    // a floor rather than hiding it.
    const drawable = quarters.map((q) => q.raised > 0);
    const cats = quarters.map((q) => q.label);

    el.chartTrend.innerHTML = barChart({
      categories: cats,
      width: Math.max(el.chartTrend.clientWidth || 560, 320),
      height: 240,
      format: (v) => `${v.toFixed(1)}%`,
      unit: '',
      series: [
        {
          name: 'Converted',
          color: '--series-1',
          values: quarters.map((q, i) => (drawable[i] ? q.rate * 100 : null)),
        },
      ],
    });
    bindChartTooltips(el.chartTrend);

    const open = quarters.filter((q) => !q.mature && q.raised);
    const partial = quarters.filter((q) => !q.recorded && q.raised);
    el.trendNote.textContent = [
      open.length ? `${open.map((q) => q.label).join(', ')} still open` : '',
      partial.length ? `${partial.map((q) => q.label).join(', ')} a floor, not a full count` : '',
    ]
      .filter(Boolean)
      .join(' · ') || 'Share of the quarter’s samples that won a bulk order';

    el.chartValue.innerHTML = barChart({
      categories: cats,
      width: Math.max(el.chartValue.clientWidth || 560, 320),
      height: 240,
      format: money,
      unit: '$',
      series: [
        {
          name: 'Bulk value',
          color: '--series-2',
          values: quarters.map((q, i) => (drawable[i] ? q.bulkValue : null)),
        },
      ],
    });
    bindChartTooltips(el.chartValue);
    el.valueNote.textContent = 'Attributed to the quarter the sample was raised in';
  }

  /** Development effort, with the converted share filled in over it. */
  function stackedMeter(effort: number, won: number) {
    return `<div class="meter stacked"><span class="meter-fill s1" style="width:${Math.max(
      0,
      Math.min(effort, 100),
    ).toFixed(1)}%"></span><span class="meter-fill good over" style="width:${Math.max(
      0,
      Math.min(won, 100),
    ).toFixed(1)}%"></span></div>`;
  }

  function meter(fill: number, cls = 'accent') {
    return `<div class="meter"><span class="meter-fill ${cls}" style="width:${Math.max(
      0,
      Math.min(fill, 100),
    ).toFixed(1)}%"></span></div>`;
  }

  function renderQuarters() {
    const quarters = state.data.quarters as any[];
    const head = `<thead><tr>
        <th>Quarter</th><th>Period</th>
        <th class="num">Samples</th><th class="num">Converted</th>
        <th class="num">Rate</th><th class="num">Bulk value won</th>
        <th class="num">Median days</th><th></th>
      </tr></thead>`;

    const body = quarters
      .map((q) => {
        const active = state.quarter === q.key;
        // Never blank a real figure. A quarter that pre-dates the sample
        // number being written down is a floor, not a blank: the conversions
        // found through a PLM number are real, and the ones nobody recorded
        // are simply missing. "At least" says both.
        const tag = !q.recorded
          ? '<span class="tag warn" title="Before the sample number was recorded on bulk orders. Conversions found by PLM number still count, so this is a floor — the true rate is at least this.">at least</span>'
          : !q.mature && q.raised
            ? '<span class="tag" title="Too recent for its samples to have converted yet. This can only rise.">still open</span>'
            : '';
        return `<tr class="clickable${active ? ' active' : ''}${
          q.recorded ? '' : ' partial'
        }" data-quarter="${esc(q.key)}">
          <td><strong>${esc(q.label)}</strong> ${tag}</td>
          <td class="rail-sub">${esc(q.span)}</td>
          <td class="num">${count(q.raised)}</td>
          <td class="num">${count(q.converted)}</td>
          <td class="num">${q.raised ? pct(q.rate) : '—'}</td>
          <td class="num">${money(q.bulkValue)}</td>
          <td class="num">${q.medianLag === null ? '—' : count(q.medianLag)}</td>
          <td class="pace">${q.raised ? meter(q.rate * 100, 's1') : ''}</td>
        </tr>`;
      })
      .join('');

    const t = state.data.totals;
    const foot = `<tfoot><tr class="total-row">
        <td colspan="2">${esc(state.data.label)}</td>
        <td class="num">${count(t.raised)}</td>
        <td class="num">${count(t.converted)}</td>
        <td class="num">${pct(t.rate)}</td>
        <td class="num">${money(t.bulkValue)}</td>
        <td class="num">${t.medianLag === null ? '—' : count(t.medianLag)}</td>
        <td></td>
      </tr></tfoot>`;

    el.quarterGrid.innerHTML = `<table class="grid day-grid">${head}<tbody>${body}</tbody>${foot}</table>`;
  }


  /**
   * Buyer, sales team, salesperson, marketer or region — the same table, one
   * dimension at a time.
   *
   * The server sends all five, so switching between them is instant and costs
   * no round trip. Rows are ordered by conversions won rather than by samples
   * raised: the question is who turns development work into orders, and the
   * team that raised the most samples is not the team that sold the most.
   */
  function renderDimension() {
    const d = state.data;
    const dims = (d.dimensions ?? []) as { key: string; label: string }[];

    el.dimChips.innerHTML = dims
      .map(
        (dim) =>
          `<button class="chip${dim.key === state.dimension ? ' active' : ''}" type="button" data-dim="${esc(
            dim.key,
          )}">${esc(dim.label)}</button>`,
      )
      .join('');

    const label = dims.find((x) => x.key === state.dimension)?.label ?? 'Buyer';
    const all = (d.breakdowns?.[state.dimension] ?? []) as any[];

    const rows = [...all].sort((a, b) => {
      const key = state.dimSort;
      if (key === 'name') return String(a.name).localeCompare(String(b.name)) * -state.dimDir;
      const av = a[key] ?? -1;
      const bv = b[key] ?? -1;
      return (av - bv) * state.dimDir || b.raised - a.raised;
    });

    const columns: { key: string; label: string; cls: string }[] = [
      { key: 'name', label, cls: 'text' },
      { key: 'raised', label: 'Samples', cls: 'num' },
      { key: 'converted', label: 'Converted', cls: 'num' },
      { key: 'rate', label: 'Rate', cls: 'num' },
      { key: 'bulkValue', label: 'Bulk value won', cls: 'num' },
      { key: 'medianLag', label: 'Median days', cls: 'num' },
    ];

    const head = `<thead><tr>${columns
      .map(
        (c) =>
          `<th class="${c.cls} sortable${state.dimSort === c.key ? ' sorted' : ''}" data-sort="${
            c.key
          }">${esc(c.label)}${
            state.dimSort === c.key
              ? `<span class="arrow">${state.dimDir === -1 ? '▾' : '▴'}</span>`
              : ''
          }</th>`,
      )
      .join('')}<th></th></tr></thead>`;

    // The bar is drawn against the biggest development effort in the list, so
    // it reads as "how much of the work went here", with the converted part
    // filled in over it.
    const widest = Math.max(...rows.map((r) => r.raised), 1);

    const body = rows.length
      ? rows
          .map(
            (r) => `<tr class="clickable${r.raised >= 100 && !r.converted ? ' barren' : ''}" data-name="${esc(
              r.name,
            )}">
            <td class="text">${esc(r.name)}</td>
            <td class="num">${count(r.raised)}</td>
            <td class="num">${count(r.converted)}</td>
            <td class="num">${pct(r.rate)}</td>
            <td class="num">${money(r.bulkValue)}</td>
            <td class="num">${r.medianLag === null ? '—' : count(r.medianLag)}</td>
            <td class="pace">${stackedMeter(
              (r.raised / widest) * 100,
              (r.converted / widest) * 100,
            )}</td>
          </tr>`,
          )
          .join('')
      : '<tr><td colspan="7" class="rail-sub">No samples match.</td></tr>';

    el.dimGrid.innerHTML = `<table class="grid day-grid">${head}<tbody>${body}</tbody></table>`;

    // A big development effort that won nothing is the finding this table
    // exists to surface, so it is named rather than left to be spotted.
    const barren = rows.filter((r) => r.raised >= 100 && !r.converted);
    el.dimNote.innerHTML = barren.length
      ? `${count(rows.length)} ${esc(label.toLowerCase())}s · <strong class="warn">${barren
          .slice(0, 3)
          .map((r) => `${esc(r.name)} (${count(r.raised)} samples, none converted)`)
          .join(', ')}</strong>${barren.length > 3 ? ` and ${barren.length - 3} more` : ''}`
      : `${count(rows.length)} ${esc(label.toLowerCase())}s, most development effort first`;
  }

  /**
   * The bulk orders a sample won, listed under it.
   *
   * Hidden until the sample is clicked. Every order carries the date it was
   * raised and the value of the lines on it that name this sample — where a
   * line names two samples its value is split between them, so these add up to
   * the sample's total rather than double-counting it.
   */
  function detailRow(r: any): string {
    const orders = (r.oas as any[])
      .map(
        (o) => `<tr>
          <td><strong>${esc(o.no)}</strong>${
            o.date === r.firstBulk
              ? ' <span class="tag">first</span>'
              : ''
          }</td>
          <td>${o.date ? esc(shortDate(o.date)) : '—'}</td>
          <td class="text">${
            o.items?.length ? esc(o.items.join(' · ')) : '<span class="dash">—</span>'
          }</td>
          <td class="text">${
            o.shades?.length ? esc(o.shades.join(' · ')) : '<span class="dash">—</span>'
          }</td>
          <td class="text">${
            o.plms?.length
              ? o.plms.map((x: string) => `<code>${esc(x)}</code>`).join(' ')
              : '<span class="dash">—</span>'
          }</td>
          <td class="num">${count(o.qty)}</td>
          <td class="num">${money(o.value)}</td>
          <td><span class="tag ${o.via === 'ref' ? 'good' : ''}" title="${
            o.via === 'ref'
              ? 'The sample number is written on this order’s line'
              : 'This order and the sample share a PLM number'
          }">${o.via === 'ref' ? 'SA ref' : 'PLM'}</span></td>
        </tr>`,
      )
      .join('');

    return `<tr class="drill-row" data-detail="${esc(r.no)}" hidden>
      <td colspan="10">
        <div class="drill-body">
          <p class="rail-sub">${count(r.oas.length)} bulk ${
            r.oas.length === 1 ? 'order names' : 'orders name'
          } <strong>${esc(r.no)}</strong> · ${money(r.bulkValue)} won${
            r.lagDays === null ? '' : ` · first one ${count(r.lagDays)} days after the sample`
          }${
            r.plms?.length
              ? ` · sample PLM ${r.plms.map((x: string) => `<code>${esc(x)}</code>`).join(' ')}`
              : ''
          }</p>
          <table class="grid day-grid drill-grid">
            <thead><tr>
              <th>Bulk order</th><th>Raised</th>
              <th class="text">Item</th><th class="text">Shade</th><th class="text">PLM</th>
              <th class="num">Qty</th><th class="num">Value</th>
              <th>Linked by</th>
            </tr></thead>
            <tbody>${orders}</tbody>
          </table>
        </div>
      </td>
    </tr>`;
  }

  function renderRows() {
    const d = state.data;
    const rows = d.rows as any[];

    const head = `<thead><tr>
        <th>Sample</th><th>Raised</th><th>Unit</th>
        <th class="text">Buyer</th><th class="text">Sales team</th>
        <th class="text">Salesperson</th>
        <th>Bulk order</th><th class="num">Bulk value</th>
        <th class="num">Days</th><th>Outcome</th>
      </tr></thead>`;

    const body = rows.length
      ? rows
          .map((r) => {
            const outcome = r.converted
              ? '<span class="tag good">converted</span>'
              : r.mature
                ? '<span class="rail-sub">not taken up</span>'
                : '<span class="tag">still open</span>';
            const oas = r.oas.length
              ? `${esc(r.oas[0].no)}${
                  r.oas.length > 1
                    ? ` <span class="rail-sub">+${r.oas.length - 1} more</span>`
                    : ''
                }`
              : '<span class="dash">—</span>';
            // A converted sample opens to show the orders that converted it;
            // the number alone is a claim, the orders are the evidence.
            return `<tr class="${r.converted ? 'clickable' : r.mature ? '' : 'future'}"${
              r.converted ? ` data-sample="${esc(r.no)}"` : ''
            }>
              <td><strong>${esc(r.no)}</strong>${
                r.converted ? '<span class="drill" aria-hidden="true">▸</span>' : ''
              }</td>
              <td>${esc(shortDate(r.date))}</td>
              <td>${r.company === 'zipper' ? 'Zipper' : 'Metal Trims'}</td>
              <td class="text">${esc(r.buyer || '—')}</td>
              <td class="text">${esc(r.team || '—')}</td>
              <td class="text">${esc(r.salesperson || '—')}</td>
              <td>${oas}</td>
              <td class="num">${r.bulkValue ? money(r.bulkValue) : '<span class="dash">—</span>'}</td>
              <td class="num">${r.lagDays === null ? '' : count(r.lagDays)}</td>
              <td>${outcome}</td>
            </tr>${r.converted ? detailRow(r) : ''}`;
          })
          .join('')
      : '<tr><td colspan="10" class="rail-sub">No samples match these filters.</td></tr>';

    el.grid.innerHTML = `<table class="grid day-grid">${head}<tbody>${body}</tbody></table>`;

    const noun =
      state.only === 'converted'
        ? 'converted'
        : state.only === 'lost'
          ? 'not taken up'
          : state.only === 'open'
            ? 'still open'
            : 'samples';
    el.rowsNote.textContent = `${count(d.matched)} ${noun}${
      d.matched > d.rows.length
        ? `, showing ${count(d.offset + 1)}–${count(d.offset + d.rows.length)}`
        : ''
    }`;

    const pages = d.matched > d.limit;
    el.pager.hidden = !pages;
    if (pages) {
      el.pageLabel.textContent = `${count(d.offset + 1)}–${count(
        d.offset + d.rows.length,
      )} of ${count(d.matched)}`;
      el.prev.disabled = d.offset === 0;
      el.next.disabled = d.offset + d.limit >= d.matched;
    }
  }

  /* --------------------------------------------------------------- events */

  const reload = () => {
    state.offset = 0;
    void load();
  };

  document.querySelectorAll<HTMLElement>('#co-seg [data-co]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.company = btn.dataset.co!;
      document
        .querySelectorAll('#co-seg [data-co]')
        .forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
      reload();
    }),
  );

  document.querySelectorAll<HTMLElement>('#fy-seg [data-fy]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.fy = Number(btn.dataset.fy);
      // A quarter belongs to the year it was picked in.
      state.quarter = '';
      document
        .querySelectorAll('#fy-seg [data-fy]')
        .forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
      reload();
    }),
  );

  el.filters.addEventListener('click', (event) => {
    const chip = (event.target as HTMLElement).closest<HTMLElement>('[data-only]');
    if (!chip) return;
    state.only = chip.dataset.only!;
    el.filters.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
    reload();
  });

  // Clicking a quarter row filters to it; clicking it again clears the filter.
  el.quarterGrid.addEventListener('click', (event) => {
    const tr = (event.target as HTMLElement).closest<HTMLElement>('[data-quarter]');
    if (!tr) return;
    state.quarter = state.quarter === tr.dataset.quarter ? '' : tr.dataset.quarter!;
    reload();
  });


  el.dimGrid.addEventListener('click', (event) => {
    const th = (event.target as HTMLElement).closest<HTMLElement>('th[data-sort]');
    if (!th) return;
    const key = th.dataset.sort as typeof state.dimSort;
    // Clicking the sorted column flips it; a new column starts descending,
    // which is what you want for every column here except the name.
    if (state.dimSort === key) state.dimDir = -state.dimDir as 1 | -1;
    else {
      state.dimSort = key;
      state.dimDir = -1;
    }
    renderDimension();
  });

  // Switching dimension needs no fetch — every breakdown is already here.
  el.dimChips.addEventListener('click', (event) => {
    const chip = (event.target as HTMLElement).closest<HTMLElement>('[data-dim]');
    if (!chip) return;
    state.dimension = chip.dataset.dim!;
    renderDimension();
  });

  // Clicking a buyer, team or salesperson searches for it, which filters the
  // whole page — the quarters and the headline rate along with the rows.
  el.dimGrid.addEventListener('click', (event) => {
    const tr = (event.target as HTMLElement).closest<HTMLElement>('[data-name]');
    if (!tr) return;
    const name = tr.dataset.name!;
    const next = state.q === name ? '' : name;
    el.search.value = next;
    state.q = next;
    reload();
  });

  el.grid.addEventListener('click', (event) => {
    const tr = (event.target as HTMLElement).closest<HTMLElement>('[data-sample]');
    if (!tr) return;
    const detail = el.grid.querySelector<HTMLElement>(
      `[data-detail="${CSS.escape(tr.dataset.sample!)}"]`,
    );
    if (!detail) return;
    detail.hidden = !detail.hidden;
    tr.classList.toggle('open', !detail.hidden);
  });

  let searchTimer: number | undefined;
  el.search.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      state.q = el.search.value.trim();
      reload();
    }, 250);
  });

  el.prev.addEventListener('click', () => {
    state.offset = Math.max(0, state.offset - state.limit);
    void loadPage();
  });
  el.next.addEventListener('click', () => {
    state.offset += state.limit;
    void loadPage();
  });

  el.refresh.addEventListener('click', () => {
    state.offset = 0;
    void load(true);
  });

  el.exportBtn.addEventListener('click', async () => {
    // The table shows a page; the export is everything the filters match.
    const p = new URLSearchParams(query());
    p.set('offset', '0');
    p.set('limit', '1000');
    const all: any[] = [];
    for (let offset = 0; ; offset += 1000) {
      p.set('offset', String(offset));
      const res = await fetch(`/api/sample-conversion?${p}`);
      const data = await res.json();
      if (!res.ok) break;
      all.push(...data.rows);
      if (all.length >= data.matched || !data.rows.length) break;
    }
    const lines = [
      'Sample,Raised,Unit,Buyer,Customer,Sales team,Salesperson,Marketing person,Region,Bulk orders,Bulk value,Days to convert,Outcome',
      ...all.map((r) =>
        [
          r.no,
          r.date,
          r.company === 'zipper' ? 'Zipper' : 'Metal Trims',
          `"${String(r.buyer).replace(/"/g, '""')}"`,
          `"${String(r.customer).replace(/"/g, '""')}"`,
          `"${String(r.team).replace(/"/g, '""')}"`,
          `"${String(r.salesperson).replace(/"/g, '""')}"`,
          `"${String(r.marketer).replace(/"/g, '""')}"`,
          `"${String(r.region).replace(/"/g, '""')}"`,
          `"${r.oas
            .map((o: any) => `${o.no}${o.date ? ` (${o.date}, ${o.via})` : ''}`)
            .join(' ')}"`,
          Math.round(r.bulkValue),
          r.lagDays ?? '',
          r.converted ? 'Converted' : r.mature ? 'Not taken up' : 'Still open',
        ].join(','),
      ),
    ];
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Sample conversion ${state.data?.label ?? state.fy}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  let resizeTimer: number | undefined;
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => state.data && renderCharts(), 180);
  });

  // The browser restores the search box and the tab selection on a reload, so
  // the page reads them rather than assuming its own defaults — otherwise the
  // headline is filtered and the controls say it is not.
  state.q = el.search.value.trim();
  state.company =
    document.querySelector<HTMLElement>('#co-seg [aria-selected="true"]')?.dataset.co ?? 'all';
  state.fy = Number(
    document.querySelector<HTMLElement>('#fy-seg [aria-selected="true"]')?.dataset.fy ?? state.fy,
  );
  state.only =
    document.querySelector<HTMLElement>('#sc-filters .chip.active')?.dataset.only ?? 'converted';

  void load();
}
