/**
 * OT Cost: the rail carries the reading, the grid carries every figure.
 *
 * Same shape as the production, budget and ABC pages — a left rail of
 * judgments, two charts, and one switchable table. Three periods: an OT month
 * (26th to 25th), a fiscal year, and that year to date.
 */
import { barChart, lineChart, bindChartTooltips } from '../lib/charts';
import { skeleton } from '../lib/skeleton';

type Scope = 'month' | 'fy' | 'ytd';
type Company = 'all' | 'zipper' | 'mt';
type GridMode = 'days' | 'sections' | 'months';
type Tag = 'M-VA' | 'M-NVA' | 'NM-NVA';

interface BuSplit {
  zipper: number;
  mt: number;
  total: number;
}

interface OtDay {
  date: string;
  day: number;
  manufacturing: BuSplit;
  other: BuSplit;
  hours: BuSplit;
  total: number;
}

interface MonthPoint {
  month: string;
  label: string;
  from: string;
  to: string;
  manufacturing: BuSplit;
  other: BuSplit;
  hours: BuSplit;
  total: number;
  plan: BuSplit | null;
  budget: BuSplit | null;
  activeDays: number;
  elapsedDays: number;
  windowDays: number;
  complete: boolean;
  partial: boolean;
}

interface SectionRow {
  bu: string;
  buLabel: string;
  section: string;
  department: string;
  tag: Tag;
  bucket: 'manufacturing' | 'other';
  cost: number;
  hours: number;
  share: number;
  cumShare: number;
  cls: 'A' | 'B' | 'C';
  rank: number;
}

interface OtReport {
  scope: Scope;
  company: Company;
  fy: number;
  label: string;
  months: string[];
  from: string;
  to: string;
  days: OtDay[];
  byMonth: MonthPoint[];
  sections: SectionRow[];
  totals: { manufacturing: BuSplit; other: BuSplit; hours: BuSplit; total: number };
  plan: BuSplit | null;
  budget: BuSplit | null;
  planActual: BuSplit | null;
  budgetActual: BuSplit | null;
  planGaps: string[];
  budgetGaps: string[];
  analysis: {
    manufacturingShare: number;
    costPerHour: number;
    vaMix: { tag: Tag; label: string; cost: number; share: number }[];
    perActiveDay: number;
    projectedTotal: number | null;
    paretoCount: number;
    paretoShare: number;
    spikes: {
      date: string;
      total: number;
      ratio: number;
      topSections: { section: string; buLabel: string; cost: number }[];
    }[];
    previous: { fy: number; total: number; months: number } | null;
  };
  unmapped: string[];
  errors: { month: string; job: string; error: string }[];
  pending: { month: string; job: string }[];
  ready: boolean;
  usdRate: number;
  rate: {
    rate: number;
    source: string;
    asOf: string;
    fetchedAt: string;
    live: boolean;
    stale?: boolean;
  };
}

const root = document.querySelector<HTMLElement>('.otcost');

if (root) {
  const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
  const el = {
    status: $<HTMLElement>('#ot-status'),
    body: $<HTMLElement>('#ot-body'),
    rail: $<HTMLElement>('#ot-rail'),
    chips: $<HTMLElement>('#ot-chips'),
    grid: $<HTMLElement>('#ot-grid'),
    note: $<HTMLElement>('#ot-note'),
    spend: $<HTMLElement>('#chart-spend'),
    cumulative: $<HTMLElement>('#chart-cumulative'),
    chartATitle: $<HTMLElement>('#chart-a-title'),
    chartANote: $<HTMLElement>('#chart-a-note'),
    chartBNote: $<HTMLElement>('#chart-b-note'),
    rateLine: $<HTMLElement>('#rate-line'),
    pickerMonth: $<HTMLElement>('#picker-month'),
    pickerFy: $<HTMLElement>('#picker-fy'),
    monthSelect: $<HTMLSelectElement>('#month-select'),
    fySelect: $<HTMLSelectElement>('#fy-select'),
  };

  const state = {
    view: 'month' as Scope,
    company: 'all' as Company,
    month: root.dataset.month ?? '',
    fy: Number(root.dataset.fy),
    grid: 'days' as GridMode,
    query: '',
    result: null as OtReport | null,
  };

  /* ------------------------------------------------------------ formatting */

  const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
  const nf2 = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const usd = (v: number) => `$${nf.format(Math.round(v))}`;
  const bdt = (v: number) => `৳${nf2.format(v)}`;
  const usd2 = (v: number) => `$${nf2.format(v)}`;
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const hrs = (v: number) => nf1.format(v);
  const esc = (s: string | number) =>
    String(s).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
    );

  const dayLabel = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      timeZone: 'UTC',
    });
  const dayLong = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });

  /* ----------------------------------------------------------------- fetch */

  let inFlight: AbortController | null = null;

  function query(): string {
    const period =
      state.view === 'month'
        ? `scope=month&month=${state.month}`
        : `scope=${state.view}&fy=${state.fy}`;
    return `${period}&company=${state.company}`;
  }

  function showSkeleton() {
    el.status.hidden = true;
    el.body.hidden = false;
    el.rail.innerHTML = skeleton.rail();
    el.chips.innerHTML = skeleton.chips(3);
    el.spend.innerHTML = skeleton.chart();
    el.cumulative.innerHTML = skeleton.chart();
    el.grid.innerHTML = skeleton.table(9, 12);
    el.note.textContent = '';
    // Titles describe the period being replaced, so clear them too — a stale
    // "$645 a day" over a blank chart is worse than no caption at all.
    el.chartATitle.textContent =
      state.view === 'month' ? 'Daily OT' : 'OT per month against plan';
    el.chartANote.textContent = '';
    el.chartBNote.textContent = '';
  }

  async function load(fresh = true) {
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    if (fresh) showSkeleton();

    const wanted = query();
    try {
      const res = await fetch(`/api/ot-cost?${wanted}`, { signal: controller.signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);

      state.result = data as OtReport;
      render();

      // The server fills a few reports per request; keep asking while partial.
      if (!state.result.ready && wanted === query()) void load(false);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      el.body.hidden = true;
      el.status.hidden = false;
      el.status.classList.add('error');
      el.status.innerHTML = `<h2>Could not read overtime</h2><p style="font-family:var(--mono);font-size:12.5px">${esc(
        (err as Error).message,
      )}</p>`;
    }
  }

  /* ------------------------------------------------------------------ rail */

  const railBlock = (label: string, body: string, note = '') =>
    `<section class="rail-block panel">
      <h2>${label}</h2>
      ${body}
      ${note ? `<p class="rail-note">${note}</p>` : ''}
    </section>`;

  const meter = (fill: number, cls = 'accent') =>
    `<div class="meter"><span class="meter-fill ${cls}" style="width:${Math.max(
      0,
      Math.min(fill, 100),
    ).toFixed(1)}%"></span></div>`;

  const split = (label: string, value: number, of: number, cls: string) =>
    `<div class="rail-split">
      <div class="rail-split-head">
        <span><i class="swatch ${cls}"></i>${esc(label)}</span>
        <b>${usd(value)} <span class="rail-of">${pct(of ? value / of : 0)}</span></b>
      </div>
      ${meter(of ? (value / of) * 100 : 0, cls)}
    </div>`;

  /** Over plan is the thing worth seeing, so the colour only ever warns. */
  const spendClass = (ratio: number) => (ratio > 1 ? 'serious' : ratio > 0.95 ? 'accent' : 'accent');

  const COMPANY_LABEL: Record<Company, string> = {
    all: 'Whole plant',
    zipper: 'Zipper',
    mt: 'Metal Trims',
  };

  function renderRail(r: OtReport) {
    const a = r.analysis;
    const blocks: string[] = [];

    const head = `<div class="rail-head">
      <p class="eyebrow">${esc(COMPANY_LABEL[r.company])} · ${esc(r.label)} · ${esc(
        dayLabel(r.from),
      )} – ${esc(dayLabel(r.to))}${r.ready ? '' : ' · filling'}</p>
      <h2 class="rail-title">What overtime cost</h2>
      <p class="rail-sub">Total plant OT, Manufacturing plus Other Departments, converted at
      ${bdt(r.usdRate)} to the dollar.</p>
    </div>`;

    /* 1. consumption against the plan */
    // Percentages compare like with like: spend over the months that carry a
    // target, never a whole year's spend against a part-year plan.
    const planTotal = r.plan?.total ?? 0;
    const planSpend = r.planActual?.total ?? 0;
    const ratio = planTotal ? planSpend / planTotal : 0;
    const balance = planTotal - planSpend;
    const covered = r.months.length - r.planGaps.length;
    const partialPlan = r.planGaps.length > 0 && covered > 0;
    const budgetRatio =
      r.budget && r.budgetActual ? r.budgetActual.total / r.budget.total : null;

    const verdict = !planTotal
      ? `<p class="rail-verdict">No OT plan is on record for this period, so there is nothing to
         measure against.</p>`
      : `<p class="rail-verdict">${
          balance >= 0
            ? `<span class="good">${usd(balance)} left</span> against the plan`
            : `<span class="warn">${usd(-balance)} over</span> the plan`
        }${
          a.projectedTotal !== null && !partialPlan
            ? ` · tracking to ${usd(a.projectedTotal)} by ${esc(dayLabel(r.to))}`
            : ''
        }.</p>`;

    blocks.push(
      railBlock(
        'OT consumed',
        `<p class="rail-figure">${usd(r.totals.total)}</p>
         <p class="rail-sub">${
           planTotal ? `of ${usd(planTotal)} plan · ${pct(ratio)}` : 'no plan on record'
         }</p>
         ${planTotal ? meter(ratio * 100, spendClass(ratio)) : ''}
         ${verdict}
         <dl class="rail-pairs">
           <dt>Plan</dt><dd>${planTotal ? usd(planTotal) : '—'}</dd>
           <dt>Budget</dt><dd>${r.budget ? usd(r.budget.total) : '—'}</dd>
           ${
             budgetRatio !== null
               ? `<dt>Against budget</dt><dd class="${budgetRatio > 1 ? 'warn' : 'good'}">${pct(
                   budgetRatio,
                 )}</dd>`
               : ''
           }
           <dt>OT hours</dt><dd>${hrs(r.totals.hours.total)}</dd>
           <dt>Cost per OT hour</dt><dd>${usd2(a.costPerHour)}</dd>
         </dl>`,
        [
          partialPlan
            ? `${covered} of ${r.months.length} months carry a plan; the percentage compares
               ${usd(planSpend)} spent in those months against their ${usd(planTotal)}.`
            : '',
          a.previous
            ? `A year earlier, ${
                a.previous.months === 1
                  ? 'the same OT month'
                  : `${a.previous.months} of these months`
              } in FY ${String(a.previous.fy).slice(2)}-${String(a.previous.fy + 1).slice(
                2,
              )} cost ${usd(a.previous.total)}.`
            : '',
        ]
          .filter(Boolean)
          .join(' '),
      ),
    );

    /* 2. manufacturing against the rest of the plant */
    blocks.push(
      railBlock(
        'Where it went',
        split('Manufacturing', r.totals.manufacturing.total, r.totals.total, 's1') +
          split('Other departments', r.totals.other.total, r.totals.total, 's2'),
        `Stores, ETP, MIS and Design &amp; Marketing count as Other even though they sit under
         manufacturing on the org chart — the OT Cost sheet moves them out.`,
      ),
    );

    /* 3. each business unit against its own plan */
    const buRow = (label: string, actual: number, plan: number | null, cls: string) => {
      const rr = plan ? actual / plan : 0;
      return `<div class="rail-split">
        <div class="rail-split-head">
          <span><i class="swatch ${cls}"></i>${esc(label)}</span>
          <b>${usd(actual)} <span class="rail-of">${plan ? pct(rr) : 'no plan'}</span></b>
        </div>
        ${meter(plan ? rr * 100 : 0, rr > 1 ? 'serious' : cls)}
      </div>`;
    };
    const unitRows = [
      r.company !== 'mt'
        ? buRow('Zipper', r.planActual?.zipper ?? 0, r.plan?.zipper ?? null, 's1')
        : '',
      r.company !== 'zipper'
        ? buRow('Metal Trims', r.planActual?.mt ?? 0, r.plan?.mt ?? null, 's2')
        : '',
    ].join('');
    blocks.push(
      railBlock(
        r.company === 'all' ? 'Against plan by unit' : 'Against plan',
        unitRows,
        `${r.company === 'all' ? 'Each unit against its own' : 'Measured against this unit’s'} OT plan, both buckets included${
          partialPlan ? `, over the ${covered} months that carry one` : ''
        }.`,
      ),
    );

    /* 4. run rate, while the period is still running */
    if (a.projectedTotal !== null) {
      // Only worth stating when the plan actually covers the projected period.
      const comparable = planTotal > 0 && !partialPlan;
      const over = comparable ? a.projectedTotal - planTotal : 0;
      blocks.push(
        railBlock(
          'Run rate',
          `<p class="rail-figure">${usd(a.perActiveDay)}</p>
           <p class="rail-sub">per day that actually ran overtime</p>
           <dl class="rail-pairs">
             <dt>Projected to ${esc(dayLabel(r.to))}</dt><dd>${usd(a.projectedTotal)}</dd>
             ${
               comparable
                 ? `<dt>Against plan</dt><dd class="${over > 0 ? 'warn' : 'good'}">${
                     over > 0 ? `+${usd(over)}` : usd(over)
                   }</dd>`
                 : ''
             }
           </dl>`,
          'The projection carries today’s spend per active day across the days left, scaled by how often a day has run overtime so far.',
        ),
      );
    }

    /* 5. the days that broke the pattern */
    if (a.spikes.length) {
      blocks.push(
        railBlock(
          'Days that broke the pattern',
          `<ul class="stuck">${a.spikes
            .map(
              (s) => `<li>
                <div class="stuck-head">
                  <span class="stuck-name">${esc(dayLong(s.date))}</span>
                  <b>${usd(s.total)}</b>
                </div>
                <p class="rail-sub">${s.ratio.toFixed(1)}× a typical overtime day · ${esc(
                  s.topSections.map((t) => `${t.section} ${usd(t.cost)}`).join(', '),
                )}</p>
              </li>`,
            )
            .join('')}</ul>`,
          'A typical day is the median of the days that ran overtime, so the spikes do not inflate their own baseline.',
        ),
      );
    }

    /* 6. how concentrated the spend is */
    const top = r.sections.slice(0, 3);
    if (top.length) {
      blocks.push(
        railBlock(
          'Concentration',
          `<p class="rail-figure">${a.paretoCount}</p>
           <p class="rail-sub">sections carry ${pct(a.paretoShare)} of the overtime bill</p>
           <dl class="rail-pairs">
             ${top
               .map(
                 (s) =>
                   `<dt>${esc(s.section)} <em>${esc(s.buLabel)}</em></dt><dd>${usd(s.cost)}</dd>`,
               )
               .join('')}
           </dl>`,
          'Ranked over the whole period, both business units together.',
        ),
      );
    }

    el.rail.innerHTML = head + blocks.join('');
  }

  /* ---------------------------------------------------------------- charts */

  function chartWidth(host: HTMLElement): number {
    return Math.max(host.clientWidth || 640, 320);
  }

  function renderCharts(r: OtReport) {
    const wA = chartWidth(el.spend);
    const wB = chartWidth(el.cumulative);

    if (r.scope === 'month') {
      const days = r.days;
      el.chartATitle.textContent = 'Daily OT — Manufacturing and Other Departments';
      el.chartANote.textContent = r.plan
        ? `Plan spread over ${days.length} days is ${usd(
            r.plan.total / Math.max(days.length, 1),
          )} a day`
        : '';
      el.spend.innerHTML = barChart({
        categories: days.map((d) => dayLabel(d.date)),
        series: [
          {
            name: 'Manufacturing',
            color: '--series-1',
            values: days.map((d) => d.manufacturing.total),
          },
          {
            name: 'Other departments',
            color: '--series-2',
            values: days.map((d) => d.other.total),
          },
        ],
        width: wA,
        height: 280,
        stacked: true,
        unit: '$',
        format: usd,
      });
    } else {
      const ms = r.byMonth;
      el.chartATitle.textContent = 'OT per month against plan';
      el.chartANote.textContent = r.planGaps.length
        ? `${r.planGaps.length} month${r.planGaps.length === 1 ? '' : 's'} carry no plan`
        : '';
      el.spend.innerHTML = barChart({
        categories: ms.map((m) => m.label),
        series: [
          { name: 'Actual', color: '--series-1', values: ms.map((m) => m.total) },
          {
            name: 'Plan',
            color: '--chart-ref',
            reference: true,
            values: ms.map((m) => m.plan?.total ?? null),
          },
        ],
        width: wA,
        height: 280,
        unit: '$',
        format: usd,
      });
    }

    /* cumulative — actual against a plan that accrues evenly across the window */
    const points = r.scope === 'month' ? r.days : r.byMonth;
    const labels =
      r.scope === 'month'
        ? r.days.map((d) => dayLabel(d.date))
        : r.byMonth.map((m) => m.label);
    const today = new Date().toISOString().slice(0, 10);
    const endOf = (p: any) => (r.scope === 'month' ? p.date : p.to);

    // A cumulative line must stop at the last point that has happened —
    // carrying it on at today's total would read as a plateau the plant chose.
    let lastReal = -1;
    points.forEach((p: any, i: number) => {
      if (endOf(p) <= today || p.total > 0) lastReal = i;
    });

    let running = 0;
    const actual = points.map((p: any, i: number) => {
      if (i > lastReal) return null;
      running += p.total;
      return running;
    });

    let planRunning = 0;
    const planLine = points.map((p: any) => {
      if (r.scope === 'month') {
        if (!r.plan) return null;
        planRunning += r.plan.total / points.length;
      } else {
        if (!p.plan) return planRunning || null;
        planRunning += p.plan.total;
      }
      return planRunning;
    });

    let budgetRunning = 0;
    const budgetLine = points.map((p: any) => {
      if (r.scope === 'month') {
        if (!r.budget) return null;
        budgetRunning += r.budget.total / points.length;
      } else {
        if (!p.budget) return budgetRunning || null;
        budgetRunning += p.budget.total;
      }
      return budgetRunning;
    });

    const series = [
      { name: 'Actual', color: '--series-1', values: actual },
      { name: 'Plan', color: '--chart-ref', reference: true, dashed: true, values: planLine },
    ];
    if (budgetLine.some((v) => v !== null)) {
      series.push({
        name: 'Budget',
        color: '--series-2',
        reference: true,
        dashed: true,
        values: budgetLine,
      });
    }

    el.chartBNote.textContent =
      r.scope === 'month'
        ? 'The plan line spreads the month’s plan evenly across its days.'
        : 'The plan and budget lines accrue month by month.';
    el.cumulative.innerHTML = lineChart({
      categories: labels,
      series,
      width: wB,
      height: 280,
      unit: '$',
      format: usd,
    });

    bindChartTooltips(el.spend);
    bindChartTooltips(el.cumulative);
  }

  /* ----------------------------------------------------------------- chips */

  function renderChips(r: OtReport) {
    const modes: [GridMode, string][] = [
      ['days', `Day sheet · ${r.days.length}`],
      ['sections', `Sections · ${r.sections.length}`],
    ];
    if (r.scope !== 'month') modes.push(['months', `Months · ${r.byMonth.length}`]);
    if (state.grid === 'months' && r.scope === 'month') state.grid = 'days';

    el.chips.innerHTML =
      `<span class="chips-label">Show</span>` +
      modes
        .map(
          ([mode, label]) =>
            `<button class="chip toggle" type="button" data-grid="${mode}" aria-pressed="${
              state.grid === mode
            }">${esc(label)}</button>`,
        )
        .join('') +
      (state.grid === 'sections'
        ? `<input class="chips-search" id="section-search" type="search" placeholder="Filter sections" value="${esc(
            state.query,
          )}" />`
        : '');
  }

  /* ------------------------------------------------------------------ grid */

  const num = (v: number, tinted = false) =>
    `<td class="num${tinted ? ' tinted' : ''}">${v ? usd2(v) : '—'}</td>`;

  /**
   * The OT Cost sheet's own day table.
   *
   * Filtered to one unit there is nothing to split, so the per-unit columns
   * collapse to a single figure per bucket rather than printing a column of
   * dashes for the unit that is not on screen.
   */
  function daySheet(r: OtReport): string {
    const both = r.company === 'all';
    const cells = (s: { zipper: number; mt: number; total: number }) =>
      both
        ? `${num(s.zipper)}${num(s.mt)}${num(s.total, true)}`
        : num(s.total, true);

    const rows = r.days
      .map(
        (d) => `<tr>
          <td class="sticky-col">${d.day}</td>
          <td class="text">${esc(dayLabel(d.date))}</td>
          ${cells(d.manufacturing)}
          ${cells(d.other)}
          ${num(d.total, true)}
          <td class="num">${d.hours.total ? hrs(d.hours.total) : '—'}</td>
        </tr>`,
      )
      .join('');

    const t = r.totals;
    const span = both ? 3 : 1;
    const unitHeads = both
      ? `<th>Zipper $</th><th>MT $</th><th>Total $</th>`
      : `<th>Total $</th>`;
    const otherHeads = both
      ? `<th>Zip others</th><th>MT others</th><th>Total $</th>`
      : `<th>Total $</th>`;

    return `<table class="day-grid key-narrow">
      <thead>
        <tr>
          <th class="sticky-col"></th>
          <th></th>
          <th class="group-head" colspan="${span}">Manufacturing</th>
          <th class="group-head" colspan="${span}">Other departments</th>
          <th class="group-head" colspan="2">${both ? 'Plant' : esc(COMPANY_LABEL[r.company])}</th>
        </tr>
        <tr class="sub-row">
          <th class="sticky-col">Day</th>
          <th class="text">Date</th>
          ${unitHeads}
          ${otherHeads}
          <th>Total OT $</th><th>OT hours</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr class="grand-row">
          <td class="sticky-col">Total</td>
          <td class="text">${r.days.filter((d) => d.total > 0).length} active days</td>
          ${cells(t.manufacturing)}
          ${cells(t.other)}
          ${num(t.total, true)}
          <td class="num">${hrs(t.hours.total)}</td>
        </tr>
      </tfoot>
    </table>`;
  }

  function monthSheet(r: OtReport): string {
    const cell = (v: number | null, cls = 'num') =>
      `<td class="${cls}">${v === null ? '—' : usd(v)}</td>`;
    const ratioCell = (actual: number, target: number | null) => {
      if (!target) return `<td class="num">—</td>`;
      const rr = actual / target;
      return `<td class="num" style="color:var(${rr > 1 ? '--warning' : '--good'})">${pct(rr)}</td>`;
    };

    const both = r.company === 'all';
    const mfgCells = (s: { zipper: number; mt: number; total: number }) =>
      both ? `${cell(s.zipper)}${cell(s.mt)}${cell(s.total)}` : cell(s.total);

    const rows = r.byMonth
      .map(
        (m) => `<tr>
          <td class="sticky-col">${esc(m.label)}${
            m.partial ? ' <span class="rail-sub">partial</span>' : ''
          }</td>
          <td class="text">${esc(dayLabel(m.from))} – ${esc(dayLabel(m.to))}</td>
          ${mfgCells(m.manufacturing)}
          ${cell(m.other.total)}
          <td class="num tinted">${usd(m.total)}</td>
          ${cell(m.plan?.total ?? null)}
          ${ratioCell(m.total, m.plan?.total ?? null)}
          ${cell(m.budget?.total ?? null)}
          ${ratioCell(m.total, m.budget?.total ?? null)}
          <td class="num">${m.hours.total ? hrs(m.hours.total) : '—'}</td>
        </tr>`,
      )
      .join('');

    const t = r.totals;
    return `<table class="day-grid">
      <thead>
        <tr>
          <th class="sticky-col"></th><th></th>
          <th class="group-head" colspan="${both ? 3 : 1}">Manufacturing</th>
          <th class="group-head">Other</th>
          <th class="group-head" colspan="5">${
            both ? 'Plant against target' : `${esc(COMPANY_LABEL[r.company])} against target`
          }</th>
          <th class="group-head"></th>
        </tr>
        <tr class="sub-row">
          <th class="sticky-col">OT month</th>
          <th class="text">Window</th>
          ${both ? '<th>Zipper $</th><th>MT $</th><th>Total $</th>' : '<th>Total $</th>'}
          <th>Total $</th>
          <th>Total OT $</th>
          <th>Plan</th><th>% of plan</th>
          <th>Budget</th><th>% of budget</th>
          <th>OT hours</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr class="grand-row">
          <td class="sticky-col">${esc(r.label)}</td>
          <td class="text">${r.months.length} months</td>
          ${mfgCells(t.manufacturing)}
          ${cell(t.other.total)}
          <td class="num tinted">${usd(t.total)}</td>
          ${cell(r.plan?.total ?? null)}
          ${ratioCell(r.planActual?.total ?? 0, r.plan?.total ?? null)}
          ${cell(r.budget?.total ?? null)}
          ${ratioCell(r.budgetActual?.total ?? 0, r.budget?.total ?? null)}
          <td class="num">${hrs(t.hours.total)}</td>
        </tr>
      </tfoot>
    </table>`;
  }

  function sectionSheet(r: OtReport): string {
    const q = state.query.trim().toLowerCase();
    const rows = r.sections.filter(
      (s) =>
        !q ||
        s.section.toLowerCase().includes(q) ||
        s.department.toLowerCase().includes(q) ||
        s.buLabel.toLowerCase().includes(q),
    );

    const showBu = r.company === 'all';
    const body = rows
      .map(
        (s) => `<tr>
          <td class="sticky-col">${s.rank}. ${esc(s.section)}</td>
          ${showBu ? `<td class="text">${esc(s.buLabel)}</td>` : ''}
          <td class="text">${esc(s.department || '—')}</td>
          <td class="text">${esc(s.tag)}</td>
          <td class="text">${s.bucket === 'manufacturing' ? 'Manufacturing' : 'Other'}</td>
          <td class="num">${s.hours ? hrs(s.hours) : '—'}</td>
          <td class="num tinted">${usd(s.cost)}</td>
          <td class="num">${pct(s.share)}</td>
          <td class="num">${pct(s.cumShare)}</td>
          <td class="text">${s.cls}</td>
        </tr>`,
      )
      .join('');

    const shown = rows.reduce((a, s) => a + s.cost, 0);
    return `<table class="day-grid">
      <thead>
        <tr class="sub-row">
          <th class="sticky-col">Section</th>
          ${showBu ? '<th class="text">Business unit</th>' : ''}
          <th class="text">Department</th>
          <th class="text">Tag</th>
          <th class="text">Counts as</th>
          <th>OT hours</th>
          <th>OT cost</th>
          <th>Share</th>
          <th>Cumulative</th>
          <th class="text">Class</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
      <tfoot>
        <tr class="grand-row">
          <td class="sticky-col">${rows.length} section${rows.length === 1 ? '' : 's'}${
            q ? ' matching' : ''
          }</td>
          <td colspan="${showBu ? 4 : 3}"></td>
          <td class="num">${hrs(rows.reduce((a, s) => a + s.hours, 0))}</td>
          <td class="num tinted">${usd(shown)}</td>
          <td class="num">${pct(r.totals.total ? shown / r.totals.total : 0)}</td>
          <td colspan="2"></td>
        </tr>
      </tfoot>
    </table>`;
  }

  function renderGrid(r: OtReport) {
    el.grid.innerHTML =
      state.grid === 'days'
        ? daySheet(r)
        : state.grid === 'months'
          ? monthSheet(r)
          : sectionSheet(r);

    const notes: string[] = [
      `Odoo reports overtime in taka. Every month here is converted at ${
        r.rate.live ? `today's rate, ${bdt(r.usdRate)} to the dollar` : `${bdt(r.usdRate)} to the dollar`
      }, so dollar figures for past months move with the taka — the taka figures do not.
       Manufacturing = M-VA + M-NVA, less ETP, FG Store, RM Store, MIS and Design &amp;
       Marketing, which count as Other.`,
    ];
    if (r.planGaps.length) {
      notes.push(`No OT plan on record for ${r.planGaps.join(', ')}.`);
    }
    if (r.budgetGaps.length && r.budgetGaps.length < r.months.length) {
      notes.push(`No OT budget on record for ${r.budgetGaps.join(', ')}.`);
    }
    if (r.unmapped.length) {
      notes.push(
        `${r.unmapped.length} section${r.unmapped.length === 1 ? '' : 's'} not in the
         classification map, counted as manufacturing: ${r.unmapped.join(', ')}.`,
      );
    }
    if (r.errors.length) {
      notes.push(
        `${r.errors.length} report${r.errors.length === 1 ? '' : 's'} failed and are missing, not
         zero: ${r.errors.map((e) => `${e.month} ${e.job}`).join(', ')}.`,
      );
    }
    if (!r.ready) {
      notes.push(`${r.pending.length} reports still to read from Odoo — figures are partial.`);
    }
    el.note.innerHTML = notes.join(' ');
  }

  /* ---------------------------------------------------------------- render */

  /** The rate line under the lede: what a dollar cost, and who said so. */
  function renderRate(r: OtReport) {
    const d = new Date(`${r.rate.asOf}T00:00:00Z`).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
    el.rateLine.innerHTML = r.rate.live
      ? `Today's rate: <b>1 USD = ${bdt(r.rate.rate)}</b> · ${esc(d)}${
          r.rate.stale ? " · last known rate, today's is unavailable" : ''
        }`
      : `Exchange rate unavailable — converting at the fixed <b>${bdt(
          r.rate.rate,
        )}</b> to the dollar.`;
  }

  function render() {
    const r = state.result;
    if (!r) return;
    el.status.hidden = true;
    el.body.hidden = false;
    renderRate(r);
    renderRail(r);
    renderCharts(r);
    renderChips(r);
    renderGrid(r);
  }

  /* ----------------------------------------------------------------- events */

  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view as Scope;
      if (view === state.view) return;
      state.view = view;
      document
        .querySelectorAll<HTMLButtonElement>('[data-view]')
        .forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
      el.pickerMonth.hidden = view !== 'month';
      el.pickerFy.hidden = view === 'month';
      state.grid = view === 'month' ? 'days' : 'months';
      void load();
    });
  });

  el.monthSelect.addEventListener('change', () => {
    state.month = el.monthSelect.value;
    void load();
  });

  const stepMonth = (by: number) => {
    const options = [...el.monthSelect.options];
    const i = options.findIndex((o) => o.value === el.monthSelect.value);
    // The list runs newest first, so "previous month" moves down it.
    const next = options[i - by];
    if (!next) return;
    el.monthSelect.value = next.value;
    state.month = next.value;
    void load();
  };
  $<HTMLButtonElement>('#month-prev').addEventListener('click', () => stepMonth(-1));
  $<HTMLButtonElement>('#month-next').addEventListener('click', () => stepMonth(1));

  el.fySelect.addEventListener('change', () => {
    state.fy = Number(el.fySelect.value);
    void load();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-company]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const company = btn.dataset.company as Company;
      if (company === state.company) return;
      state.company = company;
      document
        .querySelectorAll<HTMLButtonElement>('[data-company]')
        .forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
      void load();
    });
  });

  el.chips.addEventListener('click', (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-grid]');
    if (!btn || !state.result) return;
    state.grid = btn.dataset.grid as GridMode;
    renderChips(state.result);
    renderGrid(state.result);
  });

  el.chips.addEventListener('input', (event) => {
    const input = event.target as HTMLInputElement;
    if (input.id !== 'section-search' || !state.result) return;
    state.query = input.value;
    renderGrid(state.result);
  });

  let resizeTimer: number | undefined;
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (state.result) renderCharts(state.result);
    }, 150);
  });

  void load();
}
