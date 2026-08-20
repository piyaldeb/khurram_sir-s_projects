/**
 * Preflight for the Odoo connection: `npm run check:odoo`
 *
 * Runs the same calls the site makes, one at a time, and says which step failed
 * and why. Plain JSON-RPC — no build step, nothing imported from src.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// node --env-file handles this in npm scripts; parse .env too so a bare
// `node scripts/check-odoo.mjs` works the same way.
try {
  for (const line of readFileSync(join(root, '.env'), 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  /* no .env - rely on the real environment */
}

const URL_BASE = (process.env.ODOO_URL || 'https://taps.odoo.com').replace(/\/+$/, '');
const DB = process.env.ODOO_DB || '';
const LOGIN = process.env.ODOO_LOGIN || process.env.ODOO_USERNAME || '';
const PASSWORD = process.env.ODOO_PASSWORD || '';
const TZ = process.env.ODOO_TZ || 'Asia/Dhaka';
const LANG = process.env.ODOO_LANG || 'en_US';

const ok = (m) => console.log(`  \x1b[32mok\x1b[0m    ${m}`);
const bad = (m) => console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`);
const info = (m) => console.log(`        \x1b[2m${m}\x1b[0m`);
const step = (m) => console.log(`\n${m}`);

let cookie = '';

async function rpc(path, params) {
  const res = await fetch(`${URL_BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      'x-requested-with': 'XMLHttpRequest',
    },
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'call', params }),
  });
  const body = await res.json();
  if (body.error) {
    const e = body.error;
    throw new Error((e.data?.message || e.message || 'RPC error').trim());
  }
  return { result: body.result, res };
}

async function main() {
  console.log(`\nChecking ${URL_BASE}\n${'─'.repeat(50)}`);

  step('1. Configuration');
  for (const [name, value] of [
    ['ODOO_URL', URL_BASE],
    ['ODOO_DB', DB],
    ['ODOO_LOGIN / ODOO_USERNAME', LOGIN],
    ['ODOO_PASSWORD', PASSWORD ? '(set)' : ''],
  ]) {
    if (value) ok(`${name} = ${name === 'ODOO_PASSWORD' ? '(set)' : value}`);
    else bad(`${name} is empty — add it to .env`);
  }
  if (!LOGIN || !PASSWORD) {
    console.log('\nFill in .env and run this again.\n');
    process.exit(1);
  }

  step('2. Reachability');
  try {
    const res = await fetch(`${URL_BASE}/web/login`, { redirect: 'manual' });
    ok(`server answered HTTP ${res.status}`);
  } catch (err) {
    bad(`cannot reach the server — ${err.cause?.code ?? err.message}`);
    info('Check ODOO_URL, your network, and any VPN or firewall.');
    process.exit(1);
  }

  step('3. Sign in');
  let session;
  try {
    const { result, res } = await rpc('/web/session/authenticate', {
      db: DB,
      login: LOGIN,
      password: PASSWORD,
    });
    const setCookie = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
    cookie = (setCookie.map((c) => /session_id=([^;]+)/.exec(c)?.[0]).find(Boolean)) ?? '';
    session = result;
    if (!session?.uid) throw new Error('no uid returned');
    ok(`signed in as ${session.name} (uid ${session.uid}) on database "${session.db}"`);
    if (!cookie) bad('no session cookie came back — later calls will fail');
  } catch (err) {
    bad(`sign-in failed — ${err.message}`);
    info('Wrong database, login, or password/API key. An API key from');
    info('Preferences > Account Security > New API Key works in place of the password.');
    process.exit(1);
  }

  const allowed = Object.keys(session.user_companies?.allowed_companies ?? {}).map(Number);
  const companies = allowed.map((id) => ({
    id,
    name: session.user_companies.allowed_companies[String(id)]?.name ?? `Company ${id}`,
  }));

  step('4. Companies');
  if (companies.length) {
    companies.forEach((c) => ok(`${c.id} — ${c.name}`));
    if (companies.length === 1) {
      info('Only one company is visible. If Metal Trims is invoiced by another');
      info('company, this user needs access to it or MT will read as zero.');
    }
  } else {
    bad('no companies returned');
  }

  const context = { lang: LANG, tz: TZ, uid: session.uid, allowed_company_ids: allowed };

  step('5. MRP report wizard');
  let reportCount = 0;
  try {
    const { result } = await rpc('/web/dataset/call_kw/mrp.report.custom/get_views', {
      model: 'mrp.report.custom',
      method: 'get_views',
      args: [],
      kwargs: { context, views: [[false, 'form']], options: { load_filters: false } },
    });
    const selection = result?.models?.['mrp.report.custom']?.report_type?.selection ?? [];
    reportCount = selection.length;
    if (reportCount) ok(`${reportCount} report types available`);
    else bad('the wizard returned no report types');
  } catch (err) {
    bad(`cannot open mrp.report.custom — ${err.message}`);
    info('This user probably lacks access to the MRP Reports action.');
    process.exit(1);
  }

  step('6. Build one report (Invoice Summary, this month)');
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const lastDay = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 0)).getUTCDate();

  for (const company of companies) {
    const scoped = { ...context, allowed_company_ids: [company.id] };
    try {
      const { result: saved } = await rpc('/web/dataset/call_kw/mrp.report.custom/web_save', {
        model: 'mrp.report.custom',
        method: 'web_save',
        args: [
          [],
          {
            report_type: 'invs',
            challan_record_id: false,
            challan_no: false,
            date_from: `${month}-01`,
            date_to: `${month}-${String(lastDay).padStart(2, '0')}`,
            buyer_name_filter: false,
          },
        ],
        kwargs: { context: scoped, specification: { report_type: {}, date_from: {}, date_to: {} } },
      });
      const id = saved?.[0]?.id;
      if (!id) throw new Error('the wizard record was not created');

      const { result: action } = await rpc('/web/dataset/call_button', {
        model: 'mrp.report.custom',
        method: 'action_generate_xlsx_report',
        args: [[id]],
        kwargs: { context: scoped },
      });
      if (action?.type !== 'ir.actions.report') throw new Error('no report action returned');

      const query = new URLSearchParams();
      if (action.data) query.set('options', JSON.stringify(action.data));
      query.set(
        'context',
        JSON.stringify({
          ...scoped,
          ...(action.context ?? {}),
          active_model: 'mrp.report.custom',
          active_id: id,
          active_ids: [id],
        }),
      );

      const file = await fetch(`${URL_BASE}/report/xlsx/${action.report_name}?${query}`, {
        headers: { cookie, referer: `${URL_BASE}/odoo` },
      });
      const type = file.headers.get('content-type') ?? '';
      const size = (await file.arrayBuffer()).byteLength;
      if (!type.includes('spreadsheet')) throw new Error(`got ${type || 'no content-type'}`);
      ok(`${company.name}: ${action.name} — ${(size / 1024).toFixed(1)} KB`);
    } catch (err) {
      bad(`${company.name}: ${err.message}`);
    }
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log('Connection is good. Start the site with:  npm run dev\n');
}

main().catch((err) => {
  console.error(`\nUnexpected failure: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
