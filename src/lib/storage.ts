/**
 * Where the budget months live.
 *
 * Supabase when it is configured, otherwise JSON files under `data/`. The file
 * driver keeps the site usable before Supabase is set up, and makes local work
 * possible without a network.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  listBudgetMonths,
  selectBudget,
  selectBudgets,
  supabaseConfig,
  upsertBudget,
} from './supabase';

const DATA_DIR = resolve(process.env.DATA_DIR || 'data');
const MONTH = /^\d{4}-\d{2}$/;

export type StorageDriver = 'supabase' | 'file';

export function activeDriver(): StorageDriver {
  return supabaseConfig.enabled ? 'supabase' : 'file';
}

/* --------------------------------------------------------------- file driver */

function fileFor(month: string): string {
  if (!MONTH.test(month)) throw new Error(`Refusing to touch "${month}".`);
  return join(DATA_DIR, `budget-${month}.json`);
}

async function fileRead<T>(month: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(fileFor(month), 'utf8')) as T;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

async function fileWrite(month: string, doc: unknown): Promise<void> {
  const path = fileFor(month);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(doc, null, 2), 'utf8');
}

async function fileList(): Promise<string[]> {
  try {
    return (await readdir(DATA_DIR))
      .map((f) => /^budget-(\d{4}-\d{2})\.json$/.exec(f)?.[1])
      .filter((m): m is string => !!m)
      .sort();
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

/* ------------------------------------------------------------------- public */

export async function getBudget<T>(month: string): Promise<T | null> {
  return supabaseConfig.enabled ? selectBudget<T>(month) : fileRead<T>(month);
}

/** Batch read — one round trip instead of one per month. */
export async function getBudgets<T>(months: string[]): Promise<Map<string, T>> {
  if (supabaseConfig.enabled) return selectBudgets<T>(months);
  const out = new Map<string, T>();
  for (const month of months) {
    const doc = await fileRead<T>(month);
    if (doc) out.set(month, doc);
  }
  return out;
}

export async function putBudget(month: string, doc: unknown): Promise<void> {
  if (!MONTH.test(month)) throw new Error(`Refusing to store "${month}".`);
  return supabaseConfig.enabled ? upsertBudget(month, doc) : fileWrite(month, doc);
}

export async function storedMonths(): Promise<string[]> {
  return supabaseConfig.enabled ? listBudgetMonths() : fileList();
}

/* The file driver is exported so the migration script can read the old data. */
export const fileDriver = { read: fileRead, write: fileWrite, list: fileList };
