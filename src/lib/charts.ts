/**
 * Small SVG chart renderers — no dependencies, both themes, hover tooltips.
 *
 * Colour follows the job, not the series index:
 *   - Zipper vs Metal Trims are two identities  -> categorical slots 1 and 2
 *     (blue / orange; validated: adjacent CVD dE 24.7 light, 26.8 dark)
 *   - Achievement against Budget is one series with a reference
 *     -> the emphasis pattern: one hue plus neutral gray, never two hues
 * Series colours are read from CSS custom properties so light and dark are
 * stepped for their own surface rather than flipped.
 */

export interface Series {
  name: string;
  /** CSS variable name holding the colour, e.g. '--series-1'. */
  color: string;
  values: (number | null)[];
  /** Renders as a reference rather than a subject: neutral fill, no emphasis. */
  reference?: boolean;
  dashed?: boolean;
}

export interface ChartOptions {
  categories: string[];
  series: Series[];
  width: number;
  height?: number;
  /** Formats values in labels and tooltips. */
  format?: (v: number) => string;
  stacked?: boolean;
  /** Draw only every nth category label; auto when omitted. */
  labelEvery?: number;
  yTitle?: string;
  /** Prefix for axis ticks, e.g. "$" when the scale is money. */
  unit?: string;
  /**
   * Category indices to rule off before — fiscal-year starts, mostly. A run of
   * 41 months reads as one undifferentiated wall without them.
   */
  dividers?: number[];
  /** Labels for the bands the dividers cut, keyed by the index they start at. */
  bandLabels?: Record<number, string>;
  /** A level worth marking across the plot: the average, a target, a budget. */
  reference?: { value: number; label: string };
}

const PAD = { top: 16, right: 16, bottom: 34, left: 62 };

const compact = (v: number): string => {
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${Math.round(v / 1e3)}k`;
  return String(Math.round(v));
};

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Ticks that land on round numbers, so the axis reads cleanly.
 *
 * The top tick must sit at or above the largest value: the plot is scaled to it,
 * so a top tick below the data would draw those marks outside the chart.
 */
function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;

  const steps = Math.ceil(max / step - 1e-9);
  return Array.from({ length: steps + 1 }, (_, i) => i * step);
}

function scaffold(opts: ChartOptions, maxValue: number, rightPad = PAD.right) {
  const tick = (v: number) => `${opts.unit ?? ''}${compact(v)}`;
  const height = opts.height ?? 260;
  const plotW = Math.max(opts.width - PAD.left - rightPad, 10);
  const plotH = Math.max(height - PAD.top - PAD.bottom, 10);
  const ticks = niceTicks(maxValue);
  const top = ticks[ticks.length - 1] || 1;
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;

  const grid = ticks
    .map(
      (t) =>
        `<line class="c-grid" x1="${PAD.left}" y1="${y(t).toFixed(1)}" x2="${(PAD.left + plotW).toFixed(1)}" y2="${y(t).toFixed(1)}" />` +
        `<text class="c-tick" x="${PAD.left - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${tick(t)}</text>`,
    )
    .join('');

  return { height, plotW, plotH, top, y, grid };
}

function legend(series: Series[]): string {
  if (series.length < 2) return '';
  return `<div class="c-legend">${series
    .map(
      (s) =>
        `<span class="c-legend-item"><span class="c-swatch${s.reference ? ' ref' : ''}" style="background:var(${s.color})"></span>${esc(
          s.name,
        )}</span>`,
    )
    .join('')}</div>`;
}

/** Grouped or stacked columns. */
export function barChart(opts: ChartOptions): string {
  const { categories, series } = opts;
  const fmt = opts.format ?? compact;
  const n = Math.max(categories.length, 1);

  const maxValue = opts.stacked
    ? Math.max(
        ...categories.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0)),
        0,
      )
    : Math.max(...series.flatMap((s) => s.values.map((v) => v ?? 0)), 0);

  const { height, plotW, plotH, y, grid } = scaffold(opts, maxValue);
  const slot = plotW / n;
  const groupW = Math.max(slot * 0.68, 2);
  const barW = opts.stacked ? groupW : Math.max(groupW / series.length, 1.5);
  const every = opts.labelEvery ?? Math.ceil(n / Math.max(Math.floor(plotW / 56), 1));

  const bars: string[] = [];
  const hits: string[] = [];

  /*
   * Dividers sit in the gap before their column, and the band they open is
   * labelled just inside it. Both are drawn under the bars so a divider never
   * cuts across a column it is meant to sit beside.
   */
  const marks: string[] = [];
  for (const i of opts.dividers ?? []) {
    if (i <= 0 || i >= n) continue;
    const x = PAD.left + slot * i;
    marks.push(
      `<line class="c-divider" x1="${x.toFixed(1)}" y1="${PAD.top}" x2="${x.toFixed(1)}" y2="${(
        PAD.top + plotH
      ).toFixed(1)}" />`,
    );
  }
  for (const [key, label] of Object.entries(opts.bandLabels ?? {})) {
    const i = Number(key);
    if (!Number.isFinite(i) || i < 0 || i >= n) continue;
    marks.push(
      `<text class="c-band" x="${(PAD.left + slot * i + 3).toFixed(1)}" y="${(PAD.top + 10).toFixed(
        1,
      )}">${esc(label)}</text>`,
    );
  }

  if (opts.reference && opts.reference.value > 0) {
    const refY = y(opts.reference.value);
    // Only worth drawing while it is inside the plot; above the tallest tick it
    // would sit on the frame and say nothing.
    if (refY >= PAD.top && refY <= PAD.top + plotH) {
      /*
       * The label goes wherever the data is not. A fixed side works until the
       * bars at that end happen to be tall, and then it prints on top of them —
       * so both ends are measured and the quieter one wins.
       */
      const span = Math.max(Math.round(n * 0.18), 1);
      const peak = (from: number, to: number) =>
        Math.max(
          ...categories
            .slice(from, to)
            .map((_, k) =>
              series.reduce(
                (a, sr) =>
                  opts.stacked
                    ? a + (sr.values[from + k] ?? 0)
                    : Math.max(a, sr.values[from + k] ?? 0),
                0,
              ),
            ),
          0,
        );
      const onRight = peak(0, span) > peak(n - span, n);

      marks.push(
        `<line class="c-ref-line" x1="${PAD.left}" y1="${refY.toFixed(1)}" x2="${(
          PAD.left + plotW
        ).toFixed(1)}" y2="${refY.toFixed(1)}" />` +
          `<text class="c-ref-label" x="${(onRight ? PAD.left + plotW - 4 : PAD.left + 4).toFixed(
            1,
          )}" y="${(refY - 5).toFixed(1)}"${
            onRight ? ' text-anchor="end"' : ''
          }>${esc(opts.reference.label)}</text>`,
      );
    }
  }

  categories.forEach((cat, i) => {
    const x0 = PAD.left + slot * i + (slot - groupW) / 2;
    let stackTop = plotH + PAD.top;

    series.forEach((s, si) => {
      const v = s.values[i];
      if (v === null || v === undefined) return;
      const barH = PAD.top + plotH - y(v);
      if (barH <= 0) return;
      const yTop = opts.stacked ? stackTop - barH : y(v);
      const x = opts.stacked ? x0 : x0 + si * barW;
      // A 2px surface gap keeps stacked segments and adjacent bars from touching.
      const drawH = opts.stacked ? Math.max(barH - 2, 0.5) : barH;
      const drawW = opts.stacked ? barW : Math.max(barW - 2, 1);
      bars.push(
        `<rect class="c-bar${s.reference ? ' ref' : ''}" x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${drawW.toFixed(1)}" height="${drawH.toFixed(1)}" rx="3" fill="var(${s.color})" />`,
      );
      if (opts.stacked) stackTop = yTop;
    });

    const tip = series
      .filter((s) => s.values[i] !== null && s.values[i] !== undefined)
      .map((s) => `<span><i style="background:var(${s.color})"></i>${esc(s.name)}<b>${fmt(s.values[i]!)}</b></span>`)
      .join('');
    hits.push(
      `<rect class="c-hit" x="${(PAD.left + slot * i).toFixed(1)}" y="${PAD.top}" width="${slot.toFixed(
        1,
      )}" height="${plotH}" data-tip="${esc(`<strong>${cat}</strong>${tip}`)}" />`,
    );

    if (i % every === 0) {
      bars.push(
        `<text class="c-cat" x="${(PAD.left + slot * i + slot / 2).toFixed(1)}" y="${(PAD.top + plotH + 18).toFixed(
          1,
        )}" text-anchor="middle">${esc(cat)}</text>`,
      );
    }
  });

  return `${legend(series)}<svg class="chart" viewBox="0 0 ${opts.width} ${height}" width="${opts.width}" height="${height}" role="img">
    ${grid}
    ${marks.join('')}
    <line class="c-axis" x1="${PAD.left}" y1="${(PAD.top + plotH).toFixed(1)}" x2="${(PAD.left + plotW).toFixed(1)}" y2="${(PAD.top + plotH).toFixed(1)}" />
    ${bars.join('')}
    ${hits.join('')}
  </svg>`;
}

/**
 * A row-sized trend line — no axes, no labels, just the shape.
 *
 * A table of totals says which products are big; it cannot say which are
 * growing. One of these per row answers that without opening anything, so the
 * sheet is readable on its own.
 *
 * It is scaled to its own maximum, so it reads as shape only. Comparing
 * heights between rows would be meaningless and the design does not invite it.
 */
export function sparkline(
  values: number[],
  opts: { width?: number; height?: number; color?: string } = {},
): string {
  const width = opts.width ?? 76;
  const height = opts.height ?? 22;
  const color = opts.color ?? '--series-1';
  if (values.length < 2) return `<svg class="spark" width="${width}" height="${height}"></svg>`;

  const top = Math.max(...values, 0) || 1;
  const pad = 2;
  const x = (i: number) => (i / (values.length - 1)) * width;
  const y = (v: number) => height - pad - (v / top) * (height - pad * 2);

  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = values[values.length - 1];

  return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${points}" fill="none" stroke="var(${color})" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
    <circle cx="${x(values.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="1.7" fill="var(${color})" />
  </svg>`;
}

/** One line per series, with a crosshair on hover. */
export function lineChart(opts: ChartOptions): string {
  const { categories, series } = opts;
  const fmt = opts.format ?? compact;
  const n = Math.max(categories.length, 1);
  const maxValue = Math.max(...series.flatMap((s) => s.values.map((v) => v ?? 0)), 0);
  // Room for the direct labels that sit at the end of each line.
  const endRoom = Math.max(...series.map((s) => s.name.length), 0) * 6.2 + 18;
  const { height, plotW, plotH, y, grid } = scaffold(opts, maxValue, Math.max(PAD.right, endRoom));
  const step = n > 1 ? plotW / (n - 1) : 0;
  const x = (i: number) => PAD.left + step * i;
  const every = opts.labelEvery ?? Math.ceil(n / Math.max(Math.floor(plotW / 56), 1));

  const lastOf = (s: Series) =>
    s.values.reduce<number>((acc, v, i) => (v === null || v === undefined ? acc : i), -1);

  const paths = series
    .map((s) => {
      const pts = s.values
        .map((v, i) => (v === null || v === undefined ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`))
        .filter(Boolean);
      if (!pts.length) return '';
      const last = lastOf(s);
      return (
        `<polyline class="c-line${s.dashed ? ' dashed' : ''}" points="${pts.join(' ')}" stroke="var(${s.color})" />` +
        (last >= 0
          ? `<circle class="c-dot" cx="${x(last).toFixed(1)}" cy="${y(s.values[last]!).toFixed(1)}" r="4.5" fill="var(${s.color})" />`
          : '')
      );
    })
    .join('');

  /**
   * Direct labels sit at each line's last point, so series that finish close
   * together would print on top of each other and read as one smear. Nudge them
   * apart in the order they finish, then pull the stack back inside the plot if
   * it has grown past the bottom.
   */
  const LABEL_GAP = 13;
  const ends = series
    .map((s) => {
      const last = lastOf(s);
      return last < 0 ? null : { s, x: x(last), at: y(s.values[last]!) };
    })
    .filter((e): e is { s: Series; x: number; at: number } => e !== null)
    .sort((a, b) => a.at - b.at)
    .map((e) => ({ ...e, labelY: e.at }));

  for (let i = 1; i < ends.length; i++) {
    const gap = ends[i].labelY - ends[i - 1].labelY;
    if (gap < LABEL_GAP) ends[i].labelY = ends[i - 1].labelY + LABEL_GAP;
  }
  const spill = ends.length ? ends[ends.length - 1].labelY - (PAD.top + plotH) : 0;
  if (spill > 0) for (const e of ends) e.labelY -= spill;

  const endLabels = ends
    .map(
      (e) =>
        // A leader only earns its ink once the label has actually been moved.
        (Math.abs(e.labelY - e.at) > 1.5
          ? `<line class="c-grid" x1="${(e.x + 4).toFixed(1)}" y1="${e.at.toFixed(1)}" x2="${(
              e.x + 7
            ).toFixed(1)}" y2="${e.labelY.toFixed(1)}" />`
          : '') +
        `<text class="c-end" x="${(e.x + 9).toFixed(1)}" y="${(e.labelY + 4).toFixed(1)}">${esc(
          e.s.name,
        )}</text>`,
    )
    .join('');

  const hits = categories
    .map((cat, i) => {
      const tip = series
        .filter((s) => s.values[i] !== null && s.values[i] !== undefined)
        .map((s) => `<span><i style="background:var(${s.color})"></i>${esc(s.name)}<b>${fmt(s.values[i]!)}</b></span>`)
        .join('');
      return `<rect class="c-hit" x="${(x(i) - step / 2).toFixed(1)}" y="${PAD.top}" width="${Math.max(step, 6).toFixed(
        1,
      )}" height="${plotH}" data-x="${x(i).toFixed(1)}" data-tip="${esc(`<strong>${cat}</strong>${tip}`)}" />`;
    })
    .join('');

  const cats = categories
    .map((cat, i) =>
      i % every === 0
        ? `<text class="c-cat" x="${x(i).toFixed(1)}" y="${(PAD.top + plotH + 18).toFixed(1)}" text-anchor="middle">${esc(
            cat,
          )}</text>`
        : '',
    )
    .join('');

  return `${legend(series)}<svg class="chart" viewBox="0 0 ${opts.width} ${height}" width="${opts.width}" height="${height}" role="img">
    ${grid}
    <line class="c-axis" x1="${PAD.left}" y1="${(PAD.top + plotH).toFixed(1)}" x2="${(PAD.left + plotW).toFixed(1)}" y2="${(PAD.top + plotH).toFixed(1)}" />
    <line class="c-cross" x1="0" y1="${PAD.top}" x2="0" y2="${(PAD.top + plotH).toFixed(1)}" style="opacity:0" />
    ${paths}
    ${endLabels}
    ${cats}
    ${hits}
  </svg>`;
}

/**
 * Wires hover tooltips (and the line crosshair) for every chart inside `host`.
 * Call again after re-rendering; listeners live on the container.
 */
export function bindChartTooltips(host: HTMLElement) {
  let tip = host.querySelector<HTMLElement>('.c-tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'c-tooltip';
    tip.hidden = true;
    host.appendChild(tip);
  }

  const show = (event: MouseEvent) => {
    const hit = (event.target as HTMLElement).closest<SVGRectElement>('.c-hit');
    if (!hit) return hide();
    const svg = hit.ownerSVGElement!;
    tip!.innerHTML = hit.dataset.tip ?? '';
    tip!.hidden = false;

    const hostBox = host.getBoundingClientRect();
    const svgBox = svg.getBoundingClientRect();
    const left = event.clientX - hostBox.left;
    const top = svgBox.top - hostBox.top;
    tip!.style.left = `${Math.min(Math.max(left, 8), hostBox.width - tip!.offsetWidth - 8)}px`;
    tip!.style.top = `${top + 8}px`;

    const cross = svg.querySelector<SVGLineElement>('.c-cross');
    if (cross) {
      const cx = hit.dataset.x;
      if (cx) {
        cross.setAttribute('x1', cx);
        cross.setAttribute('x2', cx);
        cross.style.opacity = '1';
      }
    }
    svg.querySelectorAll<SVGRectElement>('.c-hit').forEach((r) => r.classList.toggle('on', r === hit));
  };

  const hide = () => {
    tip!.hidden = true;
    host.querySelectorAll<SVGLineElement>('.c-cross').forEach((c) => (c.style.opacity = '0'));
    host.querySelectorAll<SVGRectElement>('.c-hit').forEach((r) => r.classList.remove('on'));
  };

  host.addEventListener('mousemove', show);
  host.addEventListener('mouseleave', hide);
}

/**
 * Horizontal bars for ranked lists.
 *
 * Long category names — product codes, buyer and customer names — collide on a
 * vertical axis no matter how the labels are staggered. Turning the chart on
 * its side gives every name a full line of its own and puts the value at the
 * end of its bar, so the chart reads without a legend or a tooltip.
 *
 * One hue throughout: these bars are ranked, and colour must follow the entity
 * rather than its position, so rank is carried by length and order alone.
 */
export function barChartH(opts: ChartOptions): string {
  const { categories, series } = opts;
  const fmt = opts.format ?? compact;
  const bar = series[0];
  if (!bar) return '';

  const values = categories.map((_, i) => bar.values[i] ?? 0);
  const maxValue = Math.max(...values, 0);

  const ROW = 30;
  const BAR = 17;
  const labelChars = Math.max(...categories.map((c) => c.length), 4);
  const left = Math.min(Math.max(labelChars * 6.6 + 12, 70), 190);
  const valueRoom = Math.max(...values.map((v) => fmt(v).length), 4) * 6.7 + 14;
  const right = Math.min(valueRoom, 120);

  const plotW = Math.max(opts.width - left - right, 40);
  const plotH = categories.length * ROW;
  const height = plotH + 34;

  const ticks = niceTicks(maxValue, 4);
  const top = ticks[ticks.length - 1] || 1;
  const x = (v: number) => left + (v / top) * plotW;

  const grid = ticks
    .map(
      (t) =>
        `<line class="c-grid" x1="${x(t).toFixed(1)}" y1="0" x2="${x(t).toFixed(1)}" y2="${plotH}" />` +
        `<text class="c-tick" x="${x(t).toFixed(1)}" y="${plotH + 18}" text-anchor="middle">${opts.unit ?? ''}${compact(t)}</text>`,
    )
    .join('');

  const rows = categories
    .map((cat, i) => {
      const v = values[i];
      const y = i * ROW + (ROW - BAR) / 2;
      const width = Math.max(x(v) - left, v > 0 ? 2 : 0);
      const tip = `<strong>${cat}</strong><span><i style="background:var(${bar.color})"></i>${esc(
        bar.name,
      )}<b>${fmt(v)}</b></span>`;

      return (
        `<rect class="c-hit" x="0" y="${i * ROW}" width="${opts.width}" height="${ROW}" data-tip="${esc(tip)}" />` +
        `<text class="c-rowlabel" x="${left - 10}" y="${(y + BAR / 2 + 4).toFixed(1)}" text-anchor="end">${esc(cat)}</text>` +
        `<rect class="c-bar" x="${left}" y="${y.toFixed(1)}" width="${width.toFixed(1)}" height="${BAR}" rx="3" fill="var(${bar.color})" />` +
        `<text class="c-value" x="${(left + width + 8).toFixed(1)}" y="${(y + BAR / 2 + 4).toFixed(1)}">${esc(fmt(v))}</text>`
      );
    })
    .join('');

  return `<svg class="chart" viewBox="0 0 ${opts.width} ${height}" width="${opts.width}" height="${height}" role="img">
    ${grid}
    <line class="c-axis" x1="${left}" y1="0" x2="${left}" y2="${plotH}" />
    ${rows}
  </svg>`;
}

/**
 * Pareto: value per item as bars, cumulative share as a line, one axis.
 *
 * The classic Pareto puts value on one y-scale and cumulative percent on a
 * second. Two scales on one plot let the author set the crossing point
 * wherever they like, so this expresses BOTH measures as a share of the total:
 * each bar is that item's percent of the year, the line is the running total.
 * The dollar figures stay in the tooltip and the table beside it.
 *
 * Bars are one hue in three ordinal steps — A darkest through C lightest —
 * because ABC is an ordered band, not three unrelated categories.
 */
export interface ParetoItem {
  name: string;
  /** Share of the total, 0–1. */
  share: number;
  cumShare: number;
  cls: 'A' | 'B' | 'C';
  /** Shown in the tooltip. */
  detail: string;
}

export function paretoChart(opts: {
  items: ParetoItem[];
  width: number;
  height?: number;
}): string {
  const { items } = opts;
  if (!items.length) return '';

  const PAD_L = 46;
  const PAD_R = 46;
  const PAD_T = 14;
  // Angled name labels under the bars need real room.
  const PAD_B = 64;

  const height = opts.height ?? 260;
  const plotW = Math.max(opts.width - PAD_L - PAD_R, 40);
  const plotH = Math.max(height - PAD_T - PAD_B, 40);

  const y = (share: number) => PAD_T + plotH - share * plotH;
  const slot = plotW / items.length;
  const barW = Math.max(slot * 0.62, 1.5);

  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1];
  const grid = ticks
    .map(
      (t) =>
        `<line class="c-grid" x1="${PAD_L}" y1="${y(t).toFixed(1)}" x2="${(PAD_L + plotW).toFixed(
          1,
        )}" y2="${y(t).toFixed(1)}" />` +
        `<text class="c-tick" x="${PAD_L - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${Math.round(
          t * 100,
        )}%</text>`,
    )
    .join('');

  // Where class A stops carrying 80% of the value.
  const lastA = items.reduce((acc, item, i) => (item.cls === 'A' ? i : acc), -1);
  const cutX = lastA >= 0 ? PAD_L + slot * (lastA + 1) : null;
  const cut =
    cutX === null
      ? ''
      : `<line class="c-cut" x1="${cutX.toFixed(1)}" y1="${PAD_T}" x2="${cutX.toFixed(1)}" y2="${(
          PAD_T + plotH
        ).toFixed(1)}" />
         <text class="c-cut-label" x="${(cutX + 6).toFixed(1)}" y="${(PAD_T + 12).toFixed(
           1,
         )}">class A ends · 80% of value</text>`;

  const esc = (v: string) =>
    v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

  // Bars are scaled to the biggest single share so the tail stays visible;
  // the axis belongs to the cumulative line, which is the honest 0–100%.
  const biggest = Math.max(...items.map((i) => i.share), 0.0001);

  const bars = items
    .map((item, i) => {
      const h = (item.share / biggest) * plotH * 0.55;
      const x = PAD_L + slot * i + (slot - barW) / 2;
      return `<rect class="c-bar abc-${item.cls}" x="${x.toFixed(1)}" y="${(
        PAD_T + plotH - h
      ).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(h, 0.5).toFixed(1)}" rx="2" />`;
    })
    .join('');

  const points = items
    .map((item, i) => `${(PAD_L + slot * i + slot / 2).toFixed(1)},${y(item.cumShare).toFixed(1)}`)
    .join(' ');

  const hits = items
    .map((item, i) => {
      const tip =
        `<strong>${esc(item.name)}</strong>` +
        `<span>Class ${item.cls}<b>${(item.share * 100).toFixed(1)}%</b></span>` +
        `<span>Cumulative<b>${(item.cumShare * 100).toFixed(1)}%</b></span>` +
        `<span>${esc(item.detail)}</span>`;
      return `<rect class="c-hit" x="${(PAD_L + slot * i).toFixed(1)}" y="${PAD_T}" width="${slot.toFixed(
        1,
      )}" height="${plotH}" data-tip="${esc(tip)}" />`;
    })
    .join('');

  // Every bar is named. Angled so neighbours never collide; truncated so the
  // longest customer names stay inside their slot.
  const maxChars = Math.max(Math.floor(slot / 4.2) + 6, 8);
  const nameLabels = items
    .map((item, i) => {
      const x = PAD_L + slot * i + slot / 2;
      const yBase = PAD_T + plotH + 10;
      const label = item.name.length > maxChars ? `${item.name.slice(0, maxChars - 1)}…` : item.name;
      return `<text class="c-cat pareto-name" transform="rotate(-38 ${x.toFixed(1)} ${yBase.toFixed(
        1,
      )})" x="${x.toFixed(1)}" y="${yBase.toFixed(1)}" text-anchor="end">${esc(label)}</text>`;
    })
    .join('');

  const legend = `<div class="c-legend">
    <span class="c-legend-item"><span class="c-swatch abc-A"></span>Class A</span>
    <span class="c-legend-item"><span class="c-swatch abc-B"></span>B</span>
    <span class="c-legend-item"><span class="c-swatch abc-C"></span>C</span>
    <span class="c-legend-item"><span class="c-swatch ref"></span>Cumulative share</span>
  </div>`;

  return `${legend}<svg class="chart pareto" viewBox="0 0 ${opts.width} ${height}" width="${opts.width}" height="${height}" role="img">
    ${grid}
    <line class="c-axis" x1="${PAD_L}" y1="${(PAD_T + plotH).toFixed(1)}" x2="${(PAD_L + plotW).toFixed(
      1,
    )}" y2="${(PAD_T + plotH).toFixed(1)}" />
    ${bars}
    ${cut}
    <polyline class="c-line cum" points="${points}" />
    ${nameLabels}
    ${hits}
  </svg>`;
}
