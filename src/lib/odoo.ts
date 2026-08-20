import { env } from './env';

/**
 * Minimal Odoo web-session client (JSON-RPC + HTTP controllers).
 *
 * Mirrors exactly what the Odoo web client does, as captured in
 * `Manufacturing Order.har`:
 *   POST /web/session/authenticate         -> session cookie
 *   POST /web/dataset/call_kw/<model>/<m>  -> ORM calls
 *   POST /web/dataset/call_button          -> button actions (returns ir.actions.*)
 *   GET  /report/xlsx/<report_name>?...    -> the generated workbook
 */

export interface OdooCompany {
  id: number;
  name: string;
}

export interface OdooSession {
  cookie: string;
  uid: number;
  userContext: Record<string, unknown>;
  allowedCompanyIds: number[];
  companies: OdooCompany[];
  companyId: number;
  userName: string;
  db: string;
  createdAt: number;
}

export class OdooError extends Error {
  data: unknown;
  constructor(message: string, data?: unknown) {
    super(message);
    this.name = 'OdooError';
    this.data = data;
  }
}


export const config = {
  get url() {
    return env('ODOO_URL', 'https://taps.odoo.com').replace(/\/+$/, '');
  },
  get db() {
    return env('ODOO_DB');
  },
  get login() {
    // ODOO_USERNAME is accepted as an alias - it is what Odoo's own login form
    // calls the field, so it is the name people reach for first.
    return env('ODOO_LOGIN') || env('ODOO_USERNAME');
  },
  get password() {
    return env('ODOO_PASSWORD');
  },
  get timezone() {
    return env('ODOO_TZ', 'Asia/Dhaka');
  },
  get lang() {
    return env('ODOO_LANG', 'en_US');
  },
};

/** Session TTL - Odoo sessions live far longer, this just forces a periodic refresh. */
const SESSION_TTL_MS = 30 * 60 * 1000;

let cached: OdooSession | null = null;
let inFlight: Promise<OdooSession> | null = null;

/**
 * fetch() reports every transport problem as a bare "fetch failed", which tells
 * nobody anything. Say what could not be reached and why.
 */
async function httpFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const cause = (err as any)?.cause;
    const code = cause?.code ? ` (${cause.code})` : '';
    const detail = (cause?.message || (err as Error).message || '').trim();
    throw new OdooError(
      `Could not reach ${new URL(url).origin}${code}` +
        (detail && detail !== 'fetch failed' ? `: ${detail}` : '') +
        '. Check ODOO_URL, the network, and that the server is reachable.',
    );
  }
}

function parseSessionCookie(res: Response): string {
  // undici exposes getSetCookie(); fall back to the folded header.
  const raw: string[] =
    typeof (res.headers as any).getSetCookie === 'function'
      ? (res.headers as any).getSetCookie()
      : [res.headers.get('set-cookie') ?? ''];
  for (const line of raw) {
    const m = /session_id=([^;]+)/.exec(line ?? '');
    if (m) return `session_id=${m[1]}`;
  }
  return '';
}

async function resolveDb(): Promise<string> {
  if (config.db) return config.db;
  const res = await httpFetch(`${config.url}/web/database/list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: {} }),
  });
  const body: any = await res.json().catch(() => null);
  const list: string[] = body?.result ?? [];
  if (list.length === 1) return list[0];
  throw new OdooError(
    list.length
      ? `ODOO_DB is not set and the server exposes several databases (${list.join(', ')}).`
      : 'ODOO_DB is not set and the database list is not exposed by this server. Set ODOO_DB in .env.',
  );
}

async function authenticate(): Promise<OdooSession> {
  if (!config.login || !config.password) {
    throw new OdooError(
      'Missing credentials. Set ODOO_URL, ODOO_DB, ODOO_LOGIN (or ODOO_USERNAME) and ODOO_PASSWORD in .env.',
    );
  }
  const db = await resolveDb();
  const res = await httpFetch(`${config.url}/web/session/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: { db, login: config.login, password: config.password },
    }),
  });
  const body: any = await res.json();
  if (body?.error) {
    throw new OdooError(
      body.error?.data?.message || body.error?.message || 'Odoo authentication failed.',
      body.error?.data,
    );
  }
  const result = body?.result;
  if (!result?.uid) throw new OdooError('Odoo rejected the credentials (no uid returned).');

  const cookie = parseSessionCookie(res);
  if (!cookie) throw new OdooError('Odoo did not return a session cookie.');

  const allowedMap: Record<string, any> = result.user_companies?.allowed_companies ?? {};
  const allowed: number[] = Object.keys(allowedMap).length
    ? Object.keys(allowedMap).map(Number)
    : [result.company_id ?? 1];
  const companies: OdooCompany[] = allowed.map((id) => ({
    id,
    name: allowedMap[String(id)]?.name ?? `Company ${id}`,
  }));

  return {
    cookie,
    uid: result.uid,
    userName: result.name ?? result.username ?? config.login,
    db: result.db ?? db,
    allowedCompanyIds: allowed,
    companies,
    companyId: result.user_companies?.current_company ?? result.company_id ?? allowed[0] ?? 1,
    userContext: result.user_context ?? {},
    createdAt: Date.now(),
  };
}

export async function getSession(force = false): Promise<OdooSession> {
  if (!force && cached && Date.now() - cached.createdAt < SESSION_TTL_MS) return cached;
  if (!force && inFlight) return inFlight;
  inFlight = authenticate()
    .then((s) => {
      cached = s;
      return s;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * The companies that actually manufacture: Zipper and Metal Trims.
 *
 * The login also sees Head Office and Non-Management, which hold no MRP data
 * and answer HTTP 500 for every report. PRODUCTION_COMPANIES overrides the
 * match — ids or names, comma separated — if the naming ever changes.
 */
export function productionCompanies(session: OdooSession): OdooCompany[] {
  const configured = env('PRODUCTION_COMPANIES');
  if (configured) {
    const wanted = configured
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
    const picked = session.companies.filter(
      (c) => wanted.includes(String(c.id)) || wanted.includes(c.name.toLowerCase()),
    );
    if (picked.length) return picked;
  }
  const matched = session.companies.filter((c) => /zipper|metal/i.test(c.name));
  return matched.length ? matched : session.companies;
}

export function invalidateSession() {
  cached = null;
}

/**
 * The `context` every call carries - matches the web client's shape.
 *
 * `companyId` narrows `allowed_company_ids` to a single company, which is how
 * the web client scopes a report to the company whose data you want. Zipper and
 * Metal Trims are invoiced by different companies, so the budget page runs the
 * same report once per company.
 */
export function buildContext(
  session: OdooSession,
  extra: Record<string, unknown> = {},
  companyId?: number,
): Record<string, unknown> {
  return {
    lang: config.lang,
    tz: config.timezone,
    uid: session.uid,
    allowed_company_ids: companyId ? [companyId] : session.allowedCompanyIds,
    ...extra,
  };
}

function isSessionExpired(error: any): boolean {
  const name = error?.data?.name ?? '';
  return (
    name.includes('SessionExpired') ||
    name.includes('AccessDenied') ||
    error?.code === 100 ||
    /session expired/i.test(error?.message ?? '')
  );
}

async function rpc<T>(path: string, params: unknown, retry = true): Promise<T> {
  const session = await getSession();
  const res = await httpFetch(`${config.url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: session.cookie,
      'x-requested-with': 'XMLHttpRequest',
    },
    body: JSON.stringify({ id: Date.now() % 100000, jsonrpc: '2.0', method: 'call', params }),
  });

  if (!res.ok) throw new OdooError(`Odoo returned HTTP ${res.status} for ${path}.`);

  const body: any = await res.json();
  if (body?.error) {
    if (retry && isSessionExpired(body.error)) {
      invalidateSession();
      await getSession(true);
      return rpc<T>(path, params, false);
    }
    const err = body.error;
    throw new OdooError(err?.data?.message?.trim() || err?.message || 'Odoo RPC error', err?.data);
  }
  return body.result as T;
}

export interface CallKwOptions {
  args?: unknown[];
  kwargs?: Record<string, unknown>;
}

export async function callKw<T = unknown>(
  model: string,
  method: string,
  { args = [], kwargs = {} }: CallKwOptions = {},
): Promise<T> {
  return rpc<T>(`/web/dataset/call_kw/${model}/${method}`, { model, method, args, kwargs });
}

export async function callButton<T = unknown>(
  model: string,
  method: string,
  ids: number[],
  context: Record<string, unknown>,
): Promise<T> {
  return rpc<T>('/web/dataset/call_button', { model, method, args: [ids], kwargs: { context } });
}

export async function loadAction<T = unknown>(actionId: number | string): Promise<T> {
  return rpc<T>('/web/action/load', { action_id: actionId, additional_context: {} });
}

export interface SearchReadOptions {
  domain?: unknown[];
  specification?: Record<string, unknown>;
  limit?: number;
  offset?: number;
  order?: string;
  context?: Record<string, unknown>;
}

export async function webSearchRead<T = any>(
  model: string,
  opts: SearchReadOptions = {},
): Promise<{ length: number; records: T[] }> {
  const session = await getSession();
  return callKw(model, 'web_search_read', {
    kwargs: {
      specification: opts.specification ?? { display_name: {} },
      offset: opts.offset ?? 0,
      order: opts.order ?? '',
      limit: opts.limit ?? 80,
      count_limit: 10001,
      domain: opts.domain ?? [],
      context: buildContext(session, {
        bin_size: true,
        current_company_id: session.companyId,
        ...opts.context,
      }),
    },
  });
}

/** Fetch a binary produced by an Odoo HTTP controller (reports, attachments). */
export async function fetchBinary(
  path: string,
): Promise<{ buffer: ArrayBuffer; contentType: string; filename: string }> {
  const session = await getSession();
  const res = await httpFetch(`${config.url}${path}`, {
    headers: { cookie: session.cookie, referer: `${config.url}/odoo` },
  });
  const contentType = res.headers.get('content-type') ?? '';

  if (!res.ok || contentType.includes('text/html')) {
    const text = await res.text();
    const m = /<p[^>]*>([\s\S]{0,400}?)<\/p>/i.exec(text);
    throw new OdooError(
      `Odoo could not generate the report (HTTP ${res.status}).` +
        (m ? ` ${m[1].replace(/<[^>]+>/g, '').trim()}` : ''),
    );
  }

  const disposition = res.headers.get('content-disposition') ?? '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  const filename = star ? decodeURIComponent(star[1]) : plain ? plain[1] : 'report.xlsx';

  return { buffer: await res.arrayBuffer(), contentType, filename };
}
