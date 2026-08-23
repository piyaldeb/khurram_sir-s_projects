/**
 * Zipper RM demand plan against what was actually consumed.
 *
 * Nothing on this page is copied from the sheet's answer columns. Required is
 * the demand times the rate; consumed, stock and GIT come from Odoo. The sheet
 * contributes its questions — the demand, the rate, and the two hand-entered
 * stock columns — not its answers.
 *
 * Three tables behind one switch, because they answer three questions in
 * different vocabularies and stacking them would imply a join that does not
 * exist:
 *
 *   Materials — the plan's own rows, recomputed.
 *   Sliders   — the STI slider block of the same sheet.
 *   Odoo      — the month by item category, so the plan can be checked against
 *               the system rather than trusted.
 *
 * Deviation is consumed minus required. Over the requirement is the one that
 * costs money, so that is the red one; at or under it is green.
 *
 * Quantities are counted in the ledger's own units and carry no symbol; money
 * always does.
 */
import { barChart, bindChartTooltips } from '../lib/charts';
import { skeleton } from '../lib/skeleton';

interface DemandRow {
  group: string;
  type: string | null;
  material: string;
  slider: string | null;
  from: { key: string; demand: number; rate: number; factor: number }[];
  demandBd: number | null;
  demandExport: number | null;
  demandTotal: number | null;
  demandValue: number | null;
  required: number | null;
  requiredValue: number | null;
  unitCost: number | null;
  costBasis: 'consumed' | 'stock' | 'trailing' | null;
  requiredFrom: 'formula' | 'unavailable';
  op: number | null;
  ih: number | null;
  opIh: number | null;
  consumption: number | null;
  consumptionValue: number | null;
  currentStock: number | null;
  currentStockValue: number | null;
  git: number | null;
  gitValue: number | null;
  gitLines: number;
  totalAvailable: number | null;
  availability: number | null;
  unit: string | null;
  matchedOn: string[];
}

interface CategoryDemand {
  key: string;
  group: string;
  type: string;
  rate: number;
  bd: number;
  export: number;
  total: number;
  value: number;
}

interface LiveCategory {
  category: string;
  unit: string | null;
  consumption: number;
  consumptionValue: number;
  currentStock: number;
  currentStockValue: number;
  git: number;
  gitValue: number;
  gitLines: number;
}

interface DemandReport {
  month: string;
  months: string[];
  projected: boolean;
  stockAsOf: string;
  company: string;
  source: string;
  demand: CategoryDemand[];
  materials: DemandRow[];
  sliders: DemandRow[];
  live: LiveCategory[];
  unmapped: string[];
  unmatched: string[];
  error?: string;
}

interface MonthPoint {
  month: string;
  consumption: number;
  consumptionValue: number;
  closing: number;
  closingValue: number;
}

interface Shipment {
  transit: string;
  vendor: string;
  po: string;
  eta: string | null;
  ihPlan: string | null;
  mode: string;
  qty: number;
  value: number;
  product: string;
  category: string;
}

interface ItemLine {
  code: string;
  name: string;
  unit: string;
  consumption: number;
  consumptionValue: number;
  closing: number;
  closingValue: number;
}

interface RowDetail {
  key: string;
  matchedOn: string[];
  months: MonthPoint[];
  shipments: Shipment[];
  items: ItemLine[];
  error?: string;
}

type View = 'materials' | 'sliders' | 'live';

const root = document.querySelector<HTMLElement>('.rmd');

if (root) {
  const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
  const el = {
    status: $<HTMLElement>('#rmd-status'),
    body: $<HTMLElement>('#rmd-body'),
    rail: $<HTMLElement>('#rmd-rail'),
    grid: $<HTMLElement>('#rmd-grid'),
    note: $<HTMLElement>('#rmd-note'),
    viewSeg: $<HTMLElement>('#rmd-view'),
    fySeg: $<HTMLElement>('#rmd-fy'),
    monthPick: $<HTMLSelectElement>('#rmd-month'),
  };

  const state = {
    view: 'materials' as View,
    /** '' means whichever month the server picks — the last settled one. */
    month: '',
    /** The fiscal year the month picker is scoped to; '' until the first load. */
    fy: '',
    open: null as string | null,
    report: null as DemandReport | null,
    detail: new Map<string, RowDetail | 'loading'>(),
  };

  const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const qty = (v: number | null | undefined) =>
    v === null || v === undefined ? '—' : nf.format(Math.round(v));
  const usd = (v: number | null | undefined) =>
    v === null || v === undefined ? '—' : `$${nf.format(Math.round(v))}`;
  const usdShort = (v: number | null | undefined) => {
    if (v === null || v === undefined) return '—';
    const a = Math.abs(v);
    if (a >= 1e6) return `$${(v / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
    if (a >= 1e3) return `$${Math.round(v / 1e3)}k`;
    return `$${Math.round(v)}`;
  };
  /**
   * Cover, which must never round across its own threshold.
   *
   * 99.8% shown as a red "100%" reads as a contradiction — the colour says
   * short, the number says covered. One decimal near the line, none once it is
   * far enough away for the precision to be noise.
   */
  const pct = (v: number | null) => {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    const near = Math.abs(v - 1) < 0.05;
    return `${(v * 100).toFixed(near ? 1 : 0)}%`;
  };
  const esc = (s: string | number) =>
    String(s).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
    );

  /** April to March, the way the plant counts a year. */
  const fyOf = (month: string) => {
    const [y, m] = month.split('-').map(Number);
    return m >= 4 ? y : y - 1;
  };
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
  const day = (iso: string | null) =>
    !iso
      ? '—'
      : new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
          day: '2-digit',
          month: 'short',
          timeZone: 'UTC',
        });

  const VIEWS: { key: View; label: string }[] = [
    { key: 'materials', label: 'Materials' },
    { key: 'sliders', label: 'STI sliders' },
    { key: 'live', label: 'Odoo, this month' },
  ];

  const rowsOf = (r: DemandReport) =>
    state.view === 'sliders' ? r.sliders : state.view === 'materials' ? r.materials : [];
  const keyOf = (row: DemandRow) => `${row.group}|${row.type ?? ''}|${row.slider ?? row.material}`;

  /* ------------------------------------------------------------------ load */

  async function load() {
    el.status.hidden = true;
    el.body.hidden = false;
    el.rail.innerHTML = skeleton.rail();
    el.grid.innerHTML = skeleton.table(12, 12);

    try {
      const res = await fetch(`/api/rm-demand${state.month ? `?month=${state.month}` : ''}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      state.report = data as DemandReport;
      render();
    } catch (err) {
      el.body.hidden = true;
      el.status.hidden = false;
      el.status.classList.add('error');
      el.status.innerHTML = `<h2>Could not build the report</h2><p style="font-family:var(--mono);font-size:12.5px">${esc(
        (err as Error).message,
      )}</p>`;
    }
  }

  async function loadDetail(row: DemandRow) {
    const key = keyOf(row);
    if (state.detail.has(key)) return;
    state.detail.set(key, 'loading');

    const kind = row.slider ? 'slider' : 'material';
    const target = row.slider ?? row.material;
    const group = row.slider ? '' : `&group=${encodeURIComponent(row.group)}`;
    const month = state.report?.month ?? '';

    try {
      const res = await fetch(
        `/api/rm-demand?row=${encodeURIComponent(
          target,
        )}&kind=${kind}&month=${month}${group}`,
      );
      const data = await res.json();
      state.detail.set(
        key,
        res.ok ? (data as RowDetail) : ({ ...data, error: data?.error } as RowDetail),
      );
    } catch (err) {
      state.detail.set(key, {
        key,
        matchedOn: [],
        months: [],
        shipments: [],
        items: [],
        error: (err as Error).message,
      });
    }
    if (state.open === key && state.report) renderGrid(state.report);
  }

  /* --------------------------------------------------------------- shaping */

  const deviationOf = (row: DemandRow) =>
    row.consumptionValue === null || row.requiredValue === null
      ? null
      : row.consumptionValue - row.requiredValue;

  interface Totals {
    required: number;
    requiredValue: number;
    totalAvailableValue: number;
    hasRequired: boolean;
    consumption: number;
    consumptionValue: number;
    currentStock: number;
    currentStockValue: number;
    git: number;
    gitValue: number;
    totalAvailable: number;
  }

  function totalsOf(rows: DemandRow[]): Totals {
    const add = (pick: (r: DemandRow) => number | null) =>
      rows.reduce((a, r) => a + (pick(r) ?? 0), 0);
    return {
      required: add((r) => r.required),
      hasRequired: rows.some((r) => r.required !== null),
      consumption: add((r) => r.consumption),
      consumptionValue: add((r) => r.consumptionValue),
      currentStock: add((r) => r.currentStock),
      currentStockValue: add((r) => r.currentStockValue),
      git: add((r) => r.git),
      gitValue: add((r) => r.gitValue),
      totalAvailable: add((r) => r.totalAvailable),
      requiredValue: add((r) => r.requiredValue),
      totalAvailableValue: add((r) => (r.currentStockValue ?? 0) + (r.gitValue ?? 0)),
    };
  }

  /* ------------------------------------------------------------------ rail */

  const railBlock = (label: string, body: string, note = '') =>
    `<section class="rail-block">
      <h2>${label}</h2>
      ${body}
      ${note ? `<p class="rail-note">${note}</p>` : ''}
    </section>`;

  function renderRail(r: DemandReport) {
    const materials = totalsOf(r.materials);
    const sliders = totalsOf(r.sliders);

    // Materials and sliders are counted in different units — grosses against
    // pieces — so they are never added together, only shown side by side.
    const block = (label: string, t: Totals, of: DemandRow[]) => {
      const dev = t.consumptionValue - t.requiredValue;
      const over = dev > 0;
      const short = of.filter((row) => row.availability !== null && row.availability < 1).length;
      return `<div class="rail-split">
        <div class="rail-split-head">
          <span>${esc(label)}</span>
          <b>${usd(t.consumptionValue)}${
            t.hasRequired ? ` <span class="rail-of">of ${usd(t.requiredValue)}</span>` : ''
          }</b>
        </div>
        <p class="rail-note">
          ${
            t.hasRequired
              ? `<span class="rmd-dev ${over ? 'over' : 'under'}">${over ? '▲ +' : '▼ '}${usd(
                  Math.abs(dev),
                )}</span> against the requirement · `
              : 'consumed · '
          }${qty(t.consumption)} ${esc(of[0]?.unit ?? '')}${
            t.hasRequired
              ? ` · ${qty(short)} row${short === 1 ? '' : 's'} under cover`
              : ' · no requirement in Odoo'
          }
        </p>
      </div>`;
    };

    /*
     * A month the ledger has not reached says so plainly. Its requirement is
     * real and its consumption is nothing, and without that sentence the two
     * read as a collapse rather than as a month that has not happened.
     */
    const head = `<div class="rail-head">
      <p class="eyebrow">${esc(monthLong(r.month))} · ${esc(r.company)}${
        r.projected ? ' · <span class="rmd-ahead">not started</span>' : ''
      }</p>
      <h2 class="rail-title">${
        r.projected ? 'Required against what is coming' : 'Required against consumed'
      }</h2>
      <p class="rail-sub">${
        r.projected
          ? `The requirement is real — it comes from the forecast for this month. Nothing has been
             consumed yet, so stock is the position at ${esc(
               monthLong(r.stockAsOf),
             )} and GIT counts only what is planned in-house by the end of the month.`
          : `The month's requirement worked out from the demand and the rate, against what the
             ledger says was actually issued — and what is still on the water behind it.`
      }</p>
    </div>`;

    const totals = railBlock(
      'Against the plan',
      block('Materials', materials, r.materials) + block('STI sliders', sliders, r.sliders),
      'Materials and sliders are counted in different units — the two are never added.',
    );

    const live = r.live.reduce(
      (a, c) => ({
        stock: a.stock + c.currentStock,
        stockValue: a.stockValue + c.currentStockValue,
        git: a.git + c.git,
        gitValue: a.gitValue + c.gitValue,
        lines: a.lines + c.gitLines,
      }),
      { stock: 0, stockValue: 0, git: 0, gitValue: 0, lines: 0 },
    );

    const onWater = railBlock(
      'On the water',
      `<p class="rail-figure">${usd(live.gitValue)}</p>
       <p class="rail-sub">${qty(live.git)} units in transit across ${qty(live.lines)} line${
         live.lines === 1 ? '' : 's'
       } not yet in-housed, against ${usd(live.stockValue)} in stock at month close.</p>`,
      'A position, not a flow — whatever month it shipped in.',
    );

    el.rail.innerHTML = head + totals + onWater;
  }

  /* ----------------------------------------------------------------- cells */

  const devCell = (dev: number | null) => {
    if (dev === null) return '<td class="num">—</td>';
    if (Math.round(dev) === 0) return '<td class="num muted">$0</td>';
    const over = dev > 0;
    return `<td class="num"><span class="rmd-dev ${over ? 'over' : 'under'}">${
      over ? '▲ +' : '▼ '
    }${usd(Math.abs(dev))}</span></td>`;
  };

  const availCell = (v: number | null) =>
    v === null || v === undefined || !Number.isFinite(v)
      ? '<td class="num muted">—</td>'
      : `<td class="num ${v < 1 ? 'behind' : 'ahead'}">${pct(v)}</td>`;

  /**
   * Money on top, the quantity that produced it underneath.
   *
   * The page reads in value — that is the language the business plans in, and
   * the only one every material shares. The quantity stays because a planner
   * orders in kilos and pieces, not dollars, and because it is what makes the
   * cover figure mean anything.
   */
  const pairCell = (value: number | null, n: number | null, tinted = false) =>
    `<td class="num${tinted ? ' tinted' : ''}"><span class="rmd-qty">${usd(value)}</span>${
      n === null || n === undefined ? '' : `<span class="rmd-val">${qty(n)}</span>`
    }</td>`;

  /* ------------------------------------------------------------ drill-down */

  function detailRow(row: DemandRow, span: number): string {
    const detail = state.detail.get(keyOf(row));
    const loaded = detail && detail !== 'loading' ? detail : null;

    const stat = (label: string, figure: string, note = '') =>
      `<div class="oa-stat">
        <span class="oa-stat-label">${esc(label)}</span>
        <b class="oa-stat-figure">${figure}</b>
        ${note ? `<span class="oa-stat-note">${note}</span>` : ''}
      </div>`;

    /*
     * The requirement is the one figure on the page that is worked out rather
     * than read, so the row shows the working: every zipper category that feeds
     * it, its forecast, and the rate and factor applied to it.
     */
    const working = row.from.length
      ? `<div class="rmd-working">
          <span class="rmd-working-label">Required =</span>
          ${row.from
            .map(
              (f) =>
                `<span class="rmd-term">${esc(f.key)} ${qty(f.demand)} × ${f.rate} × ${
                  f.factor
                }</span>`,
            )
            .join('<span class="rmd-plus">+</span>')}
          <span class="rmd-working-label">÷ 1000 = ${qty(row.required)}${
            row.unit ? ` ${esc(row.unit)}` : ''
          }${row.requiredValue === null ? '' : ` = ${usd(row.requiredValue)}`}</span>
        </div>`
      : '';

    const inputs = `<div class="oa-stats">
      ${row.demandBd === null ? '' : stat('Demand BD', qty(row.demandBd), 'zippers')}
      ${row.demandExport === null ? '' : stat('Export', qty(row.demandExport), 'zippers')}
      ${
        row.demandTotal === null
          ? ''
          : stat('Ordered', usd(row.demandValue), `${qty(row.demandTotal)} zippers`)
      }
      ${stat(
        'Required',
        row.requiredValue === null ? '—' : usd(row.requiredValue),
        row.required === null
          ? 'not in Odoo'
          : `${qty(row.required)} ${row.unit ?? ''}`.trim(),
      )}
      ${
        row.unitCost === null
          ? ''
          : stat(
              'Priced at',
              `$${row.unitCost.toFixed(2)}`,
              `per ${row.unit ?? 'unit'}, from ${
                row.costBasis === 'stock'
                  ? 'what is in stock'
                  : row.costBasis === 'trailing'
                    ? 'the trailing year'
                    : 'what was consumed'
              }`,
            )
      }
      ${stat('Opening', qty(row.op), row.unit ?? '')}
      ${row.ih === null ? '' : stat('In-house this month', qty(row.ih), row.unit ?? '')}
    </div>`;

    const head = `<div class="oa-detail-head">
      <div class="oa-detail-title">
        <p class="eyebrow">${esc(row.group)}${
          loaded?.matchedOn.length ? ` · ${esc(loaded.matchedOn.slice(0, 2).join(', '))}` : ''
        }</p>
        <h2>${esc(row.slider ?? row.material)}</h2>
      </div>
      ${inputs}
    </div>
    ${working}`;

    if (!loaded) {
      return `<tr class="day-detail"><td colspan="${span}">
        <div class="oa-detail">${head}
          <div class="oa-detail-loading"><span class="spinner"></span> Reading ${esc(
            row.slider ?? row.material,
          )} from Odoo…</div>
        </div></td></tr>`;
    }
    if (loaded.error) {
      return `<tr class="day-detail"><td colspan="${span}">
        <div class="oa-detail">${head}<p class="oa-panel-empty">${esc(loaded.error)}</p></div>
      </td></tr>`;
    }

    const items = loaded.items.length
      ? `<section class="oa-panel">
          <header><h3>Items underneath</h3><span>${esc(
            monthShort(state.report?.month ?? ''),
          )}</span></header>
          <ol class="oa-breakdown rmd-items">
            ${loaded.items
              .slice(0, 8)
              .map(
                (i) => `<li>
                  <span class="oa-bd-name">${esc(i.name)}<span class="rmd-code">${esc(
                    i.code,
                  )}</span></span>
                  <span class="oa-bd-value">${qty(i.consumption)}<span class="rmd-unit">${esc(
                    i.unit,
                  )}</span></span>
                  <span class="oa-bd-share">${usdShort(i.consumptionValue)}</span>
                </li>`,
              )
              .join('')}
          </ol>
        </section>`
      : '';

    const shipments = loaded.shipments.length
      ? `<section class="oa-panel wide">
          <header>
            <h3>What is on the water</h3>
            <span>${qty(loaded.shipments.length)} line${
              loaded.shipments.length === 1 ? '' : 's'
            } not yet in-housed</span>
          </header>
          <div class="rmd-ship-scroll">
            <table class="grid mini rmd-ship">
              <thead><tr>
                <th class="text">Shipment</th><th class="text">Vendor</th><th class="text">PO</th>
                <th class="text">Mode</th><th class="text">ETA</th><th class="text">I/H plan</th>
                <th class="num">Qty</th><th class="num">Value</th>
              </tr></thead>
              <tbody>${loaded.shipments
                .slice(0, 12)
                .map(
                  (s) => `<tr>
                    <td class="text mono">${esc(s.transit)}</td>
                    <td class="text">${esc(s.vendor)}</td>
                    <td class="text mono">${esc(s.po)}</td>
                    <td class="text">${esc(s.mode)}</td>
                    <td class="text">${esc(day(s.eta))}</td>
                    <td class="text">${esc(day(s.ihPlan))}</td>
                    <td class="num">${qty(s.qty)}</td>
                    <td class="num">${usd(s.value)}</td>
                  </tr>`,
                )
                .join('')}</tbody>
            </table>
          </div>
        </section>`
      : `<section class="oa-panel wide">
          <header><h3>What is on the water</h3></header>
          <p class="oa-panel-empty">Nothing in transit for this row.</p>
        </section>`;

    return `<tr class="day-detail"><td colspan="${span}">
      <div class="oa-detail">
        ${head}
        <div class="chart-host rmd-history"></div>
        ${items ? `<div class="oa-panels">${items}</div>` : ''}
        ${shipments}
      </div>
    </td></tr>`;
  }

  /** Draws the open row's twelve-month consumption once it is in the document. */
  function drawOpenHistory() {
    if (!state.open) return;
    const detail = state.detail.get(state.open);
    if (!detail || detail === 'loading' || !detail.months.length) return;
    const host = document.querySelector<HTMLElement>('.rmd-history');
    if (!host) return;

    host.innerHTML = barChart({
      categories: detail.months.map((m) => monthShort(m.month)),
      width: Math.max(host.clientWidth || 640, 420),
      height: 200,
      format: qty,
      series: [
        { name: 'Consumed', color: '--series-1', values: detail.months.map((m) => m.consumption) },
      ],
    });
    bindChartTooltips(host);
  }

  /* ----------------------------------------------------------------- table */

  function groupedRows(rows: DemandRow[], cells: (row: DemandRow) => string, span: number): string {
    let last = '';
    return rows
      .map((row) => {
        const label = row.group;
        const heading =
          label === last
            ? ''
            : `<tr class="company-row"><td class="sticky-col" colspan="${span}">${esc(
                label,
              )}</td></tr>`;
        last = label;
        const key = keyOf(row);
        const open = state.open === key;
        return (
          heading +
          `<tr class="day-row can-open${open ? ' open' : ''}" data-row="${esc(
            key,
          )}" tabindex="0" role="button" aria-expanded="${open}">${cells(row)}</tr>` +
          (open ? detailRow(row, span) : '')
        );
      })
      .join('');
  }

  function planTable(rows: DemandRow[], isMaterial: boolean): string {
    const span = isMaterial ? 12 : 11;

    const cells = (row: DemandRow) => {
      const open = state.open === keyOf(row);
      return (
        `<td class="sticky-col"><span class="disclose" aria-hidden="true">${
          open ? '▾' : '▸'
        }</span>${esc(isMaterial ? row.material : (row.slider ?? ''))}${
          row.unit ? `<span class="rmd-unit-tag">${esc(row.unit)}</span>` : ''
        }</td>` +
        (isMaterial ? `<td class="co">${esc(row.type ?? '')}</td>` : '') +
        (row.demandTotal === null
          ? '<td class="num muted">—</td>'
          : pairCell(row.demandValue, row.demandTotal)) +
        (row.required === null
          ? '<td class="num"><span class="rmd-note" title="The requirement per slider is set by hand in the workbook and no readable Odoo model carries it.">not in Odoo</span></td>'
          : pairCell(row.requiredValue, row.required)) +
        pairCell(row.consumptionValue, row.consumption, true) +
        devCell(deviationOf(row)) +
        `<td class="num muted">${qty(row.opIh)}</td>` +
        pairCell(row.currentStockValue, row.currentStock) +
        pairCell(row.gitValue, row.git) +
        pairCell(
          (row.currentStockValue ?? 0) + (row.gitValue ?? 0),
          row.totalAvailable,
        ) +
        availCell(row.availability)
      );
    };

    const t = totalsOf(rows);
    const dev = t.consumptionValue - t.requiredValue;

    const total = `<tr class="grand-row">
      <td class="sticky-col" colspan="${isMaterial ? 2 : 1}">All ${qty(rows.length)} rows</td>
      <td class="num"></td>
      ${t.hasRequired ? pairCell(t.requiredValue, t.required) : '<td class="num">—</td>'}
      ${pairCell(t.consumptionValue, t.consumption)}
      ${devCell(t.hasRequired ? dev : null)}
      <td class="num"></td>
      ${pairCell(t.currentStockValue, t.currentStock)}
      ${pairCell(t.gitValue, t.git)}
      ${pairCell(t.totalAvailableValue, t.totalAvailable)}
      ${availCell(
        t.hasRequired && t.requiredValue ? t.totalAvailableValue / t.requiredValue : null,
      )}
    </tr>`;

    /*
     * Two tiers, because the first figure is not in the same unit as the rest.
     * Demand is finished zippers, in pieces; everything after it is the raw
     * material that makes them. Side by side with nothing to say so,
     * 6,722,653 against 29,741 reads as an error rather than as zippers
     * against kilos of the wire they are made from.
     *
     * The band cannot name one unit for the material half: the ledger counts
     * wire and tape in kg, sliders in pieces. Each row carries its own.
     */
    return `<table class="grid day-grid rmd-sheet">
      <thead>
        <tr>
          <th class="sticky-col"></th>
          ${isMaterial ? '<th></th>' : ''}
          <th class="group-head">Ordered · USD, pcs beneath</th>
          <th class="group-head" colspan="3">${
            state.report?.projected ? 'Material needed' : 'Material this month'
          } · USD, qty beneath</th>
          <th class="group-head" colspan="5">What is available · USD, qty beneath</th>
        </tr>
        <tr class="sub-row">
          <th class="sticky-col">${isMaterial ? 'Material' : 'Slider'}</th>
          ${isMaterial ? '<th class="text">Type</th>' : ''}
          <th class="num">Order $</th>
          <th class="num">Required $</th>
          <th class="num">Consumed $</th>
          <th class="num">Deviation $</th>
          <th class="num">OP + I/H</th>
          <th class="num">Current stock $</th>
          <th class="num">GIT $</th>
          <th class="num">Total available $</th>
          <th class="num">Cover</th>
        </tr>
      </thead>
      <tbody>${groupedRows(rows, cells, span)}${total}</tbody>
    </table>`;
  }

  function liveTable(r: DemandReport): string {
    if (!r.live.length) {
      return '<div class="state"><h2>Nothing to show</h2><p>Odoo returned no ledger rows for the plan’s month.</p></div>';
    }
    const rows = r.live
      .map(
        (c) => `<tr>
          <td class="sticky-col">${esc(c.category)}${
            c.unit ? `<span class="rmd-unit-tag">${esc(c.unit)}</span>` : ''
          }</td>
          ${pairCell(c.consumptionValue, c.consumption, true)}
          ${pairCell(c.currentStockValue, c.currentStock)}
          ${pairCell(c.gitValue, c.git)}
          <td class="num muted">${qty(c.gitLines)}</td>
        </tr>`,
      )
      .join('');

    return `<table class="grid day-grid rmd-sheet">
      <thead>
        <tr class="sub-row">
          <th class="sticky-col">Item category</th>
          <th class="num">Consumed $</th>
          <th class="num">Closing stock $</th>
          <th class="num">In transit $</th>
          <th class="num">Transit lines</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  function renderGrid(r: DemandReport) {
    el.grid.innerHTML =
      state.view === 'live' ? liveTable(r) : planTable(rowsOf(r), state.view === 'materials');

    drawOpenHistory();

    /*
     * Both vocabularies are shown as they are, and the places they do not meet
     * are named. Folding "Alm Wire" into METAL WIRE because it looks close
     * would make the sheet tie out and the figures wrong.
     */
    const gaps: string[] = [];
    if (state.view === 'live' && r.unmapped.length) {
      gaps.push(
        `${r.unmapped.length} categor${
          r.unmapped.length === 1 ? 'y' : 'ies'
        } here are not in the plan at all: ${r.unmapped.slice(0, 6).join(', ')}${
          r.unmapped.length > 6 ? ', …' : ''
        }.`,
      );
    }
    if (state.view === 'materials' && r.unmatched.length) {
      gaps.push(
        `The plan's ${r.unmatched.join(
          ', ',
        )} has no item category of its own in the Zipper ledger, so it has no live figure to check against.`,
      );
    }
    if (r.error) gaps.push(`Odoo: ${r.error}`);

    if (r.projected) {
      gaps.push(
        `${monthLong(r.month)} has not started: the requirement is the forecast, stock is the ` +
          `position at ${monthLong(r.stockAsOf)}, and GIT is only what is planned in-house by ` +
          `the end of the month. Consumption is nothing because nothing has happened yet.`,
      );
    }

    el.note.textContent =
      gaps.join(' ') ||
      'Every figure is read from Odoo: demand from the rolling forecast, the rest from the raw-material ledger and the transit lines. Only the formula behind Required comes from the workbook. Money leads with the quantity beneath it; Required is priced at what the ledger itself paid, so the two sides are comparable. Demand is finished zippers in pieces and is not.';
  }

  function renderControls(r: DemandReport) {
    el.viewSeg.innerHTML = VIEWS.map(
      (v) =>
        `<button class="seg" type="button" role="tab" data-view="${v.key}" aria-selected="${
          state.view === v.key
        }">${esc(v.label)}</button>`,
    ).join('');

    /*
     * The fiscal year picks the shelf; the month picks off it. Sixteen months
     * in one select is a list you have to read; four years and five months is
     * two glances.
     *
     * The year follows the month whenever the server chose it, so the controls
     * always agree with the sheet underneath them.
     */
    const fys = [...new Set(r.months.map(fyOf))].sort((a, b) => b - a);
    const fy = state.fy && fys.includes(Number(state.fy)) ? Number(state.fy) : fyOf(r.month);
    state.fy = String(fy);

    el.fySeg.innerHTML = fys
      .map(
        (y) =>
          `<button class="seg" type="button" role="tab" data-fy="${y}" aria-selected="${
            y === fy
          }">${esc(fyLabel(y))}</button>`,
      )
      .join('');

    const inYear = r.months.filter((m) => fyOf(m) === fy);
    el.monthPick.innerHTML = [...inYear]
      .reverse()
      .map(
        (m) =>
          `<option value="${m}"${m === r.month ? ' selected' : ''}>${esc(monthLong(m))}</option>`,
      )
      .join('');
    el.monthPick.disabled = inYear.length < 2;
  }

  function render() {
    const r = state.report;
    if (!r) return;
    renderControls(r);
    renderRail(r);
    renderGrid(r);
    el.status.hidden = true;
    el.body.hidden = false;
  }

  /* ---------------------------------------------------------------- events */

  function toggleRow(key: string) {
    const r = state.report;
    if (!r) return;
    state.open = state.open === key ? null : key;
    const row = rowsOf(r).find((x) => keyOf(x) === key);
    if (state.open && row) void loadDetail(row);
    renderGrid(r);
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

  el.fySeg.addEventListener('click', (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLElement>('[data-fy]');
    if (!btn || btn.dataset.fy === state.fy) return;
    state.fy = btn.dataset.fy!;

    // Land on the latest month of that year that the forecast actually has,
    // so switching year never lands on an empty sheet.
    const inYear = (state.report?.months ?? []).filter((m) => String(fyOf(m)) === state.fy);
    state.month = inYear.at(-1) ?? '';
    state.open = null;
    state.detail.clear();
    void load();
  });

  el.monthPick.addEventListener('change', () => {
    state.month = el.monthPick.value;
    state.open = null;
    state.detail.clear();
    void load();
  });

  el.viewSeg.addEventListener('click', (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLElement>('[data-view]');
    if (!btn) return;
    state.view = btn.dataset.view as View;
    // A different table has different rows, so nothing carries over.
    state.open = null;
    render();
  });

  let resizeTimer: number | undefined;
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(drawOpenHistory, 180);
  });

  if (root.dataset.odoo !== '1') {
    el.status.innerHTML =
      '<h2>Not connected</h2><p>Set the Odoo credentials in .env to check the plan against the ledger.</p>';
  } else {
    void load();
  }
}
