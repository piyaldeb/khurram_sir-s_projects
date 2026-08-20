import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { s as supabaseConfig, l as listBudgetMonths, b as selectBudget, u as upsertBudget, d as selectBudgets } from './supabase_C8i5aIv3.mjs';

const DATA_DIR = resolve(process.env.DATA_DIR || "data");
const MONTH = /^\d{4}-\d{2}$/;
function fileFor(month) {
  if (!MONTH.test(month)) throw new Error(`Refusing to touch "${month}".`);
  return join(DATA_DIR, `budget-${month}.json`);
}
async function fileRead(month) {
  try {
    return JSON.parse(await readFile(fileFor(month), "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}
async function fileWrite(month, doc) {
  const path = fileFor(month);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(doc, null, 2), "utf8");
}
async function fileList() {
  try {
    return (await readdir(DATA_DIR)).map((f) => /^budget-(\d{4}-\d{2})\.json$/.exec(f)?.[1]).filter((m) => !!m).sort();
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}
async function getBudget(month) {
  return supabaseConfig.enabled ? selectBudget(month) : fileRead(month);
}
async function getBudgets(months) {
  if (supabaseConfig.enabled) return selectBudgets(months);
  const out = /* @__PURE__ */ new Map();
  for (const month of months) {
    const doc = await fileRead(month);
    if (doc) out.set(month, doc);
  }
  return out;
}
async function putBudget(month, doc) {
  if (!MONTH.test(month)) throw new Error(`Refusing to store "${month}".`);
  return supabaseConfig.enabled ? upsertBudget(month, doc) : fileWrite(month, doc);
}
async function storedMonths() {
  return supabaseConfig.enabled ? listBudgetMonths() : fileList();
}

export { getBudgets as a, getBudget as g, putBudget as p, storedMonths as s };
