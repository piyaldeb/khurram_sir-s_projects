/**
 * Production report: the daily MRP Invoice sheet as a decision page.
 *
 * A fixed rail answers the day's four questions — what was released, what is
 * pending, where the month stands, and what has stalled — and the full sheet
 * sits beside it. Nothing is dropped: every product row and all eleven numeric
 * columns still render. What changes is the reading order.
 *
 * The day report carries no target of its own, so "did we hit it" comes from
 * the budget sheet for that month (one extra call to /api/budget).
 */
interface InvoiceRow {
  product: string;
  packingQty: number;
  packingValue: number;
  pendingQty: number;
  pendingValue: number;
  cumProduction: number;
  cumInvoicing: number;
  todayReleasedQty: number;
  todayReleasedValue: number;
  cumReleasedQty: number;
  cumReleasedValue: number;
  pendingOa: number;
}

interface CompanyInvoiceDay {
  id: number;
  name: string;
  unit: string;
  rows: InvoiceRow[];
  totals: InvoiceRow;
  ordersClosed: number;
  error?: string;
}

interface DayReport {
  date: string;
  companies: CompanyInvoiceDay[];
  generatedAt: string;
}

interface BudgetSummary {
  budget: number;
  perDayRequired: number;
  workingDays: number;
  daysEntered: number;
  totalDone: number;
  prodDonePct: number;
  averageProduction: number;
  runRateRequired: number | null;
  countedThrough: string | null;
}

const root = document.querySelector<HTMLElement>('.production');

if (root) {
  const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
  const el = {
    day: $<HTMLInputElement>('#day'),
    prev: $<HTMLButtonElement>('#day-prev'),
    next: $<HTMLButtonElement>('#day-next'),
    yesterday: $<HTMLButtonElement>('#day-yesterday'),
    refresh: $<HTMLButtonElement>('#day-refresh'),
    rail: $<HTMLElement>('#day-rail'),
    chips: $<HTMLElement>('#group-chips'),
    grid: $<HTMLElement>('#day-grid'),
    note: $<HTMLElement>('#day-note'),
  };

  const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const qty = (v: number) => nf.format(Math.round(v));
  const usd = (v: number) => `$${nf.format(Math.round(v))}`;
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const esc = (s: string | number) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

  const longDate = (iso: string) => {
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
  };

  const monthName = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });

  const shiftDay = (iso: string, days: number) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };

  const yesterday = () => shiftDay(new Date().toISOString().slice(0, 10), -1);

  /* ------------------------------------------------------------- columns */

  interface Column {
    key: keyof InvoiceRow;
    label: string;
    money?: boolean;
    /** Quantity columns are per-company units (PCS or GRS) and never add up. */
    unitised?: boolean;
  }

  interface Group {
    id: string;
    label: string;
    columns: Column[];
    on: boolean;
    tinted?: boolean;
  }

  // The sheet's own order and wording, gathered into groups.
  const GROUPS: Group[] = [
    {
      id: 'packing',
      label: 'Packing',
      on: true,
      columns: [
        { key: 'packingQty', label: 'Qty', unitised: true },
        { key: 'packingValue', label: 'Value', money: true },
      ],
    },
    {
      id: 'pending',
      label: 'Pending',
      on: true,
      columns: [
        { key: 'pendingQty', label: 'Qty', unitised: true },
        { key: 'pendingValue', label: 'Value', money: true },
        { key: 'pendingOa', label: 'OA' },
      ],
    },
    {
      id: 'released',
      label: 'Released yesterday',
      on: true,
      tinted: true,
      columns: [
        { key: 'todayReleasedQty', label: 'Qty', unitised: true },
        { key: 'todayReleasedValue', label: 'Value', money: true },
      ],
    },
    {
      id: 'cumulative',
      label: 'Cumulative',
      on: true,
      columns: [
        { key: 'cumProduction', label: 'Production', unitised: true },
        { key: 'cumInvoicing', label: 'Invoicing', money: true },
      ],
    },
    {
      id: 'cumReleased',
      label: 'Cum. released',
      on: false,
      columns: [
        { key: 'cumReleasedQty', label: 'Qty', unitised: true },
        { key: 'cumReleasedValue', label: 'Value', money: true },
      ],
    },
  ];

  const activeGroups = () => GROUPS.filter((g) => g.on);
  const activeColumns = () => activeGroups().flatMap((g) => g.columns);

  /* --------------------------------------------------------------- state */

  const state = {
    report: null as DayReport | null,
    budget: null as BudgetSummary | null,
    query: '',
  };

  let inFlight: AbortController | null = null;

  async function load(date: string) {
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;

    el.rail.innerHTML = '';
    el.chips.hidden = true;
    el.note.textContent = '';
    el.grid.innerHTML = `<div class="state"><h2><span class="spinner"></span> Reading Odoo</h2><p>Building the invoice report for ${esc(
      longDate(date),
    )}, once per company.</p></div>`;

    try {
      // The month's budget gives the day a target to be measured against.
      const [reportRes, budgetRes] = await Promise.all([
        fetch(`/api/day-report?date=${date}`, { signal: controller.signal }),
        fetch(`/api/budget?month=${date.slice(0, 7)}`, { signal: controller.signal }).catch(
          () => null,
        ),
      ]);

      const data = await reportRes.json();
      if (!reportRes.ok) throw new Error(data?.error ?? `HTTP ${reportRes.status}`);
      state.report = data as DayReport;

      state.budget = null;
      if (budgetRes?.ok) {
        const budget = await budgetRes.json().catch(() => null);
        state.budget = budget?.view?.summary ?? null;
      }

      render();
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      el.grid.innerHTML = `<div class="state error"><h2>Could not build the report</h2><p style="font-family:var(--mono);font-size:12.5px">${esc(
        (err as Error).message,
      )}</p></div>`;
    }
  }

  /* ---------------------------------------------------------------- rail */

  const railBlock = (label: string, body: string, note = '') =>
    `<section class="rail-block panel">
      <h2>${esc(label)}</h2>
      ${body}
      ${note ? `<p class="rail-note">${note}</p>` : ''}
    </section>`;

  function renderRail(report: DayReport) {
    const live = report.companies.filter((c) => !c.error);
    const sum = (pick: (c: CompanyInvoiceDay) => number) => live.reduce((a, c) => a + pick(c), 0);

    const releasedValue = sum((c) => c.totals.todayReleasedValue);
    const releasedQty = sum((c) => c.totals.todayReleasedQty);
    const pendingValue = sum((c) => c.totals.pendingValue);
    const pendingOa = sum((c) => c.totals.pendingOa);
    const ordersClosed = sum((c) => c.ordersClosed);

    /* 1 — what went out, against what a day is supposed to carry */
    const perDay = state.budget?.perDayRequired ?? 0;
    // Both sides are money: the plan is a USD figure, so comparing the released
    // value to it is the only comparison that means anything.
    const ratio = perDay ? releasedValue / perDay : 0;
    const verdict = !perDay
      ? ''
      : ratio >= 1
        ? `<span class="good">${ratio.toFixed(1)}× the daily plan</span> — a release day, not a typical one`
        : `<span class="warn">${pct(ratio)} of the daily plan</span> of ${usd(perDay)}`;

    const released = railBlock(
      'Released',
      `<p class="rail-figure">${usd(releasedValue)}</p>
       <p class="rail-sub">${qty(releasedQty)} pieces · ${qty(ordersClosed)} orders closed</p>
       ${verdict ? `<p class="rail-verdict">${verdict}</p>` : ''}`,
      esc(longDate(report.date)),
    );

    /* 2 — what is waiting, and whose */
    const split = live
      .map((c, i) => {
        const share = pendingValue ? c.totals.pendingValue / pendingValue : 0;
        return `<div class="rail-split">
          <div class="rail-split-head">
            <span><i class="swatch s${i + 1}"></i>${esc(c.name)}</span>
            <b>${usd(c.totals.pendingValue)}</b>
          </div>
          <div class="meter"><span class="meter-fill s${i + 1}" style="width:${(share * 100).toFixed(1)}%"></span></div>
          <p class="rail-sub">${qty(c.totals.pendingQty)} ${esc(c.unit)} · ${qty(c.totals.pendingOa)} OA</p>
        </div>`;
      })
      .join('');

    const pending = railBlock(
      'Pending',
      `<p class="rail-figure">${usd(pendingValue)}</p>
       <p class="rail-sub">${qty(pendingOa)} order acknowledgements open</p>
       ${split}`,
    );

    /* 3 — where the month stands */
    let month = '';
    const b = state.budget;
    if (b && b.budget) {
      const ahead = b.averageProduction >= b.perDayRequired;
      month = railBlock(
        `${monthName(report.date)}, month to date`,
        `<p class="rail-figure">${pct(b.prodDonePct)}</p>
         <div class="meter"><span class="meter-fill accent" style="width:${Math.min(b.prodDonePct * 100, 100).toFixed(1)}%"></span></div>
         <p class="rail-sub">${usd(b.totalDone)} of ${usd(b.budget)}</p>
         <dl class="rail-pairs">
           <dt>Average per day</dt>
           <dd class="${ahead ? 'good' : 'warn'}">${usd(b.averageProduction)}</dd>
           <dt>Needed per day</dt>
           <dd>${usd(b.perDayRequired)}</dd>
           <dt>Run rate required</dt>
           <dd>${
             b.runRateRequired === null
               ? 'month complete'
               : `${usd(b.runRateRequired)}<span class="rail-sub"> for the last ${qty(
                   b.workingDays - b.daysEntered,
                 )} days</span>`
           }</dd>
         </dl>`,
        `${b.daysEntered} of ${b.workingDays} working days${
          b.countedThrough ? ` · counted to ${esc(shortDate(b.countedThrough))}` : ''
        }`,
      );
    }

    /* 4 — what has stalled: money pending, nothing released */
    const stuck = live
      .flatMap((c) => c.rows.map((r) => ({ ...r, company: c.name, unit: c.unit })))
      .filter((r) => r.pendingValue > 0 && r.todayReleasedValue === 0)
      .sort((a, b2) => b2.pendingValue - a.pendingValue)
      .slice(0, 5);

    const stuckBlock = railBlock(
      'Stuck in pending',
      stuck.length
        ? `<ul class="stuck">${stuck
            .map((r) => {
              const width = stuck[0].pendingValue
                ? (r.pendingValue / stuck[0].pendingValue) * 100
                : 0;
              return `<li>
                <div class="stuck-head">
                  <span class="stuck-name">${esc(r.product)}</span>
                  <b>${usd(r.pendingValue)}</b>
                </div>
                <div class="meter"><span class="meter-fill serious" style="width:${width.toFixed(1)}%"></span></div>
                <p class="rail-sub">${qty(r.pendingQty)} ${esc(r.unit)}${
                  r.pendingOa ? ` · ${qty(r.pendingOa)} OA` : ''
                } · ${esc(r.company)}</p>
              </li>`;
            })
            .join('')}</ul>`
        : '<p class="rail-sub">Everything with money pending also released something.</p>',
      'Pending value with nothing released on the day',
    );

    el.rail.innerHTML = released + pending + month + stuckBlock;
  }

  const shortDate = (iso: string) => {
    const d = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(d.getTime())
      ? iso
      : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  };

  /* ---------------------------------------------------------------- grid */

  function renderChips() {
    el.chips.hidden = false;
    el.chips.innerHTML =
      `<span class="chips-label">Columns</span>` +
      GROUPS.map(
        (g) =>
          `<button class="chip toggle" type="button" data-group="${g.id}" aria-pressed="${g.on}">${
            g.on ? '' : '+ '
          }${esc(g.label)}</button>`,
      ).join('') +
      `<input class="chips-search" id="grid-search" type="search" placeholder="Search products…" value="${esc(
        state.query,
      )}" />
       <button class="chip" type="button" id="grid-export">Export CSV</button>`;
  }

  const cell = (col: Column, value: number) =>
    value === 0 ? '' : col.money ? usd(value) : qty(value);

  function renderGrid(report: DayReport) {
    const live = report.companies.filter((c) => !c.error);
    const groups = activeGroups();
    const columns = activeColumns();
    const span = columns.length + 1;

    const head = `<thead>
      <tr class="group-row">
        <th class="sticky-col" rowspan="2">Product</th>
        ${groups
          .map(
            (g) =>
              `<th colspan="${g.columns.length}" class="group-head${g.tinted ? ' tinted' : ''}">${esc(
                g.label,
              )}</th>`,
          )
          .join('')}
      </tr>
      <tr class="sub-row">
        ${groups
          .map((g) =>
            g.columns
              .map((c) => `<th class="num${g.tinted ? ' tinted' : ''}">${esc(c.label)}</th>`)
              .join(''),
          )
          .join('')}
      </tr>
    </thead>`;

    const query = state.query.trim().toLowerCase();
    const visible = live
      .map((c) => ({
        company: c,
        rows: query ? c.rows.filter((r) => r.product.toLowerCase().includes(query)) : c.rows,
      }))
      .filter((entry) => entry.rows.length);

    const body = visible
      .map(({ company: c, rows: shown }) => {
        const heading = `<tr class="company-row">
          <td class="sticky-col" colspan="${span}">
            <strong>${esc(c.name)}</strong>
            <span class="rail-sub">${shown.length}${
              shown.length === c.rows.length ? '' : ` of ${c.rows.length}`
            } products · quantities in ${esc(c.unit)}</span>
          </td>
        </tr>`;

        const rows = shown
          .map(
            (r) =>
              `<tr>
                <td class="sticky-col">${esc(r.product)}</td>
                ${columns.map((col) => `<td class="num">${cell(col, r[col.key] as number)}</td>`).join('')}
              </tr>`,
          )
          .join('');

        // The sheet's own TOTAL row, not a sum of what happens to be on screen.
        const total = `<tr class="total-row">
          <td class="sticky-col">${esc(c.name)} total <span class="rail-sub">${
            c.rows.length
          } products${query ? ', whole sheet' : ''}</span></td>
          ${columns
            .map((col) => `<td class="num">${cell(col, c.totals[col.key] as number)}</td>`)
            .join('')}
        </tr>`;

        return heading + rows + total;
      })
      .join('');

    // Money adds across companies; quantities do not — Zipper counts in PCS and
    // Metal Trims in GRS, so those cells name the units instead of summing.
    const units = [...new Set(live.map((c) => c.unit))];
    const grand = live.length > 1
      ? `<tr class="grand-row">
          <td class="sticky-col">Both companies <span class="rail-sub">money only</span></td>
          ${columns
            .map((col) => {
              if (col.unitised) return `<td class="num units">${esc(units.join(' + '))}</td>`;
              const value = live.reduce((a, c) => a + (c.totals[col.key] as number), 0);
              return `<td class="num">${cell(col, value)}</td>`;
            })
            .join('')}
        </tr>`
      : '';

    el.grid.innerHTML = visible.length
      ? `<table class="grid day-grid">${head}<tbody>${body}${grand}</tbody></table>`
      : `<div class="state"><h2>No product matches “${esc(state.query)}”</h2><p>Clear the search to see the whole sheet.</p></div>`;

    const closed = live.reduce((a, c) => a + c.ordersClosed, 0);
    const cumInvoicing = live.reduce((a, c) => a + c.totals.cumInvoicing, 0);
    const failed = report.companies.filter((c) => c.error);

    el.note.innerHTML =
      `${qty(closed)} orders closed on this day. Cumulative invoicing ${usd(
        cumInvoicing,
      )} across ${live.length > 1 ? 'both companies' : esc(live[0]?.name ?? 'the company')}.` +
      (failed.length
        ? ` <span title="${esc(
            failed.map((c) => `${c.name}: ${c.error}`).join(' | '),
          )}">No report for ${esc(failed.map((c) => c.name).join(' and '))}.</span>`
        : '');
  }

  function render() {
    if (!state.report) return;
    renderRail(state.report);
    renderChips();
    renderGrid(state.report);
  }

  let searchTimer: number | undefined;
  el.chips.addEventListener('input', (event) => {
    const input = event.target as HTMLInputElement;
    if (input.id !== 'grid-search') return;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      state.query = input.value;
      // Only the grid is redrawn, so the caret stays in the search box.
      if (state.report) renderGrid(state.report);
    }, 140);
  });

  el.chips.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).id === 'grid-export') {
      exportCsv();
      return;
    }
    const btn = (event.target as HTMLElement).closest<HTMLElement>('[data-group]');
    if (!btn) return;
    const group = GROUPS.find((g) => g.id === btn.dataset.group);
    if (!group) return;
    // Keep at least one group on; an empty grid helps nobody.
    if (group.on && activeGroups().length === 1) return;
    group.on = !group.on;
    btn.setAttribute('aria-pressed', String(group.on));
    if (state.report) renderGrid(state.report);
  });

  /** The sheet as shown: active columns, every company, totals included. */
  function exportCsv() {
    const report = state.report;
    if (!report) return;
    const live = report.companies.filter((c) => !c.error);
    const columns = activeColumns();
    const groups = activeGroups();

    const cellFor = (v: number) => (v === 0 ? '' : String(Math.round(v)));
    const escape = (v: string) =>
      /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

    const lines = [
      ['', ...groups.flatMap((g) => g.columns.map(() => g.label))].map(escape).join(','),
      ['Product', ...columns.map((c) => c.label)].map(escape).join(','),
    ];

    for (const c of live) {
      lines.push(escape(`${c.name} (${c.unit})`));
      for (const r of c.rows) {
        lines.push([escape(r.product), ...columns.map((col) => cellFor(r[col.key] as number))].join(','));
      }
      lines.push(
        [escape(`${c.name} total`), ...columns.map((col) => cellFor(c.totals[col.key] as number))].join(','),
      );
    }

    // BOM first so Excel opens it as UTF-8.
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Production report ${report.date}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /* -------------------------------------------------------------- events */

  const go = (date: string) => {
    const max = root.dataset.today ?? date;
    const clamped = date > max ? max : date;
    el.day.value = clamped;
    el.next.disabled = clamped >= max;
    void load(clamped);
  };

  el.day.addEventListener('change', () => go(el.day.value));
  el.prev.addEventListener('click', () => go(shiftDay(el.day.value, -1)));
  el.next.addEventListener('click', () => go(shiftDay(el.day.value, 1)));
  el.yesterday.addEventListener('click', () => go(yesterday()));
  el.refresh.addEventListener('click', () => go(el.day.value));

  if (root.dataset.odoo !== '1') {
    [el.prev, el.next, el.yesterday, el.refresh].forEach((b) => (b.disabled = true));
    el.grid.innerHTML =
      '<div class="state"><h2>Not connected</h2><p>Set the Odoo credentials in .env to read the report.</p></div>';
  } else {
    go(root.dataset.date ?? yesterday());
  }
}
