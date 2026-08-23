/**
 * Buyer expectation against our own lead time, for bulk zipper orders.
 *
 * Buyers tell us how long they expect an order to take, and the figure differs
 * for a standard item and a non-standard one. That expectation is hand-kept in
 * `Buyer wise EDD (2 July'26).xlsx` and has no Odoo model at all, so it ships
 * as `src/data/buyer-edd.json` — the same arrangement the budget and OT pages
 * use for numbers Odoo does not hold. Everything it is compared against is
 * read live.
 *
 * WHICH FIGURE AN ORDER IS JUDGED AGAINST
 * ---------------------------------------
 * The workbook's second sheet lists the standard sliders for each zipper type
 * — TZP-305 and TZP-294 for M-4, TZP-793 and TZP-794 for C-3, and so on. An
 * order built on one of those is standard and gets the shorter figure; anything
 * else is non-standard and gets the longer one.
 *
 * Odoo carries the slider on the order line as `slider_tzp_code`, set on
 * 326,000 of them, and its values are the workbook's codes exactly. So the
 * classification is read rather than guessed. An order whose lines disagree is
 * decided by the slider carrying the most quantity, and says that it was mixed.
 *
 * H&M writes a policy rather than a day count, and its regular-order figure —
 * close by twelve working days — is resolved to fourteen calendar days at this
 * plant's six-day week. Every row so derived carries a `basis` saying so, and
 * the page marks it, because a worked-out figure sitting beside read ones
 * should never pass for one.
 *
 * WHAT THE LEAD TIME IS
 * ---------------------
 * Odoo's own bulk figure, from the PPC report the Lead time page already runs —
 * calendar days from the OA date to completion, with no holidays deducted,
 * because that report ships none. An order still open counts against today and
 * keeps growing, which is the honest reading: it is already that late.
 */
import edd from '../data/buyer-edd.json';
import { buildContext, callKw, getSession } from './odoo';
import { getLeadFy, normaliseNo, type LeadRow } from './sampletime';

export interface BuyerExpectation {
  buyer: string;
  standardDays: number | null;
  nonStandardDays: number | null;
  note?: string;
  /** Set where the figure was worked out rather than read off the sheet. */
  basis?: string;
}

export interface EddSource {
  source: string;
  company: string;
  /** Working days convert to calendar days at this many days a week. */
  workingWeek: number;
  note: string;
  buyers: BuyerExpectation[];
  /** Zipper type -> the sliders that count as standard for it. */
  standardSliders: Record<string, string[]>;
}

export const eddSource = edd as EddSource;

/** Buyer names are typed by hand on both sides; match on shape, not spelling. */
const key = (s: string) =>
  String(s ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

/** A slider code, normalised: "TZP 305", "tzp-305" and "305" all agree. */
const sliderKey = (s: string) => {
  const raw = String(s ?? '').toUpperCase().trim();
  const m = /TZP[\s-]*(\d+)/.exec(raw);
  if (m) return `TZP-${Number(m[1])}`;
  const digits = /^(\d{2,4})/.exec(raw);
  return digits ? `TZP-${Number(digits[1])}` : raw;
};

const expectationOf = new Map(eddSource.buyers.map((b) => [key(b.buyer), b]));

/**
 * Every slider the workbook calls standard, whatever type it sits under.
 *
 * The sheet groups them by zipper type, but the bulk report names the type its
 * own way ("M#4 CE" against the sheet's "M-4") and a slider only ever belongs
 * to one type anyway — so membership is the question, not which column it was
 * written in.
 */
const STANDARD_SLIDERS = new Set(
  Object.values(eddSource.standardSliders).flat().map(sliderKey),
);

export type Standard = 'standard' | 'non-standard' | 'unknown';

export interface EddRow {
  /** OA number as the report prints it. */
  no: string;
  order: string | null;
  date: string;
  buyer: string;
  customer: string;
  /** The zipper type, as the bulk report names it: "M#4 CE". */
  item: string;
  style: string;
  qty: number;
  status: string;
  pending: boolean;

  /** The slider the order was built on, and how it was classified. */
  slider: string;
  mixedSliders: boolean;
  standard: Standard;

  /** What the buyer expects, in days. Null when the workbook has no figure. */
  expected: number | null;
  /** Odoo's own lead time for the order, in calendar days. */
  actual: number;
  /** actual - expected. Positive is late. */
  gap: number | null;
  onTime: boolean | null;
  /** Set where the buyer wrote a sentence instead of a number. */
  note: string | null;
  /** Set where the expected figure was derived rather than read. */
  basis: string | null;
  /** True when the buyer is not in the workbook at all. */
  unknownBuyer: boolean;
}

export interface EddReport {
  fy: number;
  label: string;
  from: string;
  to: string;
  rows: EddRow[];
  /** Buyers seen in the orders that the workbook has never heard of. */
  missingBuyers: string[];
  source: string;
  builtAt: string;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * The slider behind each OA, by order number.
 *
 * One read for the whole year rather than one per order: the codes live on the
 * order lines, and a grouped read gives the quantity behind each so a mixed
 * order can be settled on the dominant one.
 */
async function slidersFor(orders: string[]): Promise<Map<string, { slider: string; mixed: boolean }>> {
  const out = new Map<string, { slider: string; mixed: boolean }>();
  if (!orders.length) return out;

  const context = buildContext(await getSession());
  const rows: any[] = [];

  // Odoo takes a long `in` badly; the year goes over in slices.
  const CHUNK = 500;
  for (let i = 0; i < orders.length; i += CHUNK) {
    rows.push(
      ...(await callKw<any[]>('sale.order.line', 'read_group', {
        args: [
          [
            ['order_id.name', 'in', orders.slice(i, i + CHUNK)],
            ['slider_tzp_code', '!=', false],
          ],
          ['product_uom_qty'],
          ['order_id', 'slider_tzp_code'],
        ],
        kwargs: { context, lazy: false, limit: 0 },
      })),
    );
  }

  const byOrder = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const order = Array.isArray(r.order_id) ? String(r.order_id[1]) : '';
    const code = sliderKey(r.slider_tzp_code);
    if (!order || !code) continue;
    const held = byOrder.get(order) ?? new Map<string, number>();
    held.set(code, (held.get(code) ?? 0) + num(r.product_uom_qty));
    byOrder.set(order, held);
  }

  for (const [order, codes] of byOrder) {
    const ranked = [...codes.entries()].sort((a, b) => b[1] - a[1]);
    out.set(order, { slider: ranked[0][0], mixed: ranked.length > 1 });
  }
  return out;
}

/** One fiscal year of bulk zipper orders, judged against what buyers expect. */
export async function eddReport(fy: number): Promise<EddReport> {
  // Zipper only: the workbook's expectations are for zipper, and the sheet
  // names itself so.
  const data = await getLeadFy(fy, 'bulk', ['zipper']);

  const orders = [
    ...new Set(data.rows.map((r) => r.order ?? `OA${normaliseNo(r.no).padStart(6, '0')}`)),
  ].filter(Boolean);
  const sliders = await slidersFor(orders);

  const missing = new Set<string>();

  const rows: EddRow[] = data.rows.map((r: LeadRow) => {
    const order = r.order ?? `OA${normaliseNo(r.no).padStart(6, '0')}`;
    const found = sliders.get(order);
    const slider = found?.slider ?? '';

    const standard: Standard = !slider
      ? 'unknown'
      : STANDARD_SLIDERS.has(slider)
        ? 'standard'
        : 'non-standard';

    const expectation = expectationOf.get(key(r.buyer));
    if (!expectation && r.buyer) missing.add(r.buyer);

    // An order whose slider is unknown cannot be told which figure applies, so
    // it gets none rather than the wrong one.
    const expected =
      !expectation || standard === 'unknown'
        ? null
        : standard === 'standard'
          ? expectation.standardDays
          : expectation.nonStandardDays;

    const gap = expected === null ? null : r.lead - expected;

    return {
      no: r.no,
      order: r.order,
      date: r.date,
      buyer: r.buyer,
      customer: r.customer,
      item: r.productType,
      style: r.style,
      qty: r.qty,
      status: r.status,
      pending: r.pending,

      slider,
      mixedSliders: found?.mixed ?? false,
      standard,

      expected,
      actual: r.lead,
      gap,
      onTime: gap === null ? null : gap <= 0,
      note: expectation?.note ?? null,
      basis: expectation?.basis ?? null,
      unknownBuyer: !expectation,
    };
  });

  return {
    fy,
    label: data.label,
    from: data.from,
    to: data.to,
    rows,
    missingBuyers: [...missing].sort(),
    source: eddSource.source,
    builtAt: new Date().toISOString(),
  };
}
