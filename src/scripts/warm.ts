/**
 * Fill the caches for the other pages while this one is being read.
 *
 * Every report on this site is cached server-side, but the first visitor after
 * an entry expires still pays the rebuild. That visitor is almost always a
 * person who has just opened the site and is about to click through to three
 * more pages. So the first page they open asks for the rest, quietly, in the
 * background: by the time they get there the answer is already sitting in the
 * cache.
 *
 * Warming from the browser rather than the server on purpose. Work started on
 * the server after a response has been sent is not guaranteed to finish -
 * a serverless instance is free to freeze the moment it replies - whereas a
 * real request keeps the thing alive for as long as it takes.
 *
 * Rules it follows, so that helping never turns into hurting:
 *
 *   - Once per browser session, not once per page.
 *   - Only after this page has finished its own loading and gone idle. The
 *     page in front of the reader always wins.
 *   - One at a time, heaviest first. Six at once would queue behind each other
 *     in the browser and hammer Odoo besides.
 *   - Never on a metered or slow connection, and never on a phone left on a
 *     bad signal.
 *   - Abandoned the moment the reader leaves.
 */

/** April to March, so the year a page opens on is the year April last started. */
function currentFy() {
  const now = new Date();
  return now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;
}

/** The month a monthly report opens on. */
function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Heaviest first: the long ones benefit most from a head start.
 *
 * The year is the one each page opens on, so these are the entries a reader
 * clicking through will actually land on.
 */
function targets() {
  const fy = currentFy();
  return [
    // Costing a month reads the order book, every BOM behind it and a year of
    // purchase history, so it is the longest cold build on the site.
    `/api/rm-cost?month=${currentMonth()}`,
    `/api/buyer-edd?fy=${fy}`,
    `/api/sample-leadtime?fy=${fy}&dataset=bulk&company=zipper`,
    '/api/ccr',
    '/api/oa-released',
    '/api/rm-consumption',
    '/api/rm-demand',
  ];
}

const ONCE_KEY = 'taps:warmed';

function allowed(): boolean {
  // A connection the browser thinks is poor, or one the reader pays for by the
  // megabyte, is not one to spend a few megabytes on speculatively.
  const conn = (navigator as any).connection;
  if (conn?.saveData) return false;
  if (conn?.effectiveType && /^(slow-)?2g$/.test(conn.effectiveType)) return false;

  try {
    if (sessionStorage.getItem(ONCE_KEY)) return false;
    sessionStorage.setItem(ONCE_KEY, '1');
  } catch {
    // Private mode with storage denied: warm anyway, at worst once per page.
  }
  return true;
}

async function warm(signal: AbortSignal) {
  for (const url of targets()) {
    if (signal.aborted) return;
    try {
      // The body is never read; the point is the cache entry it leaves behind.
      await fetch(url, { signal, priority: 'low', headers: { 'x-warm': '1' } } as RequestInit);
    } catch {
      // A warm-up that fails costs nothing: the page that needs it will ask
      // again, and the reader will simply wait as they would have anyway.
    }
  }
}

export function startWarming() {
  if (!allowed()) return;

  const controller = new AbortController();
  addEventListener('pagehide', () => controller.abort(), { once: true });

  const begin = () => {
    const idle = (window as any).requestIdleCallback;
    if (idle) idle(() => warm(controller.signal), { timeout: 4000 });
    else setTimeout(() => warm(controller.signal), 1500);
  };

  if (document.readyState === 'complete') begin();
  else addEventListener('load', begin, { once: true });
}
