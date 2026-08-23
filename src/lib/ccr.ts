/**
 * CCR — customer complaint reports, read from `sale.ccr`.
 *
 * One record per complaint raised against a delivery: what the customer said,
 * how it was classified, who is thought to be responsible, and where it has
 * got to. 1,070 of them from December 2023, split Zipper and Metal Trims.
 *
 * OPEN AGAINST CLOSED
 * -------------------
 * The workflow runs draft -> intermediate -> justified / non-justified -> CA ->
 * PA -> done, and `closing_date` is only ever set on `done`: 37 of the 38 done
 * records have one and nothing else does. So closed means done, and everything
 * else is still open — including `nonjust`, which is a decision that the
 * complaint was not our fault rather than a closure of the case.
 *
 * That distinction matters enough to keep: 258 non-justified complaints sitting
 * in the open pile is a very different picture from 258 closed ones, and the
 * page shows the states rather than only the two buckets.
 *
 * THE HISTORY OF ONE COMPLAINT
 * ---------------------------
 * Odoo's own audit trail is out of reach: `sale.ccr.ca`, `sale.ccr.pa` and
 * `sale.ccr.service` are access-denied to this login, and reading `mail.message`
 * directly is refused on security grounds. What the record itself carries is
 * enough to reconstruct the trail, because every stage stamps its own date:
 *
 *   raised     ticket_raised_date, and the complaint text
 *   reported   report_date
 *   decided    justification — Justified or Not Justified — with the root
 *              cause where it was ours, or the reason and the action to take
 *              where it was not
 *   CA / PA    ca_status and pa_status, with their closing dates
 *   closed     closing_date, and the lead time Odoo computed
 *
 * Those fields ship flat and the page assembles the trail from them. Shipping
 * a pre-built trail meant every note travelled twice — once in its own field
 * and once inside the stage — and doubled the payload for nothing.
 *
 * The whole table is small enough to send at once, so the page filters and
 * groups in the browser and the server does one cached read.
 */
import { buildContext, callKw, getSession } from './odoo';
import { readCache, writeCache } from './cache';

const MODEL = 'sale.ccr';
const FRESH_MINUTES = Number(process.env.CCR_FRESH_MINUTES || process.env.ODOO_SYNC_FRESH_MINUTES || 15);

/** The only state that carries a closing date, and so the only closed one. */
export const CLOSED_STATES = ['done'];

/** Never counted: a draft complaint has not been raised yet. */
export const EXCLUDED_STATES = ['draft'];

/**
 * The workflow, in the order it runs.
 *
 * Odoo's own selection is unordered, and a status column that jumps about is
 * harder to read than one that walks the process.
 */
export const STATE_ORDER = ['inter', 'just', 'nonjust', 'ca', 'pa', 'done', 'cancel'] as const;

/**
 * The decision, which runs in lockstep with the state.
 *
 * Every one of the 643 intermediate complaints is undecided, all 258
 * non-justified ones are Not Justified, and every complaint at CA, PA or Done
 * is Justified. So the decision is not a second opinion on the state — it is
 * the fork the state came out of, and worth its own column.
 */
export type Decision = 'Justified' | 'Not Justified' | 'Undecided';

export const DECISIONS: Decision[] = ['Justified', 'Not Justified', 'Undecided'];

export const STATE_LABEL: Record<string, string> = {
  draft: 'Draft',
  inter: 'Intermediate',
  just: 'Justified',
  nonjust: 'Non justified',
  ca: 'Corrective action',
  pa: 'Preventive action',
  done: 'Done',
  cancel: 'Cancelled',
};

export interface Ccr {
  id: number;
  name: string;
  /** ISO date the complaint was raised. */
  raised: string;
  companyId: number;
  companyName: string;
  state: string;
  closed: boolean;
  closingDate: string | null;
  /** Nature of complaint — the classification the dashboard cuts by. */
  classification: string;
  /** A second, finer classification; unset on most records. */
  type: string;
  department: string;
  team: string;
  customer: string;
  buyer: string;
  /** What the customer actually said. */
  comment: string;
  justification: string;
  orderQty: number;
  rejectedQty: number;
  oa: string;
  invoice: string;
  raisedBy: string;
  /** Free text like "12 days", straight from Odoo. */
  totalLead: string;
  caLead: string;
  paLead: string;

  /** Justified, Not Justified, or not yet decided. */
  decision: Decision;
  /** Where the corrective and preventive actions have got to. */
  caStatus: string;
  paStatus: string;
  caClosed: string | null;
  paClosed: string | null;

  /** What the record says about itself at each stage. */
  rootCause: string;
  reason: string;
  actionToTake: string;
  reportDate: string | null;
  product: string;
  finish: string;
  salesType: string;
  ticket: string;
}

export interface CcrReport {
  rows: Ccr[];
  companies: { id: number; name: string }[];
  /** Every month a complaint was raised in, oldest first. */
  months: string[];
  fetchedAt: string;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const nameOf = (v: unknown) => (Array.isArray(v) ? String(v[1] ?? '').trim() : '');
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** Odoo returns the complaint as typed, newlines and all. */
function tidy(v: unknown): string {
  return text(v)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The cache key carries the document's shape, not just its subject.
 *
 * A cached document written by an older version of this file is still valid
 * JSON and will be served as though it were current — which is how adding the
 * decision and the history trail produced a page reading fields that were not
 * there. Bump the suffix whenever the shape changes and the old entry is simply
 * ignored rather than silently believed.
 */
const CACHE_KEY = 'ccr-v3';

function isFresh(entry: CcrReport): boolean {
  return Date.now() - new Date(entry.fetchedAt).getTime() < FRESH_MINUTES * 60_000;
}

export async function ccrReport(): Promise<CcrReport> {
  const cached = await readCache<CcrReport>(CACHE_KEY, 'ccr');
  if (cached && isFresh(cached)) return cached;

  const context = buildContext(await getSession());

  const records = await callKw<any[]>(MODEL, 'search_read', {
    args: [
      [['states', 'not in', EXCLUDED_STATES]],
      [
        'name',
        'ticket_raised_date',
        'company_id',
        'states',
        'closing_date',
        'complain_nature',
        'ccr_type',
        'department_id',
        'team',
        'customer',
        'buyer',
        'complaint',
        'justification',
        'order_quantity',
        'rejected_quantity',
        'oa_number',
        'invoice_reference',
        'raised_by',
        'total_lead',
        'ca_lead',
        'pa_lead',
        'report_date',
        'quality_action',
        'ca_status',
        'pa_status',
        'ca_closing_date',
        'pa_closing_date',
        'analysis_activity',
        'reason',
        'non_justify_action',
        'fg_product',
        'finish',
        'sales_type',
        'ticket_id',
      ],
    ],
    kwargs: { context, limit: 0, order: 'ticket_raised_date desc' },
  });

  const companies = new Map<number, string>();
  const months = new Set<string>();

  const rows: Ccr[] = records.map((r) => {
    const companyId = Array.isArray(r.company_id) ? (r.company_id[0] as number) : 0;
    const companyName = nameOf(r.company_id);
    if (companyId) companies.set(companyId, companyName);

    // The raised date is a datetime; the report only ever asks about the day.
    const raised = text(r.ticket_raised_date).slice(0, 10);
    if (raised) months.add(raised.slice(0, 7));

    const state = text(r.states);
    const raw = text(r.justification);
    const decision: Decision =
      raw === 'Justified' ? 'Justified' : raw === 'Not Justified' ? 'Not Justified' : 'Undecided';

    return {
      id: r.id,
      name: text(r.name),
      raised,
      companyId,
      companyName,
      state,
      closed: CLOSED_STATES.includes(state),
      closingDate: text(r.closing_date) || null,
      classification: nameOf(r.complain_nature) || '(unclassified)',
      type: nameOf(r.ccr_type) || '(no type)',
      department: nameOf(r.department_id) || '(unassigned)',
      team: nameOf(r.team) || '(no team)',
      customer: nameOf(r.customer) || '(no customer)',
      buyer: nameOf(r.buyer) || '(no buyer)',
      comment: tidy(r.complaint),
      justification: raw || 'Undecided',
      orderQty: num(Number(r.order_quantity)),
      rejectedQty: num(Number(r.rejected_quantity)),
      oa: nameOf(r.oa_number),
      invoice: text(r.invoice_reference),
      raisedBy: nameOf(r.raised_by),
      totalLead: text(r.total_lead),
      caLead: text(r.ca_lead),
      paLead: text(r.pa_lead),

      decision,
      caStatus: text(r.ca_status),
      paStatus: text(r.pa_status),
      caClosed: text(r.ca_closing_date).slice(0, 10) || null,
      paClosed: text(r.pa_closing_date).slice(0, 10) || null,

      rootCause: tidy(r.analysis_activity),
      reason: tidy(r.reason),
      actionToTake: tidy(r.non_justify_action),
      reportDate: text(r.report_date).slice(0, 10) || null,
      product: nameOf(r.fg_product),
      finish: nameOf(r.finish),
      salesType: text(r.sales_type),
      ticket: nameOf(r.ticket_id),
    };
  });

  const doc: CcrReport = {
    rows,
    companies: [...companies.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.id - b.id),
    months: [...months].sort(),
    fetchedAt: new Date().toISOString(),
  };

  await writeCache(CACHE_KEY, doc, 'ccr');
  return doc;
}
