import { env } from './env';

/**
 * Supabase (PostgREST) access for the data Odoo does not hold — the budget
 * months: plans, working calendars, and the production figures fetched from
 * Odoo.
 *
 * Server-side only, and only with the service-role key. The browser never
 * talks to Supabase: it talks to this site's `/api/*` routes, so the key never
 * leaves the server and the table can stay locked down (RLS on, no policies).
 */


export const supabaseConfig = {
  get url() {
    return (env('SUPABASE_URL') || '').replace(/\/+$/, '');
  },
  get key() {
    // The service-role key bypasses RLS, which is what a trusted server wants.
    return env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_KEY');
  },
  get table() {
    return env('SUPABASE_TABLE') || 'budget_months';
  },
  get cacheTable() {
    return env('SUPABASE_CACHE_TABLE') || 'app_cache';
  },
  get enabled() {
    return !!(this.url && this.key);
  },
};

export class SupabaseError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'SupabaseError';
    this.status = status;
  }
}

async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  const { url, key } = supabaseConfig;
  if (!url || !key) throw new SupabaseError('Supabase is not configured.');

  let res: Response;
  try {
    res = await fetch(`${url}/rest/v1${path}`, {
      ...init,
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    const cause = (err as any)?.cause;
    throw new SupabaseError(
      `Could not reach ${url}${cause?.code ? ` (${cause.code})` : ''}. ` +
        'Check SUPABASE_URL and the network.',
    );
  }

  if (!res.ok) {
    const body = await res.text();
    let detail = body.slice(0, 300);
    try {
      const parsed = JSON.parse(body);
      detail = parsed.message || parsed.hint || parsed.details || detail;
    } catch {
      /* keep the raw text */
    }
    if (res.status === 404 || /does not exist|schema cache/i.test(detail)) {
      // Name the table that is actually missing, not whichever one is default.
      const missing = /'public\.([\w]+)'/.exec(detail)?.[1] ?? path.split('?')[0].replace('/', '');
      throw new SupabaseError(
        `Table "${missing}" is missing — run \`npm run db:create\` to apply db/schema.sql. (${detail})`,
        res.status,
      );
    }
    throw new SupabaseError(`Supabase ${res.status}: ${detail}`, res.status);
  }
  return res;
}

export interface BudgetRow<T = unknown> {
  month: string;
  doc: T;
  updated_at?: string;
}

export async function selectBudget<T>(month: string): Promise<T | null> {
  const res = await rest(
    `/${supabaseConfig.table}?month=eq.${encodeURIComponent(month)}&select=doc&limit=1`,
  );
  const rows = (await res.json()) as BudgetRow<T>[];
  return rows.length ? rows[0].doc : null;
}

export async function selectBudgets<T>(months?: string[]): Promise<Map<string, T>> {
  const filter =
    months?.length
      ? `&month=in.(${months.map((m) => `"${m}"`).join(',')})`
      : '';
  const res = await rest(`/${supabaseConfig.table}?select=month,doc${filter}&order=month.asc`);
  const rows = (await res.json()) as BudgetRow<T>[];
  return new Map(rows.map((r) => [r.month, r.doc]));
}

export async function upsertBudget(month: string, doc: unknown): Promise<void> {
  await rest(`/${supabaseConfig.table}`, {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ month, doc, updated_at: new Date().toISOString() }),
  });
}

export async function listBudgetMonths(): Promise<string[]> {
  const res = await rest(`/${supabaseConfig.table}?select=month&order=month.asc`);
  const rows = (await res.json()) as { month: string }[];
  return rows.map((r) => r.month);
}

/** Cheap round-trip used by the setup script and the health check. */
export async function ping(): Promise<{ ok: true; rows: number }> {
  const res = await rest(`/${supabaseConfig.table}?select=month&limit=1`, {
    headers: { prefer: 'count=exact' },
  });
  const range = res.headers.get('content-range') ?? '';
  const total = Number(range.split('/')[1]);
  return { ok: true, rows: Number.isFinite(total) ? total : 0 };
}


/* ------------------------------------------------------------ generic cache */

export async function cacheGetMany<T>(keys: string[]): Promise<Map<string, T>> {
  if (!keys.length) return new Map();
  const list = keys.map((k) => `"${k}"`).join(',');
  const res = await rest(`/${supabaseConfig.cacheTable}?select=key,doc&key=in.(${list})`);
  const rows = (await res.json()) as { key: string; doc: T }[];
  return new Map(rows.map((r) => [r.key, r.doc]));
}

export async function cacheSet(key: string, doc: unknown): Promise<void> {
  await rest(`/${supabaseConfig.cacheTable}`, {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key, doc, updated_at: new Date().toISOString() }),
  });
}
