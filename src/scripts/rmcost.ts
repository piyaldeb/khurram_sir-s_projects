/**
 * What the BOM says a month should have cost, against what the store issued.
 *
 * The page has one job: put the standard and the actual side by side, on one
 * scale, and let the difference be the thing you see first. So the hero is two
 * bars rather than a number with a number under it — a gap you have to compute
 * from two figures is a gap nobody computes.
 *
 * Three lists follow, and each answers a different question the bars raise:
 * where the BOM was wrong, what went out with no BOM behind it at all, and
 * which single components ran over. Five rows each; the page is the shape of
 * one decision, not a table to be searched.
 */

interface Variance {
  key: string;
  standard: number;
  actual: number;
  gap: number;
  gapShare: number | null;
}

interface Report {
  month: string | null;
  label: string;
  totals: { revenue: number; material: number; qty: number; lines: number; share: number | null };
  actuals: {
    issued: number;
    matched: number;
    unmodelled: number;
    byMaterial: Variance[];
    outside: { key: string; category: string; actual: number }[];
    overruns: Variance[];
    present: boolean;
  };
  coverage: {
    bookedLines: number;
    costedLines: number;
    untypedBomLines: number;
    unpricedComponents: string[];
  };
  trend: { month: string; label: string; material: number; actual: number; share: number | null }[];
  builtAt: string;
  stale: boolean;
  staleError: string | null;
}

const root = document.querySelector<HTMLElement>('.rmcost');

if (root) {
  const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
  const el = {
    month: $<HTMLSelectElement>('#rc-month'),
    refresh: $<HTMLButtonElement>('#rc-refresh'),
    status: $<HTMLElement>('#rc-status'),
    statusTitle: $<HTMLElement>('#rc-status-title'),
    error: $<HTMLElement>('#rc-error'),
    hero: $<HTMLElement>('#rc-hero'),
    months: $<HTMLElement>('#rc-months'),
    gaps: $<HTMLElement>('#rc-gaps'),
    outside: $<HTMLElement>('#rc-outside'),
    overruns: $<HTMLElement>('#rc-overruns'),
    foot: $<HTMLElement>('#rc-foot'),
  };

  const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const money = (v: number) => `$${nf.format(Math.round(v))}`;
  /** Short money, for the places six digits will not fit. */
  const brief = (v: number) => {
    const a = Math.abs(v);
    const sign = v < 0 ? '−' : '';
    if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
    if (a >= 1e4) return `${sign}$${nf.format(Math.round(a / 1e3))}k`;
    return `${sign}$${nf.format(Math.round(a))}`;
  };
  const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${brief(Math.abs(v))}`;
  const esc = (s: string | number) =>
    String(s).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
    );

  const shortMonth = (label: string) => label.split(' ')[0];

  /** Raw-material codes are noise on a card; the name after them is the thing. */
  const plainName = (s: string) => s.replace(/^\[[^\]]*\]\s*/, '');

  const state = { month: el.month.value || 'all', data: null as Report | null, loading: false };

  /* -------------------------------------------------------------- tooltips */

  /**
   * Hover readouts, in the site's own chart-tooltip shape.
   *
   * Anything carrying `data-tip` inside `host` shows it. One listener per host
   * rather than one per element, so re-rendering the contents never leaves a
   * stale handler behind — the markup is replaced wholesale on every load.
   *
   * The tip is placed against the host and clamped to it, so it never hangs off
   * the card at either end.
   */
  function attachTips(host: HTMLElement) {
    let tip = host.querySelector<HTMLElement>('.c-tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'c-tooltip';
      tip.hidden = true;
      host.appendChild(tip);
    }

    const hide = () => {
      tip!.hidden = true;
      host.querySelectorAll('[data-tip].on').forEach((n) => n.classList.remove('on'));
      const cross = host.querySelector<HTMLElement>('.rc-cross');
      if (cross) cross.style.opacity = '0';
    };

    host.addEventListener('mousemove', (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-tip]');
      if (!target) return hide();

      tip!.innerHTML = target.dataset.tip ?? '';
      tip!.hidden = false;

      // Horizontally the tip is clamped to the host so it never hangs off the
      // card. Vertically it is not: the plot is 68px tall and the tip is taller
      // than that, so clamping would park it on top of the lines it explains.
      // It is allowed to rise above the card instead, the way a chart tooltip
      // normally does.
      const box = host.getBoundingClientRect();
      const left = event.clientX - box.left + 14;
      tip!.style.left = `${Math.min(Math.max(left, 8), box.width - tip!.offsetWidth - 8)}px`;
      tip!.style.top = `${event.clientY - box.top - tip!.offsetHeight - 14}px`;

      host.querySelectorAll('[data-tip]').forEach((n) => n.classList.toggle('on', n === target));

      // A vertical rule through the hovered month, so the two lines are read at
      // the same instant rather than by eye.
      const cross = host.querySelector<HTMLElement>('.rc-cross');
      if (cross && target.dataset.x) {
        cross.style.left = `${target.dataset.x}%`;
        cross.style.opacity = '1';
      }
    });

    host.addEventListener('mouseleave', hide);
  }

  /* ------------------------------------------------------------ skeletons */

  /**
   * Placeholders shaped like what replaces them.
   *
   * A skeleton earns its place by keeping the page still: the bars, the plot
   * and the five rows of each card are all drawn at the size they will be, so
   * nothing jumps when the figures land. Built from the site's own `sk`
   * primitives, so the shimmer matches every other page.
   */
  const bone = (w: string, h = '12px') =>
    `<span class="sk sk-line" style="width:${w};height:${h}"></span>`;

  function skeletons() {
    el.hero.innerHTML = `
      <div class="rc-sk" aria-hidden="true">
        ${bone('220px', '10px')}
        <div class="rc-sk-figure">${bone('190px', '58px')}${bone('320px', '34px')}</div>
        <div class="rc-sk-bars">
          ${[0, 1]
            .map(
              () => `<div class="rc-bar-row">
                ${bone('60px', '10px')}
                <span class="sk" style="height:46px;border-radius:var(--radius-sm)"></span>
                ${bone('56px', '14px')}
              </div>`,
            )
            .join('')}
        </div>
        <div class="rc-sk-money">
          ${Array.from({ length: 4 }, () => `<div>${bone('70%', '10px')}${bone('55%', '20px')}</div>`).join(
            '',
          )}
        </div>
      </div>`;

    el.months.innerHTML = `
      <div class="rc-sk" aria-hidden="true">
        ${bone('120px', '13px')}
        <span class="sk" style="display:block;height:68px;margin-top:10px;border-radius:var(--radius-sm)"></span>
        <div class="rc-sk-months">
          ${Array.from({ length: 5 }, () => `<div>${bone('70%', '14px')}${bone('50%', '9px')}</div>`).join(
            '',
          )}
        </div>
      </div>`;

    for (const host of [el.gaps, el.outside, el.overruns]) {
      host.innerHTML = `
        <div class="rc-sk" aria-hidden="true">
          ${bone('55%', '14px')}
          ${bone('75%', '10px')}
          <div class="rc-sk-rows">
            ${Array.from({ length: 5 }, () => `<span class="sk" style="height:38px"></span>`).join('')}
          </div>
        </div>`;
    }

    el.foot.innerHTML = '';
  }

  /* ---------------------------------------------------------------- loading */

  async function load(refresh = false) {
    if (state.loading) return;
    state.loading = true;
    el.error.hidden = true;
    skeletons();

    // The status panel explains why a first build takes a minute. Once there is
    // data on the page the skeletons say "working" on their own, and a second
    // banner saying it again is just noise.
    el.status.hidden = !!state.data;
    el.statusTitle.textContent = refresh
      ? 'Re-reading Odoo'
      : 'Comparing the BOM against the store';

    try {
      const res = await fetch(
        `/api/rm-cost?month=${encodeURIComponent(state.month)}${refresh ? '&refresh=1' : ''}`,
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      state.data = data as Report;
      render();
    } catch (err) {
      el.error.hidden = false;
      el.error.className = 'banner error';
      el.error.textContent = `Could not load: ${(err as Error).message}`;
    } finally {
      state.loading = false;
      el.status.hidden = true;
    }
  }

  function render() {
    if (!state.data) return;
    renderHero();
    renderMonths();
    renderCards();
    renderFoot();
  }

  /* ------------------------------------------------------------------ hero */

  /**
   * The two bars.
   *
   * Both are drawn against the larger of the two totals, so their lengths are
   * directly comparable — the whole claim of the page is that one is longer
   * than the other, and scaling each bar to its own total would destroy it.
   *
   * Segments under a twentieth of the scale cannot hold a label, so the small
   * materials fold into one. The lists below name every part anyway.
   */
  function bars(v: Report['actuals'], standardTotal: number): string {
    const scale = Math.max(standardTotal, v.issued, 1);
    const FOLD = 0.05;

    const row = (
      label: string,
      total: number,
      parts: { key: string; value: number; outside?: boolean }[],
    ) => {
      const named = parts.filter((p) => p.outside || p.value / scale >= FOLD);
      const rest = parts.filter((p) => !named.includes(p));
      const restTotal = rest.reduce((a, p) => a + p.value, 0);
      // Folded materials rejoin the run of materials; anything outside the BOM
      // stays at the far end, where it reads as the overhang it is.
      const shown = [
        ...named.filter((p) => !p.outside),
        ...(restTotal > 0
          ? [{ key: rest.length === 1 ? rest[0].key : 'other', value: restTotal, outside: false }]
          : []),
        ...named.filter((p) => p.outside),
      ];

      const segments = shown
        .map((p, i) => {
          const w = (p.value / scale) * 100;
          const tone = p.outside ? 'out' : String(Math.min(i + 1, 5));
          // A folded or narrow segment shows no label of its own, so the hover
          // is the only place its figure appears.
          const tipText = [
            `<strong>${esc(p.key)}</strong>`,
            `<span>${esc(label)}<b>${money(p.value)}</b></span>`,
            `<span>of the bar<b>${w.toFixed(1)}%</b></span>`,
          ].join('');
          return `<span class="rc-seg" data-tone="${tone}"${
            w < 9 ? ' data-narrow' : ''
          } style="width:${w.toFixed(3)}%" data-tip="${esc(tipText)}">
            <em>${esc(p.key)}</em><b>${brief(p.value)}</b>
          </span>`;
        })
        .join('');

      return `<div class="rc-bar-row">
        <span class="rc-bar-label">${esc(label)}</span>
        <span class="rc-bar">${segments}</span>
        <span class="rc-bar-total">${brief(total)}</span>
      </div>`;
    };

    const standardParts = v.byMaterial
      .filter((m) => m.standard > 0)
      .sort((a, b) => b.standard - a.standard)
      .map((m) => ({ key: m.key, value: m.standard }));

    const actualParts = [
      ...v.byMaterial
        .filter((m) => m.actual > 0)
        .sort((a, b) => b.actual - a.actual)
        .map((m) => ({ key: m.key, value: m.actual })),
      ...(v.unmodelled > 0 ? [{ key: 'no BOM', value: v.unmodelled, outside: true }] : []),
    ];

    return row('BOM says', standardTotal, standardParts) + row('Issued', v.issued, actualParts);
  }

  function renderHero() {
    const d = state.data!;
    const v = d.actuals;
    const standard = d.totals.material;

    if (!v.present) {
      el.hero.innerHTML = `
        <p class="eyebrow">${esc(d.label)}</p>
        <p class="rc-empty">The raw-material ledger has nothing for this month, so there is
        nothing to compare the BOM against.</p>`;
      return;
    }

    const gap = v.issued - standard;
    const gapShare = standard > 0 ? gap / standard : 0;
    const over = gap > 0;

    el.hero.innerHTML = `
      <p class="eyebrow">${esc(d.label)} · Zipper · bulk orders</p>

      <div class="rc-figure">
        <strong class="${over ? 'over' : 'under'}">${over ? '+' : '−'}${Math.abs(
          gapShare * 100,
        ).toFixed(1)}<span>%</span></strong>
        <p>
          The BOM accounts for <b>${money(standard)}</b>. The store issued
          <b>${money(v.issued)}</b>.
          <span class="rc-move ${over ? 'worse' : 'better'}">${signed(gap)} ${
            over ? 'more went out than any BOM asked for' : 'less went out than the BOM allowed'
          }</span>
        </p>
      </div>

      <div class="rc-bars">${bars(v, standard)}</div>

      <dl class="rc-money">
        <div><dt>BOM standard</dt><dd>${brief(standard)}</dd></div>
        <div><dt>Issued</dt><dd>${brief(v.issued)}</dd></div>
        <div><dt>Difference</dt><dd class="${over ? 'neg' : 'pos'}">${signed(gap)}</dd></div>
        <div><dt>Issued with no BOM</dt><dd class="${
          v.unmodelled > 0 ? 'neg' : ''
        }">${brief(v.unmodelled)}</dd></div>
      </dl>`;

    attachTips(el.hero.querySelector<HTMLElement>('.rc-bars')!);
  }

  /**
   * The months as two lines: what the BOM allowed and what went out.
   *
   * One line would show a trend; two show whether the plant is tracking its own
   * standard, which is the question. The columns beneath are the click targets,
   * and each column's centre is exactly where its points are drawn.
   */
  function renderMonths() {
    const d = state.data!;
    const points = d.trend.filter((p) => p.material > 0 || p.actual > 0);
    if (points.length < 2) {
      el.months.innerHTML = '';
      return;
    }

    const all = points.flatMap((p) => [p.material, p.actual]).filter((n) => n > 0);
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    const pad = (hi - lo) * 0.25 || hi * 0.1 || 1;
    const top = hi + pad;
    const bottom = Math.max(lo - pad, 0);

    const H = 68;
    const x = (i: number) => ((i + 0.5) / points.length) * 100;
    const y = (v: number) => ((top - v) / (top - bottom || 1)) * H;

    const path = (pick: (p: Report['trend'][number]) => number) =>
      points.map((p, i) => `${x(i).toFixed(3)},${y(pick(p)).toFixed(2)}`).join(' ');

    // Viewing every month selects none of them: marking the last one would say
    // the reader had picked August when they picked the whole run.
    const current = d.month ? points.findIndex((p) => p.month === d.month) : -1;

    // Points as HTML, not SVG: the viewBox is stretched to the container width,
    // so a circle drawn inside it would be an ellipse at every width but one.
    const dots = points
      .flatMap((p, i) =>
        (
          [
            ['std', p.material],
            ['act', p.actual],
          ] as const
        ).map(
          ([kind, value]) =>
            `<span class="rc-dot ${kind}${i === current ? ' on' : ''}" style="left:${x(i).toFixed(
              3,
            )}%;top:${((y(value) / H) * 100).toFixed(2)}%"></span>`,
        ),
      )
      .join('');

    const columns = points
      .map((p, i) => {
        const on = i === current;
        const gap = p.actual - p.material;
        return `<button type="button" class="rc-month${on ? ' on' : ''}" data-month="${p.month}"
          aria-pressed="${on}">
          <b class="${gap > 0 ? 'over' : 'under'}">${signed(gap)}</b>
          <em>${esc(shortMonth(p.label))}</em>
        </button>`;
      })
      .join('');

    // One hit zone per month, the full height of the plot: the reader aims at a
    // month, not at a two-pixel point on a line.
    const width = 100 / points.length;
    const hits = points
      .map((p, i) => {
        const gap = p.actual - p.material;
        const tip = [
          `<strong>${esc(p.label)}</strong>`,
          `<span><i style="background:var(--ink-muted)"></i>BOM standard<b>${money(
            p.material,
          )}</b></span>`,
          `<span><i style="background:var(--mat-2)"></i>Issued<b>${money(p.actual)}</b></span>`,
          `<span>Difference<b class="${gap > 0 ? 'over' : 'under'}">${signed(gap)}</b></span>`,
        ].join('');
        return `<span class="rc-hit" data-tip="${esc(tip)}" data-x="${x(i).toFixed(3)}"
          style="left:${(i * width).toFixed(3)}%;width:${width.toFixed(3)}%"></span>`;
      })
      .join('');

    el.months.innerHTML = `
      <div class="rc-months-head">
        <h2>Month by month</h2>
        <p class="rc-key">
          <span class="rc-swatch std"></span> BOM standard
          <span class="rc-swatch act"></span> Issued
        </p>
      </div>
      <div class="rc-plot">
        <svg viewBox="0 0 100 ${H}" preserveAspectRatio="none" aria-hidden="true">
          <polyline class="std" points="${path((p) => p.material)}" />
          <polyline class="act" points="${path((p) => p.actual)}" />
        </svg>
        ${dots}
        <span class="rc-cross" aria-hidden="true"></span>
        ${hits}
      </div>
      <div class="rc-month-row">${columns}</div>`;

    attachTips(el.months.querySelector<HTMLElement>('.rc-plot')!);
  }

  /* ----------------------------------------------------------------- cards */

  interface Item {
    name: string;
    note: string;
    figure: string;
    fill: number;
    tone?: 'over' | 'under' | 'out';
  }

  function card(host: HTMLElement, title: string, lead: string, items: Item[], empty: string) {
    if (!items.length) {
      host.innerHTML = `<h2>${esc(title)}</h2><p class="rc-empty">${esc(empty)}</p>`;
      return;
    }
    host.innerHTML = `
      <h2>${esc(title)}</h2>
      <p class="rc-lead">${esc(lead)}</p>
      <ol class="rc-list">
        ${items
          .map(
            (i) => `<li${i.tone ? ` class="${i.tone}"` : ''}>
              <span class="rc-row-bar" style="width:${(i.fill * 100).toFixed(1)}%"></span>
              <span class="rc-row-name">${esc(i.name)}<em>${esc(i.note)}</em></span>
              <span class="rc-row-fig">${esc(i.figure)}</span>
            </li>`,
          )
          .join('')}
      </ol>`;
  }

  function renderCards() {
    const d = state.data!;
    const v = d.actuals;

    // Where the BOM and the floor disagree most, in money. Ranked by the size
    // of the gap either way: a material the BOM over-states is as wrong as one
    // it under-states, and both are worth the owner's minute.
    const gaps = [...v.byMaterial]
      .filter((m) => m.standard > 0 || m.actual > 0)
      .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))
      .slice(0, 5);
    const gapMax = Math.max(...gaps.map((g) => Math.abs(g.gap)), 1);
    card(
      el.gaps,
      'Where the BOM missed',
      'Standard against what was issued',
      gaps.map((g) => ({
        name: g.key,
        note: `${brief(g.standard)} allowed · ${brief(g.actual)} issued`,
        figure: signed(g.gap),
        fill: Math.abs(g.gap) / gapMax,
        tone: g.gap > 0 ? ('over' as const) : ('under' as const),
      })),
      'Every material tracked its standard.',
    );

    // Money that left the store with nothing to measure it against.
    const outside = v.outside.slice(0, 5);
    const outMax = Math.max(...outside.map((o) => o.actual), 1);
    card(
      el.outside,
      'Issued with no BOM',
      `${brief(v.unmodelled)} of material no BOM accounts for`,
      outside.map((o) => ({
        name: plainName(o.key),
        note: o.category,
        figure: brief(o.actual),
        fill: o.actual / outMax,
        tone: 'out' as const,
      })),
      'Everything issued sits under a BOM.',
    );

    // The single components that ran furthest over their own standard.
    const overruns = v.overruns.slice(0, 5);
    const runMax = Math.max(...overruns.map((o) => o.gap), 1);
    card(
      el.overruns,
      'Ran over the most',
      'One component at a time, by money over standard',
      overruns.map((o) => ({
        name: plainName(o.key),
        note: `${brief(o.standard)} allowed · ${brief(o.actual)} issued`,
        figure: signed(o.gap),
        fill: o.gap / runMax,
        tone: 'over' as const,
      })),
      'No component ran over its standard.',
    );
  }

  /** The two things that would make a reader over-trust the gap, said plainly. */
  function renderFoot() {
    const d = state.data!;
    const c = d.coverage;
    const missed = c.bookedLines - c.costedLines;

    el.foot.innerHTML = `
      <p><b>The two sides are not measured the same way, and the gap should be read knowing
      it.</b></p>
      <p><b>Timing.</b> The standard is the BOM's claim on orders <em>booked</em> in the month;
      the ledger is material <em>issued</em> in it. An order booked in July is cut in August, so
      one month compares two slightly different populations. Pick <em>Every month</em> to let
      the timing wash out.</p>
      <p><b>Valuation.</b> The ledger prices an issue at the lot's own landed cost; the standard
      prices it at a year of purchase orders, weighted by quantity. A few points of any gap are
      that difference rather than consumption.</p>
      <p>${
        missed > 0
          ? `${nf.format(missed)} of ${nf.format(
              c.bookedLines,
            )} booked lines carry no BOM and are outside the standard. `
          : `All ${nf.format(c.bookedLines)} booked lines carry a BOM. `
      }Zipper only — Metal Trims stamps no BOM on its orders. Before labour, overhead and
      freight.${
        d.stale ? ` Odoo is not answering; showing ${new Date(d.builtAt).toLocaleString()}.` : ''
      }</p>`;
  }

  /* --------------------------------------------------------------- wiring */

  el.month.addEventListener('change', () => {
    state.month = el.month.value;
    load();
  });

  el.refresh.addEventListener('click', () => load(true));

  el.months.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-month]');
    if (!button?.dataset.month || button.dataset.month === state.month) return;
    state.month = button.dataset.month;
    el.month.value = state.month;
    load();
  });

  if (root.dataset.odoo) load();
}
