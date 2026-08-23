# TAPS Manufacturing Reports

An Astro site that reads manufacturing reporting straight out of Odoo over JSON-RPC —
no export/import step, no copies of the data:

| Section | What it does |
|---|---|
| **Reports** (`/`) | Runs any of the 36 `MRP Reports` wizard reports and renders the result as a searchable, sortable table with totals and CSV/Excel export. |
| **Budget follow-up** (`/budget`) | `Monthly Budget vs Achievement`, live — as a month sheet, a fiscal year, or year-to-date, with charts. Targets come from the planning workbook; production is read from Odoo. |
| **OA released** (`/oa-released`, under Sales) | Every bulk order marketing has released to production, by product and by company, from the first OA in April 2023. Open a product for its own month-by-month history, the codes and variants it ships under, and who buys it. |
| **Production ABC** (`/analytics`) | Pareto analysis over the packing reports: which items, buyers and customers carry the value. |
| **OT cost** (`/ot-cost`) | The `OT Cost` sheet, live — an OT month, a fiscal year, or year-to-date, split Manufacturing against Other Departments and measured against the OT plan and budget. |
| **180+ stock** (`/ageing`) | The `180 plus days stock` workbook, live — raw material sat over 180 days, its month-by-month history, the usable/unusable split, and every lot in the band. |
| **Lead time** (`/sample-leadtime`) | Sample and bulk lead time from Odoo's PPC reports — by fiscal year, month, business unit, buyer or customer, with the sales-module revision behind every negative figure. |

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

## Deploying to Vercel

The app runs as serverless functions on Vercel, which changes two things:

- **No writable filesystem.** Supabase must be configured — it is the only
  storage that works there. Locally the file fallback still applies.
- **A hard request timeout.** A cold fiscal year needs ~24 Odoo report builds,
  far more than one request allows, so `/api/analytics` fills a few months per
  call (`ANALYTICS_FETCH_PER_REQUEST`, default 4) and the page polls until
  nothing is pending, showing partial figures meanwhile. `/api/ot-cost` does the
  same with `OT_FETCH_PER_REQUEST` (default 6).

The adapter switches automatically: `@astrojs/vercel` when `VERCEL` or
`DEPLOY_TARGET=vercel` is set, `@astrojs/node` otherwise. Build locally with
`DEPLOY_TARGET=vercel npm run build` to check the serverless bundle.

### Deploys are git-triggered

The Vercel project is connected to this GitHub repository, so **pushing to `main`
deploys production**. Nothing else to run:

```bash
git push origin main     # -> builds and promotes to
                         #    https://khurram-sir-s-reports.vercel.app
```

Any other branch, or a pull request, gets its own preview URL on the same
environment variables. `vercel --prod` still works if you ever need to deploy a
working tree that is not committed, and `vercel git connect` re-establishes the
link if it is ever lost.

### First-time setup

1. **Import the repo** at [vercel.com/new](https://vercel.com/new) — framework
   detects as Astro, no build settings to change.
2. **Add the environment variables** (Settings → Environment Variables). These
   are secrets and must be entered by you:

   | Variable | Notes |
   |---|---|
   | `ODOO_URL` | `https://taps.odoo.com` |
   | `ODOO_DB` | `masbha-tex-taps-master-2093561` |
   | `ODOO_USERNAME` | the Odoo login |
   | `ODOO_PASSWORD` | password, or better an API key |
   | `SUPABASE_URL` | `https://<ref>.supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | server-side only — never `PUBLIC_` |
   | `ODOO_TZ` | `Asia/Dhaka` |

   Optional: `PRODUCTION_COMPANIES`, `ODOO_SYNC_FRESH_MINUTES`,
   `ANALYTICS_FETCH_PER_REQUEST`.

3. **Run `npm run db:setup` once locally** so both Supabase tables exist and the
   cached months are uploaded. The deployment reads the same database, so it
   starts warm.

### Anything public?

Nothing in the repo carries a credential — `.env`, `*.har`, `*.xlsx` and `data/`
are all ignored.

Three files under `src/data/` **are** committed, because the app imports them, and each
holds internal planning figures:

| File | What is in it |
|---|---|
| `plan-calendar.json` | monthly production targets and the working-day calendar |
| `ot-budget.json` | the OT plan and OT budget per month, per business unit |
| `ot-sections.json` | section and department names with their value-add tag |

The repository is currently **public**, so those figures are public too. Nothing else
about the business is: actuals are read from Odoo at request time and never committed.

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

## OT cost

The `OT Cost` workbook, rebuilt against Odoo. Two controls in the header: three periods —
an **OT month**, a **fiscal year**, that **year to date** — and a business unit: **whole
plant**, **Zipper**, or **Metal Trims**.

An OT month is not a calendar month — `2026-08` runs **26 Jul to 25 Aug**, the payroll
cycle the sheets are cut on.

The unit filter is applied server-side, before anything is derived, so a filtered view is
a real report about that unit rather than a subtotal of the plant's: its Pareto, its
spikes, its cost per OT hour. Zipper and Metal Trims add back to the whole plant exactly.
Filtering also collapses the per-unit columns, so the tables never print a column of
dashes for the unit that is not on screen.

### Where the numbers come from

The `attendance.pdf.report` wizard's `ot_analysis` report, run the same way the Odoo web
client runs it (`web_save` → `action_generate_xlsx_report` → `GET /report/xlsx/...`). Its
*SectionWise OT* sheet carries two rows per section — OT Hours and OT Cost — with one
column per day.

One plant is three reports, because that is how the source workbook fetches it:

| Report | Filter | `allowed_company_ids` | Counts as |
|---|---|---|---|
| Zipper | company 1 | `[1]` | Zipper |
| C-Zipper Worker | employee category 42 | `[4, 1]` | Zipper |
| Metal Trims | company 3 | `[3]` | Metal Trims |

The report's `Total` column is a formula Odoo leaves uncached, so it is ignored and the
day columns are summed instead. Date headers come back year-less (`26 Jul Sun`), so the
year is inferred from the requested window — which is what makes the January month,
straddling two years, come out right.

### What a day was spent on

Every day in the day sheet that ran overtime opens: click the row (or focus it and press
Enter) and the sections behind that day's total unfold underneath it — section, unit,
department, tag, whether it counts as Manufacturing or Other, hours, cost, and share of
that day. It nests in the row rather than opening a dialog so the days around it stay on
screen to compare against.

The breakdown is fetched one day at a time (`?day=YYYY-MM-DD`). Carrying every day's
sections in the main payload made them 93% of it — 850KB of a 914KB year-to-date response
— for a drill-down that is opened one day at a time. Each one is cached by day and by
query, since the same date reads differently under a unit filter.

Section costs sum to the day's total exactly, and their Manufacturing subset to the day's
Manufacturing figure — the breakdown is the same arithmetic re-grouped, not a second pass.

### The exchange rate

Odoo reports overtime in taka. The workbook divides by a flat **120**, which drifts as
the taka moves, so `src/lib/fxrate.ts` looks today's rate up instead and the page prints
it under the title — *Today's rate: 1 USD = ৳122.21 · 21 Aug 2026*. The page shows the
rate and its date; which service supplied it stays in the code.

Two free sources, no API key between them:

1. `open.er-api.com/v6/latest/USD`
2. `cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json`

If both are unreachable the **last good rate** is reused and the line says so; only if
there has never been one does it fall back to `OT_USD_RATE` and say the figure is not a
live quote. Rates are cached for `FX_FRESH_HOURS` (default 6).

What is cached from Odoo stays in **taka**, and conversion happens on the way out — so a
change of rate costs nothing and never triggers a refetch.

Two consequences worth knowing, both stated in the page's own footnote:

- Every month is converted at **today's** rate, so dollar figures for past months move
  with the taka. The taka figures behind them do not.
- Dollar figures therefore no longer match the workbook's flat-120 arithmetic. Set
  `FX_LIVE=0` to pin the rate to `OT_USD_RATE` and reproduce the workbook exactly.

### Manufacturing vs Other Departments

Every section is tagged `M-VA`, `M-NVA` or `NM-NVA` on the monitoring sheets, and the
roll-up then moves five sections out of Manufacturing regardless of their tag:

```
Manufacturing = M-VA + M-NVA − { ETP, FG Store, RM Store, MIS, Design & Marketing. }
Other         = NM-NVA        + { ETP, FG Store, RM Store, MIS, Design & Marketing. }
```

That is exactly what rows 110/111 (Zipper) and 89/90 (Metal Trims) of each
`<BU> <Month>_new` sheet do — stores, effluent treatment and MIS serve the plant rather
than run it. `src/data/ot-sections.json` holds the 40 Zipper and 25 Metal Trims sections
with their tag and department, extracted from those sheets. Every section Odoo has
returned since April 2023 is in the map; anything genuinely new counts as manufacturing
and is named in the page's footnote rather than passing silently.

### Plan and budget

`src/data/ot-budget.json` carries two targets per OT month, and they are different things:

- **Plan** — the operational cap from the `OT Cost` workbook's own month sheets
  ($20,000 a month through Jun-26, $18,000 + $2,000 from Jul-26). This is what the
  sheet's *OT Consumed %* is measured against, so it is the page's headline too.
- **Budget** — the annual model from `YTD 2025-26 OT BGT Vs Actaul`, which varies by
  month and only covers Apr-26 → Mar-27.

Months with no figure are left empty and named in the footnote — Jan-26 has no plan
because the workbook has no January sheet.

### Validation

Rebuilt from Odoo and converted at the workbook's flat 120 (`FX_LIVE=0`), the Aug-26 OT
month reproduces `OT Cost (1).xlsx`, sheet `26-Jul to 25-Aug-2026`, **to the cent**:

| | Zipper | Metal Trims |
|---|---|---|
| Manufacturing | $17,754.99 | $2,517.87 |
| Other departments | $1,349.19 | $131.40 |

Total plant $21,753.45, Manufacturing 93.19% — and it matches day by day, not just on the
total. Jul-26 ties out the same way: Manufacturing $16,541.11, Other $1,402.88, plant
$17,943.99. At the live rate the same month reads $21,360.85, which is the same taka
divided by ৳122.21 rather than ৳120.

Earlier months do **not** match the workbook, and the reason is in the workbook rather
than here:

| OT month | Workbook Zipper mfg | Here | Why |
|---|---|---|---|
| Jul-26, Aug-26 | — | exact | The sheet pulls actual per-section OT Cost and applies the exclusions. |
| Jun-26 | $16,930.23 | $16,869.53 | The `26-May to 25-Jun` sheet holds hard-coded values, not a live pull — a frozen snapshot, 0.4% adrift. |
| Apr-26, May-26 | $21,226.34, $18,735.56 | $22,751.37, $23,249.99 | Those month sheets compute cost as **OT hours × one blended rate** (`=G49*G1`) and apply no exclusions at all. |

So the workbook changed method mid-year. This page applies the current method — actual
per-section cost, C-Zipper Worker included, the same Manufacturing / Other rule — to
every month, which is what makes a fiscal year comparable end to end.

### The reading

The rail carries the judgment: consumption against plan, the Manufacturing / Other split,
each business unit against its own plan, the run rate and what it projects to, the days
that broke the pattern, and how few sections carry most of the bill.

Percentages compare like with like. A fiscal year can hold months with no plan on record,
and dividing a full year's spend by a seven-month plan reads as a 47% overrun that never
happened — so the ratio uses spend over exactly the months that carry a target, the
headline figure stays the real total, and a note says how many months that was.

Spikes are days at or above **twice the median of the days that actually ran overtime** —
a mean would be dragged up by the very days being looked for. Each one names the sections
it came from. The projection carries today's spend per active day across the days left,
scaled by how often a day has run overtime so far, rather than assuming every remaining
calendar day is worked.

### Cost and caching

A report takes Odoo ~8s to build and a month is three of them, so a cold fiscal year is
36 builds. Each job-month's parsed figures are cached — Supabase `app_cache` when it is
configured, `data/otcost/` otherwise — and a closed OT month is fetched exactly once. The
month in progress ages out on `ODOO_SYNC_FRESH_MINUTES`. Each request fills at most
`OT_FETCH_PER_REQUEST` (default 6) and the page polls until nothing is pending, which is
what keeps it inside a serverless timeout.

Odoo answers with real OT data from **April 2023**; `OT_EARLIEST_MONTH` bounds what the
page offers so it never spends a report build on a window Odoo cannot fill.

## 180+ days stock

The `180 plus days stock` workbook, rebuilt against Odoo. Raw material that has sat for
more than 180 days: what the band opened at, what aged into it, what was consumed out of
it, and what is left — for every month Odoo has snapshotted, not just this one.

Two controls in the header: a business unit (**both units**, **Zipper**, **Metal Trims**)
and a **snapshot month**. Both are re-projections of one payload, so switching either is
instant.

### Where the numbers come from

Odoo stores the ageing snapshots as real models, so nothing is exported or pasted:

| Model | Carries |
|---|---|
| `stock.ageing.movement` | one row per lot per monthly snapshot; `slot_5` + `slot_6` are the 181-365 and 365+ that make up 180+ |
| `rm.ageing.summary.report` | the same, aggregated to company x item category x classification, with all seven age buckets |
| `rm.ageing.monthly.report` | opening -> new add -> issue -> closing through the 180+ band, per item category per month |
| `stock.lot.unusable` | the flag that splits 180+ into what can still be consumed and what is only waiting to be written off |
| `consolidated.inventory.report` | total inventory by month and fiscal year — the denominator behind "share of stock" |
| `stock.move.line` | the done issues behind the month-to-date consumption figure, valued at the lot's own price |

The bucket history is read straight off the stored summary rows rather than through
`retrive_ageing_by_item_cat_data`, which answers for one bucket and one fiscal year per
call and would need ~50 round trips to cover the same ground.

Odoo's own dashboard is the origin of these endpoints; `180 days.har` is the capture they
were read from.

### Two models, one band

`stock.ageing.movement` and `rm.ageing.summary.report` describe the same 180+ band and
agree to the dollar for every closed month. They part company on the month in progress:
the movement dashboard rebuilds its current-month row on a slower cycle, while the summary
report carries a snapshot dated today. On 22 Aug the dashboard still had Zipper's August
closing $9,801 behind the live figure.

So the summary snapshot wins for the last month, and `newAdd` is re-derived to keep
`opening + newAdd + issue = closing`. That residual is exactly what the workbook calls
"TOTAL Value ADD in 180+". Closed months are left alone — a bucket total that disagreed
with a settled month would be a real discrepancy worth seeing, not one to paper over.

Usable is likewise derived as `closing − unusable` rather than summed from lots, so the
two halves add to the closing figure even when the lot-level snapshot is a day behind.
Unusable is the half that holds still: condemned lots are neither consumed nor replaced.

### The summary block

The three panels under the KPI row are the workbook's `Dashboard` sheet, line for line
and in its order — Zipper, Metal, and the two added together — because that is the block
people read every morning and know the position of each figure in. What changes is the
provenance: every figure is read from Odoo at load rather than pasted in overnight.

`TOTAL Value ADD in 180+` is derived the way the sheet derives it: whatever the closing
figure is that the opening and the month's consumption do not explain.

### What matches the workbook, and what does not

All eighteen rows of the summary block — three panels, six rows each — reconcile to the
workbook exactly, as do eleven of the twelve age-bucket figures. The twelfth is Zipper's
0-30 bucket, which runs ahead of the workbook by whatever was received since the workbook
was last exported; that is the bucket new receipts land in.

Two things do not tie, and are worth knowing about:

- **Historic bucket totals** can sit $84-$2,100 away from the same month's closing figure
  (Zipper, 23 of 29 months; worst case 0.5%). That is a disagreement between two Odoo
  models about a settled month, not something this page introduces. The current month is
  exact.
- **Per-day consumption** is a derivation, not a reproduction. The workbook's own row is
  usually blank — its formula looks up *yesterday* and the daily table normally ends the
  day before — so there is nothing to match. This page instead reads the done move lines
  against lots in the band and values them at the lot's price, then names the day it is
  reporting. Its month total comes to about 11% above the workbook's equivalent, because
  the workbook matches by invoice name where this matches by lot, and values at the issue
  register's price rather than the lot's. Treat it as an indicator of daily pace, not as a
  figure to reconcile.

Move lines are bucketed by **Asia/Dhaka** date, not the UTC date Odoo stores. An evening
shift is exactly when overtime consumption happens, and a UTC day would push it onto the
day before.

### Usable against dead money

The split that decides what anyone does about the number. Usable 180+ is a planning
failure that can still be consumed; unusable 180+ is money already gone.

`unusable` is a boolean on `stock.lot`, and Odoo accepts it as a dotted domain on the
ageing snapshot — so two grouped reads give the split for all thirty months rather than
one lot-level fetch per month. Usable + unusable reconciles to the movement dashboard's
closing figure to the cent, in every month.

The flag is **not historised**: it says what the lot is considered today, applied to
whichever snapshot it appears in. A lot condemned last week therefore reads as unusable in
older months too. That is still the useful question — how much of what was sitting there
is value we now know is gone — but it is not a record of what anyone believed at the time,
and the card says so on any month but the current one.

### Charts

`Aged in against consumed` diverges from a shared zero line on one symmetric scale, so a
bar above and a bar below of equal length mean equal money, and the months where the band
grew are the ones with the longer up-bar.

`How the month moved` is a waterfall. A month typically moves 1-3% of a band worth half a
million, which a zero-based axis would flatten to nothing, so the axis starts just below
the data — and prints a line saying where it starts, because a truncated axis that does
not announce itself exaggerates every change drawn on it.

`Age profile of all stock` runs one hue light-to-dark across the seven buckets, since age
is an ordered band rather than seven unrelated categories. The two past 180 days carry the
alert hue: they are the only ones the page is asking anyone to act on.

### Cost and caching

Eight reads and ~300KB of JSON, over snapshots that only change when Odoo's monthly cron
runs. The built report is held in process for `AGEING_CACHE_MS` (default 5 minutes);
**Refresh** bypasses it. Odoo's history starts at **March 2024**.

Lot detail is the one thing kept out of that payload — ~800 rows a month over thirty
months is megabytes, and only the month on screen is ever wanted. `?lots=YYYY-MM` fetches
one month (~300KB, under half a second) and both the server and the page hold what they
have fetched, because a closed snapshot never changes again.

## Lead time

Sample and bulk lead time, from Odoo's PPC wizard. Four controls: **dataset** (sample or
bulk), **business unit**, **month**, and **fiscal year** — FY 25-26 and FY 26-27.

### Where the numbers come from

The same `ppc.report` wizard the PPC bulk BTM export uses, on three of its report types:

| Report type | Odoo's name | What it gives |
|---|---|---|
| `sbtm_detail` | SA Based SAMPLE BTM DATA Detail | one row per sample line, with its completion date and a holiday sheet |
| `bbtm` | OA Based Bulk BTM DATA | one row per bulk order line, with a lead time Odoo computes itself |
| `samplehistory` | Sample History | the OA numbers a sample turned into, which is what makes OA search work |

`skpi` (Sample KPI) is not used: Odoo returns HTTP 500 for it.

The sample report's lead time is an Excel **formula**, not a value, so nothing downstream
can read it without evaluating the workbook. This applies the report's own formula:

    completion blank -> today      - SA date - (holidays in between)
    otherwise        -> completion - SA date - (holidays in between)

Holidays come from the report's own second sheet, so the arithmetic stays whatever Odoo
says it is rather than a calendar of our own.

### Two things that do not match between the datasets

- **Sample deducts holidays; bulk does not.** Odoo's bulk report ships a plain calendar-day
  figure and no holiday sheet beside it. Each is shown on its own basis and the header says
  which — a 4-day bulk lead over a window containing one holiday is a 3-day sample lead.
- **The wizard reports on one company at a time.** Passing both company ids returns the
  first, not the union, so "Both units" is two builds merged here rather than one call.

### Why a lead time goes negative

Because the order was revised and its date moved *after* the work was already finished. So
every row is joined to the sales module — `sale.order`'s `is_revised`, `revised_num`,
`cause_of_revision` and `last_revised_date`, plus the `sales.revision` chain — and rows
that carry one expand to show it.

The chain's first entry holds the date the order had before any revision, which is the date
the work actually ran to, so the row also shows a corrected lead time. SA030852 reports
−30 days; measured from its original date it is **3 days**, and the cause reads "ADD COLOR
NAME".

FY 25-26 has 126 negative samples. About half carry a revision that explains them; the rest
say plainly that Odoo has no revision on record.

### A gap in the source worth knowing about

**Metal Trims samples carry no completion date at all** — every row comes back "Pending",
535 of them in FY 25-26. Their lead time is therefore measured against today, and the mean
is the age of the backlog rather than how long a sample takes. The page prints a warning
over any slice that is ≥90% open, because 276 days beside Zipper's 3.6 would otherwise read
as a catastrophe rather than a gap.

### Cost and paging

A fiscal year is around 22,000 sample rows and one ~20s Odoo build per company per dataset,
so each combination is built once and held — twelve hours for a closed year, fifteen
minutes for the year in progress. The two companies build in parallel, so "Both units"
costs the slower one rather than the sum.

A year of rows is several megabytes, so the server filters, aggregates and pages: the
figures are computed over everything the filters match, and only 200 rows travel. Search
covers customer, buyer, style, buying house, and SA or OA number — numbers match on their
digits, so "42035", "SA042035" and "sa 42035" all find the same sample.

## OA released

`/oa-released`, reached from **Sales** in the top bar. The production report says what the
plant made; this says what it has been told to make — the order book that leads it by weeks.

An **OA** (Order Acknowledgement) is a bulk sales order, named `OA` plus its number.
`released_status = released` is the moment marketing hands it to production. So the report
is every `sale.order` matching:

```
name            =like  OA%
released_status =      released
```

37,648 orders and 332,594 lines at the time of writing, $69.2M, back to `OA00401` on
6 April 2023. Zipper carries 82.8% of it, Metal Trims 17.2%.

### Which month an OA belongs to

The **order's** `date_order`, not the line's creation date. Summing `price_subtotal` over the
lines whose order falls in a month reproduces the order-level `amount_untaxed` exactly —
July 2026 Zipper is $1,562,705 read either way, and 826 OAs both ways. Grouping by the line's
own `create_date` instead drifts by a couple of percent, because a line added by a revision
is created after the order it belongs to.

`sale.order.line` cannot be grouped by a field on its order, so the month is a domain and the
report walks month by month.

### What counts as a "product"

Odoo has no level between `COIL 3 ZIPPER CLOSE END` and the 21,623 variants that spell out
every slider, shade and length. Neither end is the report:

- **The variant** is too fine. Grouping all of history by `product_id` takes Odoo a minute and
  returns 21,623 rows, most of them one order.
- **`product_code`** on the line looks right — 1,151 codes, and it groups in under a second —
  but it was only filled in from **September 2023**. April to August 2023 has none at all, so
  it cannot carry the early months.

What does hold for all of it is the variant's own name. Everything before the bracketed spec
is the product family, so `product_family()` takes it:

```
COIL 3 ZIPPER CLOSE END (DTM, Slider C#3 DTM REVERSE TZP-794, ...)  ->  COIL 3 ZIPPER CLOSE END
HIDDEN SNAP 100234813                                              ->  HIDDEN SNAP
```

That is 73 products in a recent month, 171 over the whole run, and it covers April 2023.
The codes and the variants are not lost — they open underneath the row.

Note that the daily production report labels the same things `M#4 CE`, `C#3 CE` and so on.
Those come from Odoo's own `dpr` sheet, which names products its own way; the internal code
in a product's breakdown (`M4ZDCE`, `C3ZCE`) is the bridge between the two.

### Opening a product

The month-by-month history is free — the page already holds every month, so the chart draws
with no request. Only what the roll-up threw away is fetched, in four sub-second grouped
reads: the internal codes, the top customers, the top variants, and the last OAs to carry it.
Each is scoped by `product_id.name =like '<family>%'`.

The variant list strips the spec every listed variant shares and prints it once above them,
because within one product most of the spec is identical and eight variants printed in full
are eight identical paragraphs. What is left is the token that actually differs — usually the
size.

### What the page leads with

The order book runs weeks ahead of the floor, so the rail opens on the **month in progress**:
what has been released so far, the pace those days project across the whole month, the trailing
twelve-month average, and the same month a year ago. A part-month total on its own reads as a
collapse every time you look at it on the 3rd, so the pace is the figure that gets judged and
the average is the mark it is judged against — both on one scale, so the gap between them is
the reading.

The rail used to carry fourteen months of bars underneath that. It was the trend chart again in
less room, so it is gone; the chart keeps the whole run, ruled at each April with the fiscal
year named in the band it opens, and the average drawn across it.

**Movement** is the only block that says something changed:

- **New** — first released inside the window. Over all of history that is every product that
  did not exist in April 2023, which is most of the catalogue and says nothing, so the
  whole-history case falls back to a rolling twelve months and says which it used.
- **Quiet** — nothing released for three months or more, counting only products inside the 95%
  cut. A class-C product going quiet is the tail behaving like a tail.

### Reading the sheet without opening a row

Every row already held its own month-by-month series, so it draws one: a **Trend** sparkline
scaled to its own maximum, shape only. The cumulative column earns its place by banding the
sheet **A / B / C** at the 80 and 95% cuts — the same language Production ABC uses, so a product
that is class A there and class C here says something rather than just looking inconsistent. A
rule where the band changes does the work a heading row would.

### Filtering to one month

The month picker narrows whatever period is selected rather than replacing it, so picking
FY 26-27 offers that year's months and nothing else. Two things change when the sheet is one
month:

- **The charts stay wider than the sheet.** A chart of one bar says nothing, so the trend chart
  and the opened product's chart both show the year running up to that month, and say so.
- **"Months" goes and the sparkline becomes a "Run-up".** The column could only ever say 1, and
  a series of one point draws nothing.

The drill-down is scoped to the same months the row is counting (`from` / `to` on the API).
Without that the breakdowns would be the product's whole life shown underneath a row that is one
month of it, and every share would read over 100%.

### Cost and caching

Grouping one month by product and company takes Odoo about six seconds. Each month's
**aggregate** is cached under `oarel-<month>`, so a closed month is fetched exactly once and
the month in progress ages out after fifteen minutes. A cold cache fills four months per
request and the page asks again until nothing is pending — 41 months takes about two minutes,
the same as Production ABC. Raw lines are never stored.

## Layout

```
src/
  data/
    plan-calendar.json  targets + working calendars, extracted from the workbook
    ot-sections.json    OT section -> M-VA / M-NVA / NM-NVA, extracted from the workbook
    ot-budget.json      OT plan and budget per OT month
  lib/
    odoo.ts        session + JSON-RPC client (companies, context)
    reports.ts     wizard catalogue and the run-a-report flow
    xlsx.ts        workbook -> JSON (merges, header detection)
    formula.ts     evaluates the SUM formulas Odoo leaves uncached
    budget.ts      the budget sheet's model, formulas and fiscal-year helpers
    production.ts  daily Zipper / MT production, read from Odoo
    backfill.ts    fills and saves a run of months
    summary.ts     fiscal-year / year-to-date rollups
    fxrate.ts      today's USD/BDT rate, looked up and cached
    otcost.ts      OT analysis from Odoo: wizard, parse, per-month cache
    otanalysis.ts  the OT Cost sheet's arithmetic and the reading that goes with it
    ageing.ts      180+ days stock: ageing snapshots, lots, the unusable split
    sampletime.ts  sample and bulk lead time, with the sales-module revisions
    oarelease.ts   OA released: per-month product/company aggregates from sale.order
    cache.ts       derived aggregates, in Supabase or on disk
    charts.ts      inline-SVG bar, line and row-sized sparkline charts
    storage.ts     flat-file JSON storage
  pages/
    index.astro    report console
    budget.astro   budget follow-up
    ot-cost.astro  OT cost
    ageing.astro   180+ days stock
    sample-leadtime.astro  sample and bulk lead time
    oa-released.astro      OA released by product and company
    api/report.ts     POST - run a report, return parsed JSON
    api/download.ts   GET  - stream the untouched xlsx
    api/lookup.ts     GET  - buyers, challans, work centres
    api/budget.ts     GET/POST - budget documents
    api/production.ts GET  - one month's production from Odoo
    api/backfill.ts   POST - fetch and save a fiscal year / YTD
    api/summary.ts    GET  - fiscal-year and YTD rollups
    api/ot-cost.ts    GET  - OT cost for a month, a fiscal year, or YTD
    api/ageing.ts     GET  - the 180+ report, or ?lots=YYYY-MM for one month's lots
    api/sample-leadtime.ts GET - lead time, filtered/aggregated/paged server-side
    api/oa-released.ts     GET - every month of OA release, or ?product=&from=&to= for one
  scripts/         client-side logic for each page
  styles/app.css   design tokens (light + dark), components, charts
```
