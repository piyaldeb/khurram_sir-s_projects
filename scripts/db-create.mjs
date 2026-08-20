/**
 * Creates the budget_months table over a direct Postgres connection.
 *
 * Used by `npm run db:setup` when the table is missing, and runnable on its own
 * as `npm run db:create`.
 *
 * The database password is read from a prompt (or SUPABASE_DB_PASSWORD /
 * SUPABASE_DB_URL if you would rather set it) and used for this one connection.
 * It is never written to disk.
 *
 * Supabase projects no longer publish a direct `db.<ref>.supabase.co` host, so
 * this goes through the connection pooler. The pooler hostname carries the
 * region, which the dashboard knows and we do not — so the region is discovered
 * by trying each one until the credentials are accepted.
 */
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Pooler regions to try. SUPABASE_DB_REGION short-circuits this; the order below
 * is only the fallback if the region is unknown. A wrong region answers
 * "tenant/user not found", the right one gets as far as authentication.
 */
const REGIONS = [
  'ap-northeast-1',
  'ap-south-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-northeast-2',
  'eu-central-1',
  'eu-west-1',
  'eu-west-2',
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'ca-central-1',
  'sa-east-1',
];

const green = (m) => `\x1b[32m${m}\x1b[0m`;
const red = (m) => `\x1b[31m${m}\x1b[0m`;
const dim = (m) => `\x1b[2m${m}\x1b[0m`;

/**
 * Reads a secret without echoing it.
 *
 * Nothing appears while you type or paste — that is deliberate, and the prompt
 * says so, because a silent prompt reads as a frozen one.
 */
export async function promptSecret(label) {
  if (!stdin.isTTY) return '';

  console.log(dim('  Nothing will appear as you type — that is normal.'));
  console.log(dim('  Paste with Ctrl+V (or right-click), then press Enter.\n'));

  // Read the keys directly rather than through readline: readline redraws its
  // line, which wipes a separately-written prompt, and muting its output to
  // hide the secret takes the label with it.
  const answer = await new Promise((resolve) => {
    stdout.write(`  ${label}: `);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let buffer = '';
    const finish = (value) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stdout.write('\n');
      resolve(value);
    };

    const onData = (chunk) => {
      // A paste arrives as one chunk, so walk it character by character.
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish(buffer);
        if (ch === '\u0003') {
          finish('');
          process.exit(130); // Ctrl+C
        }
        if (ch === '\u007f' || ch === '') {
          buffer = buffer.slice(0, -1);
          continue;
        }
        if (ch < ' ') continue; // other control characters
        buffer += ch;
      }
    };

    stdin.on('data', onData);
  });

  const trimmed = answer.trim();
  if (trimmed) console.log(dim(`  got it (${trimmed.length} characters)\n`));
  return trimmed;
}

/** Tries each pooler region until one accepts the credentials. */
async function connect(ref, password, onTry) {
  const attempts = [];
  const configured = process.env.SUPABASE_DB_REGION;
  const regions = configured ? [configured, ...REGIONS.filter((r) => r !== configured)] : REGIONS;

  for (const region of regions) {
    const host = `aws-0-${region}.pooler.supabase.com`;
    onTry?.(region);
    const sql = postgres({
      host,
      port: 5432, // session mode - behaves like a normal connection, fine for DDL
      database: 'postgres',
      username: `postgres.${ref}`,
      password,
      ssl: 'require',
      max: 1,
      idle_timeout: 5,
      connect_timeout: 8,
      prepare: false,
      onnotice: () => {},
    });
    try {
      await sql`select 1`;
      return { sql, region };
    } catch (err) {
      attempts.push(`${region}: ${err.message}`);
      await sql.end({ timeout: 1 }).catch(() => {});
      // A wrong password fails identically everywhere; stop rather than
      // hammering fourteen regions with bad credentials.
      if (/password authentication failed/i.test(err.message)) {
        throw new Error('password authentication failed — check the database password');
      }
    }
  }
  throw new Error(`could not connect through any pooler region.\n${dim(attempts.slice(0, 3).join('\n'))}`);
}

export async function createTable({ ref, password, quiet = false }) {
  const schema = readFileSync(join(root, 'db', 'schema.sql'), 'utf8');
  const log = (m) => !quiet && console.log(m);

  let found;
  const { sql, region } = await connect(ref, password, (r) => {
    if (!quiet && r !== found) {
      found = r;
      stdout.write(`\r  ${dim(`trying ${r}…`.padEnd(40))}`);
    }
  });
  if (!quiet) stdout.write(`\r${' '.repeat(44)}\r`);
  log(`  ${green('ok')}    connected via ${region}`);

  try {
    await sql.unsafe(schema);
    log(`  ${green('ok')}    schema applied`);

    const [row] = await sql`
      select count(*)::int as n
      from information_schema.tables
      where table_schema = 'public' and table_name = 'budget_months'
    `;
    if (!row?.n) throw new Error('the table still is not there after running the schema');
    log(`  ${green('ok')}    table public.budget_months exists`);
    return { region };
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

/* Run directly: npm run db:create */
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  try {
    for (const line of readFileSync(join(root, '.env'), 'utf8').split('\n')) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no .env */
  }

  const ref = /https:\/\/([a-z0-9]+)\.supabase\.co/.exec(process.env.SUPABASE_URL ?? '')?.[1];
  if (!ref) {
    console.log(red('\nSUPABASE_URL is missing or malformed in .env.\n'));
    process.exit(1);
  }

  console.log(`\nCreating public.budget_months in project ${ref}\n${'─'.repeat(52)}`);
  let password = process.env.SUPABASE_DB_PASSWORD || '';
  if (!password) {
    console.log(dim('\n  Database password (Settings > Database). Used for this'));
    console.log(dim('  connection only — it is not saved anywhere.\n'));
    password = await promptSecret('database password');
  }
  if (!password) {
    console.log(red('\nNo password given.\n'));
    process.exit(1);
  }

  try {
    await createTable({ ref, password });
    console.log(`\n${'─'.repeat(52)}`);
    console.log('Done. Run `npm run db:setup` to migrate the months in.\n');
  } catch (err) {
    console.log(`  ${red('FAIL')}  ${err.message}`);
    process.exit(1);
  }
}
