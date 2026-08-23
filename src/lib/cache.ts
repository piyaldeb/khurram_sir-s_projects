/**
 * Where derived aggregates live between requests.
 *
 * Supabase when it is configured, otherwise JSON files under `data/`. Vercel's
 * filesystem is read-only, so in production Supabase is the only driver that
 * actually persists; the file driver keeps local work possible without one.
 *
 * Everything stored here is derived from Odoo and safe to drop — a missing
 * entry makes a page slower, never wrong.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { buildContext, callKw, getSession, OdooError } from './odoo';
import { cacheGetMany, cacheSet, supabaseConfig } from './supabase';

const CACHE_DIR = resolve(process.env.DATA_DIR || 'data', 'analytics');

const cachePath = (key: string) => join(CACHE_DIR, `${key}.json`);

const warned = new Set<string>();

/** Say once, per subsystem, that the cache is missing — then carry on without it. */
function warnOnce(tag: string, message: string) {
  if (warned.has(tag)) return;
  warned.add(tag);
  console.warn(`[${tag}] cache unavailable, falling back to refetching: ${message}`);
}

export async function readCacheMany<T>(keys: string[], tag: string): Promise<Map<string, T>> {
  if (!keys.length) return new Map();

  if (supabaseConfig.enabled) {
    try {
      return await cacheGetMany<T>(keys);
    } catch (err) {
      warnOnce(tag, (err as Error).message);
      return new Map();
    }
  }

  const out = new Map<string, T>();
  for (const key of keys) {
    try {
      out.set(key, JSON.parse(await readFile(cachePath(key), 'utf8')) as T);
    } catch {
      /* not cached */
    }
  }
  return out;
}

export async function readCache<T>(key: string, tag: string): Promise<T | null> {
  return (await readCacheMany<T>([key], tag)).get(key) ?? null;
}

export async function writeCache(key: string, doc: unknown, tag: string): Promise<void> {
  if (supabaseConfig.enabled) {
    try {
      await cacheSet(key, doc);
    } catch (err) {
      warnOnce(tag, (err as Error).message);
    }
    return;
  }
  const path = cachePath(key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(doc), 'utf8');
}

// ------------------------------------------------------- keeping it current

/**
 * A build, with what it was built from and when.
 *
 * The stamp is Odoo's own answer to "has anything changed" - see `odooStamp`.
 * Holding it beside the value is what lets a stale entry be revalidated for
 * the price of one cheap query instead of one expensive rebuild.
 */
interface Envelope<T> {
  v: 1;
  value: T;
  builtAt: string;
  stamp: string | null;
}

export interface Cached<T> {
  value: T;
  /** When the value was built, ISO. */
  builtAt: string;
  ageMs: number;
  /**
   * True when Odoo could not be reached and this is the last good copy. The
   * figures are real, they are just from `builtAt` rather than from now.
   */
  stale: boolean;
  /** Why it is stale, when it is. */
  error: string | null;
  /** How the answer was arrived at, for the page to say so honestly. */
  via: 'fresh' | 'cache' | 'revalidated' | 'stale';
}

const isEnvelope = <T>(doc: unknown): doc is Envelope<T> =>
  !!doc && typeof doc === 'object' && (doc as Envelope<T>).v === 1;

/**
 * Odoo's own answer to "has anything changed in this model".
 *
 * How many records match, and the latest `write_date` among them. Between
 * them those two catch a create, an edit and a delete, and they cost one
 * indexed read_group - milliseconds against the tens of seconds a real
 * rebuild takes. So a cache entry past its TTL usually still costs nothing:
 * the stamp says nothing moved, and the entry is simply marked fresh again.
 *
 * Returns null where the model has no `write_date` or the query fails, which
 * just means the cache falls back to rebuilding on age alone.
 */
export async function odooStamp(model: string, domain: unknown[] = []): Promise<string | null> {
  try {
    const context = buildContext(await getSession());
    const rows = await callKw<any[]>(model, 'read_group', {
      args: [domain, ['write_date:max'], []],
      kwargs: { context, lazy: false, limit: 1 },
    });
    const row = rows?.[0];
    if (!row) return `${model}:0:none`;
    const count = Number(row.__count ?? 0);
    const latest = String(row.write_date ?? row['write_date:max'] ?? 'none');
    return `${model}:${count}:${latest}`;
  } catch {
    return null;
  }
}

/** Several models in one stamp, for a page that reads from more than one. */
export async function odooStampAll(
  sources: { model: string; domain?: unknown[] }[],
): Promise<string | null> {
  const parts = await Promise.all(sources.map((s) => odooStamp(s.model, s.domain ?? [])));
  return parts.some((p) => p === null) ? null : parts.join('|');
}

export interface CachedOptions<T> {
  /** How long a build is trusted without asking Odoo whether anything moved. */
  ttlMs: number;
  /** The expensive part. */
  build: () => Promise<T>;
  /**
   * Odoo's change stamp. Given one, an expired entry is revalidated rather
   * than rebuilt when nothing has changed.
   */
  stamp?: () => Promise<string | null>;
  /** Rebuild whatever the cache says. */
  force?: boolean;
}

/** In-flight builds, so ten simultaneous readers cost one build. */
const running = new Map<string, Promise<unknown>>();

/**
 * A value that survives a restart, a redeploy and an Odoo outage.
 *
 * The order of preference, and why:
 *
 *   1. A cache entry inside its TTL. Costs nothing.
 *   2. An expired entry whose stamp still matches Odoo. Costs one cheap query,
 *      and is the common case: most of what this site reports is closed months
 *      that will never change again.
 *   3. A rebuild.
 *   4. If the rebuild fails and there is any previous copy at all, that copy,
 *      marked stale and carrying the error. A page that says "as of 09:15,
 *      Odoo is not answering" is worth more than one that says "Odoo error"
 *      and shows nothing - the figures were true at 09:15 and mostly still are.
 *
 * Only step 4 is new to the site, and it is the one people notice.
 */
export async function cached<T>(
  key: string,
  tag: string,
  opts: CachedOptions<T>,
): Promise<Cached<T>> {
  const stored = await readCache<unknown>(key, tag);
  const held = isEnvelope<T>(stored) ? stored : null;

  const shape = (env: Envelope<T>, via: Cached<T>['via'], error: string | null = null) => ({
    value: env.value,
    builtAt: env.builtAt,
    ageMs: Math.max(0, Date.now() - Date.parse(env.builtAt)),
    stale: via === 'stale',
    error,
    via,
  });

  if (held && !opts.force) {
    const age = Date.now() - Date.parse(held.builtAt);
    if (Number.isFinite(age) && age < opts.ttlMs) return shape(held, 'cache');

    // Expired. Ask Odoo the cheap question before paying for the dear one.
    if (opts.stamp && held.stamp) {
      const now = await opts.stamp();
      if (now && now === held.stamp) {
        const refreshed: Envelope<T> = { ...held, builtAt: new Date().toISOString() };
        await writeCache(key, refreshed, tag);
        return shape(refreshed, 'revalidated');
      }
    }
  }

  const job =
    (running.get(key) as Promise<Envelope<T>> | undefined) ??
    (async (): Promise<Envelope<T>> => {
      const [value, stamp] = await Promise.all([
        opts.build(),
        opts.stamp ? opts.stamp() : Promise.resolve(null),
      ]);
      const env: Envelope<T> = { v: 1, value, builtAt: new Date().toISOString(), stamp };
      await writeCache(key, env, tag);
      return env;
    })();

  running.set(key, job);
  try {
    return shape(await job, 'fresh');
  } catch (err) {
    const message = err instanceof OdooError ? err.message : (err as Error).message;
    if (!held) throw err;
    console.warn(`[${tag}] ${key}: rebuild failed, serving the copy from ${held.builtAt}: ${message}`);
    return shape(held, 'stale', message);
  } finally {
    running.delete(key);
  }
}
