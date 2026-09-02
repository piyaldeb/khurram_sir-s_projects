/**
 * Which pages are open right now.
 *
 * Only the budget follow-up and the OT report are in use; the rest are shut
 * until they are signed off. The nav (src/layouts/Base.astro) renders a closed
 * page as plain text, and the middleware (src/middleware.ts) sends anyone who
 * types the URL to the budget page instead. Both read this list, so opening a
 * page again is one line here.
 */
export const OPEN_PAGES = ['/budget', '/ot-cost'] as const;

/** The API routes those two pages call. Everything else under /api is closed. */
export const OPEN_API = ['/api/budget', '/api/summary', '/api/sync', '/api/backfill', '/api/ot-cost'];

/** Where a closed URL lands. */
export const HOME = '/budget';

const startsWithAny = (path: string, roots: readonly string[]) =>
  roots.some((root) => path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}?`));

export const isOpen = (path: string): boolean =>
  startsWithAny(path, OPEN_PAGES) || startsWithAny(path, OPEN_API);
