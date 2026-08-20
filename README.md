# TAPS Manufacturing Reports

An Astro site that reads manufacturing reporting straight out of Odoo over JSON-RPC —
no export/import step, no copies of the data. Two sections:

| Section | What it does |
|---|---|
| **Reports** (`/`) | Runs any of the 36 `MRP Reports` wizard reports and renders the result as a searchable, sortable table with totals and CSV/Excel export. |
| **Budget follow-up** (`/budget`) | `Monthly Budget vs Achievement`, live — as a month sheet, a fiscal year, or year-to-date, with charts. Targets come from the planning workbook; production is read from Odoo. |

## Setup

```bash
npm install
cp .env.example .env      # then fill in ODOO_LOGIN and ODOO_PASSWORD
npm run check:odoo        # preflight: says which step fails and why
npm run dev               # http://localhost:4321
```

`npm run check:odoo` walks the same calls the site makes — reachability, sign-in,
visible companies, the MRP wizard, and building one real report per company — and
reports each step separately, so a bad password and a missing access right don't look
alike.

`.env`:

```
ODOO_URL=https://taps.odoo.com
ODOO_DB=masbha-tex-taps-master-2093561
ODOO_LOGIN=you@example.com
ODOO_PASSWORD=your-password-or-api-key
ODOO_TZ=Asia/Dhaka
```

`ODOO_DB` is already filled in — the server exposes exactly one database.

Use an Odoo **API key** (Preferences → Account Security → New API Key) rather than the
password. The credentials never leave the server — the browser only ever talks to this
site's own `/api/*` routes.

For production: `npm run build && npm start` (the start script loads `.env` at runtime, so
you can change credentials without rebuilding).

## How the Odoo calls work

Everything mirrors what the Odoo web client itself does, captured in
`Manufacturing Order.har`. `src/lib/odoo.ts` holds the client:

```
POST /web/session/authenticate          -> session cookie, cached in memory, auto-renewed
POST /web/dataset/call_kw/<model>/<m>   -> ORM calls (get_views, onchange, web_save, web_search_read)
POST /web/dataset/call_button           -> action_generate_xlsx_report
GET  /report/xlsx/<report_name>?...     -> the generated workbook
```

Running one report (`src/lib/reports.ts`) is four calls:

1. `onchange` on `mrp.report.custom` for the field defaults.
2. `web_save` with the chosen filters → a transient wizard record id.
3. `call_button action_generate_xlsx_report` → an `ir.actions.report` descriptor.
4. `GET /report/xlsx/<report_name>?options=…&context=…` → the xlsx bytes.

The workbook is then parsed into JSON (`src/lib/xlsx.ts`) preserving merged cells and
title rows. Odoo writes its TOTAL columns as formulas with no cached result, so
`src/lib/formula.ts` evaluates the `SUM`/arithmetic shapes those reports use — otherwise
the totals would render blank.

Which filters a report accepts comes from the wizard's own form view, so the form follows
Odoo rather than a hard-coded list: `date_from`/`date_to` hide for the reports whose view
hides them, `buyer_name_filter` shows only for *PI File* and *Dying QC*, and
`challan_record_id` only for *Painting/Plating Invoice*.

## Budget follow-up

Three views, switched from the segmented control in the header:

- **Month** — the workbook's `<Month>- Automation` sheet, live. Editable day table,
  the plan block, KPI tiles, and two charts (cumulative production vs target, daily
  production split Zipper / Metal Trims).
- **Fiscal year** — April to March. Monthly achievement against budget, cumulative
  achievement vs budget, the product split, and a month-by-month table. Click any
  month to open its sheet.
- **Year to date** — the same, from April up to the current month.

### The formulas

`src/lib/budget.ts` is the ported sheet. Every derived value names the cell it came from:

| Sheet | Meaning |
|---|---|
| `E5` | Budget = Zipper Plan + MT Plan |
| `E6` | Per-day required = Budget ÷ working days |
| `E8`, `E10` | Zipper / MT per-day requirement |
| `G11` | Run rate required = (Budget − done) ÷ days left |
| `H`, `I`, `J` | Cumulative production, cumulative target, lagging |
| `J5`–`J11` | Done %, average, achieve % zipper/MT, expected month, remaining targets |

Verified against the workbook: all 18 derived cells reproduce `Aug-26- Automation`
exactly (Budget 2,150,000 · run rate 123,009.11 · avg 65,182.375 · done 48.5% ·
expected 1,629,559.375).

Three formulas are generalised rather than copied literally, because the workbook
hard-codes numbers that have to move with the month:

- `G11` divides by a literal `9` → divided by the actual remaining working days.
- `J6` divides by `C28`, a fixed row → divided by the days that actually produced
  (days sitting at 0 because they haven't happened yet don't count, which is what
  `C28` was standing in for).
- `E38`/`F38`/`G38` sum `E13:E36`, which misses the last working-day row → sums all rows.

### Targets: from the workbook

`src/data/plan-calendar.json` is extracted from
`Monthly Budget follow up sheet.xlsx` — for each of the 13 months it plans, the
Zipper Plan, the MT Plan, and the working-day calendar (August 2026 has 25 days
because the holidays are already pruned). Opening a month with no saved document
starts from those targets.

**User inputs**, exactly as in the sheet: Zipper Plan, MT Plan, the working-day dates
(add / remove / edit), and the daily Zipper and MT figures. Everything else is computed.

### Production: from Odoo

Daily production is **not** read from the workbook. `src/lib/production.ts` reads it
out of Odoo:

- Report: **Invoice Summary** (`invs`), run for the month.
- Rows: the **USD** rows only (the report interleaves PCS and USD per date).
- Columns: the six Metal Trims categories the workbook's Dashboard sheet breaks out —
  `SHANK BUTTON`, `RIVET`, `SNAP BUTTON`, `EYELET`, `ALLOY`, `OTHERS` — count as
  Metal Trims; every other data column is Zipper. Columns are matched by header
  **name**, and each Metal Trims name claims the first column carrying it, because
  the report has a second `Others` column near the end that is a zipper catch-all.
- Companies: **company 1 is Zipper and company 3 is Metal Trims**, and each one's
  report contains only its own products — the zipper sheet has no trims categories at
  all and ends with its own catch-all `Others` column; the trims sheet has only the
  six categories. So the report runs once per allowed company
  (`allowed_company_ids` narrowed to one) and the results are added. A generic name
  like `OTHERS` counts as Metal Trims only when a named trims category is on the same
  sheet — otherwise it is the zipper catch-all. Companies with no MRP data (Head
  Office, Non-Management) answer HTTP 500; they are reported and then skipped for the
  rest of a multi-month run.

### Validation

The mapping was derived by comparing the two sources rather than guessed, then checked
against live Odoo for every month the workbook covers:

| Months | Zipper | Metal Trims |
|---|---|---|
| Oct-25 → Jul-26 (10 months) | ±0.0% | ±0.0% |
| Aug-25, Sep-25 | −0.3%, −0.2% | −0.8%, −0.3% |
| Aug-26 | +0.7% | ±0.0% |

The Aug-26 gap is Odoo carrying invoicing the workbook snapshot predates (20-Aug:
5,986 zipper in Odoo, 0 in the sheet); day by day the two agree to within ±5 on every
other day. The two oldest sheets drift slightly, most likely because their Google
Sheet source lagged. Everything else is rounding.

Two buttons drive it:

- **Fetch production from Odoo** (month view) fills the open sheet; press Save to keep it.
- **Fetch all months from Odoo** (fiscal year / YTD) fetches and saves every month of
  the period, which is what fills in the earlier months of the year. It runs the
  months sequentially and reports per-month results, including dates Odoo produced on
  that the working calendar doesn't list.

### Where the months are stored

Supabase when it is configured, JSON files under `data/` otherwise — the file
driver keeps the site working before Supabase is set up and for offline work.

```bash
npm run db:setup
```

One command does the lot. It prompts for anything missing — the service-role key,
and the database password if the table still needs creating — uses each for that
one purpose, and writes only the key to `.env`. The password is never stored.

Creating the table goes over a direct Postgres connection rather than the SQL
editor. Supabase no longer publishes a `db.<ref>.supabase.co` host for new
projects, so it connects through `aws-0-<region>.pooler.supabase.com`. The region
is not in any of the project's public values, so it is discovered by trying each
one: a wrong region answers *tenant/user not found*, the right one gets as far as
authentication. Once known it is pinned in `.env` as `SUPABASE_DB_REGION`
(`ap-northeast-1` here) so later runs connect first try.

`npm run db:create` runs just the DDL step. If a direct connection is ever blocked,
both scripts fall back to printing `db/schema.sql` with a link to the SQL editor.

PostgREST caches the schema, so a freshly created table can 404 for a few seconds —
`db:setup` says so plainly and re-running finishes the job.

One row per month: `month` (primary key), `doc` (jsonb), `updated_at`. The whole
budget document lives in `doc`, so its shape can change without a migration and a
month is always written atomically.

Only the server touches Supabase, with the **service-role** key. The browser talks
to this site's `/api/*` routes, never to Supabase, so the table keeps RLS on with no
policies — the anon key can read nothing.

### Syncing

Opening the page syncs by itself, but only what has gone stale:

| Month | Stale when |
|---|---|
| never synced | always |
| the current month | last sync older than `ODOO_SYNC_FRESH_MINUTES` (default 15) |
| a past month | it was last synced before the month closed (+2 days' grace) |
| anything else | never — a closed month does not change |

So the first visit fills the whole year and later visits refresh just the current
month (~3s). Concurrent visitors share one run rather than each starting their own.
The sync bar shows the state and **last synced**, and **Sync now** re-fetches
everything regardless of freshness.

### Charts

`src/lib/charts.ts` renders inline SVG — no chart library. Colour follows the job:
Zipper and Metal Trims are two identities, so they take categorical slots 1 and 2
(blue / orange, validated: adjacent CVD ΔE 24.7 light and 26.8 dark, both ≥ 3:1 on
their surface); budget against achievement is one subject plus a reference, so budget
is neutral gray and only achievement carries the hue. Every chart has a legend, direct
end labels, hover tooltips, and a table view beside it.

## Layout

```
src/
  data/
    plan-calendar.json  targets + working calendars, extracted from the workbook
  lib/
    odoo.ts        session + JSON-RPC client (companies, context)
    reports.ts     wizard catalogue and the run-a-report flow
    xlsx.ts        workbook -> JSON (merges, header detection)
    formula.ts     evaluates the SUM formulas Odoo leaves uncached
    budget.ts      the budget sheet's model, formulas and fiscal-year helpers
    production.ts  daily Zipper / MT production, read from Odoo
    backfill.ts    fills and saves a run of months
    summary.ts     fiscal-year / year-to-date rollups
    charts.ts      inline-SVG bar and line charts
    storage.ts     flat-file JSON storage
  pages/
    index.astro    report console
    budget.astro   budget follow-up
    api/report.ts     POST - run a report, return parsed JSON
    api/download.ts   GET  - stream the untouched xlsx
    api/lookup.ts     GET  - buyers, challans, work centres
    api/budget.ts     GET/POST - budget documents
    api/production.ts GET  - one month's production from Odoo
    api/backfill.ts   POST - fetch and save a fiscal year / YTD
    api/summary.ts    GET  - fiscal-year and YTD rollups
  scripts/         client-side logic for each page
  styles/app.css   design tokens (light + dark), components, charts
```
