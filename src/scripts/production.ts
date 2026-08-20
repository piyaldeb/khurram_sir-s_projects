/**
 * Production report: the daily MRP Invoice sheet, one card per company.
 *
 * Renders exactly what the factory's own sheet shows — product rows with
 * packing, pending, cumulative and released figures plus pending OA — with
 * money in dollars and the day's totals as KPI tiles.
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

const root = document.querySelector<HTMLElement>('.production');

if (root) {
  const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
  const el = {
    day: $<HTMLInputElement>('#day'),
    prev: $<HTMLButtonElement>('#day-prev'),
    next: $<HTMLButtonElement>('#day-next'),
    yesterday: $<HTMLButtonElement>('#day-yesterday'),
    refresh: $<HTMLButtonElement>('#day-refresh'),
    kpis: $<HTMLElement>('#day-kpis'),
    companies: $<HTMLElement>('#day-companies'),
  };

  const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  /** Quantities and counts: plain numbers. */
  const qty = (v: number) => nf.format(Math.round(v));
  /** Money always carries the symbol. */
  const usd = (v: number) => `$${nf.format(Math.round(v))}`;
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

  const shiftDay = (iso: string, days: number) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };

  const yesterday = () => shiftDay(new Date().toISOString().slice(0, 10), -1);

  let inFlight: AbortController | null = null;

  async function load(date: string) {
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;

    el.kpis.hidden = true;
    el.companies.innerHTML = `<div class="panel state"><h2><span class="spinner"></span> Reading Odoo</h2><p>Building the invoice report for ${esc(
      longDate(date),
    )}, once per company.</p></div>`;

    try {
      const res = await fetch(`/api/day-report?date=${date}`, { signal: controller.signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      render(data as DayReport);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      el.kpis.hidden = true;
      el.companies.innerHTML = `<div class="panel state error"><h2>Could not build the report</h2><p style="font-family:var(--mono);font-size:12.5px">${esc(
        (err as Error).message,
      )}</p></div>`;
    }
  }

  /** The column layout of one company card. Money columns carry $. */
  const COLUMNS: { key: keyof InvoiceRow; label: (unit: string) => string; money?: boolean }[] = [
    { key: 'packingQty', label: (u) => `Packing ${u}` },
    { key: 'packingValue', label: () => 'Packing value', money: true },
    { key: 'pendingQty', label: (u) => `Pending ${u}` },
    { key: 'pendingValue', label: () => 'Pending', money: true },
    { key: 'cumProduction', label: () => 'Cum. production' },
    { key: 'cumInvoicing', label: () => 'Cum. invoicing', money: true },
    { key: 'todayReleasedQty', label: (u) => `Released ${u}` },
    { key: 'todayReleasedValue', label: () => 'Released', money: true },
    { key: 'cumReleasedQty', label: (u) => `Cum. released ${u}` },
    { key: 'cumReleasedValue', label: () => 'Cum. released', money: true },
    { key: 'pendingOa', label: () => 'Pending OA' },
  ];

  function render(report: DayReport) {
    const live = report.companies.filter((c) => !c.error);

    // Headline tiles: the figures people open this page for.
    const total = (pick: (c: CompanyInvoiceDay) => number) => live.reduce((a, c) => a + pick(c), 0);
    const tiles = [
      tile('Packing value', usd(total((c) => c.totals.packingValue)), longDate(report.date)),
      tile('Released today', usd(total((c) => c.totals.todayReleasedValue)), `${qty(total((c) => c.totals.todayReleasedQty))} pcs`),
      tile('Pending value', usd(total((c) => c.totals.pendingValue)), `${qty(total((c) => c.totals.pendingQty))} pcs outstanding`),
      tile('Pending OA', qty(total((c) => c.totals.pendingOa)), 'order acknowledgements open'),
      tile('Orders closed', qty(total((c) => c.ordersClosed)), 'on this day'),
      ...live.map((c) =>
        tile(c.name, usd(c.totals.pendingValue), `pending · packing ${usd(c.totals.packingValue)}`),
      ),
    ];
    el.kpis.innerHTML = tiles.join('');
    el.kpis.hidden = false;

    el.companies.innerHTML = live
      .map((c) => {
        if (!c.rows.length) {
          return `<section class="panel card" style="margin-bottom:16px">
            <div class="card-head"><h2>${esc(c.name)}</h2></div>
            <div class="state" style="padding:22px 16px"><p>Nothing on the sheet for this day.</p></div>
          </section>`;
        }

        // Biggest first: pending value is what the sheet is read for, with
        // packing value breaking ties for rows that have nothing pending.
        const rows = [...c.rows].sort(
          (a, b) => b.pendingValue - a.pendingValue || b.packingValue - a.packingValue || b.cumInvoicing - a.cumInvoicing,
        );

        const head = `<tr><th>Product</th>${COLUMNS.map(
          (col) => `<th class="num">${esc(col.label(c.unit))}</th>`,
        ).join('')}</tr>`;

        const fmt = (col: (typeof COLUMNS)[number], v: number) =>
          v === 0 ? '' : col.money ? usd(v) : qty(v);

        const body = rows
          .map(
            (row) =>
              `<tr><td>${esc(row.product)}</td>${COLUMNS.map(
                (col) => `<td class="num">${fmt(col, row[col.key] as number)}</td>`,
              ).join('')}</tr>`,
          )
          .join('');

        const foot =
          `<tr><td>Total Order Close: ${qty(c.ordersClosed)}</td>${COLUMNS.map(() => '<td></td>').join('')}</tr>` +
          `<tr><td>TOTAL</td>${COLUMNS.map(
            (col) =>
              `<td class="num">${col.money ? usd(c.totals[col.key] as number) : qty(c.totals[col.key] as number)}</td>`,
          ).join('')}</tr>`;

        return `<section class="panel card" style="margin-bottom:16px">
          <div class="card-head">
            <h2>${esc(c.name)}</h2>
            <span class="hint">${c.rows.length} products · quantities in ${esc(c.unit)}</span>
          </div>
          <div class="table-scroll" style="max-height:none">
            <table class="grid day-table">
              <thead>${head}</thead>
              <tbody>${body}</tbody>
              <tfoot>${foot}</tfoot>
            </table>
          </div>
        </section>`;
      })
      .join('');

    const failed = report.companies.filter((c) => c.error);
    if (failed.length) {
      el.companies.insertAdjacentHTML(
        'beforeend',
        `<p class="hint" title="${esc(failed.map((c) => `${c.name}: ${c.error}`).join(' | '))}">No report for ${esc(
          failed.map((c) => c.name).join(' and '),
        )}.</p>`,
      );
    }
  }

  const tile = (label: string, value: string, sub: string) =>
    `<div class="kpi"><div class="label">${esc(label)}</div><div class="value">${esc(
      value,
    )}</div><div class="sub">${esc(sub)}</div></div>`;

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
    el.companies.innerHTML =
      '<div class="panel state"><h2>Not connected</h2><p>Set the Odoo credentials in .env to read the report.</p></div>';
  } else {
    go(root.dataset.date ?? yesterday());
  }
}
