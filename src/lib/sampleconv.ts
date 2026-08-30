/**
 * Sample to bulk conversion — how many samples turn into orders.
 *
 * A sample (`sales_type = 'sample'`, named `SA…`) is developed for a buyer. If
 * the buyer likes it, a bulk order follows (`sales_type = 'oa'`, named `OA…`).
 * Nothing in Odoo marks a sample "converted", so the link has to be read off
 * the bulk line, where marketing writes the sample it came from:
 *
 *   Zipper       sale.order.line.shade_ref   "SA Ref"     e.g. "SA044490"
 *   Metal Trims  sale.order.line.finish_ref  "Finish Ref" e.g. "04-REF SA 16231"
 *
 * The two companies keep it in different fields, and Metal Trims keeps it as
 * free text with the reference buried in a sentence, so the SA number is pulled
 * out by pattern rather than read whole. Checked against the order book: every
 * Metal Trims reference resolves to a real sample, and 97.8% of Zipper's do —
 * the rest are a legacy `SA-1610/23` numbering that predates the current one.
 *
 * That is not the only convention in use. Some buyers never write the SA number
 * at all and identify the development by its PLM number instead, carried in the
 * shade on both the sample and the bulk order:
 *
 *   sample  "PK23604 – Baby Dreams   (PLM # 1362318)"
 *   bulk    "PK23604 | BABY DREAMS | PLM#1362318"
 *
 * So a PLM number shared by a sample and a later bulk order, for the same
 * buyer, is read as the same link. It matters: Carter's writes the SA number on
 * 0% of its bulk lines and a PLM number on 92% of its samples, so on the SA
 * reference alone it read as 417 samples developed and nothing sold, which is
 * simply false. Across Zipper only 3.4% of samples carry a PLM number, so this
 * changes almost nothing anywhere else — which is the point: it is one buyer's
 * convention, matched on its own terms.
 *
 * Shades themselves are deliberately NOT matched. Odoo's own Sample History
 * report matches a sample to a bulk order when the sample's shade text appears
 * inside the bulk order's, and that is too loose to build on: shades like
 * "BLACK" appear in nearly every order a buyer places, and the match rate
 * collapses from 12.5% to 2.7% the moment a minimum length is imposed. A link
 * has to be an identifier, not a colour name.
 *
 * Two structural links exist as well (`sale.order.sample_ref`, and
 * `sale.order.line.ref_line_id` from a PI line back to the sample line), but
 * both are filled in on roughly half of Metal Trims and under 1% of Zipper, so
 * they cannot carry the report on their own.
 *
 * WHAT THE FIGURES CANNOT SAY
 * ---------------------------
 * Both limits below are measured from the data rather than assumed, and both
 * are reported, because a conversion rate that quietly omits either is wrong
 * rather than approximate:
 *
 *   - The reference is only recorded from the day each company started
 *     recording it (Metal Trims mid-2023, Zipper August 2025). Samples raised
 *     before then look unconverted whether they converted or not.
 *   - A sample raised last month has not had time to convert. Nine conversions
 *     in ten land within `maturityDays` of the sample, so a quarter closer to
 *     today than that is still open, and is left out of the headline rate.
 */
import { cached, odooStamp } from './cache';
import { buildContext, callKw, getSession } from './odoo';

export type CompanyKey = 'zipper' | 'mt';

export interface ConversionCompany {
  key: CompanyKey;
  id: number;
  name: string;
  /** The sale.order.line field this company writes the sample reference into. */
  refField: 'shade_ref' | 'finish_ref';
}

export const COMPANIES: ConversionCompany[] = [
  { key: 'zipper', id: 1, name: 'Zipper', refField: 'shade_ref' },
  { key: 'mt', id: 3, name: 'Metal Trims', refField: 'finish_ref' },
];

export const companyOf = (key: CompanyKey) => COMPANIES.find((c) => c.key === key)!;

/* --------------------------------------------------------------- SA numbers */

/**
 * The digits of a sample number, which is the only part both sides agree on.
 *
 * An order is `SA044490` or `SA16360`; a reference to it may be written
 * `SA-14092`, `SA 16231` or `SA-02059`. Leading zeros are dropped so the
 * padding the two companies use differently cannot separate a sample from the
 * order that names it.
 */
export function saKey(name: string | null | undefined): string | null {
  const m = /^SA[\s\-_]*0*(\d+)/i.exec(String(name ?? '').trim());
  return m ? m[1] : null;
}

/**
 * Every sample referenced inside a free-text field.
 *
 * Anchored on `SA` so the `OA506738` that often sits beside it in the same
 * sentence is not mistaken for a sample. A line may name more than one.
 */
export function saRefsIn(text: string | null | undefined): string[] {
  if (!text) return [];
  return [...new Set([...String(text).matchAll(/\bSA[\s\-_]*0*(\d+)/gi)].map((m) => m[1]))];
}

/**
 * Every PLM number in a piece of text.
 *
 * The buyers who use them write them a dozen ways — `PLM #1315630`,
 * `PLM # 1384302`, `PLM: 1264505`, `PLM NO. 1315947`, `PLM -1346624`,
 * `NEW PLM NO : 1386524` — so the word anchors the match and the separators are
 * skipped. Six to eight digits: short enough to allow the older numbering,
 * long enough that a style or a size cannot be mistaken for one.
 */
export function plmsIn(text: string | null | undefined): string[] {
  if (!text) return [];
  return [
    ...new Set(
      [...String(text).matchAll(/PLM\s*(?:NO\.?|NUMBER|#)?\s*[:#\-.]*\s*(\d{6,8})/gi)].map(
        (m) => m[1],
      ),
    ),
  ];
}

/* ------------------------------------------------------------ fiscal years */

/** A fiscal year runs 1 April to 31 March; FY 2025 is "FY 25-26". */
export function fyWindow(fy: number): { from: string; to: string } {
  return { from: `${fy}-04-01`, to: `${fy + 1}-03-31` };
}

export const fyLabel = (fy: number) => `FY ${String(fy).slice(2)}-${String(fy + 1).slice(2)}`;

export function fyOf(iso: string): number {
  const [y, m] = iso.split('-').map(Number);
  return m >= 4 ? y : y - 1;
}

export const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * The years worth offering.
 *
 * Metal Trims has recorded the reference since mid-2023, so FY 23-24 onwards
 * has something to say. Zipper only joins in FY 25-26; its earlier years are
 * shown as unrecorded rather than hidden, because "we did not write it down"
 * and "no sample converted" must not look the same.
 */
export function availableFys(): number[] {
  const current = fyOf(todayIso());
  const out: number[] = [];
  for (let y = 2023; y <= current; y++) out.push(y);
  return out;
}

/* ----------------------------------------------------------------- shapes */

/** A bulk order won off a sample, as the drill-down shows it. */
export interface ConvertedOrder {
  /** OA number, as Odoo names it. */
  no: string;
  /** When the bulk order was raised. */
  date: string | null;
  /** Value of the lines on it that name this sample, ex tax. */
  value: number;
  qty: number;
  /** What was ordered: the item, and the shade it was ordered in. */
  items: string[];
  shades: string[];
  /** PLM numbers on those lines — the buyers who use them identify by these. */
  plms: string[];
  /**
   * Which link tied this order to the sample — the SA number written on the
   * bulk line, or a PLM number the two share. Shown in the drill-down, because
   * a conversion the reader cannot check is one they have to take on trust.
   */
  via: 'ref' | 'plm';
}

export interface SampleRow {
  company: CompanyKey;
  /** SA number as Odoo names it. */
  no: string;
  /** The date the sample order was raised. */
  date: string;
  customer: string;
  buyer: string;
  /** Who owns the sample, and which team they sit in. */
  salesperson: string;
  team: string;
  marketer: string;
  region: string;
  /** The sample's own PLM numbers, where the buyer works that way. */
  plms: string[];
  /** The sample order's own value, ex tax. */
  sampleValue: number;
  /** The bulk orders that name this sample — the proof of the conversion. */
  oas: ConvertedOrder[];
  /** Bulk value won, ex tax, attributed to this sample. */
  bulkValue: number;
  bulkQty: number;
  /** The first bulk order that named it, and how long that took. */
  firstBulk: string | null;
  lagDays: number | null;
  converted: boolean;
  /**
   * Has this sample had long enough to convert? A sample raised last week has
   * not, and counting it as a miss understates every recent quarter.
   */
  mature: boolean;
}

export interface QuarterRollup {
  /** "2025-Q1" — the fiscal quarter, not the calendar one. */
  key: string;
  /** "Q1" */
  label: string;
  /** "Apr - Jun 2025" */
  span: string;
  fy: number;
  quarter: number;
  raised: number;
  converted: number;
  rate: number;
  bulkValue: number;
  sampleValue: number;
  medianLag: number | null;
  /** False while the quarter is too recent for its samples to have converted. */
  mature: boolean;
  /** False before the company started recording the reference at all. */
  recorded: boolean;
}

/** One row of a "by buyer" / "by team" / "by salesperson" breakdown. */
export interface BreakdownRow {
  name: string;
  raised: number;
  converted: number;
  rate: number;
  bulkValue: number;
  medianLag: number | null;
}

/** The dimensions the page can group samples by. */
export const DIMENSIONS = [
  { key: 'buyer', label: 'Buyer' },
  { key: 'team', label: 'Sales team' },
  { key: 'salesperson', label: 'Salesperson' },
  { key: 'marketer', label: 'Marketing person' },
  { key: 'region', label: 'Region' },
] as const;

export type Dimension = (typeof DIMENSIONS)[number]['key'];

export interface ConversionTotals {
  raised: number;
  converted: number;
  rate: number;
  bulkValue: number;
  sampleValue: number;
  medianLag: number | null;
  /** Samples too recent to judge, and the rate over only the ones old enough. */
  pending: number;
  matureRaised: number;
  matureConverted: number;
  matureRate: number;
}

export interface CompanySlice {
  company: CompanyKey;
  fy: number;
  from: string;
  to: string;
  rows: SampleRow[];
  /**
   * The first day this company ever wrote a sample reference on a bulk order,
   * over all history rather than over this year. Everything before it is
   * unrecorded rather than unconverted, and a year that starts after it is
   * fully recorded — which the year's own first reference cannot tell you,
   * since that only says when this year's first bulk order happened to land.
   */
  adoptedAt: string | null;
  /** Days within which 90% of conversions land — how long a quarter needs. */
  maturityDays: number;
  builtAt: string;
}

export interface ConversionData {
  fy: number;
  label: string;
  from: string;
  to: string;
  companies: CompanyKey[];
  rows: SampleRow[];
  adoptedAt: Partial<Record<CompanyKey, string | null>>;
  maturityDays: Partial<Record<CompanyKey, number>>;
  builtAt: string;
  stale: boolean;
  staleError: string | null;
}

/* ------------------------------------------------------------------ fetch */

/** Reads a whole result set, a page at a time — a year runs to tens of thousands. */
async function readAll<T = any>(
  model: string,
  domain: unknown[],
  fields: string[],
  companyId: number,
): Promise<T[]> {
  const session = await getSession();
  const context = buildContext(session, {}, companyId);
  const PAGE = 5000;
  const out: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const rows = await callKw<T[]>(model, 'search_read', {
      args: [domain, fields],
      kwargs: { limit: PAGE, offset, order: 'id', context },
    });
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

const dateOnly = (v: unknown) => String(v ?? '').slice(0, 10);
const nameOf = (v: unknown) => (Array.isArray(v) ? String(v[1] ?? '') : '');
const idOf = (v: unknown) => (Array.isArray(v) ? Number(v[0]) : 0);

/** Shade and item text runs to several lines; the drill-down wants one. */
const oneLine = (v: unknown, max = 90) => {
  const text = String(v ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** Keeps a short, stable list — the wire carries one of these per order. */
function addTo(set: Set<string>, value: string, cap = 4) {
  if (value && set.size < cap) set.add(value);
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** The lag nine conversions in ten land inside. */
function p90(values: number[]): number {
  if (!values.length) return 90;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
}

/**
 * One company's fiscal year.
 *
 * The bulk side deliberately runs from the start of the year to *today* rather
 * than to the end of the year: a sample raised in March converts in June, and
 * a window that stopped at the year end would call it a miss.
 */
async function buildSlice(fy: number, key: CompanyKey): Promise<CompanySlice> {
  const co = companyOf(key);
  const { from, to } = fyWindow(fy);
  const bulkTo = to > todayIso() ? todayIso() : to;

  const session0 = await getSession();
  const adoption = await callKw<any[]>('sale.order', 'search_read', {
    args: [
      [
        ['sales_type', '=', 'oa'],
        ['state', '=', 'sale'],
        ['company_id', '=', co.id],
        [`order_line.${co.refField}`, '!=', false],
      ],
      ['date_order'],
    ],
    kwargs: {
      limit: 1,
      order: 'date_order asc',
      context: buildContext(session0, {}, co.id),
    },
  });
  const adoptedAt = adoption.length ? dateOnly(adoption[0].date_order) : null;

  // Only the shade fields are scanned for a PLM number, so the line queries ask
  // Odoo for the lines that can possibly match rather than for every line of
  // the year — a Zipper year is 132,000 bulk lines, of which about a tenth
  // carry either kind of reference.
  const plmClause = ['|', ['shade', 'ilike', 'PLM'], ['shade_name', 'ilike', 'PLM']];

  const [samples, samplePlmLines, bulkLines] = await Promise.all([
    readAll(
      'sale.order',
      [
        ['sales_type', '=', 'sample'],
        ['state', '=', 'sale'],
        ['company_id', '=', co.id],
        ['date_order', '>=', `${from} 00:00:00`],
        ['date_order', '<=', `${to} 23:59:59`],
      ],
      [
        'name',
        'date_order',
        'partner_id',
        'buyer_name',
        'user_id',
        'team_id',
        'marketing_person',
        'region_id',
        'amount_untaxed',
      ],
      co.id,
    ),
    // The sample side of the PLM link: the sample lines that carry one.
    readAll(
      'sale.order.line',
      [
        ['order_id.sales_type', '=', 'sample'],
        ['order_id.state', '=', 'sale'],
        ['order_id.company_id', '=', co.id],
        ['order_id.date_order', '>=', `${from} 00:00:00`],
        ['order_id.date_order', '<=', `${to} 23:59:59`],
        ...plmClause,
      ],
      ['order_id', 'shade', 'shade_name'],
      co.id,
    ),
    // Bulk lines that name a sample, either way round: the SA number in this
    // company's reference field, or a PLM number in the shade.
    readAll(
      'sale.order.line',
      [
        ['order_id.sales_type', '=', 'oa'],
        ['order_id.state', '=', 'sale'],
        ['order_id.company_id', '=', co.id],
        ['order_id.date_order', '>=', `${from} 00:00:00`],
        '|',
        [co.refField, '!=', false],
        ...plmClause,
      ],
      [
        'order_id',
        co.refField,
        'shade',
        'shade_name',
        'product_id',
        'price_subtotal',
        'product_uom_qty',
      ],
      co.id,
    ),
  ]);

  // The bulk order's date and buyer, which the line does not carry. The buyer
  // matters: a PLM number is only the same development when it is the same
  // buyer's PLM number.
  const orderIds = [...new Set(bulkLines.map((l) => idOf(l.order_id)))].filter(Boolean);
  const orderDate = new Map<number, string>();
  const orderBuyer = new Map<number, number>();
  const session = await getSession();
  const context = buildContext(session, {}, co.id);
  for (let i = 0; i < orderIds.length; i += 2000) {
    const orders = await callKw<any[]>('sale.order', 'read', {
      args: [orderIds.slice(i, i + 2000), ['date_order', 'buyer_name']],
      kwargs: { context },
    });
    for (const o of orders) {
      orderDate.set(o.id, dateOnly(o.date_order));
      orderBuyer.set(o.id, idOf(o.buyer_name));
    }
  }

  // sample id -> its SA key and buyer, so a bulk line can be resolved to the
  // samples it points at.
  const sampleBuyer = new Map<number, number>();
  const keyOfSample = new Map<number, string>();
  const knownKeys = new Set<string>();
  /** SA key -> the day the sample was raised, for the date test below. */
  const raisedOn = new Map<string, string>();
  for (const s of samples) {
    const k = saKey(s.name);
    sampleBuyer.set(s.id, idOf(s.buyer_name));
    if (k) {
      keyOfSample.set(s.id, k);
      knownKeys.add(k);
      const when = dateOnly(s.date_order);
      const held = raisedOn.get(k);
      if (!held || when < held) raisedOn.set(k, when);
    }
  }

  // `${buyerId}|${plm}` -> the samples of that buyer carrying that PLM number.
  const samplesByPlm = new Map<string, Set<string>>();
  /** SA key -> its own PLM numbers, shown on the row. */
  const plmsOfSample = new Map<string, Set<string>>();
  for (const line of samplePlmLines) {
    const id = idOf(line.order_id);
    const k = keyOfSample.get(id);
    if (!k) continue;
    const buyer = sampleBuyer.get(id) ?? 0;
    for (const plm of plmsIn(`${line.shade ?? ''} ${line.shade_name ?? ''}`)) {
      const bucket = `${buyer}|${plm}`;
      (samplesByPlm.get(bucket) ?? samplesByPlm.set(bucket, new Set()).get(bucket)!).add(k);
      addTo(plmsOfSample.get(k) ?? plmsOfSample.set(k, new Set()).get(k)!, plm, 6);
    }
  }

  interface Hit {
    /** Per bulk order, so the drill-down can show each one and its value. */
    oas: Map<string, ConvertedOrder>;
    value: number;
    qty: number;
    first: string | null;
  }
  const hits = new Map<string, Hit>();

  for (const line of bulkLines) {
    const orderId = idOf(line.order_id);
    const when = orderDate.get(orderId) || null;
    const buyer = orderBuyer.get(orderId) ?? 0;

    // Which samples does this line point at, and by which link? A line can
    // carry both, and the SA number is the better evidence, so it wins.
    const targets = new Map<string, 'ref' | 'plm'>();
    for (const ref of saRefsIn(line[co.refField])) targets.set(ref, 'ref');
    for (const plm of plmsIn(`${line.shade ?? ''} ${line.shade_name ?? ''}`)) {
      for (const k of samplesByPlm.get(`${buyer}|${plm}`) ?? []) {
        if (targets.has(k)) continue;
        // A PLM number says "same development", not "won by this sample". An
        // order raised before the sample existed cannot have been won by it —
        // it is the earlier business the shade was re-submitted against — so
        // the PLM link only reaches forward. The SA number written on a line is
        // a deliberate statement and is trusted whichever way the dates fall,
        // since a revised order carries its new date, not the date it was won.
        const raised = raisedOn.get(k);
        if (when && raised && when < raised) continue;
        targets.set(k, 'plm');
      }
    }
    if (!targets.size) continue;

    // A line pointing at several samples is split between them, so no value is
    // counted twice when the rows are added up. References to samples outside
    // this year still take their share: that value is theirs, not ours.
    const share = targets.size;
    const value = (Number(line.price_subtotal) || 0) / share;
    const qty = (Number(line.product_uom_qty) || 0) / share;
    const no = nameOf(line.order_id);
    // Odoo names a variant "COIL 3 ZIPPER CLOSE END (TEETH, Slider C#3 DTM
    // TZP-2239, Dyeing …)" — the family, then the full spec of every component.
    // The drill-down wants the family; the spec is a paragraph per row.
    const full = nameOf(line.product_id);
    const item = oneLine(full.split('(')[0] || full, 60);
    const shade = oneLine(line.shade || line.shade_name, 70);
    const linePlms = plmsIn(`${line.shade ?? ''} ${line.shade_name ?? ''}`);

    for (const [k, via] of targets) {
      if (!knownKeys.has(k)) continue;
      let hit = hits.get(k);
      if (!hit) {
        hit = { oas: new Map(), value: 0, qty: 0, first: null };
        hits.set(k, hit);
      }

      let order = hit.oas.get(no);
      if (!order) {
        order = { no, date: when, value: 0, qty: 0, via, items: [], shades: [], plms: [] };
        hit.oas.set(no, order);
      }
      order.value += value;
      order.qty += qty;
      if (via === 'ref') order.via = 'ref';

      // What was actually ordered, so the drill-down shows the work rather than
      // only the money. Several lines of one order collapse into one row, so
      // the item and shade are collected as a short distinct list.
      const items = new Set(order.items);
      addTo(items, item);
      order.items = [...items];
      const shades = new Set(order.shades);
      addTo(shades, shade);
      order.shades = [...shades];
      const plms = new Set(order.plms);
      for (const plm of linePlms) addTo(plms, plm);
      order.plms = [...plms];

      hit.value += value;
      hit.qty += qty;
      if (when && (!hit.first || when < hit.first)) hit.first = when;
    }
  }

  const rows: SampleRow[] = samples.map((s) => {
    const date = dateOnly(s.date_order);
    // Not `key` — that is the company this slice is for.
    const saNo = saKey(s.name);
    const hit = saNo ? hits.get(saNo) : undefined;
    const lag = hit?.first
      ? Math.round((Date.parse(hit.first) - Date.parse(date)) / 86_400_000)
      : null;
    return {
      company: key,
      no: String(s.name ?? ''),
      date,
      customer: nameOf(s.partner_id),
      buyer: nameOf(s.buyer_name),
      salesperson: nameOf(s.user_id),
      team: nameOf(s.team_id),
      marketer: nameOf(s.marketing_person),
      region: nameOf(s.region_id),
      plms: saNo ? [...(plmsOfSample.get(saNo) ?? [])] : [],
      sampleValue: Number(s.amount_untaxed) || 0,
      // Earliest first: the order that actually won the sample leads.
      oas: hit
        ? [...hit.oas.values()].sort(
            (a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.no.localeCompare(b.no),
          )
        : [],
      bulkValue: hit?.value ?? 0,
      bulkQty: hit?.qty ?? 0,
      firstBulk: hit?.first ?? null,
      // A bulk order dated before its sample is a data entry artefact, not a
      // conversion that ran backwards; the link stands, the lag does not.
      lagDays: lag !== null && lag >= 0 ? lag : null,
      converted: !!hit,
      mature: true, // filled in below, once the lag distribution is known
    };
  });

  // How long a sample needs before an absent bulk order means anything: the
  // lag that nine conversions in ten come in under, measured on this company's
  // own year rather than assumed.
  const maturityDays = p90(rows.map((r) => r.lagDays).filter((d): d is number => d !== null));
  const cutoff = Date.now() - maturityDays * 86_400_000;
  for (const row of rows) row.mature = Date.parse(row.date) <= cutoff;

  return {
    company: key,
    fy,
    from,
    to: bulkTo,
    rows,
    adoptedAt,
    maturityDays,
    builtAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ cache */

/** The year in progress moves; a finished year does not. */
const OPEN_TTL_MS = Number(process.env.SAMPLE_CONV_CACHE_MS || 30 * 60 * 1000);
const CLOSED_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Whether Odoo has anything new, asked cheaply.
 *
 * A closed year still changes, because a bulk order raised today can convert a
 * sample raised eighteen months ago. So the stamp covers orders from the start
 * of the year to now, not just the year itself.
 */
function stampFor(fy: number, key: CompanyKey) {
  const { from } = fyWindow(fy);
  const id = companyOf(key).id;
  return () =>
    odooStamp('sale.order', [
      ['date_order', '>=', `${from} 00:00:00`],
      ['company_id', '=', id],
      ['sales_type', 'in', ['sample', 'oa']],
    ]);
}

/**
 * Bumped whenever the shape a slice is built into changes.
 *
 * The cache holds the built slice, not the query, so a new field on a row is
 * simply absent from every slice built before it — the page renders blanks and
 * nothing says why. Versioning the key means a shape change rebuilds itself
 * instead of waiting for someone to notice and press Refresh.
 */
const SHAPE = 3;

function getSlice(fy: number, key: CompanyKey, force = false) {
  return cached<CompanySlice>(`sampleconv-v${SHAPE}-${fy}-${key}`, 'sampleconv', {
    ttlMs: fy === fyOf(todayIso()) ? OPEN_TTL_MS : CLOSED_TTL_MS,
    stamp: stampFor(fy, key),
    // A finished year cannot change under the reader, so an expired copy of it
    // may stand in while the rebuild runs behind the response. Not when the
    // reader asked for the rebuild, though: "Refresh" that hands back the copy
    // it was meant to replace is indistinguishable from a button that does
    // nothing.
    staleWhileRevalidate: !force && fy !== fyOf(todayIso()),
    force,
    build: () => buildSlice(fy, key),
  });
}

/** One fiscal year across the companies asked for. */
export async function getConversionFy(
  fy: number,
  companies: CompanyKey[],
  force = false,
): Promise<ConversionData> {
  const held = await Promise.all(companies.map((c) => getSlice(fy, c, force)));
  const slices = held.map((h) => h.value);
  const { from, to } = fyWindow(fy);

  return {
    fy,
    label: fyLabel(fy),
    from,
    to,
    companies,
    rows: slices.flatMap((s) => s.rows),
    adoptedAt: Object.fromEntries(slices.map((s) => [s.company, s.adoptedAt])),
    maturityDays: Object.fromEntries(slices.map((s) => [s.company, s.maturityDays])),
    // A year is only as fresh as its least fresh company.
    builtAt: held.map((h) => h.builtAt).sort()[0] ?? new Date().toISOString(),
    stale: held.some((h) => h.stale),
    staleError: held.find((h) => h.error)?.error ?? null,
  };
}

/* -------------------------------------------------------------- roll-ups */

export function totalsOf(rows: SampleRow[]): ConversionTotals {
  const converted = rows.filter((r) => r.converted);
  const mature = rows.filter((r) => r.mature);
  const matureConverted = mature.filter((r) => r.converted).length;

  return {
    raised: rows.length,
    converted: converted.length,
    rate: rows.length ? converted.length / rows.length : 0,
    bulkValue: converted.reduce((a, r) => a + r.bulkValue, 0),
    sampleValue: rows.reduce((a, r) => a + r.sampleValue, 0),
    medianLag: median(converted.map((r) => r.lagDays).filter((d): d is number => d !== null)),
    pending: rows.length - mature.length,
    matureRaised: mature.length,
    matureConverted,
    matureRate: mature.length ? matureConverted / mature.length : 0,
  };
}

/* ------------------------------------------------------- fiscal quarters */

const QUARTER_MONTHS = [
  ['04', '05', '06'],
  ['07', '08', '09'],
  ['10', '11', '12'],
  ['01', '02', '03'],
];

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The fiscal quarter a date falls in.
 *
 * The year starts in April, so Q1 is Apr-Jun and Q4 is Jan-Mar of the
 * following calendar year — a January sample belongs to the fiscal year that
 * began the previous April.
 */
export function fyQuarterOf(iso: string): { fy: number; quarter: number; key: string } {
  const [y, m] = iso.slice(0, 7).split('-').map(Number);
  const fy = m >= 4 ? y : y - 1;
  const quarter = Math.floor(((m - 4 + 12) % 12) / 3) + 1;
  return { fy, quarter, key: `${fy}-Q${quarter}` };
}

/** "Apr - Jun 2025"; Q4 sits in the next calendar year, and says so. */
export function quarterSpan(fy: number, quarter: number): string {
  const months = QUARTER_MONTHS[quarter - 1];
  const year = quarter === 4 ? fy + 1 : fy;
  const first = MONTH_NAMES[Number(months[0]) - 1];
  const last = MONTH_NAMES[Number(months[2]) - 1];
  return `${first} - ${last} ${year}`;
}

/** The four quarters of a fiscal year, in order, whether or not they have data. */
export function fyQuarters(fy: number): { key: string; quarter: number }[] {
  return [1, 2, 3, 4].map((q) => ({ key: `${fy}-Q${q}`, quarter: q }));
}

/**
 * Samples rolled up by the fiscal quarter they were raised in.
 *
 * Every quarter of the year is returned, including the ones with no samples,
 * so a year always reads as four columns and a gap is visible as a gap.
 */
export function byQuarter(
  rows: SampleRow[],
  fy: number,
  adoptedAt: Partial<Record<CompanyKey, string | null>> = {},
): QuarterRollup[] {
  const map = new Map<string, SampleRow[]>();
  for (const row of rows) {
    const { key } = fyQuarterOf(row.date);
    (map.get(key) ?? map.set(key, []).get(key)!).push(row);
  }

  // A quarter counts as recorded once every company in view was recording
  // before it began; otherwise its misses cannot be told from its blanks. The
  // latest adopter sets the date, because a quarter is only as readable as the
  // unit that started writing the reference down last.
  const starts = Object.values(adoptedAt).filter(Boolean) as string[];
  const recordedBy = starts.length ? starts.sort().at(-1)! : null;

  return fyQuarters(fy).map(({ key, quarter }) => {
    const list = map.get(key) ?? [];
    const converted = list.filter((r) => r.converted);
    const months = QUARTER_MONTHS[quarter - 1];
    const startsOn = `${quarter === 4 ? fy + 1 : fy}-${months[0]}-01`;

    return {
      key,
      label: `Q${quarter}`,
      span: quarterSpan(fy, quarter),
      fy,
      quarter,
      raised: list.length,
      converted: converted.length,
      rate: list.length ? converted.length / list.length : 0,
      bulkValue: converted.reduce((a, r) => a + r.bulkValue, 0),
      sampleValue: list.reduce((a, r) => a + r.sampleValue, 0),
      medianLag: median(converted.map((r) => r.lagDays).filter((d): d is number => d !== null)),
      // An empty quarter that has not happened yet is not "mature"; one that
      // has passed with no samples in it is.
      mature: list.length ? list.every((r) => r.mature) : startsOn < todayIso(),
      recorded: !recordedBy || startsOn >= recordedBy,
    };
  });
}

/**
 * Samples grouped by buyer, sales team, salesperson, marketer or region.
 *
 * Ordered by samples RAISED, not by conversions won. Sorting by conversions
 * reads well but hides the row that matters most: in FY 25-26 Carter's had 417
 * samples developed for it and not one bulk order, which is the ninth largest
 * development effort of the year and would have sat at rank 127 under a
 * conversions sort. The effort is what the business spent; whether it converted
 * is the column beside it.
 */
export function breakdown(rows: SampleRow[], dimension: Dimension, limit = 25): BreakdownRow[] {
  const map = new Map<string, SampleRow[]>();
  for (const row of rows) {
    const name =
      (dimension === 'buyer' ? row.buyer || row.customer : row[dimension]) || 'Unattributed';
    (map.get(name) ?? map.set(name, []).get(name)!).push(row);
  }
  return [...map]
    .map(([name, list]) => {
      const converted = list.filter((r) => r.converted);
      return {
        name,
        raised: list.length,
        converted: converted.length,
        rate: list.length ? converted.length / list.length : 0,
        bulkValue: converted.reduce((a, r) => a + r.bulkValue, 0),
        medianLag: median(converted.map((r) => r.lagDays).filter((d): d is number => d !== null)),
      };
    })
    .sort((a, b) => b.raised - a.raised || b.converted - a.converted)
    .slice(0, limit);
}
