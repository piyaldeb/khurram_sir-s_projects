/**
 * Supabase setup + migration:  npm run db:setup
 *
 *   1. checks SUPABASE_URL, and prompts for the service-role key if it is missing
 *   2. checks the budget_months table exists (prints the SQL to run if not)
 *   3. copies any month files under data/ into the table
 *
 * The key is asked for here rather than hand-edited into .env so it never lands
 * in shell history. Nothing else is written except the month documents.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createTable, promptSecret } from './db-create.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');

try {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  /* no .env yet */
}

const URL_BASE = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
let KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';
const TABLE = process.env.SUPABASE_TABLE || 'budget_months';
const REF = /https:\/\/([a-z0-9]+)\.supabase\.co/.exec(URL_BASE)?.[1] ?? '';

const ok = (m) => console.log(`  \x1b[32mok\x1b[0m    ${m}`);
const bad = (m) => console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`);
const info = (m) => console.log(`        \x1b[2m${m}\x1b[0m`);
const dim = (m) => `\x1b[2m${m}\x1b[0m`;
const cyan = (m) => `\x1b[36m${m}\x1b[0m`;

const JWT = /^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Reads the key from the terminal and stores it on its own line in .env. */
async function promptForKey() {
  if (!stdin.isTTY) {
    info('not a terminal — add SUPABASE_SERVICE_ROLE_KEY to .env by hand');
    return '';
  }

  console.log('\n  Paste the service_role key, then press Enter.');
  if (REF) info(`https://supabase.com/dashboard/project/${REF}/settings/api`);

  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  const answer = (await rl.question('  key: ')).trim();
  rl.close();

  if (!answer) return '';
  if (!JWT.test(answer)) {
    bad('that does not look like a Supabase key (expected a JWT starting "ey")');
    return '';
  }

  let env = '';
  try {
    env = readFileSync(envPath, 'utf8');
  } catch {
    /* create it */
  }
  const line = `SUPABASE_SERVICE_ROLE_KEY=${answer}`;
  env = /^SUPABASE_SERVICE_ROLE_KEY=.*$/m.test(env)
    ? env.replace(/^SUPABASE_SERVICE_ROLE_KEY=.*$/m, line)
    : `${env}${!env || env.endsWith('\n') ? '' : '\n'}${line}\n`;
  writeFileSync(envPath, env, 'utf8');
  ok('written to .env');
  return answer;
}

const rest = (path, init = {}) =>
  fetch(`${URL_BASE}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: KEY,
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

const countOf = (res) => Number((res.headers.get('content-range') ?? '').split('/')[1]) || 0;

console.log(`\nSupabase setup\n${'─'.repeat(52)}`);

console.log('\n1. Configuration');
if (URL_BASE) ok(`SUPABASE_URL = ${URL_BASE}`);
else bad('SUPABASE_URL is empty — add it to .env');

if (!KEY) {
  bad('SUPABASE_SERVICE_ROLE_KEY is empty');
  KEY = await promptForKey();
}
if (KEY) ok(`SUPABASE_SERVICE_ROLE_KEY = set, ${KEY.length} chars`);

if (!URL_BASE || !KEY) {
  console.log('\nAdd the missing value to .env and run this again.\n');
  process.exit(1);
}

console.log('\n2. Table');
let res;
try {
  res = await rest(`/${TABLE}?select=month&limit=1`, { headers: { prefer: 'count=exact' } });
} catch (err) {
  bad(`cannot reach Supabase — ${err.cause?.code ?? err.message}`);
  info('Check SUPABASE_URL and the network.');
  process.exit(1);
}

if (!res.ok) {
  const body = await res.text();
  bad(`table "${TABLE}" is not there yet (HTTP ${res.status})`);

  // Offer to create it over a direct Postgres connection rather than making
  // anyone paste SQL into a dashboard.
  let created = false;
  if (stdin.isTTY && REF) {
    console.log(dim('\n  I can create it now. That needs the database password'));
    console.log(dim('  (Settings > Database). It is used for this one connection'));
    console.log(dim('  and is not saved anywhere.\n'));
    const password = process.env.SUPABASE_DB_PASSWORD || (await promptSecret('database password'));
    if (password) {
      try {
        await createTable({ ref: REF, password });
        created = true;
      } catch (err) {
        bad(err.message);
      }
    }
  }

  if (!created) {
    console.log('\nOr create it by hand in the SQL editor:');
    if (REF) console.log(`  ${cyan(`https://supabase.com/dashboard/project/${REF}/sql/new`)}`);
    console.log('\nCopy the SQL to the clipboard with:');
    console.log(`  ${cyan('type db\\schema.sql | clip')}   ${dim('(PowerShell / cmd)')}`);
    console.log(`  ${cyan('cat db/schema.sql | clip')}     ${dim('(Git Bash)')}\n`);
    console.log(dim(readFileSync(join(root, 'db', 'schema.sql'), 'utf8')));
    console.log('Then run `npm run db:setup` again.\n');
    process.exit(1);
  }

  // PostgREST caches the schema; nudge it so the new table is visible.
  await fetch(`${URL_BASE}/rest/v1/`, { headers: { apikey: KEY } }).catch(() => {});
  res = await rest(`/${TABLE}?select=month&limit=1`, { headers: { prefer: 'count=exact' } });
  if (!res.ok) {
    bad('created, but PostgREST has not picked it up yet — wait a moment and re-run.');
    process.exit(1);
  }
}

ok(`table "${TABLE}" is reachable — ${countOf(res)} rows`);

console.log('\n3. Migrating local month files');
let files = [];
try {
  files = readdirSync(join(root, 'data')).filter((f) => /^budget-\d{4}-\d{2}\.json$/.test(f));
} catch {
  /* no data directory */
}

if (!files.length) {
  info('nothing under data/ to migrate');
} else {
  let moved = 0;
  for (const file of files.sort()) {
    const month = /budget-(\d{4}-\d{2})\.json/.exec(file)[1];
    const doc = JSON.parse(readFileSync(join(root, 'data', file), 'utf8'));
    const put = await rest(`/${TABLE}`, {
      method: 'POST',
      headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ month, doc, updated_at: doc.updatedAt ?? new Date().toISOString() }),
    });
    if (put.ok) {
      moved++;
      const days = (doc.days ?? []).filter((d) => (d.zipper ?? 0) + (d.mt ?? 0) > 0).length;
      ok(`${month} — ${days} producing days`);
    } else {
      bad(`${month} — ${(await put.text()).slice(0, 140)}`);
    }
  }
  info(`${moved} of ${files.length} months written`);
}

const after = await rest(`/${TABLE}?select=month&limit=1`, { headers: { prefer: 'count=exact' } });

console.log(`\n${'─'.repeat(52)}`);
console.log(`Supabase now holds ${countOf(after)} months. The site will use it automatically.\n`);
