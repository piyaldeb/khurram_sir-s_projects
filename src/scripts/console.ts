/**
 * Report console: drives the filter form, asks the server to run an Odoo
 * report, and renders the returned workbook as a searchable, sortable table.
 */

interface SheetCell {
  v: string | number | null;
  n?: boolean;
  b?: boolean;
  rs?: number;
  cs?: number;
}

interface Sheet {
  name: string;
  rows: (SheetCell | null)[][];
  headerRow: number;
  columnCount: number;
  rowCount: number;
  widths: number[];
}

interface ReportResult {
  reportType: string;
  reportLabel: string;
  reportName: string;
  filename: string;
  generatedAt: string;
  sizeBytes: number;
  elapsedMs: number;
  workbook: { sheets: Sheet[]; filename: string };
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel);

const els = {
  railSearch: $<HTMLInputElement>('#rail-search'),
  title: $<HTMLElement>('#report-title'),
  sub: $<HTMLElement>('#report-sub'),
  run: $<HTMLButtonElement>('#run'),
  download: $<HTMLButtonElement>('#download'),
  dateFrom: $<HTMLInputElement>('#date_from'),
  dateTo: $<HTMLInputElement>('#date_to'),
  buyer: $<HTMLSelectElement>('#buyer_id'),
  challan: $<HTMLSelectElement>('#challan_id'),
  fDateFrom: $<HTMLElement>('#f-date-from'),
  fDateTo: $<HTMLElement>('#f-date-to'),
  fBuyer: $<HTMLElement>('#f-buyer'),
  fChallan: $<HTMLElement>('#f-challan'),
  kpis: $<HTMLElement>('#kpis'),
  results: $<HTMLElement>('#results'),
  workcenters: $<HTMLElement>('#workcenters'),
};

if (els.run) {
  const state = {
    report: '',
    label: '',
    needs: { dateFrom: true, dateTo: true, buyer: false, challan: false },
    result: null as ReportResult | null,
    sheetIndex: 0,
    sort: null as { col: number; dir: 1 | -1 } | null,
    query: '',
    totals: true,
    /** Rendering every row of a 20k-row report locks the page up. */
    rowLimit: 2000 as number | null,
    buyersLoaded: false,
    challanFor: '',
  };

  /* ------------------------------------------------------------- helpers */

  const iso = (d: Date) => {
    const tzOffset = d.getTimezoneOffset() * 60000;
    return new Date(d.getTime() - tzOffset).toISOString().slice(0, 10);
  };

  const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });

  const fmt = (cell: SheetCell): string => {
    if (cell.v === null || cell.v === undefined) return '';
    return cell.n && typeof cell.v === 'number' ? nf.format(cell.v) : String(cell.v);
  };

  const escapeHtml = (s: string) =>
    s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

  const highlight = (text: string, query: string): string => {
    if (!query) return escapeHtml(text);
    const i = text.toLowerCase().indexOf(query.toLowerCase());
    if (i < 0) return escapeHtml(text);
    return (
      escapeHtml(text.slice(0, i)) +
      '<mark>' +
      escapeHtml(text.slice(i, i + query.length)) +
      '</mark>' +
      escapeHtml(text.slice(i + query.length))
    );
  };

  const bytes = (n: number) =>
    n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

  /* -------------------------------------------------- report rail + form */

  function selectReport(btn: HTMLElement) {
    document
      .querySelectorAll<HTMLElement>('.rail-item')
      .forEach((b) => b.setAttribute('aria-current', String(b === btn)));

    state.report = btn.dataset.report ?? '';
    state.label = btn.dataset.label ?? '';
    state.needs = {
      dateFrom: btn.dataset.dateFrom === 'true',
      dateTo: btn.dataset.dateTo === 'true',
      buyer: btn.dataset.buyer === 'true',
      challan: btn.dataset.challan === 'true',
    };

    if (els.title) els.title.textContent = state.label;
    if (els.sub) {
      const parts: string[] = [];
      if (state.needs.dateFrom || state.needs.dateTo) parts.push('date range');
      if (state.needs.buyer) parts.push('buyer filter');
      if (state.needs.challan) parts.push('challan');
      els.sub.textContent = parts.length
        ? `Filters: ${parts.join(' · ')}`
        : 'This report takes no filters.';
    }

    els.fDateFrom!.hidden = !state.needs.dateFrom;
    els.fDateTo!.hidden = !state.needs.dateTo;
    els.fBuyer!.hidden = !state.needs.buyer;
    els.fChallan!.hidden = !state.needs.challan;

    if (state.needs.buyer) void loadBuyers();
    if (state.needs.challan) void loadChallans(state.report);
  }

  document.querySelectorAll<HTMLElement>('.rail-item').forEach((btn) => {
    btn.addEventListener('click', () => selectReport(btn));
    if (btn.getAttribute('aria-current') === 'true') selectReport(btn);
  });

  if (!state.report) {
    const first = document.querySelector<HTMLElement>('.rail-item');
    if (first) selectReport(first);
  }

  els.railSearch?.addEventListener('input', () => {
    const q = els.railSearch!.value.trim().toLowerCase();
    document.querySelectorAll<HTMLElement>('.rail-group').forEach((group) => {
      let visible = 0;
      group.querySelectorAll<HTMLElement>('.rail-item').forEach((item) => {
        const hit = (item.dataset.label ?? '').toLowerCase().includes(q);
        item.hidden = !hit;
        if (hit) visible++;
      });
      group.hidden = visible === 0;
    });
  });

  document.querySelectorAll<HTMLElement>('[data-range]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const now = new Date();
      let from = new Date(now);
      let to = new Date(now);
      switch (chip.dataset.range) {
        case 'today':
          break;
        case '7':
          from.setDate(now.getDate() - 6);
          break;
        case '30':
          from.setDate(now.getDate() - 29);
          break;
        case 'mtd':
          from = new Date(now.getFullYear(), now.getMonth(), 1);
          break;
        case 'prev-month':
          from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
          to = new Date(now.getFullYear(), now.getMonth(), 0);
          break;
        case 'ytd':
          from = new Date(now.getFullYear(), 0, 1);
          break;
      }
      if (els.dateFrom) els.dateFrom.value = iso(from);
      if (els.dateTo) els.dateTo.value = iso(to);
    });
  });

  async function loadBuyers() {
    if (state.buyersLoaded || !els.buyer) return;
    state.buyersLoaded = true;
    try {
      const res = await fetch('/api/lookup?kind=buyers');
      const data = await res.json();
      if (Array.isArray(data)) {
        for (const b of data) {
          const opt = document.createElement('option');
          opt.value = String(b.id);
          opt.textContent = b.name;
          els.buyer.append(opt);
        }
      }
    } catch {
      state.buyersLoaded = false;
    }
  }

  async function loadChallans(reportType: string) {
    if (!els.challan || state.challanFor === reportType) return;
    state.challanFor = reportType;
    els.challan.innerHTML = '<option value="">Loading…</option>';
    try {
      const res = await fetch(`/api/lookup?kind=challans&report_type=${encodeURIComponent(reportType)}`);
      const data = await res.json();
      els.challan.innerHTML = '<option value="">All challans</option>';
      if (Array.isArray(data)) {
        for (const c of data) {
          const opt = document.createElement('option');
          opt.value = String(c.id);
          opt.textContent = c.name;
          els.challan.append(opt);
        }
      }
    } catch {
      els.challan.innerHTML = '<option value="">Could not load challans</option>';
      state.challanFor = '';
    }
  }

  function currentFilters() {
    return {
      report_type: state.report,
      date_from: state.needs.dateFrom ? els.dateFrom?.value || null : null,
      date_to: state.needs.dateTo ? els.dateTo?.value || null : null,
      buyer_id: state.needs.buyer ? Number(els.buyer?.value) || null : null,
      challan_id: state.needs.challan ? Number(els.challan?.value) || null : null,
    };
  }

  /* ------------------------------------------------------------- running */

  els.run.addEventListener('click', async () => {
    const filters = currentFilters();
    if (!filters.report_type) return;

    els.run!.disabled = true;
    els.download!.disabled = true;
    els.kpis!.hidden = true;
    els.results!.innerHTML =
      '<div class="state"><h2><span class="spinner"></span> Building the report</h2><p>Odoo is generating <strong>' +
      escapeHtml(state.label) +
      '</strong>. Large ranges can take a while.</p></div>';

    try {
      const res = await fetch('/api/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(filters),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);

      state.result = data as ReportResult;
      state.rowLimit = 2000;
      state.sheetIndex = 0;
      state.sort = null;
      state.query = '';
      renderResult();
    } catch (err) {
      els.results!.innerHTML =
        '<div class="state error"><h2>Report failed</h2><p style="font-family:var(--mono);font-size:12.5px;white-space:pre-wrap">' +
        escapeHtml((err as Error).message) +
        '</p></div>';
    } finally {
      els.run!.disabled = false;
      els.download!.disabled = false;
    }
  });

  els.download!.addEventListener('click', () => {
    const f = currentFilters();
    if (!f.report_type) return;
    const q = new URLSearchParams({ report_type: f.report_type });
    if (f.date_from) q.set('date_from', f.date_from);
    if (f.date_to) q.set('date_to', f.date_to);
    if (f.buyer_id) q.set('buyer_id', String(f.buyer_id));
    if (f.challan_id) q.set('challan_id', String(f.challan_id));
    window.location.href = `/api/download?${q.toString()}`;
  });

  /* ----------------------------------------------------------- rendering */

  function dataRows(sheet: Sheet): (SheetCell | null)[][] {
    const start = sheet.headerRow >= 0 ? sheet.headerRow + 1 : 0;
    return sheet.rows.slice(start).filter((r) => r.some((c) => c && c.v !== null));
  }

  function renderResult() {
    const result = state.result;
    if (!result) return;
    const sheets = result.workbook.sheets;
    const sheet = sheets[state.sheetIndex];

    if (!sheet) {
      els.results!.innerHTML =
        '<div class="state"><h2>Empty workbook</h2><p>Odoo returned a file with no sheets.</p></div>';
      return;
    }

    const rows = dataRows(sheet);
    els.kpis!.hidden = false;
    els.kpis!.innerHTML = [
      tile('Rows', nf.format(rows.length), sheet.name),
      tile('Columns', nf.format(sheet.columnCount), ''),
      tile('Sheets', nf.format(sheets.length), sheets.map((s) => s.name).join(', ').slice(0, 42)),
      tile('Built in', `${(result.elapsedMs / 1000).toFixed(1)}s`, bytes(result.sizeBytes)),
      tile('Generated', new Date(result.generatedAt).toLocaleTimeString(), result.reportName ?? ''),
    ].join('');

    els.results!.innerHTML = `
      <div class="results-bar">
        <div class="tabs" role="tablist">
          ${sheets
            .map(
              (s, i) =>
                `<button class="tab" role="tab" data-sheet="${i}" aria-selected="${i === state.sheetIndex}">${escapeHtml(
                  s.name,
                )}</button>`,
            )
            .join('')}
        </div>
        <div class="topbar-spacer"></div>
        <input class="table-search" id="table-search" type="search" placeholder="Search rows…" value="${escapeHtml(state.query)}" />
        <button class="chip" id="toggle-totals" type="button">${state.totals ? 'Hide totals' : 'Show totals'}</button>
        <button class="chip" id="export-csv" type="button">Export CSV</button>
      </div>
      <div class="table-scroll" id="table-scroll"></div>`;

    els.results!.querySelectorAll<HTMLElement>('[data-sheet]').forEach((tab) =>
      tab.addEventListener('click', () => {
        state.sheetIndex = Number(tab.dataset.sheet);
        state.sort = null;
        renderResult();
      }),
    );

    const search = els.results!.querySelector<HTMLInputElement>('#table-search');
    let timer: number | undefined;
    search?.addEventListener('input', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        state.query = search.value.trim();
        renderTable();
      }, 140);
    });

    els.results!.querySelector('#toggle-totals')?.addEventListener('click', () => {
      state.totals = !state.totals;
      renderResult();
    });
    els.results!.querySelector('#export-csv')?.addEventListener('click', exportCsv);

    renderTable();
  }

  function tile(label: string, value: string, sub: string) {
    return `<div class="kpi"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(
      value,
    )}</div><div class="sub">${escapeHtml(sub)}</div></div>`;
  }

  function visibleRows(sheet: Sheet) {
    const rows = dataRows(sheet);
    const q = state.query.toLowerCase();
    let out = q
      ? rows.filter((r) => r.some((c) => c && c.v !== null && String(c.v).toLowerCase().includes(q)))
      : rows;

    if (state.sort) {
      const { col, dir } = state.sort;
      out = [...out].sort((a, b) => {
        const av = a[col]?.v ?? null;
        const bv = b[col]?.v ?? null;
        if (av === null && bv === null) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
        return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
      });
    }
    return out;
  }

  function renderTable() {
    const sheet = state.result?.workbook.sheets[state.sheetIndex];
    const host = document.getElementById('table-scroll');
    if (!sheet || !host) return;

    const allRows = visibleRows(sheet);
    const capped = state.rowLimit !== null && allRows.length > state.rowLimit;
    const rows = capped ? allRows.slice(0, state.rowLimit!) : allRows;
    const header = sheet.headerRow >= 0 ? sheet.rows[sheet.headerRow] : null;
    const preamble = sheet.headerRow > 0 ? sheet.rows.slice(0, sheet.headerRow) : [];
    const q = state.query;

    const cellHtml = (cell: SheetCell | null, tag: 'td' | 'th', col: number) => {
      if (!cell) return '';
      const attrs: string[] = [];
      if (cell.rs) attrs.push(`rowspan="${cell.rs}"`);
      if (cell.cs) attrs.push(`colspan="${cell.cs}"`);
      if (tag === 'td' && cell.n) attrs.push('class="num"');
      if (tag === 'th') {
        attrs.push(`data-col="${col}"`);
        if (state.sort?.col === col) attrs.push(`data-dir="${state.sort.dir}"`);
      }
      const text = fmt(cell);
      const arrow = tag === 'th' ? `<span class="arrow">${state.sort?.dir === -1 ? '▼' : '▲'}</span>` : '';
      return `<${tag} ${attrs.join(' ')}>${highlight(text, q)}${arrow}</${tag}>`;
    };

    const totalsRow = () => {
      if (!state.totals || !header) return '';
      const sums = new Array(sheet.columnCount).fill(null) as (number | null)[];
      // Totals cover every matching row, including any the cap is hiding.
      for (const row of allRows) {
        row.forEach((cell, i) => {
          if (cell?.n && typeof cell.v === 'number') sums[i] = (sums[i] ?? 0) + cell.v;
        });
      }
      if (sums.every((s) => s === null)) return '';
      const cells = sums
        .map((s, i) =>
          i === 0 && s === null
            ? `<td>Σ ${nf.format(allRows.length)} rows</td>`
            : s === null
              ? '<td></td>'
              : `<td class="num">${nf.format(Math.round(s * 10000) / 10000)}</td>`,
        )
        .join('');
      return `<tfoot><tr>${cells}</tr></tfoot>`;
    };

    host.innerHTML = `<table class="grid">
      ${
        preamble.length
          ? `<thead>${preamble
              .map(
                (r) =>
                  `<tr class="title">${r
                    .map((c) => (c ? cellHtml(c, 'td', 0) : ''))
                    .join('')}</tr>`,
              )
              .join('')}</thead>`
          : ''
      }
      ${header ? `<thead><tr>${header.map((c, i) => cellHtml(c, 'th', i)).join('')}</tr></thead>` : ''}
      <tbody>${rows
        .map((r) => `<tr>${r.map((c, i) => cellHtml(c, 'td', i)).join('')}</tr>`)
        .join('')}</tbody>
      ${totalsRow()}
    </table>`;

    if (!rows.length) {
      host.innerHTML +=
        '<div class="state"><h2>No rows match</h2><p>Clear the search or widen the date range.</p></div>';
    }

    // Never truncate silently - say what is hidden and offer the rest.
    if (capped) {
      host.insertAdjacentHTML(
        'beforeend',
        `<div class="row-cap">Showing the first ${nf.format(rows.length)} of ${nf.format(
          allRows.length,
        )} rows. <button class="chip" type="button" id="show-all">Show all rows</button></div>`,
      );
      host.querySelector('#show-all')?.addEventListener('click', () => {
        state.rowLimit = null;
        renderTable();
      });
    }

    host.querySelectorAll<HTMLElement>('th[data-col]').forEach((th) =>
      th.addEventListener('click', () => {
        const col = Number(th.dataset.col);
        state.sort =
          state.sort?.col === col
            ? state.sort.dir === 1
              ? { col, dir: -1 }
              : null
            : { col, dir: 1 };
        renderTable();
      }),
    );
  }

  function exportCsv() {
    const sheet = state.result?.workbook.sheets[state.sheetIndex];
    if (!sheet || !state.result) return;
    const header = sheet.headerRow >= 0 ? sheet.rows[sheet.headerRow] : null;
    const lines: string[] = [];
    const cell = (c: SheetCell | null) => {
      const v = c?.v ?? '';
      const s = typeof v === 'number' ? String(v) : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    if (header) lines.push(header.map(cell).join(','));
    for (const row of visibleRows(sheet)) lines.push(row.map(cell).join(','));

    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.result.reportLabel.replace(/[^\w -]/g, '')} - ${sheet.name}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /* --------------------------------------------------------- work centres */

  const wcDetails = els.workcenters?.closest('details');
  wcDetails?.addEventListener(
    'toggle',
    async () => {
      if (!wcDetails.open || !els.workcenters || els.workcenters.dataset.loaded) return;
      els.workcenters.dataset.loaded = '1';
      try {
        const res = await fetch('/api/lookup?kind=workcenters');
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error(data?.error ?? 'Unexpected response');
        const active = data.filter((w: any) => w.workorder_count > 0);
        els.workcenters.innerHTML = `
          <table class="wc-table">
            <thead><tr>
              <th>Work centre</th><th>State</th>
              <th style="text-align:right">Work orders</th>
              <th style="text-align:right">To produce</th>
              <th style="text-align:right">To output</th>
              <th style="text-align:right">To QC</th>
              <th style="text-align:right">OEE target</th>
            </tr></thead>
            <tbody>${(active.length ? active : data)
              .map(
                (w: any) => `<tr>
                  <td>${escapeHtml(w.name ?? '')}</td>
                  <td><span class="badge ${w.working_state === 'blocked' ? 'blocked' : w.working_state === 'done' ? 'progress' : ''}">
                    <span class="dot"></span>${escapeHtml(w.working_state ?? '')}</span></td>
                  <td class="num">${nf.format(w.workorder_count ?? 0)}</td>
                  <td class="num">${nf.format(w.order_toproduce_count ?? 0)}</td>
                  <td class="num">${nf.format(w.order_tooutput_count ?? 0)}</td>
                  <td class="num">${nf.format(w.order_toqc_count ?? 0)}</td>
                  <td class="num">${nf.format(w.oee_target ?? 0)}%</td>
                </tr>`,
              )
              .join('')}</tbody>
          </table>`;
      } catch (err) {
        els.workcenters.textContent = `Could not load work centres: ${(err as Error).message}`;
        delete els.workcenters.dataset.loaded;
      }
    },
  );
}
