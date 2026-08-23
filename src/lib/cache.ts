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
