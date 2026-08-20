/**
 * Budget follow-up: month sheet, fiscal year and year-to-date.
 *
 * The month view is the workbook's "<Month>- Automation" sheet made live —
 * `computeBudget` holds the formulas. Targets and the working calendar come
 * from the planning workbook; production is fetched from Odoo.
 */
import {
  computeBudget,
  defaultDays,
  emptyDoc,
  monthLabel,
  planFor,
  renumber,
  todayIso,
  type BudgetDoc,
  type BudgetView,
} from '../lib/budget';
import { bindChartTooltips, barChart, lineChart } from '../lib/charts';
import type { PeriodSummary } from '../lib/summary';

import { skeleton } from '../lib/skeleton';

const root = document.querySelector<HTMLElement>('.budget');

if (root) {
  const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
  const maybe = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel);

  const el = {
    viewMonth: $<HTMLElement>('#view-month'),
    viewPeriod: $<HTMLElement>('#view-period'),
    pickerMonth: $<HTMLElement>('#picker-month'),
    pickerFy: $<HTMLElement>('#picker-fy'),
    monthSelect: $<HTMLSelectElement>('#month-select'),
    fySelect: $<HTMLSelectElement>('#fy-select'),
    lede: $<HTMLElement>('#page-lede'),
    monthRail: $<HTMLElement>('#month-rail'),
    monthGrid: $<HTMLElement>('#month-grid'),
    monthNote: $<HTMLElement>('#month-note'),
    chartNote: $<HTMLElement>('#chart-note'),
    save: $<HTMLButtonElement>('#save'),
    saveState: $<HTMLElement>('#save-state'),
    chartCumulative: $<HTMLElement>('#chart-cumulative'),
    chartDaily: $<HTMLElement>('#chart-daily'),
    periodKpis: $<HTMLElement>('#period-kpis'),
    periodRows: $<HTMLElement>('#period-rows'),
    periodFoot: $<HTMLElement>('#period-foot'),
    periodTitle: $<HTMLElement>('#period-title'),
    chartMonths: $<HTMLElement>('#chart-months'),
    chartPeriodCum: $<HTMLElement>('#chart-period-cum'),
    chartSplit: $<HTMLElement>('#chart-split'),
    backfill: $<HTMLButtonElement>('#backfill'),
    syncbar: $<HTMLElement>('#syncbar'),
    syncDot: $<HTMLElement>('#sync-dot'),
    syncTitle: $<HTMLElement>('#sync-title'),
    syncNote: $<HTMLElement>('#sync-note'),
    syncNow: $<HTMLButtonElement>('#sync-now'),
    periodState: $<HTMLElement>('#period-state'),
    periodHeading: $<HTMLElement>('#period-heading'),
    periodSub: $<HTMLElement>('#period-sub'),
  };

  type View = 'month' | 'fy' | 'ytd';

  const state = {
    view: 'month' as View,
    month: root.dataset.month ?? '',
    fy: Number(root.dataset.fy ?? 0),
    odoo: root.dataset.odoo === '1',
    doc: emptyDoc(root.dataset.month ?? ''),
    period: null as PeriodSummary | null,
    dirty: false,
  };

  const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const esc = (s: string | number) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  /** Every figure on this page is a USD value, so all of them carry the symbol. */
  const money = (v: number) => `$${nf.format(Math.round(v))}`;
  /** Plain counts (days, months) must not. */
  const count = (v: number) => nf.format(Math.round(v));

  /* -------------------------------------------------------------- plumbing */

  function markDirty() {
    state.dirty = true;
    el.saveState.textContent = 'Unsaved changes';
    el.saveState.className = 'save-state dirty';
  }

  function markSaved(when?: string) {
    state.dirty = false;
    el.saveState.textContent = when ? `Saved ${new Date(when).toLocaleTimeString()}` : 'Saved';
    el.saveState.className = 'save-state';
  }

  const tile = (label: string, value: string, sub: string, tone?: 'warn' | 'good') =>
    `<div class="kpi${tone ? ` ${tone}` : ''}"><div class="label">${esc(label)}</div><div class="value">${esc(
      value,
    )}</div><div class="sub">${esc(sub)}</div></div>`;

  const chartWidth = (host: HTMLElement) => Math.max(host.clientWidth || 640, 320);

  /* ------------------------------------------------------------ syncing */

  /** "4 minutes ago" reads better than a timestamp for something this recent. */
  function ago(iso: string): string {
    const seconds = Math.max((Date.now() - new Date(iso).getTime()) / 1000, 0);
    if (seconds < 45) return 'just now';
    const minutes = seconds / 60;
    if (minutes < 60) return `${Math.round(minutes)} min ago`;
    const hours = minutes / 60;
    if (hours < 24) return `${Math.round(hours)} h ago`;
    const days = Math.round(hours / 24);
    return days === 1 ? 'yesterday' : `${days} days ago`;
  }

  let syncStatus: any = null;
  let syncing = false;

  function paintSync() {
    if (syncing) {
      el.syncbar.dataset.state = 'syncing';
      el.syncTitle.textContent = 'Syncing with Odoo…';
      return;
    }
    if (!syncStatus) return;

    const last = syncStatus.lastSyncedAt;
    const stale = syncStatus.staleMonths ?? [];
    el.syncbar.dataset.state = stale.length ? 'stale' : 'fresh';
    el.syncTitle.textContent = stale.length ? `${stale.length} ${stale.length === 1 ? 'month' : 'months'} out of date` : 'Synced';
    el.syncNote.textContent = last
      ? `Last synced ${ago(last)} · ${new Date(last).toLocaleString()}`
      : 'Never synced';
    el.syncNote.title = stale.length ? `Stale: ${stale.join(', ')}` : '';
  }

  async function loadSyncStatus() {
    try {
      const res = await fetch('/api/sync');
      syncStatus = await res.json();
      paintSync();
    } catch {
      el.syncbar.dataset.state = 'error';
      el.syncTitle.textContent = 'Cannot reach the sync service';
    }
  }

  /** `all` re-fetches everything; otherwise only the months that have gone stale. */
  async function runSync(mode: 'auto' | 'all' = 'auto', body: Record<string, unknown> = {}) {
    if (syncing) return;
    syncing = true;
    el.syncNow.disabled = true;
    paintSync();

    try {
      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, ...body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);

      syncStatus = data.status;
      syncing = false;
      paintSync();

      if (data.ran) {
        const failed = (data.result?.months ?? []).filter((m: any) => m.error);
        el.syncTitle.textContent = failed.length
          ? `Synced ${data.months.length - failed.length} of ${data.months.length} months`
          : `Synced ${data.months.length} ${data.months.length === 1 ? 'month' : 'months'}`;
        if (failed.length) {
          el.syncbar.dataset.state = 'error';
          el.syncTitle.title = failed.map((m: any) => `${m.month}: ${m.error}`).join(' | ');
        }
        // Whatever is on screen was rendered from the pre-sync figures.
        await loadMonth(state.month);
        if (state.view !== 'month') await loadPeriod(state.view === 'fy' ? 'fy' : 'ytd');
      }
    } catch (err) {
      syncing = false;
      el.syncbar.dataset.state = 'error';
      el.syncTitle.textContent = `Sync failed: ${(err as Error).message}`;
    } finally {
      el.syncNow.disabled = false;
    }
  }

  /* ------------------------------------------------------------ month view */

  /* ------------------------------------------------------------ month rail */

  const railBlock = (label: string, body: string, note = '') =>
    `<section class="rail-block">
      <h2>${label}</h2>
      ${body}
      ${note ? `<p class="rail-note">${note}</p>` : ''}
    </section>`;

  const shortDate = (iso: string) => {
    const d = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(d.getTime())
      ? iso
      : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  };

  const bar = (fillPct: number, cls = 'accent') =>
    `<div class="meter"><span class="meter-fill ${cls}" style="width:${Math.max(
      0,
      Math.min(fillPct, 100),
    ).toFixed(1)}%"></span></div>`;

  function renderRail(view: BudgetView) {
    const s = view.summary;
    const doc = state.doc;
    const plan = planFor(doc.month);
    const monthWord = monthLabel(doc.month).split(' ')[0];

    const head = `<div class="rail-head">
      <p class="eyebrow">${esc(plan?.sheet ?? monthLabel(doc.month))}</p>
      <h2 class="rail-title">Can ${esc(monthWord)} still close?</h2>
      <p class="rail-sub">Counted through ${
        s.countedThrough ? esc(shortDate(s.countedThrough)) : '—'
      } — ${count(s.daysEntered)} of ${count(s.workingDays)} working days.${
        s.pendingTotal ? " Today's shift is still running, so it is carried but not counted." : ''
      }</p>
    </div>`;

    const done = railBlock(
      `Done <span class="rail-of">of ${money(s.budget)}</span>`,
      `<p class="rail-figure">${pct(s.prodDonePct)}</p>
       <p class="rail-sub">${money(s.totalDone)}</p>
       ${bar(s.prodDonePct * 100)}`,
    );

    // The run rate only means anything while working days remain.
    const paceRatio = s.averageProduction ? (s.runRateRequired ?? 0) / s.averageProduction : 0;
    const widest = Math.max(s.runRateRequired ?? 0, s.averageProduction, 1);
    const runRate = railBlock(
      'Run rate required',
      s.runRateRequired === null
        ? '<p class="rail-figure">Month complete</p>'
        : `<p class="rail-figure">${money(s.runRateRequired)}<span class="rail-of">/day · ${count(
            s.daysRemaining,
          )} days left</span></p>
           <div class="rail-compare">
             <span>needed</span>${bar((s.runRateRequired / widest) * 100, 'critical')}<b>${money(
               s.runRateRequired,
             )}</b>
             <span>average</span>${bar((s.averageProduction / widest) * 100, 's1')}<b>${money(
               s.averageProduction,
             )}</b>
           </div>`,
      s.runRateRequired === null
        ? ''
        : `${paceRatio.toFixed(1)}× the pace held so far — plan is ${money(s.perDayRequired)}/day`,
    );

    const shortfall = s.budget - s.expectedMonthProduction;
    const expected = railBlock(
      'Expected at this pace',
      `<p class="rail-figure">${money(s.expectedMonthProduction)}</p>
       ${bar(
         s.budget ? (s.expectedMonthProduction / s.budget) * 100 : 0,
         shortfall > 0 ? 'warning' : 'good',
       )}`,
      shortfall > 0
        ? `<span class="warn">${money(shortfall)} short</span> of budget — ${pct(
            s.budget ? shortfall / s.budget : 0,
          )} of the month`
        : `<span class="good">${money(-shortfall)} over</span> budget at this pace`,
    );

    const plans = [
      {
        name: 'Zipper',
        cls: 's1',
        pctDone: s.zipperAchievedPct,
        planValue: doc.zipperPlan,
        done: s.zipperDone,
        left: s.zipperRemaining,
      },
      {
        name: 'Metal Trims',
        cls: 's2',
        pctDone: s.mtAchievedPct,
        planValue: doc.mtPlan,
        done: s.mtDone,
        left: s.mtRemaining,
      },
    ];

    const againstPlan = railBlock(
      'Against each plan',
      plans
        .map(
          (row) => `<div class="rail-split">
            <div class="rail-split-head">
              <span><i class="swatch ${row.cls}"></i>${esc(row.name)}</span>
              <b>${pct(row.pctDone)} <span class="rail-of">of ${money(row.planValue)}</span></b>
            </div>
            ${bar(row.pctDone * 100, row.cls)}
            <p class="rail-sub">${money(row.done)} done · ${money(row.left)} to go</p>
          </div>`,
        )
        .join(''),
    );

    // The only two figures on this page that are the user's, not Odoo's.
    const planCard = `<section class="rail-block panel plan-input">
      <div class="plan-input-head">
        <h2>The plan</h2><span class="input-flag">your input</span>
      </div>
      <label class="plan-field">
        <span>Zipper plan <em>E7</em></span>
        <input type="number" id="zipperPlan" min="0" step="1000" value="${doc.zipperPlan || ''}" />
      </label>
      <label class="plan-field">
        <span>Metal Trims plan <em>E9</em></span>
        <input type="number" id="mtPlan" min="0" step="1000" value="${doc.mtPlan || ''}" />
      </label>
      <dl class="rail-pairs">
        <dt>Budget <em>E5</em></dt><dd>${money(s.budget)}</dd>
        <dt>Per day <em>E6</em></dt><dd>${money(s.perDayRequired)}</dd>
      </dl>
      <p class="rail-note">Zipper ${money(s.zipperPerDay)}/day · Trims ${money(
        s.mtPerDay,
      )}/day · ${count(s.workingDays)} working days</p>
    </section>`;

    el.monthRail.innerHTML = head + done + runRate + expected + againstPlan + planCard;
  }

  /* ----------------------------------------------------------- month chart */

  function renderMonthCharts(view: BudgetView) {
    const s = view.summary;
    const rows = view.rows;
    const cats = rows.map((r) => String(r.day));

    let lastCounted = -1;
    rows.forEach((r, i) => {
      if (r.produced) lastCounted = i;
    });

    const production = rows.map((r, i) => (i <= lastCounted ? r.cumulative : null));
    const target = rows.map((r) => r.cumTarget);

    // Where the month lands if the pace held so far simply continues.
    const pace = rows.map((_row, i) => {
      if (lastCounted < 0 || i < lastCounted) return null;
      return rows[lastCounted].cumulative + s.averageProduction * (i - lastCounted);
    });

    el.chartCumulative.innerHTML = lineChart({
      categories: cats,
      width: Math.max(el.chartCumulative.clientWidth || 720, 320),
      height: 250,
      format: money,
      unit: '$',
      series: [
        { name: 'Production', color: '--series-1', values: production },
        { name: 'Target', color: '--chart-ref', values: target, dashed: true, reference: true },
        { name: 'At this pace', color: '--warning', values: pace, dashed: true },
      ],
    });
    bindChartTooltips(el.chartCumulative);

    el.chartNote.textContent = s.countedThrough
      ? `Production to ${shortDate(s.countedThrough)}; the pace line carries ${money(
          s.averageProduction,
        )}/day to month end`
      : 'No production counted yet';
  }

  /* ------------------------------------------------------------ month grid */

  function rowClass(r: BudgetView['rows'][number]): string {
    const today = todayIso();
    if (r.date === today) return 'today';
    if (!r.counted) return 'future';
    if (!r.produced) return 'pending';
    return '';
  }

  /** "01 Aug Sat" — the weekday matters when the calendar skips holidays. */
  const dayDate = (iso: string) => {
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return esc(iso);
    const day = String(d.getUTCDate()).padStart(2, '0');
    const month = d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
    const dow = d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
    return `${day} ${month} <span class="dow">${dow}</span>`;
  };


  /** The two closing rows: what is counted, and the budget they answer to. */
  function footRows(view: BudgetView): string {
    const s = view.summary;
    const doc = state.doc;
    const shortfall = s.budget - s.expectedMonthProduction;
    return `<tr class="total-row">
        <td class="sticky-col" colspan="2">Counted <span class="rail-sub">· ${count(
          s.daysEntered,
        )} of ${count(s.workingDays)} days</span></td>
        <td class="num">${money(s.zipperDone)}</td>
        <td class="num">${money(s.mtDone)}</td>
        <td class="num">${money(s.totalDone)}</td>
        <td class="num"><span class="rail-sub">avg ${money(s.averageProduction)}</span></td>
        <td class="num" colspan="3"><span class="rail-sub">${pct(s.prodDonePct)} of budget · ${count(
          s.daysRemaining,
        )} days left</span></td>
      </tr>
      <tr class="grand-row">
        <td class="sticky-col" colspan="2">Budget <span class="rail-sub">· ${esc(
          monthLabel(doc.month),
        )}</span></td>
        <td class="num">${money(doc.zipperPlan)}</td>
        <td class="num">${money(doc.mtPlan)}</td>
        <td class="num">${money(s.budget)}</td>
        <td class="num"><span class="rail-sub">${
          s.runRateRequired === null ? 'complete' : `need ${money(s.runRateRequired)}`
        }</span></td>
        <td class="num" colspan="3"><span class="rail-sub">at this pace ${money(
          s.expectedMonthProduction,
        )}${shortfall > 0 ? ` · ${money(shortfall)} short` : ''}</span></td>
      </tr>`;
  }

  function renderRows(view: BudgetView) {
    const s = view.summary;
    const today = todayIso();
    const perDay = s.perDayRequired;
    const doc = state.doc;

    const head = `<thead>
      <tr class="group-row">
        <th class="sticky-col" colspan="2">Working day</th>
        <th colspan="4" class="group-head">Production</th>
        <th colspan="3" class="group-head">Against plan</th>
      </tr>
      <tr class="sub-row">
        <th class="sticky-col">No.</th>
        <th>Date</th>
        <th class="num">Zipper</th>
        <th class="num">Metal Trims</th>
        <th class="num">Total</th>
        <th class="num">vs ${money(perDay)}/day</th>
        <th class="num">Cum. production</th>
        <th class="num">Cum. target</th>
        <th class="num">Lagging</th>
      </tr>
    </thead>`;

    const body = view.rows
      .map((r, i) => {
        const future = !r.counted && r.date !== today;
        const share = perDay ? Math.min((r.total / perDay) * 100, 100) : 0;

        const tag =
          r.date === today
            ? '<span class="tag">today · not counted</span>'
            : future
              ? '<span class="rail-sub">to come</span>'
              : '';

        return `<tr class="${rowClass(r)}">
          <td class="sticky-col num">${String(r.day).padStart(2, '0')}</td>
          <td class="date-cell">${dayDate(r.date)} ${tag}</td>
          <td class="num"><input class="cell num${
            r.auto ? ' auto' : ''
          }" type="number" step="1" data-i="${i}" data-k="zipper" value="${r.zipper ?? ''}" /></td>
          <td class="num"><input class="cell num${
            r.auto ? ' auto' : ''
          }" type="number" step="1" data-i="${i}" data-k="mt" value="${r.mt ?? ''}" /></td>
          <td class="num">${r.entered ? money(r.total) : '<span class="dash">—</span>'}</td>
          <td class="num pace">${bar(share, r.total >= perDay ? 'good' : 's1')}</td>
          <td class="num">${r.counted && r.entered ? money(r.cumulative) : ''}</td>
          <td class="num">${money(r.cumTarget)}</td>
          <td class="num ${r.lagging > 0 ? 'behind' : 'ahead'}">${
            r.counted && r.entered
              ? `${money(Math.abs(r.lagging))} ${r.lagging > 0 ? 'behind' : 'ahead'}`
              : ''
          }</td>
        </tr>`;
      })
      .join('');



    el.monthGrid.innerHTML = `<table class="grid day-grid month-grid">${head}<tbody>${body}</tbody><tfoot>${footRows(
      view,
    )}</tfoot></table>`;

    el.monthNote.textContent =
      'All working days, none collapsed. Tinted cells came from Odoo; typing over one makes it yours until the next sync. Today is shown, tagged, and left out of the average and the run rate.';
  }

  /**
   * Refresh the computed parts without rebuilding the rows.
   *
   * Rewriting the table on each keystroke destroys the input being typed in,
   * which drops focus and jumps the scroll position.
   */
  function updateDerived(view: BudgetView) {
    const s = view.summary;
    const perDay = s.perDayRequired;
    const trs = el.monthGrid.querySelectorAll('tbody tr');

    view.rows.forEach((r, i) => {
      const tr = trs[i] as HTMLElement | undefined;
      if (!tr) return;
      tr.className = rowClass(r);
      const td = tr.children;
      td[4].innerHTML = r.entered ? money(r.total) : '<span class="dash">—</span>';
      td[5].innerHTML = bar(
        perDay ? Math.min((r.total / perDay) * 100, 100) : 0,
        r.total >= perDay ? 'good' : 's1',
      );
      td[6].textContent = r.counted && r.entered ? money(r.cumulative) : '';
      td[7].textContent = money(r.cumTarget);
      td[8].className = `num ${r.lagging > 0 ? 'behind' : 'ahead'}`;
      td[8].textContent =
        r.counted && r.entered
          ? `${money(Math.abs(r.lagging))} ${r.lagging > 0 ? 'behind' : 'ahead'}`
          : '';
    });

    const tfoot = el.monthGrid.querySelector('tfoot');
    if (tfoot) tfoot.innerHTML = footRows(view);

    renderRail(view);
    scheduleCharts(view);
  }

  // Charts are the expensive part; let the typing settle before redrawing.
  let chartTimer: number | undefined;
  function scheduleCharts(view: BudgetView) {
    window.clearTimeout(chartTimer);
    chartTimer = window.setTimeout(() => renderMonthCharts(view), 220);
  }

  function renderMonth() {
    const view = computeBudget(state.doc);
    renderRail(view);
    renderMonthCharts(view);
    renderRows(view);
  }

  /* ----------------------------------------------------------- period view */

  function renderPeriod() {
    const p = state.period;
    if (!p) return;
    const t = p.totals;

    el.periodKpis.innerHTML = [
      tile('Achieved', pct(t.achievedPct), `${money(t.doneTotal)} of ${money(t.planTotal)}`),
      tile('Budget', money(t.planTotal), `${p.months.length} months`),
      tile('Achievement', money(t.doneTotal), `${t.monthsWithProduction} months with production`),
      tile(
        'Gap to budget',
        money(Math.abs(t.gap)),
        t.gap > 0 ? 'behind budget' : 'ahead of budget',
        t.gap > 0 ? 'warn' : 'good',
      ),
      tile('Zipper', money(t.doneZipper), `of ${money(t.planZipper)} planned`),
      tile('Metal Trims', money(t.doneMt), `of ${money(t.planMt)} planned`),
      tile('Daily run rate', money(t.runRate), `${t.daysProduced} producing days`),
    ].join('');

    const cats = p.months.map((m) => m.short);

    el.chartMonths.innerHTML = barChart({
      categories: cats,
      width: chartWidth(el.chartMonths),
      height: 260,
      format: money,
      unit: '$',
      series: [
        { name: 'Budget', color: '--chart-ref', values: p.months.map((m) => m.planTotal), reference: true },
        { name: 'Achievement', color: '--series-1', values: p.months.map((m) => m.doneTotal) },
      ],
    });

    // Cumulative runs to the last month that produced; later months stay blank
    // rather than flat-lining as if nothing had been achieved.
    let lastProducing = -1;
    p.months.forEach((m, i) => {
      if (m.doneTotal > 0) lastProducing = i;
    });

    let planCum = 0;
    let doneCum = 0;
    const planSeries = p.months.map((m) => (planCum += m.planTotal));
    const doneSeries = p.months.map((m, i) => {
      doneCum += m.doneTotal;
      return i <= lastProducing ? doneCum : null;
    });

    el.chartPeriodCum.innerHTML = lineChart({
      categories: cats,
      width: chartWidth(el.chartPeriodCum),
      height: 260,
      format: money,
      unit: '$',
      series: [
        { name: 'Budget', color: '--chart-ref', values: planSeries, dashed: true, reference: true },
        { name: 'Achievement', color: '--series-1', values: doneSeries },
      ],
    });

    el.chartSplit.innerHTML = barChart({
      categories: cats,
      width: chartWidth(el.chartSplit),
      height: 240,
      format: money,
      unit: '$',
      stacked: true,
      series: [
        { name: 'Zipper', color: '--series-1', values: p.months.map((m) => m.doneZipper) },
        { name: 'Metal Trims', color: '--series-2', values: p.months.map((m) => m.doneMt) },
      ],
    });

    [el.chartMonths, el.chartPeriodCum, el.chartSplit].forEach(bindChartTooltips);

    el.periodTitle.textContent = p.label;
    el.periodHeading.textContent = p.label;
    const missing = p.months.filter((m) => m.doneTotal === 0);
    el.periodSub.textContent = missing.length
      ? `${missing.length} of ${p.months.length} months have no production yet — fetch them from Odoo.`
      : `All ${p.months.length} months have production from Odoo.`;
    el.periodRows.innerHTML = p.months
      .map(
        (m) => `<tr${m.doneTotal ? '' : ' class="pending"'}>
        <td><a href="#" data-goto="${m.month}">${esc(m.label)}</a></td>
        <td class="num">${money(m.planZipper)}</td>
        <td class="num">${money(m.planMt)}</td>
        <td class="num">${money(m.planTotal)}</td>
        <td class="num">${money(m.doneZipper)}</td>
        <td class="num">${money(m.doneMt)}</td>
        <td class="num">${money(m.doneTotal)}</td>
        <td class="num ${m.achievedPct >= 1 ? 'ahead' : m.doneTotal ? 'behind' : ''}">${pct(m.achievedPct)}</td>
        <td class="num ${m.gap > 0 ? 'behind' : 'ahead'}">${money(m.gap)}</td>
        <td class="num">${m.daysProduced}/${m.workingDays}</td>
      </tr>`,
      )
      .join('');

    el.periodFoot.innerHTML = `<tr>
      <td>Total</td>
      <td class="num">${money(t.planZipper)}</td>
      <td class="num">${money(t.planMt)}</td>
      <td class="num">${money(t.planTotal)}</td>
      <td class="num">${money(t.doneZipper)}</td>
      <td class="num">${money(t.doneMt)}</td>
      <td class="num">${money(t.doneTotal)}</td>
      <td class="num">${pct(t.achievedPct)}</td>
      <td class="num">${money(t.gap)}</td>
      <td class="num">${t.daysProduced}/${t.workingDays}</td>
    </tr>`;
  }

  el.periodRows.addEventListener('click', (event) => {
    const link = (event.target as HTMLElement).closest<HTMLElement>('[data-goto]');
    if (!link) return;
    event.preventDefault();
    el.monthSelect.value = link.dataset.goto!;
    setView('month');
    void loadMonth(link.dataset.goto!);
  });

  /* -------------------------------------------------------------- loading */

  async function loadMonth(month: string) {
    state.month = month;
    el.saveState.textContent = '';
    // The shape holds while the month loads.
    el.monthRail.innerHTML = skeleton.rail();
    el.chartCumulative.innerHTML = skeleton.chart();
    el.monthGrid.innerHTML = skeleton.table(9, 12);
    try {
      const res = await fetch(`/api/budget?month=${month}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      state.doc = data.doc as BudgetDoc;
      markSaved(data.stored ? state.doc.updatedAt : undefined);
      if (!data.stored) el.saveState.textContent = 'Not saved yet';
    } catch (err) {
      state.doc = emptyDoc(month);
      el.saveState.textContent = `Could not load: ${(err as Error).message}`;
    }
    const plan = planFor(month);
    el.lede.textContent = plan
      ? `Targets and the ${plan.workingDays.length}-day working calendar come from the planning workbook. Production is read live from Odoo.`
      : 'No workbook target for this month — set the plan below.';
    renderMonth();
  }

  async function loadPeriod(view: 'fy' | 'ytd') {
    const query = view === 'fy' ? `fy=${el.fySelect.value}` : `ytd=${state.month}`;
    el.periodTitle.textContent = 'Loading…';
    el.periodKpis.innerHTML = skeleton.chips(6);
    el.periodRows.innerHTML = '';
    el.chartMonths.innerHTML = skeleton.chart();
    el.chartPeriodCum.innerHTML = skeleton.chart();
    el.chartSplit.innerHTML = skeleton.chart(220);
    try {
      const res = await fetch(`/api/summary?${query}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      state.period = data as PeriodSummary;
      renderPeriod();
    } catch (err) {
      el.periodTitle.textContent = `Could not load: ${(err as Error).message}`;
    }
  }

  /** Fills every month of the current period from Odoo and saves each one. */
  async function runBackfill() {
    const p = state.period;
    if (!p) return;
    const body =
      state.view === 'fy' ? { fy: Number(el.fySelect.value) } : { ytd: state.month };

    el.backfill.disabled = true;
    const original = el.backfill.textContent;
    el.backfill.innerHTML = '<span class="spinner"></span> Fetching…';
    el.periodState.textContent = `Asking Odoo for ${p.months.length} months — this takes a while.`;
    el.periodState.className = 'save-state dirty';

    try {
      const res = await fetch('/api/backfill', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);

      const failed = (data.months ?? []).filter((m: any) => m.error);
      // The same failure usually hits every month; say it once, not twelve times.
      const reasons: string[] = [...new Set(failed.map((m: any) => String(m.error)))] as string[];
      el.periodState.innerHTML =
        `<strong>${data.filledMonths} of ${data.months.length} months filled</strong>` +
        (failed.length
          ? `<br><span class="fail">${esc(failed.length)} failed — ${esc(
              reasons.slice(0, 2).join(' · '),
            )}${reasons.length > 2 ? ` (+${reasons.length - 2} more)` : ''}</span>`
          : '');
      await loadPeriod(state.view === 'fy' ? 'fy' : 'ytd');
      // The month sheet may be one of the months just filled.
      await loadMonth(state.month);
    } catch (err) {
      el.periodState.textContent = `Fetch failed: ${(err as Error).message}`;
    } finally {
      el.backfill.disabled = false;
      el.backfill.textContent = original;
    }
  }

  async function save() {
    el.save.disabled = true;
    el.saveState.textContent = 'Saving…';
    try {
      const res = await fetch(`/api/budget?month=${state.doc.month}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(state.doc),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      state.doc = data.doc as BudgetDoc;
      markSaved(state.doc.updatedAt);
      renderMonth();
    } catch (err) {
      el.saveState.textContent = `Save failed: ${(err as Error).message}`;
      el.saveState.className = 'save-state dirty';
    } finally {
      el.save.disabled = false;
    }
  }

  /* --------------------------------------------------------------- events */

  function setView(view: View) {
    state.view = view;
    document
      .querySelectorAll<HTMLElement>('[data-view]')
      .forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
    el.viewMonth.hidden = view !== 'month';
    el.viewPeriod.hidden = view === 'month';
    el.pickerMonth.hidden = view === 'fy';
    el.pickerFy.hidden = view !== 'fy';
    if (view === 'month') renderMonth();
    else void loadPeriod(view);
  }

  document.querySelectorAll<HTMLElement>('[data-view]').forEach((btn) =>
    btn.addEventListener('click', () => setView(btn.dataset.view as View)),
  );

  el.monthSelect.addEventListener('change', () => {
    if (state.dirty && !confirm('You have unsaved changes. Load another month anyway?')) {
      el.monthSelect.value = state.doc.month;
      return;
    }
    void loadMonth(el.monthSelect.value);
    if (state.view === 'ytd') void loadPeriod('ytd');
  });

  const stepMonth = (delta: number) => {
    const options = [...el.monthSelect.options].map((o) => o.value);
    const i = options.indexOf(el.monthSelect.value);
    const next = options[i + delta];
    if (!next) return;
    el.monthSelect.value = next;
    el.monthSelect.dispatchEvent(new Event('change'));
  };
  // The list runs newest first, so "previous month" moves down it.
  maybe('#month-prev')?.addEventListener('click', () => stepMonth(1));
  maybe('#month-next')?.addEventListener('click', () => stepMonth(-1));

  el.fySelect.addEventListener('change', () => void loadPeriod('fy'));
  el.backfill.addEventListener('click', runBackfill);
  el.syncNow.addEventListener('click', () => void runSync('all'));
  if (!state.odoo) {
    for (const b of [el.backfill, el.syncNow]) {
      b.disabled = true;
      b.title = 'Connect Odoo in .env to fetch production';
    }
  }

  el.save.addEventListener('click', save);

  // The plan fields are re-rendered with the rail, so they are bound by
  // delegation rather than by reference.
  el.monthRail.addEventListener('input', (event) => {
    const input = event.target as HTMLInputElement;
    const key = input.id === 'zipperPlan' ? 'zipperPlan' : input.id === 'mtPlan' ? 'mtPlan' : null;
    if (!key) return;

    state.doc[key] = Number(input.value) || 0;
    markDirty();

    // Rebuilding the rail would destroy the field being typed in, so only the
    // grid and chart refresh; the rail catches up on the next full render.
    const view = computeBudget(state.doc);
    renderRows(view);
    scheduleCharts(view);
  });

  el.monthGrid.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement;
    if (!target.classList.contains('cell') && !target.classList.contains('date-input')) return;
    const i = Number(target.dataset.i);
    const key = target.dataset.k as 'date' | 'zipper' | 'mt';
    const day = state.doc.days[i];
    if (!day) return;

    if (key === 'date') {
      if (!target.value) return;
      day.date = target.value;
      state.doc.days = renumber(state.doc.days);
      markDirty();
      renderMonth(); // the order changed, so the rows have to be rebuilt
      return;
    }

    day[key] = target.value === '' ? null : Number(target.value);
    day.auto = false;
    target.classList.remove('auto');
    // A typed production figure is a what-if, not an edit worth saving: the
    // sheet recalculates around it and the next sync puts Odoo's number back.
    // Only the plan and the working calendar are yours to keep.
    updateDerived(computeBudget(state.doc));
  });

  // A wheel over a focused number input changes it; scrolling the page should
  // never quietly edit a figure.
  el.monthGrid.addEventListener(
    'wheel',
    (event) => {
      const target = event.target as HTMLElement;
      if (target instanceof HTMLInputElement && target.type === 'number' && document.activeElement === target) {
        target.blur();
      }
    },
    { passive: true },
  );

  el.monthGrid.addEventListener('click', (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLElement>('[data-del]');
    if (!btn) return;
    state.doc.days.splice(Number(btn.dataset.del), 1);
    state.doc.days = renumber(state.doc.days);
    markDirty();
    renderMonth();
  });

  $('#reset-days').addEventListener('click', () => {
    const kept = new Map(state.doc.days.map((d) => [d.date, d]));
    const plan = planFor(state.doc.month);
    const dates = plan ? plan.workingDays : defaultDays(state.doc.month).map((d) => d.date);
    state.doc.days = renumber(
      dates.map((date, i) => kept.get(date) ?? { day: i + 1, date, zipper: null, mt: null }),
    );
    markDirty();
    renderMonth();
  });

  $('#drop-empty').addEventListener('click', () => {
    state.doc.days = renumber(state.doc.days.filter((d) => (d.zipper ?? 0) + (d.mt ?? 0) > 0));
    markDirty();
    renderMonth();
  });

  $('#add-day').addEventListener('click', () => {
    const last = state.doc.days[state.doc.days.length - 1];
    const next = last
      ? new Date(new Date(`${last.date}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10)
      : `${state.doc.month}-01`;
    state.doc.days.push({ day: state.doc.days.length + 1, date: next, zipper: null, mt: null });
    state.doc.days = renumber(state.doc.days);
    markDirty();
    renderMonth();
  });

  const download = (name: string, lines: string[]) => {
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  $('#export').addEventListener('click', () => {
    const view = computeBudget(state.doc);
    const lines = [
      'Working Day,Date,Zipper Prod,MT Prod,Total,Cumu Prod,Cum target,Cum Target Lagging',
      ...view.rows.map((r) =>
        [r.day, r.date, r.zipper ?? '', r.mt ?? '', r.total, r.cumulative, Math.round(r.cumTarget), Math.round(r.lagging)].join(','),
      ),
    ];
    download(`Budget follow-up ${state.doc.month}.csv`, lines);
  });

  $('#period-export').addEventListener('click', () => {
    const p = state.period;
    if (!p) return;
    const lines = [
      'Month,Zipper Plan,MT Plan,Budget,Zipper Done,MT Done,Achievement,Achieved %,Gap,Producing days,Working days',
      ...p.months.map((m) =>
        [m.label, m.planZipper, m.planMt, m.planTotal, m.doneZipper, m.doneMt, m.doneTotal, (m.achievedPct * 100).toFixed(1), m.gap, m.daysProduced, m.workingDays].join(','),
      ),
    ];
    download(`${p.label}.csv`, lines);
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) e.preventDefault();
  });

  let resizeTimer: number | undefined;
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (state.view === 'month') renderMonthCharts(computeBudget(state.doc));
      else renderPeriod();
    }, 180);
  });

  // Opening the page syncs by itself. Only stale months are fetched, so the
  // usual case is one quick call for the current month.
  void (async () => {
    await loadMonth(state.month);
    await loadSyncStatus();
    if (state.odoo) await runSync('auto');
  })();

  // Keep "last synced 3 min ago" honest without re-asking the server.
  setInterval(paintSync, 30_000);
}
