/**
 * 180+ days stock — client rendering.
 *
 * One fetch pulls every month Odoo has snapshotted; the scope and month
 * controls are pure re-projections of that payload, so switching between Zipper
 * and Metal Trims or stepping back through the history costs nothing.
 *
 * The page answers four questions in order, and the layout follows them:
 *   1. How much is stuck, and is it growing?      KPIs and the trend chart
 *   2. Is it a timing problem or a write-off?     the usable / dead-money split
 *   3. Where did it come from?                    flow, profile, waterfall
 *   4. What do I actually go and deal with?       category and lot tables
 */
import { lineChart, bindChartTooltips } from '../lib/charts';
import { skeleton } from '../lib/skeleton';

// ------------------------------------------------------------------- shapes

interface MovementPoint {
  month: string;
  opening: number;
  newAdd: number;
  currentStatus: number;
  issue: number;
  closing: number;
}

interface BucketPoint {
  month: string;
  value: number[];
  qty: number[];
}

interface CategoryRow {
  category: string;
  opening: number;
  newAdd: number;
  issue: number;
  closing: number;
  history: (number | null)[];
}

interface LotRow {
  lot: string;
  product: string;
  code: string;
  category: string;
  company: string;
  uom: string;
  receivedOn: string | null;
  duration: number;
  qty: number;
  band181: number;
  band365: number;
  value: number;
  unusable: boolean;
  rejected: string;
  shipment: string;
  unitPrice: number;
}

interface SplitPoint {
  month: string;
  usable: number;
  unusable: number;
}

interface CompanyReport {
  key: string;
  id: number;
  name: string;
  movement: MovementPoint[];
  buckets: BucketPoint[];
  categories: CategoryRow[];
  split: SplitPoint[];
  lots: LotRow[];
}

interface InventoryMatrix {
  months: string[];
  years: string[];
  cell: Record<string, Record<string, { total: number; rm: number }>>;
}

interface DailyPoint {
  date: string;
  zipper: number;
  mt: number;
}

interface AgeingReport {
  generatedAt: string;
  months: string[];
  asOf: string;
  slots: { field: string; label: string }[];
  companies: CompanyReport[];
  inventory: InventoryMatrix | null;
  daily: DailyPoint[];
  error?: string;
}

type Scope = 'all' | 'zipper' | 'mt';
type LotFilter = 'all' | 'unusable' | 'usable' | '365' | 'rejected';

// -------------------------------------------------------------------- state

const state = {
  report: null as AgeingReport | null,
  scope: 'all' as Scope,
  /** Index into `report.months`; defaults to the newest. */
  month: 0,
  lotFilter: 'all' as LotFilter,
  lotSearch: '',
  catSearch: '',
  lotSort: { key: 'value' as keyof LotRow, dir: -1 },
  catSort: { key: 'closing' as keyof CategoryRow, dir: -1 },
  /** Lot detail per month, fetched on demand and kept for the session. */
  lotsByMonth: new Map<string, Record<string, LotRow[]>>(),
  /** Guards against an out-of-order response overwriting a newer month. */
  lotRequest: 0,
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;

// ------------------------------------------------------------------ formats

/*
 * Rounding must never turn a real figure into a zero. A category holding $0.40
 * printed as "$0" reads as empty when it is not, and a 0.03% share printed as
 * "0.0%" says the same lie about a row that is plainly there. Both fall back to
 * a "smaller than this column can show" mark.
 */
const money = (v: number) =>
  v !== 0 && Math.abs(v) < 0.5
    ? `${v < 0 ? '−' : ''}<$1`
    : `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

const moneyExact = (v: number) =>
  `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const qty = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 2 });

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/** A share column: never rounds a real slice down to nothing. */
const share = (v: number) => (v !== 0 && Math.abs(v) < 0.0005 ? '<0.1%' : pct(v));

const esc = (s: string) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function monthLabel(month: string): string {
  const [y, m] = month.split('-');
  const d = new Date(Number(y), Number(m) - 1, 1);
  return Number.isNaN(d.getTime()) ? month : d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

/** Years reads better than a four-digit day count once a lot passes its first. */
function ageLabel(days: number): string {
  if (days < 365) return `${days}d`;
  const years = days / 365;
  return `${years.toFixed(years >= 10 ? 0 : 1)}y`;
}

// ------------------------------------------------------------------ scoping

/** The companies the current scope covers. */
function scoped(): CompanyReport[] {
  const all = state.report?.companies ?? [];
  return state.scope === 'all' ? all : all.filter((c) => c.key === state.scope);
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Movement for the current scope, summed across companies, month by month. */
function movementSeries(): MovementPoint[] {
  const months = state.report?.months ?? [];
  const cs = scoped();
  return months.map((month, i) => ({
    month,
    opening: sum(cs.map((c) => c.movement[i]?.opening ?? 0)),
    newAdd: sum(cs.map((c) => c.movement[i]?.newAdd ?? 0)),
    currentStatus: sum(cs.map((c) => c.movement[i]?.currentStatus ?? 0)),
    issue: sum(cs.map((c) => c.movement[i]?.issue ?? 0)),
    closing: sum(cs.map((c) => c.movement[i]?.closing ?? 0)),
  }));
}

function bucketsAt(index: number): number[] {
  const slots = state.report?.slots ?? [];
  return slots.map((_, s) => sum(scoped().map((c) => c.buckets[index]?.value[s] ?? 0)));
}

function bucketQtyAt(index: number): number[] {
  const slots = state.report?.slots ?? [];
  return slots.map((_, s) => sum(scoped().map((c) => c.buckets[index]?.qty[s] ?? 0)));
}

/** Category rows merged across the scope's companies. */
function categoryRows(): CategoryRow[] {
  const monthCount = state.report?.months.length ?? 0;
  const by = new Map<string, CategoryRow>();
  for (const c of scoped()) {
    for (const row of c.categories) {
      const found = by.get(row.category);
      if (!found) {
        by.set(row.category, { ...row, history: [...row.history] });
        continue;
      }
      found.opening += row.opening;
      found.newAdd += row.newAdd;
      found.issue += row.issue;
      found.closing += row.closing;
      for (let i = 0; i < monthCount; i++) {
        const add = row.history[i];
        if (add === null || add === undefined) continue;
        found.history[i] = (found.history[i] ?? 0) + add;
      }
    }
  }
  return [...by.values()];
}

/** The usable / unusable split for the scope, at the selected month. */
function splitAt(): { usable: number; unusable: number } {
  const cs = scoped();
  return {
    usable: sum(cs.map((c) => c.split?.[state.month]?.usable ?? 0)),
    unusable: sum(cs.map((c) => c.split?.[state.month]?.unusable ?? 0)),
  };
}

/** Lot detail for the selected month, or null while it is still being fetched. */
function lotRows(): LotRow[] | null {
  const month = state.report?.months[state.month];
  if (!month) return null;
  const held = state.lotsByMonth.get(month);
  if (!held) return null;
  return scoped().flatMap((c) => held[c.key] ?? []);
}

function viewingLatest(): boolean {
  const months = state.report?.months ?? [];
  return state.month === months.length - 1;
}

/**
 * Pulls lot detail for the selected month if it is not already held.
 *
 * Only the month on screen is fetched — thirty months of lot rows is megabytes
 * — and each month is kept once fetched, because a closed snapshot never
 * changes again.
 */
async function ensureLots() {
  const month = state.report?.months[state.month];
  if (!month || state.lotsByMonth.has(month)) return;

  const ticket = ++state.lotRequest;
  try {
    const res = await fetch(`/api/ageing?lots=${month}`);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`);
    state.lotsByMonth.set(month, data.lots ?? {});
  } catch {
    // Leave the month unfetched so a later visit can retry; the table says so.
  }
  // A slower request for a month the user has already left must not repaint.
  if (ticket === state.lotRequest) renderLots();
}

// --------------------------------------------------------------------- boot

async function load(force = false) {
  showSkeletons();
  const banner = $('error-banner');
  banner?.setAttribute('hidden', '');

  try {
    const res = await fetch(`/api/ageing${force ? '?refresh=1' : ''}`);
    const data: AgeingReport = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`);

    state.report = data;
    state.month = Math.max(data.months.length - 1, 0);
    // The payload carries the newest month's lots already.
    if (data.asOf) {
      state.lotsByMonth.set(
        data.asOf,
        Object.fromEntries(data.companies.map((c) => [c.key, c.lots ?? []])),
      );
    }
    fillMonths();
    render();
  } catch (err) {
    if (banner) {
      banner.textContent = `Could not load the ageing report — ${(err as Error).message}`;
      banner.removeAttribute('hidden');
    }
    clearSkeletons();
  }
}

function showSkeletons() {
  const kpis = $('kpis');
  if (kpis) {
    kpis.innerHTML = Array.from(
      { length: 6 },
      () =>
        `<div class="kpi" aria-hidden="true"><span class="sk sk-line" style="width:60%;height:10px"></span>` +
        `<span class="sk sk-line" style="width:80%;height:24px"></span>` +
        `<span class="sk sk-line" style="width:50%;height:10px"></span></div>`,
    ).join('');
  }
  const summary = $('summary');
  if (summary) {
    summary.innerHTML = Array.from(
      { length: 3 },
      () =>
        `<section class="sum-panel" aria-hidden="true"><div style="padding:12px">${Array.from(
          { length: 7 },
          () => `<span class="sk sk-line" style="width:100%;height:13px"></span>`,
        ).join('')}</div></section>`,
    ).join('');
  }
  for (const id of ['chart-trend', 'chart-flow', 'chart-profile', 'chart-waterfall']) {
    const host = $(id);
    if (host) host.innerHTML = skeleton.chart(240);
  }
  const split = $('split-card');
  if (split) split.innerHTML = `<div style="padding:16px">${skeleton.chart(70)}</div>`;
  const cat = $('cat-grid');
  if (cat) cat.innerHTML = skeleton.table(7, 6);
  const lot = $('lot-grid');
  if (lot) lot.innerHTML = skeleton.table(9, 10);
}

function clearSkeletons() {
  for (const id of ['kpis', 'summary', 'chart-trend', 'chart-flow', 'chart-profile', 'chart-waterfall', 'split-card', 'cat-grid', 'lot-grid']) {
    const host = $(id);
    if (host) host.innerHTML = '';
  }
}

function fillMonths() {
  const select = $<HTMLSelectElement>('month-select');
  const months = state.report?.months ?? [];
  if (!select) return;
  select.innerHTML = months
    .map((m, i) => `<option value="${i}"${i === state.month ? ' selected' : ''}>${monthLabel(m)}</option>`)
    .join('');
}

// ------------------------------------------------------------------- render

function render() {
  const report = state.report;
  if (!report) return;

  renderAsOf();
  renderKpis();
  renderSummary();
  renderSplit();
  renderTrend();
  renderFlow();
  renderProfile();
  renderWaterfall();
  renderCategories();
  renderLots();

  document.querySelectorAll<HTMLElement>('.chart-host').forEach(bindChartTooltips);

  // Fills the lot table (and the split card's lot counts) once the month's
  // detail arrives; a no-op when it is already held.
  void ensureLots().then(() => {
    if (lotRows()) renderSplit();
  });
}

function renderAsOf() {
  const report = state.report!;
  const month = report.months[state.month];
  const built = new Date(report.generatedAt);
  const label = $('as-of');
  if (!label) return;
  const scopeName =
    state.scope === 'all' ? 'Zipper and Metal Trims' : scoped()[0]?.name ?? '';
  label.textContent =
    `${scopeName} · ${monthLabel(month)} snapshot · ${report.months.length} months of history · ` +
    `read ${built.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * The six figures the workbook's Dashboard sheet leads with, plus the one it
 * cannot compute: 180+ as a share of everything on the floor.
 */
function renderKpis() {
  const host = $('kpis');
  if (!host) return;

  const series = movementSeries();
  const now = series[state.month];
  const prev = series[state.month - 1];
  if (!now) return;

  const net = now.closing - now.opening;
  const buckets = bucketsAt(state.month);
  const totalStock = sum(buckets);
  const aged = buckets.slice(5).reduce((a, b) => a + b, 0);

  // A year ago if the history reaches that far, otherwise the oldest month.
  const yearAgo = series[Math.max(state.month - 12, 0)];
  const yoy = yearAgo && yearAgo.closing ? now.closing / yearAgo.closing - 1 : null;

  const cards = [
    {
      label: 'Opening 180+',
      value: money(now.opening),
      sub: prev ? `${monthLabel(prev.month)} closed here` : 'First month on record',
    },
    {
      label: 'Aged in',
      value: money(now.newAdd),
      sub: 'Crossed 180 days this month',
      tone: now.newAdd > Math.abs(now.issue) ? 'bad' : '',
    },
    {
      label: 'Consumed out',
      value: money(Math.abs(now.issue)),
      sub: 'Issued from the 180+ band',
      tone: 'good',
    },
    {
      label: 'Closing 180+',
      value: money(now.closing),
      sub: yoy === null ? 'No year-ago figure' : `${yoy >= 0 ? '+' : ''}${pct(yoy)} against a year ago`,
      tone: yoy !== null && yoy > 0 ? 'bad' : yoy !== null ? 'good' : '',
    },
    {
      label: 'Net change',
      value: `${net >= 0 ? '+' : '−'}${money(Math.abs(net)).replace('−', '')}`,
      sub: net >= 0 ? 'The band grew this month' : 'The band shrank this month',
      tone: net >= 0 ? 'bad' : 'good',
    },
    {
      label: 'Share of stock',
      value: totalStock ? pct(aged / totalStock) : '—',
      sub: totalStock ? `of ${money(totalStock)} held in RM` : 'No ageing profile for this month',
    },
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

/**
 * The workbook's Dashboard block, line for line: Zipper, Metal, and the two
 * added together, each with the same seven rows in the same order.
 *
 * People read this sheet every morning and know where each figure sits, so the
 * order is the workbook's rather than one of our own. What changes is the
 * provenance — every number here is read from Odoo at load rather than pasted
 * in by a script the night before.
 */
function renderSummary() {
  const host = $('summary');
  if (!host) return;

  const report = state.report!;
  const months = report.months;
  const index = state.month;
  const monthName = monthLabel(months[index]);

  const dayLabel = (iso: string) =>
    new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: '2-digit',
    });

  // Daily move lines are only read for the current month; the usable split now
  // covers every month, so those two rows fill in whichever month is showing.
  const lastDay = viewingLatest() ? report.daily[report.daily.length - 1] : undefined;

  const panels = [
    { key: 'zipper', title: 'Zipper', tone: 'zip' },
    { key: 'mt', title: 'Metal', tone: 'mt' },
    { key: 'all', title: 'Total (Zipper + MT)', tone: 'total' },
  ] as const;

  host.innerHTML = panels
    .map((panel) => {
      const cs =
        panel.key === 'all' ? report.companies : report.companies.filter((c) => c.key === panel.key);

      const opening = sum(cs.map((c) => c.movement[index]?.opening ?? 0));
      const closing = sum(cs.map((c) => c.movement[index]?.closing ?? 0));
      const consumed = -Math.abs(sum(cs.map((c) => c.movement[index]?.issue ?? 0)));
      // The workbook derives this rather than reading it: whatever the closing
      // figure is that the opening and the month's consumption do not explain.
      const valueAdd = closing - (opening + consumed);

      const unusable = sum(cs.map((c) => c.split?.[index]?.unusable ?? 0));
      const usable = sum(cs.map((c) => c.split?.[index]?.usable ?? 0));
      const hasSplit = unusable + usable > 0;

      const prevDay = lastDay
        ? panel.key === 'all'
          ? lastDay.zipper + lastDay.mt
          : panel.key === 'zipper'
            ? lastDay.zipper
            : lastDay.mt
        : null;

      const name = panel.key === 'all' ? 'Total' : panel.title;
      const rows: { label: string; value: string; kind?: 'out' | 'add' | 'head' }[] = [
        { label: `${name} Unusable`, value: hasSplit ? money(unusable) : '—' },
        { label: `${name} Usable`, value: hasSplit ? money(usable) : '—' },
        { label: '180+ days Opening Value', value: money(opening) },
        {
          label: `PREVIOUS DAY CONSUMPTION : ${lastDay ? dayLabel(lastDay.date) : '—'}`,
          value: prevDay === null ? '—' : money(prevDay),
          kind: 'out',
        },
        {
          label: `Till TOTAL CONSUMPTION : ${monthName}`,
          value: money(consumed),
          kind: 'out',
        },
        { label: 'TOTAL Value ADD in 180+', value: money(valueAdd), kind: 'add' },
        { label: '180+ days Current Status', value: money(closing), kind: 'head' },
      ];

      return `<section class="sum-panel ${panel.tone}">
        <h3>${esc(panel.title)}</h3>
        <dl>
          ${rows
            .map((r) => {
              // A tint on an em dash is a highlight around nothing: only style
              // the figure when there is a figure.
              const kind = r.kind && r.value !== '—' ? ` ${r.kind}` : '';
              return `<div class="sum-row${kind}">
                  <dt>${esc(r.label)}</dt>
                  <dd>${esc(r.value)}</dd>
                </div>`;
            })
            .join('')}
        </dl>
      </section>`;
    })
    .join('');
}

/**
 * Usable against unusable.
 *
 * This is the split that changes what anyone does about the number: usable 180+
 * is a planning failure that can still be consumed, unusable 180+ is money
 * already gone and only waiting to be written off. Lot flags exist for the
 * current snapshot only, so an older month says so instead of guessing.
 */
function renderSplit() {
  const host = $('split-card');
  if (!host) return;

  const cs = scoped();
  const { usable, unusable } = splitAt();
  const total = usable + unusable;
  if (!total) {
    host.innerHTML = `<div class="card-head"><h2>Usable against dead money</h2></div>
      <p class="hint" style="padding:0 16px 16px">Nothing sitting in the band.</p>`;
    return;
  }

  const lots = lotRows();
  const deadLots = lots?.filter((l) => l.unusable).length ?? null;
  const oldest = lots?.length ? lots.reduce((a, b) => (b.duration > a.duration ? b : a)) : null;

  const perCompany = cs
    .map((c) => {
      const point = c.split?.[state.month];
      const t = (point?.usable ?? 0) + (point?.unusable ?? 0);
      if (!t) return '';
      const dead = point!.unusable;
      return `<div class="split-unit">
        <span class="split-unit-name">${esc(c.name)}</span>
        <span class="split-unit-fig">${esc(money(dead))} dead <em>of ${esc(money(t))}</em></span>
        <div class="meter"><div class="meter-fill dead" style="width:${((dead / t) * 100).toFixed(1)}%"></div></div>
      </div>`;
    })
    .join('');

  /*
   * The flag is what the lot is considered today, not what anyone thought in
   * an older month — Odoo does not historise it. Worth stating on a back month,
   * where the reading is "how much of what sat here is value we now know is
   * gone" rather than a record of the position at the time.
   */
  const caveat = viewingLatest()
    ? deadLots === null
      ? 'Loading lot detail…'
      : `${deadLots} of ${lots!.length} lots are flagged unusable in Odoo.`
    : `Judged against today's unusable flags — Odoo does not keep a history of them.`;

  host.innerHTML = `<div class="card-head">
      <h2>Usable against dead money</h2>
      <span class="hint">${esc(caveat)}</span>
    </div>
    <div class="split-body">
      <div class="split-main">
        <div class="split-bar" role="img"
             aria-label="${esc(money(unusable))} unusable, ${esc(money(usable))} still usable">
          <div class="split-seg dead" style="width:${((unusable / total) * 100).toFixed(2)}%"></div>
          <div class="split-seg live" style="width:${((usable / total) * 100).toFixed(2)}%"></div>
        </div>
        <div class="split-keys">
          <div class="split-key">
            <span class="swatch dead"></span>
            <div>
              <strong>${esc(money(unusable))}</strong>
              <small>Unusable — ${pct(unusable / total)} of the band</small>
            </div>
          </div>
          <div class="split-key">
            <span class="swatch live"></span>
            <div>
              <strong>${esc(money(usable))}</strong>
              <small>Still usable — ${pct(usable / total)} of the band</small>
            </div>
          </div>
          ${
            oldest
              ? `<div class="split-key">
                  <span class="swatch age"></span>
                  <div>
                    <strong>${esc(ageLabel(oldest.duration))}</strong>
                    <small>Oldest lot: ${esc(oldest.lot)} · ${esc(money(oldest.value))}</small>
                  </div>
                </div>`
              : ''
          }
        </div>
      </div>
      ${perCompany ? `<div class="split-units">${perCompany}</div>` : ''}
    </div>`;
}

/** 180+ closing value per month, one line per unit plus the combined total. */
function renderTrend() {
  const host = $('chart-trend');
  if (!host) return;
  const report = state.report!;
  const months = report.months;
  const cats = months.map(monthLabel);

  const series =
    state.scope === 'all'
      ? [
          {
            name: 'Both units',
            color: '--ink-muted',
            values: months.map((_, i) => sum(report.companies.map((c) => c.movement[i]?.closing ?? 0))),
            reference: true,
          },
          ...report.companies.map((c, i) => ({
            name: c.name,
            color: `--series-${i + 1}`,
            values: c.movement.map((p) => p.closing),
          })),
        ]
      : scoped().map((c) => ({
          name: c.name,
          color: c.key === 'zipper' ? '--series-1' : '--series-2',
          values: c.movement.map((p) => p.closing),
        }));

  host.innerHTML = lineChart({
    categories: cats,
    series,
    width: 620,
    height: 250,
    format: money,
    unit: '$',
  });

  const s = movementSeries();
  const first = s[0]?.closing ?? 0;
  const last = s[state.month]?.closing ?? 0;
  const note = $('trend-note');
  if (note && first) {
    const change = last / first - 1;
    note.textContent = `${change >= 0 ? '+' : ''}${pct(change)} since ${monthLabel(months[0])}`;
  }
}

/**
 * Aged in against consumed, as bars diverging from a shared zero line.
 *
 * The shared bar chart scales from zero up, so a negative series would render
 * with no height at all. Here the axis sits mid-plot: value entering the band
 * goes up, value leaving it goes down, and the months where the up-bar is the
 * longer of the pair are exactly the months the band grew.
 */
function renderFlow() {
  const host = $('chart-flow');
  if (!host) return;
  const points = movementSeries();

  const W = 620;
  const H = 250;
  const PAD = { top: 16, right: 14, bottom: 34, left: 66 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const inValues = points.map((p) => Math.abs(p.newAdd));
  const outValues = points.map((p) => Math.abs(p.issue));
  // One symmetric scale, so a bar above and a bar below of equal length mean
  // equal money. Two independent half-scales would make them lie.
  const top = Math.max(...inValues, ...outValues, 1) * 1.06;
  const mid = PAD.top + plotH / 2;
  const half = plotH / 2;
  const y = (v: number) => mid - (v / top) * half;

  const slot = plotW / Math.max(points.length, 1);
  const barW = Math.max(Math.min(slot * 0.34, 9), 2);

  const ticks = [-1, -0.5, 0, 0.5, 1].map((f) => top * f);
  const grid = ticks
    .map(
      (t) =>
        `<line class="c-grid" x1="${PAD.left}" y1="${y(t).toFixed(1)}" x2="${(PAD.left + plotW).toFixed(1)}" y2="${y(t).toFixed(1)}" />` +
        `<text class="c-tick" x="${PAD.left - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">$${compact(Math.abs(t))}</text>`,
    )
    .join('');

  const every = Math.ceil(points.length / Math.max(Math.floor(plotW / 58), 1));

  const bars = points
    .map((p, i) => {
      const cx = PAD.left + slot * i + slot / 2;
      const upH = Math.max((Math.abs(p.newAdd) / top) * half, p.newAdd ? 1 : 0);
      const downH = Math.max((Math.abs(p.issue) / top) * half, p.issue ? 1 : 0);
      const label = monthLabel(p.month);

      const tip =
        `<strong>${esc(label)}</strong>` +
        `<span><i style="background:var(--series-2)"></i>Aged in<b>${esc(money(p.newAdd))}</b></span>` +
        `<span><i style="background:var(--series-1)"></i>Consumed<b>${esc(money(Math.abs(p.issue)))}</b></span>` +
        `<span><i style="background:transparent"></i>Net<b>${esc(money(p.closing - p.opening))}</b></span>`;

      return (
        `<rect class="c-hit" x="${(PAD.left + slot * i).toFixed(1)}" y="${PAD.top}" width="${slot.toFixed(1)}" height="${plotH}" data-tip="${esc(tip)}" />` +
        `<rect class="c-bar" x="${(cx - barW - 1).toFixed(1)}" y="${(mid - upH).toFixed(1)}" width="${barW.toFixed(1)}" height="${upH.toFixed(1)}" rx="1.5" fill="var(--series-2)" />` +
        `<rect class="c-bar" x="${(cx + 1).toFixed(1)}" y="${mid.toFixed(1)}" width="${barW.toFixed(1)}" height="${downH.toFixed(1)}" rx="1.5" fill="var(--series-1)" />` +
        (i % every === 0
          ? `<text class="c-cat" x="${cx.toFixed(1)}" y="${(PAD.top + plotH + 20).toFixed(1)}" text-anchor="middle">${esc(label)}</text>`
          : '')
      );
    })
    .join('');

  const legendHtml =
    `<div class="c-legend">` +
    `<span class="c-legend-item"><i class="c-swatch" style="background:var(--series-2)"></i>Aged in</span>` +
    `<span class="c-legend-item"><i class="c-swatch" style="background:var(--series-1)"></i>Consumed</span>` +
    `</div>`;

  host.innerHTML = `${legendHtml}<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">
    ${grid}
    ${bars}
    <line class="c-axis" x1="${PAD.left}" y1="${mid.toFixed(1)}" x2="${(PAD.left + plotW).toFixed(1)}" y2="${mid.toFixed(1)}" />
  </svg>`;
}

/**
 * The full age profile, oldest bucket last, with 180+ picked out.
 *
 * Age is an ordered band rather than seven unrelated categories, so the bars
 * run one hue from light to dark and the two that make up 180+ are the only
 * ones carrying the alert colour.
 */
function renderProfile() {
  const host = $('chart-profile');
  if (!host) return;

  const report = state.report!;
  const values = bucketsAt(state.month);
  const quantities = bucketQtyAt(state.month);
  const total = sum(values);
  const max = Math.max(...values, 1);

  const rows = report.slots
    .map((slot, i) => {
      const value = values[i];
      const aged = i >= 5;
      const part = total ? value / total : 0;
      const tip =
        `<strong>${esc(slot.label)} days</strong>` +
        `<span><i style="background:var(${aged ? '--critical' : '--accent'})"></i>Value<b>${esc(money(value))}</b></span>` +
        `<span><i style="background:transparent"></i>Quantity<b>${esc(qty(quantities[i]))}</b></span>` +
        `<span><i style="background:transparent"></i>Share<b>${share(part)}</b></span>`;
      return `<div class="prof-row${aged ? ' aged' : ''}" data-tip="${esc(tip)}">
        <span class="prof-label">${esc(slot.label)}</span>
        <div class="prof-track">
          <div class="prof-bar" style="width:${((value / max) * 100).toFixed(2)}%;opacity:${(0.45 + (i / 6) * 0.55).toFixed(2)}"></div>
        </div>
        <span class="prof-value">${esc(money(value))}</span>
        <span class="prof-share">${share(part)}</span>
      </div>`;
    })
    .join('');

  host.innerHTML = `<div class="profile">${rows}</div>`;

  const aged = values.slice(5).reduce((a, b) => a + b, 0);
  const note = $('profile-note');
  if (note) {
    note.textContent = total
      ? `${money(aged)} of ${money(total)} is past 180 days`
      : 'No profile for this month';
  }
}

/**
 * The month as a waterfall: where the closing figure came from.
 *
 * Drawn by hand rather than through the shared bar chart, because a waterfall's
 * bars float at a running offset instead of sitting on the axis.
 */
function renderWaterfall() {
  const host = $('chart-waterfall');
  if (!host) return;

  const now = movementSeries()[state.month];
  if (!now) return;

  const consumed = -Math.abs(now.issue);
  const steps = [
    { label: 'Opening', value: now.opening, kind: 'total' as const },
    { label: 'Aged in', value: now.newAdd, kind: 'up' as const },
    { label: 'Consumed', value: consumed, kind: 'down' as const },
    { label: 'Closing', value: now.closing, kind: 'total' as const },
  ];

  const W = 620;
  const H = 250;
  const PAD = { top: 18, right: 16, bottom: 40, left: 68 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  // The scale has to hold every intermediate level, not just the endpoints.
  let running = 0;
  const levels: { from: number; to: number }[] = [];
  for (const step of steps) {
    if (step.kind === 'total') {
      levels.push({ from: 0, to: step.value });
      running = step.value;
    } else {
      const next = running + step.value;
      levels.push({ from: running, to: next });
      running = next;
    }
  }
  /*
   * The levels the eye actually has to separate: each total's height, and both
   * ends of each floating delta. A total's baseline is excluded — it is only
   * ever zero, and letting it into the range is what would force the axis back
   * down to zero and flatten everything above.
   */
  const marks = steps.flatMap((step, i) =>
    step.kind === 'total' ? [levels[i].to] : [levels[i].from, levels[i].to],
  );
  const hi = Math.max(...marks, 1);
  const lo = Math.min(...marks);

  /*
   * A month typically moves 1-3% of a band worth half a million, so a
   * zero-based axis flattens the two middle bars to nothing. When the whole
   * story sits in the top slice, the axis starts just below it instead — and
   * says so, because a truncated axis that does not announce itself
   * exaggerates every change drawn on it.
   */
  const span = hi - lo;
  const zoomed = lo > 0 && span / hi < 0.25;
  const floor = zoomed ? Math.max(lo - span * 1.4, 0) : 0;
  const top = hi + (hi - floor) * 0.12;
  const y = (v: number) => PAD.top + plotH - ((v - floor) / (top - floor)) * plotH;

  // With the axis lifted off zero, a total bar starts at the axis, not at zero.
  for (const [i, step] of steps.entries()) {
    if (step.kind === 'total') levels[i].from = floor;
  }

  const slot = plotW / steps.length;
  const barW = Math.min(slot * 0.5, 74);

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => floor + (top - floor) * f);
  const grid = ticks
    .map(
      (t) =>
        `<line class="c-grid" x1="${PAD.left}" y1="${y(t).toFixed(1)}" x2="${(PAD.left + plotW).toFixed(1)}" y2="${y(t).toFixed(1)}" />` +
        `<text class="c-tick" x="${PAD.left - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">$${compact(t)}</text>`,
    )
    .join('');

  const bars = steps
    .map((step, i) => {
      const level = levels[i];
      const x = PAD.left + slot * i + (slot - barW) / 2;
      const hi = Math.max(level.from, level.to);
      const lo = Math.min(level.from, level.to);
      const barH = Math.max(y(lo) - y(hi), 1.5);
      const fill =
        step.kind === 'total' ? '--ink-muted' : step.kind === 'up' ? '--series-2' : '--series-1';

      const connector =
        i > 0 && i < steps.length - 1
          ? `<line class="wf-link" x1="${(x + barW).toFixed(1)}" y1="${y(level.to).toFixed(1)}" x2="${(x + slot).toFixed(1)}" y2="${y(level.to).toFixed(1)}" />`
          : '';

      const tip =
        `<strong>${esc(step.label)}</strong>` +
        `<span><i style="background:var(${fill})"></i>Value<b>${esc(money(step.value))}</b></span>`;

      return (
        `<rect class="c-hit" x="${(PAD.left + slot * i).toFixed(1)}" y="${PAD.top}" width="${slot.toFixed(1)}" height="${plotH}" data-tip="${esc(tip)}" />` +
        `<rect class="c-bar" x="${x.toFixed(1)}" y="${y(hi).toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="3" fill="var(${fill})" />` +
        connector +
        `<text class="c-value" x="${(x + barW / 2).toFixed(1)}" y="${(y(hi) - 6).toFixed(1)}" text-anchor="middle">${esc(money(step.value))}</text>` +
        `<text class="c-cat" x="${(x + barW / 2).toFixed(1)}" y="${(PAD.top + plotH + 20).toFixed(1)}" text-anchor="middle">${esc(step.label)}</text>`
      );
    })
    .join('');

  host.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">
    ${grid}
    <line class="c-axis" x1="${PAD.left}" y1="${(PAD.top + plotH).toFixed(1)}" x2="${(PAD.left + plotW).toFixed(1)}" y2="${(PAD.top + plotH).toFixed(1)}" />
    ${bars}
  </svg>${
    zoomed
      ? `<p class="axis-note">Axis starts at ${esc(money(floor))} — the month moves ${pct(
          span / hi,
        )} of the band, which a zero-based scale would flatten to nothing.</p>`
      : ''
  }`;
}

function compact(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${Math.round(v / 1e3)}k`;
  return String(Math.round(v));
}

// -------------------------------------------------------------------- table

/** Item categories with their month's movement and a closing-value sparkline. */
function renderCategories() {
  const host = $('cat-grid');
  if (!host) return;

  const monthIndex = state.month;
  const needle = state.catSearch.trim().toLowerCase();

  // The month's figures come from the aligned history, so stepping back through
  // the months moves the whole table, not just the charts.
  const rows = categoryRows()
    .map((row) => {
      const closing = row.history[monthIndex] ?? 0;
      const prev = monthIndex > 0 ? row.history[monthIndex - 1] ?? 0 : closing;
      return { ...row, closing, opening: prev, delta: closing - prev };
    })
    .filter((row) => row.closing !== 0 || row.opening !== 0)
    .filter((row) => !needle || row.category.toLowerCase().includes(needle));

  const key = state.catSort.key as 'category' | 'closing' | 'opening' | 'delta';
  rows.sort((a, b) => {
    const av = (a as any)[key];
    const bv = (b as any)[key];
    if (typeof av === 'string') return av.localeCompare(bv) * state.catSort.dir;
    return ((av ?? 0) - (bv ?? 0)) * state.catSort.dir;
  });

  const total = sum(rows.map((r) => r.closing));

  const cols: { key: string; label: string; num?: boolean }[] = [
    { key: 'category', label: 'Item category' },
    { key: 'opening', label: 'Opening', num: true },
    { key: 'closing', label: 'Closing', num: true },
    { key: 'delta', label: 'Change', num: true },
    { key: 'share', label: 'Share', num: true },
    { key: 'spark', label: `History · ${state.report!.months.length} months` },
  ];

  const head = cols
    .map(
      (c) =>
        `<th data-sort="${c.key}"${state.catSort.key === c.key ? ` data-dir="${state.catSort.dir}"` : ''}${
          c.num ? ' class="num"' : ''
        }>${esc(c.label)}<span class="arrow">${state.catSort.dir > 0 ? '▲' : '▼'}</span></th>`,
    )
    .join('');

  const body = rows
    .map(
      (r) => `<tr>
        <td>${esc(r.category)}</td>
        <td class="num">${esc(money(r.opening))}</td>
        <td class="num">${esc(money(r.closing))}</td>
        <td class="num ${r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : ''}">${
          r.delta === 0 ? '—' : `${r.delta > 0 ? '+' : '−'}${money(Math.abs(r.delta)).replace('−', '')}`
        }</td>
        <td class="num">${total ? share(r.closing / total) : '—'}</td>
        <td class="spark-cell">${sparkline(r.history)}</td>
      </tr>`,
    )
    .join('');

  host.innerHTML = `<table class="grid">
      <thead><tr>${head}</tr></thead>
      <tbody>${body || `<tr><td colspan="6" class="empty">Nothing matches.</td></tr>`}</tbody>
      <tfoot><tr>
        <td>${rows.length} categories</td>
        <td class="num">${esc(money(sum(rows.map((r) => r.opening))))}</td>
        <td class="num">${esc(money(total))}</td>
        <td class="num">${esc(money(sum(rows.map((r) => r.delta))))}</td>
        <td class="num">100%</td><td></td>
      </tr></tfoot>
    </table>`;

  const note = $('cat-note');
  if (note) note.textContent = `${rows.length} categories holding ${money(total)} in ${monthLabel(state.report!.months[monthIndex])}`;

  host.querySelectorAll<HTMLElement>('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const k = th.dataset.sort as any;
      state.catSort =
        state.catSort.key === k
          ? { key: k, dir: -state.catSort.dir as 1 | -1 }
          : { key: k, dir: k === 'category' ? 1 : -1 };
      renderCategories();
    });
  });
}

/** A closing-value sparkline; the last point is marked so the eye lands on now. */
function sparkline(history: (number | null)[]): string {
  const values = history.map((v) => v ?? 0);
  if (values.length < 2) return '';
  const W = 120;
  const H = 22;
  const max = Math.max(...values, 1);
  const step = W / (values.length - 1);
  const y = (v: number) => H - 2 - (v / max) * (H - 4);
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = values[values.length - 1];
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">
    <polyline points="${points}" />
    <circle cx="${W.toFixed(1)}" cy="${y(last).toFixed(1)}" r="2.4" />
  </svg>`;
}

/** Every lot in the band — the list someone works down. */
function renderLots() {
  const host = $('lot-grid');
  const note = $('lot-note');
  if (!host) return;

  const all = lotRows();
  if (all === null) {
    host.innerHTML = skeleton.table(9, 8);
    if (note) note.textContent = 'Fetching lot detail…';
    return;
  }

  const needle = state.lotSearch.trim().toLowerCase();
  let rows = all;

  if (state.lotFilter === 'unusable') rows = rows.filter((r) => r.unusable);
  else if (state.lotFilter === 'usable') rows = rows.filter((r) => !r.unusable);
  else if (state.lotFilter === '365') rows = rows.filter((r) => r.band365 > 0);
  else if (state.lotFilter === 'rejected') rows = rows.filter((r) => /reject/i.test(r.rejected));

  if (needle) {
    rows = rows.filter((r) =>
      `${r.product} ${r.code} ${r.lot} ${r.category}`.toLowerCase().includes(needle),
    );
  }

  const { key, dir } = state.lotSort;
  rows = [...rows].sort((a, b) => {
    const av = a[key] as any;
    const bv = b[key] as any;
    if (typeof av === 'string' || typeof bv === 'string') {
      return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
    }
    return ((Number(av) || 0) - (Number(bv) || 0)) * dir;
  });

  const cols: { key: keyof LotRow | 'flag'; label: string; num?: boolean }[] = [
    { key: 'product', label: 'Product' },
    { key: 'code', label: 'Code' },
    { key: 'category', label: 'Category' },
    { key: 'lot', label: 'Lot / invoice' },
    { key: 'receivedOn', label: 'Received' },
    { key: 'duration', label: 'Age', num: true },
    { key: 'qty', label: 'Quantity', num: true },
    { key: 'band181', label: '181–365', num: true },
    { key: 'band365', label: '365+', num: true },
    { key: 'value', label: 'Value', num: true },
    { key: 'flag', label: 'Status' },
    { key: 'shipment', label: 'Shipment' },
  ];

  const head = cols
    .map(
      (c) =>
        `<th data-sort="${c.key}"${key === c.key ? ` data-dir="${dir}"` : ''}${c.num ? ' class="num"' : ''}>${esc(
          c.label,
        )}<span class="arrow">${dir > 0 ? '▲' : '▼'}</span></th>`,
    )
    .join('');

  // 800-odd rows render fine in one pass; capping would hide exactly the tail
  // this table exists to expose.
  const body = rows
    .map(
      (r) => `<tr${r.unusable ? ' class="is-dead"' : ''}>
        <td title="${esc(r.product)}">${esc(r.product)}</td>
        <td class="mono">${esc(r.code)}</td>
        <td>${esc(r.category)}</td>
        <td class="mono">${esc(r.lot)}</td>
        <td>${esc(r.receivedOn ?? '—')}</td>
        <td class="num" title="${r.duration} days">${esc(ageLabel(r.duration))}</td>
        <td class="num">${esc(qty(r.qty))}${r.uom ? ` <small>${esc(r.uom)}</small>` : ''}</td>
        <td class="num">${r.band181 ? esc(moneyExact(r.band181)) : '—'}</td>
        <td class="num">${r.band365 ? esc(moneyExact(r.band365)) : '—'}</td>
        <td class="num strong">${esc(moneyExact(r.value))}</td>
        <td>${
          r.unusable
            ? '<span class="badge dead">Unusable</span>'
            : /reject/i.test(r.rejected)
              ? '<span class="badge warn">Rejected</span>'
              : '<span class="badge ok">Usable</span>'
        }</td>
        <td>${esc(r.shipment)}</td>
      </tr>`,
    )
    .join('');

  const total = sum(rows.map((r) => r.value));

  host.innerHTML = `<table class="grid lot-grid">
      <thead><tr>${head}</tr></thead>
      <tbody>${body || `<tr><td colspan="12" class="empty">Nothing matches.</td></tr>`}</tbody>
      <tfoot><tr>
        <td colspan="7">${rows.length} lots</td>
        <td class="num">${esc(money(sum(rows.map((r) => r.band181))))}</td>
        <td class="num">${esc(money(sum(rows.map((r) => r.band365))))}</td>
        <td class="num strong">${esc(money(total))}</td>
        <td colspan="2"></td>
      </tr></tfoot>
    </table>`;

  if (note) {
    const dead = sum(rows.filter((r) => r.unusable).map((r) => r.value));
    const parts = [`${rows.length} lots`, money(total), `${money(dead)} of it unusable`];

    /*
     * Odoo rebuilds the lot-level snapshot on a slower cycle than the summary
     * one the headline figures come from, so in the month in progress this
     * table can be a step behind the total above it. Better to name the gap
     * than to let two figures for the same thing sit on one page unexplained.
     */
    const { usable, unusable } = splitAt();
    const headline = usable + unusable;
    const gap = headline - sum(all.map((r) => r.value));
    if (headline && Math.abs(gap) > 1) {
      parts.push(
        `${money(Math.abs(gap))} ${gap > 0 ? 'behind' : 'ahead of'} the ${money(headline)} above — ` +
          `Odoo refreshes lot detail less often than the monthly totals`,
      );
    }
    note.textContent = parts.join(' · ');
  }

  host.querySelectorAll<HTMLElement>('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const k = th.dataset.sort as keyof LotRow;
      state.lotSort =
        state.lotSort.key === k
          ? { key: k, dir: -state.lotSort.dir }
          : { key: k, dir: ['product', 'code', 'category', 'lot', 'shipment'].includes(k as string) ? 1 : -1 };
      renderLots();
    });
  });
}

// -------------------------------------------------------------------- wiring

function wire() {
  $('scope-seg')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-scope]');
    if (!btn) return;
    state.scope = btn.dataset.scope as Scope;
    document.querySelectorAll<HTMLElement>('#scope-seg .seg').forEach((s) => {
      s.setAttribute('aria-selected', String(s === btn));
    });
    render();
  });

  $<HTMLSelectElement>('month-select')?.addEventListener('change', (e) => {
    state.month = Number((e.target as HTMLSelectElement).value);
    render();
  });

  const stepMonth = (by: number) => {
    const months = state.report?.months.length ?? 0;
    const next = Math.min(Math.max(state.month + by, 0), months - 1);
    if (next === state.month) return;
    state.month = next;
    const select = $<HTMLSelectElement>('month-select');
    if (select) select.value = String(next);
    render();
  };
  $('month-prev')?.addEventListener('click', () => stepMonth(-1));
  $('month-next')?.addEventListener('click', () => stepMonth(1));

  $('refresh')?.addEventListener('click', () => load(true));

  $('lot-filters')?.addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-filter]');
    if (!chip) return;
    state.lotFilter = chip.dataset.filter as LotFilter;
    document.querySelectorAll<HTMLElement>('#lot-filters .chip').forEach((c) => {
      c.classList.toggle('active', c === chip);
    });
    renderLots();
  });

  $<HTMLInputElement>('lot-search')?.addEventListener('input', (e) => {
    state.lotSearch = (e.target as HTMLInputElement).value;
    renderLots();
  });

  $<HTMLInputElement>('cat-search')?.addEventListener('input', (e) => {
    state.catSearch = (e.target as HTMLInputElement).value;
    renderCategories();
  });
}

if (document.querySelector('.ageing')?.getAttribute('data-odoo')) {
  wire();
  load();
}
