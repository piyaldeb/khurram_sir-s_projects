/**
 * Loading skeletons — the page keeps its shape while Odoo builds reports.
 *
 * Every page uses the same rail / chips / chart / table shapes, so the
 * placeholders live in one place. Purely presentational: grey blocks with a
 * shimmer, honest about nothing except the layout to come.
 */

const line = (w: string, h = '12px') =>
  `<span class="sk sk-line" style="width:${w};height:${h}"></span>`;

function railBlockSk(): string {
  return `<section class="rail-block" aria-hidden="true">
    ${line('40%', '10px')}
    ${line('55%', '26px')}
    ${line('70%')}
    <span class="sk sk-line" style="width:100%;height:4px;margin-top:8px"></span>
  </section>`;
}

export const skeleton = {
  /** The left rail: a heading block and three stat blocks. */
  rail(): string {
    return `<div class="rail-head" aria-hidden="true">
      ${line('30%', '10px')}
      ${line('75%', '20px')}
      ${line('90%')}
    </div>${railBlockSk()}${railBlockSk()}${railBlockSk()}`;
  },

  /** The chips row above a grid. */
  chips(n = 4): string {
    return Array.from({ length: n }, () => `<span class="sk sk-chip"></span>`).join('');
  },

  /** A chart area. */
  chart(height = 250): string {
    return `<div class="sk-chart" style="height:${height}px" aria-hidden="true">
      <span class="sk" style="width:100%;height:100%"></span>
    </div>`;
  },

  /** A table: header band plus shimmering rows. */
  table(cols = 8, rows = 10): string {
    const header = `<div class="sk-row head">${Array.from(
      { length: cols },
      () => `<span class="sk sk-cell" style="height:10px"></span>`,
    ).join('')}</div>`;
    const body = Array.from(
      { length: rows },
      () =>
        `<div class="sk-row">${Array.from(
          { length: cols },
          () => `<span class="sk sk-cell"></span>`,
        ).join('')}</div>`,
    ).join('');
    return `<div class="sk-table" aria-hidden="true" aria-busy="true">${header}${body}</div>`;
  },
};
