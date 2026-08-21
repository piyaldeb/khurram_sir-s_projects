/**
 * Today's USD/BDT rate, read from the web.
 *
 * Odoo reports overtime in taka; the report is read in dollars. The workbook
 * divides by a flat 120, which drifts as the taka moves, so the rate is looked
 * up instead and shown on the page next to the figures it produced.
 *
 * Two free sources, no API key between them, tried in order — and if both are
 * unreachable the last good rate is served rather than a wrong one. Only when
 * there has never been a good rate does it fall back to the configured
 * `OT_USD_RATE` (120), and it says so.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { cacheGetMany, cacheSet, supabaseConfig } from './supabase';
import { env } from './env';

const CACHE_KEY = 'fx-usd-bdt';
const CACHE_DIR = resolve(process.env.DATA_DIR || 'data', 'fx');

/** How long a looked-up rate stays fresh. Rates publish roughly daily. */
const FRESH_HOURS = Number(env('FX_FRESH_HOURS', '6')) || 6;

/** Used when the web has never answered, and when lookups are switched off. */
export const FIXED_USD_RATE = Number(env('OT_USD_RATE', '120')) || 120;

/**
 * Set `FX_LIVE=0` to pin every figure to `OT_USD_RATE` instead.
 *
 * The workbook converts at a flat 120, so pinning is what reproduces its dollar
 * figures exactly; a live rate is truer to what the overtime actually cost.
 */
const LIVE = !/^(0|false|off|no)$/i.test(env('FX_LIVE', '1'));

export interface UsdRate {
  /** Taka per dollar. */
  rate: number;
  /** Who said so, for the line printed on the page. */
  source: string;
  /** The date the rate is quoted for, ISO. */
  asOf: string;
  fetchedAt: string;
  /** False when this is the configured fallback rather than a real quote. */
  live: boolean;
  /** True when a refresh failed and the last good rate is being reused. */
  stale?: boolean;
}

interface Provider {
  name: string;
  url: string;
  read: (body: any) => { rate: number; asOf: string } | null;
}

const PROVIDERS: Provider[] = [
  {
    name: 'exchangerate-api.com',
    url: 'https://open.er-api.com/v6/latest/USD',
    read: (b) => {
      const rate = Number(b?.rates?.BDT);
      if (!Number.isFinite(rate) || rate <= 0) return null;
      const stamp = Number(b?.time_last_update_unix);
      return {
        rate,
        asOf: Number.isFinite(stamp)
          ? new Date(stamp * 1000).toISOString().slice(0, 10)
          : new Date().toISOString().slice(0, 10),
      };
    },
  },
  {
    name: 'currency-api',
    url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
    read: (b) => {
      const rate = Number(b?.usd?.bdt);
      if (!Number.isFinite(rate) || rate <= 0) return null;
      return { rate, asOf: String(b?.date ?? new Date().toISOString().slice(0, 10)) };
    },
  },
];

/* ------------------------------------------------------------------ cache */

async function readCache(): Promise<UsdRate | null> {
  try {
    if (supabaseConfig.enabled) {
      return (await cacheGetMany<UsdRate>([CACHE_KEY])).get(CACHE_KEY) ?? null;
    }
    return JSON.parse(await readFile(join(CACHE_DIR, `${CACHE_KEY}.json`), 'utf8')) as UsdRate;
  } catch {
    return null;
  }
}

async function writeCache(entry: UsdRate): Promise<void> {
  try {
    if (supabaseConfig.enabled) {
      await cacheSet(CACHE_KEY, entry);
      return;
    }
    const path = join(CACHE_DIR, `${CACHE_KEY}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(entry), 'utf8');
  } catch (err) {
    // A rate that cannot be cached is still a usable rate.
    console.warn(`[fx] could not cache the rate: ${(err as Error).message}`);
  }
}

const isFresh = (entry: UsdRate) =>
  entry.live && Date.now() - new Date(entry.fetchedAt).getTime() < FRESH_HOURS * 3_600_000;

/* ----------------------------------------------------------------- lookup */

async function lookup(): Promise<UsdRate | null> {
  for (const provider of PROVIDERS) {
    try {
      const res = await fetch(provider.url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) continue;
      const parsed = provider.read(await res.json());
      if (!parsed) continue;
      return {
        rate: parsed.rate,
        source: provider.name,
        asOf: parsed.asOf,
        fetchedAt: new Date().toISOString(),
        live: true,
      };
    } catch {
      // Try the next provider; a rate is never worth failing the report over.
    }
  }
  return null;
}

let inFlight: Promise<UsdRate> | null = null;

/**
 * The rate to convert with. Never throws: the worst case is the configured
 * fallback, flagged so the page can say the figure is not a live quote.
 */
export async function usdRate(): Promise<UsdRate> {
  if (!LIVE) {
    return {
      rate: FIXED_USD_RATE,
      source: 'fixed rate',
      asOf: new Date().toISOString().slice(0, 10),
      fetchedAt: new Date().toISOString(),
      live: false,
    };
  }

  const cached = await readCache();
  if (cached && isFresh(cached)) return cached;

  // Concurrent page loads share one lookup rather than each starting their own.
  inFlight ??= (async () => {
    try {
      const fresh = await lookup();
      if (fresh) {
        await writeCache(fresh);
        return fresh;
      }
      if (cached) return { ...cached, stale: true };
      return {
        rate: FIXED_USD_RATE,
        source: 'fixed rate',
        asOf: new Date().toISOString().slice(0, 10),
        fetchedAt: new Date().toISOString(),
        live: false,
      };
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
