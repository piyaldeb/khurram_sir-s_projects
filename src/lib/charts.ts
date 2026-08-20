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
    <line class="c-axis" x1="${PAD.left}" y1="${(PAD.top + plotH).toFixed(1)}" x2="${(PAD.left + plotW).toFixed(1)}" y2="${(PAD.top + plotH).toFixed(1)}" />
    ${bars.join('')}
    ${hits.join('')}
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

  const paths = series
    .map((s) => {
      const pts = s.values
        .map((v, i) => (v === null || v === undefined ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`))
        .filter(Boolean);
      if (!pts.length) return '';
      const last = s.values.reduce<number>(
        (acc, v, i) => (v === null || v === undefined ? acc : i),
        -1,
      );
      const endLabel =
        last >= 0
          ? `<text class="c-end" x="${(x(last) + 7).toFixed(1)}" y="${(y(s.values[last]!) + 4).toFixed(1)}">${esc(
              s.name,
            )}</text>`
          : '';
      return (
        `<polyline class="c-line${s.dashed ? ' dashed' : ''}" points="${pts.join(' ')}" stroke="var(${s.color})" />` +
        (last >= 0
          ? `<circle class="c-dot" cx="${x(last).toFixed(1)}" cy="${y(s.values[last]!).toFixed(1)}" r="4.5" fill="var(${s.color})" />`
          : '') +
        endLabel
      );
    })
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
