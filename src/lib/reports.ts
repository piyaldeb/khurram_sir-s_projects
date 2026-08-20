/**
 * The `mrp.report.custom` wizard: catalogue + the four-call flow the Odoo web
 * client performs to turn a report request into a workbook.
 *
 * Captured flow (see `Manufacturing Order.har`):
 *   1. call_kw mrp.report.custom.onchange     -> field defaults (dates)
 *   2. call_kw mrp.report.custom.web_save     -> transient record id
 *   3. call_button action_generate_xlsx_report -> ir.actions.report descriptor
 *   4. GET /report/<converter>/<report_name>?options=..&context=.. -> the file
 */
import {
  buildContext,
  callButton,
  callKw,
  fetchBinary,
  getSession,
  OdooError,
  webSearchRead,
} from './odoo';
import { parseWorkbook, type Workbook } from './xlsx';

export const WIZARD_MODEL = 'mrp.report.custom';
export const WIZARD_ACTION_ID = 1943;
export const WORKCENTER_ACTION_ID = 1179;

/** Field specification the wizard's form view sends on every call. */
const SPEC = {
  report_type: {},
  available_challan_ids: { fields: {} },
  challan_record_id: { fields: { display_name: {} } },
  challan_no: {},
  date_from: {},
  date_to: {},
  buyer_name_filter: { fields: { display_name: {} } },
} as const;

/** Mirrors the `invisible=` expressions in the wizard form view. */
const NO_DATE_FROM = new Set([
  's_pir',
  's_pir_coil',
  'p_bo',
  'pir_buying_house',
  'daily_sample_report',
  'avail_metarial',
]);
const NO_DATE_TO = new Set(['s_pir', 's_pir_coil', 'p_bo', 'pir_buying_house', 'avail_metarial']);
const NEEDS_CHALLAN = new Set(['painting_invoice', 'plating_invoice']);
const NEEDS_BUYER = new Set(['pir', 'pi_file_dying']);

export interface ReportDef {
  value: string;
  label: string;
  group: string;
  dateFrom: boolean;
  dateTo: boolean;
  challan: boolean;
  buyer: boolean;
}

/** Report type -> section, so 36 entries read as a menu rather than a list. */
const GROUPS: Record<string, string[]> = {
  'PI Files': ['pir', 'pi_file_dying', 'pir_buying_house', 's_pir', 's_pir_coil', 'pird', 'pic', 's_pic', 'pis', 'p_s'],
  Production: ['dpcl', 'dppr', 'dppr_', 't_qc', 'packing_details', 'pack_ytd', 'avail_metarial'],
  'Invoicing': ['dpr', 'invs', 's_invs', 'r_invs', 'p_invs', 'painting_invoice', 'plating_invoice'],
  'Orders & BO': ['p_bo', 'c_bo', 'monthly_bo', 'bo_details', 'oa_d', 'oa_ds', 'cos', 'opo', 'r_ord'],
  Sampling: ['daily_sample_report', 'monthly_sample_report', 'sample_delivery'],
};

function groupOf(value: string): string {
  for (const [group, members] of Object.entries(GROUPS)) {
    if (members.includes(value)) return group;
  }
  return 'Other';
}

export interface WizardFields {
  reports: ReportDef[];
  groups: string[];
  defaults: { date_from: string; date_to: string; report_type: string };
}

let fieldsCache: { at: number; value: WizardFields } | null = null;
const FIELDS_TTL_MS = 10 * 60 * 1000;

/** Reads the selection list straight off the wizard's form view. */
export async function getWizardFields(): Promise<WizardFields> {
  if (fieldsCache && Date.now() - fieldsCache.at < FIELDS_TTL_MS) return fieldsCache.value;

  const session = await getSession();
  const views = await callKw<any>(WIZARD_MODEL, 'get_views', {
    kwargs: {
      context: buildContext(session),
      views: [[false, 'form']],
      options: { action_id: WIZARD_ACTION_ID, load_filters: false, toolbar: false },
    },
  });

  const selection: [string, string][] = views?.models?.[WIZARD_MODEL]?.report_type?.selection ?? [];
  const reports: ReportDef[] = selection.map(([value, label]) => ({
    value,
    label,
    group: groupOf(value),
    dateFrom: !NO_DATE_FROM.has(value),
    dateTo: !NO_DATE_TO.has(value),
    challan: NEEDS_CHALLAN.has(value),
    buyer: NEEDS_BUYER.has(value),
  }));

  if (!reports.length) throw new OdooError('The MRP report wizard exposed no report types.');

  const onchange = await callKw<any>(WIZARD_MODEL, 'onchange', {
    args: [[], {}, [], SPEC],
    kwargs: { context: buildContext(session) },
  });
  const value = onchange?.value ?? {};

  const order = Object.keys(GROUPS);
  const rank = (g: string) => (order.indexOf(g) < 0 ? order.length : order.indexOf(g));
  const groups = [...new Set(reports.map((r) => r.group))].sort((a, b) => rank(a) - rank(b));

  const result: WizardFields = {
    reports,
    groups,
    defaults: {
      report_type: value.report_type ?? reports[0].value,
      date_from: value.date_from ?? '',
      date_to: value.date_to ?? '',
    },
  };
  fieldsCache = { at: Date.now(), value: result };
  return result;
}

export interface ReportRequest {
  report_type: string;
  date_from?: string | null;
  date_to?: string | null;
  buyer_id?: number | null;
  challan_id?: number | null;
  /** Scope the report to one company; omitted means every allowed company. */
  company_id?: number | null;
}

export interface ReportArtifact {
  /** ir.actions.report descriptor returned by the button. */
  action: any;
  wizardId: number;
  downloadPath: string;
  filename: string;
  contentType: string;
  buffer: ArrayBuffer;
}

function normaliseDate(value: string | null | undefined): string | false {
  if (!value) return false;
  return value.slice(0, 10);
}

/** Runs steps 1-4 and returns the raw file plus everything used to get it. */
export async function generateReport(req: ReportRequest): Promise<ReportArtifact> {
  const session = await getSession();
  const company = req.company_id ?? undefined;
  const def = (await getWizardFields()).reports.find((r) => r.value === req.report_type);
  if (!def) throw new OdooError(`Unknown report type "${req.report_type}".`);

  const values: Record<string, unknown> = {
    report_type: def.value,
    challan_record_id: def.challan ? (req.challan_id ?? false) : false,
    challan_no: false,
    date_from: def.dateFrom ? normaliseDate(req.date_from) : false,
    date_to: def.dateTo ? normaliseDate(req.date_to) : false,
    buyer_name_filter: def.buyer ? (req.buyer_id ?? false) : false,
  };

  const saved = await callKw<any[]>(WIZARD_MODEL, 'web_save', {
    args: [[], values],
    kwargs: { context: buildContext(session, {}, company), specification: SPEC },
  });
  const wizardId: number | undefined = saved?.[0]?.id;
  if (!wizardId) throw new OdooError('Odoo did not create the report wizard record.');

  const action = await callButton<any>(
    WIZARD_MODEL,
    'action_generate_xlsx_report',
    [wizardId],
    buildContext(session, {}, company),
  );

  if (!action || action.type !== 'ir.actions.report') {
    const hint =
      action?.params?.message ||
      action?.type ||
      'the button returned nothing (usually means the filters matched no data)';
    throw new OdooError(`Odoo did not return a report for "${def.label}" - ${hint}.`);
  }

  const converter = action.report_type === 'xlsx' ? 'xlsx' : 'pdf';
  const context = {
    ...buildContext(session, {}, company),
    ...(action.context ?? {}),
    active_model: WIZARD_MODEL,
    active_id: wizardId,
    active_ids: [wizardId],
  };

  const query = new URLSearchParams();
  if (action.data) query.set('options', JSON.stringify(action.data));
  query.set('context', JSON.stringify(context));

  const downloadPath = `/report/${converter}/${action.report_name}?${query.toString()}`;
  const file = await fetchBinary(downloadPath);

  return {
    action,
    wizardId,
    downloadPath,
    filename: file.filename,
    contentType: file.contentType,
    buffer: file.buffer,
  };
}

export interface ReportResult {
  reportType: string;
  reportLabel: string;
  reportName: string;
  filename: string;
  generatedAt: string;
  filters: ReportRequest;
  workbook: Workbook;
  sizeBytes: number;
}

/** Generate + parse, i.e. what the report console renders. */
export async function runReport(req: ReportRequest): Promise<ReportResult> {
  const def = (await getWizardFields()).reports.find((r) => r.value === req.report_type);
  const artifact = await generateReport(req);

  if (!artifact.contentType.includes('spreadsheet')) {
    throw new OdooError(
      `"${def?.label ?? req.report_type}" is produced as ${artifact.action.report_type}, not a spreadsheet - use the download button instead.`,
    );
  }

  const workbook = await parseWorkbook(artifact.buffer, artifact.filename);

  return {
    reportType: req.report_type,
    reportLabel: def?.label ?? req.report_type,
    reportName: artifact.action.name ?? artifact.action.report_name,
    filename: artifact.filename,
    generatedAt: new Date().toISOString(),
    filters: req,
    workbook,
    sizeBytes: artifact.buffer.byteLength,
  };
}

/* ---------------------------------------------------------------- lookups */

export async function searchBuyers(query: string, limit = 30) {
  const domain: unknown[] = [['buyer_rank', '=', 1]];
  if (query.trim()) domain.push(['display_name', 'ilike', query.trim()]);
  const { records } = await webSearchRead<{ id: number; display_name: string }>('res.partner', {
    domain,
    specification: { display_name: {} },
    limit,
    order: 'display_name asc',
  });
  return records.map((r) => ({ id: r.id, name: r.display_name }));
}

/** The wizard fills `available_challan_ids` via onchange on report_type. */
export async function availableChallans(reportType: string) {
  const session = await getSession();
  const res = await callKw<any>(WIZARD_MODEL, 'onchange', {
    args: [
      [],
      {
        report_type: reportType,
        available_challan_ids: [],
        challan_record_id: false,
        challan_no: false,
        date_from: false,
        date_to: false,
        buyer_name_filter: false,
      },
      ['report_type'],
      SPEC,
    ],
    kwargs: { context: buildContext(session) },
  });

  const ids: number[] = (res?.value?.available_challan_ids ?? [])
    .map((entry: any) => (Array.isArray(entry) ? entry[1] : entry?.id ?? entry))
    .filter((v: unknown) => typeof v === 'number');

  if (!ids.length) return [];

  const { records } = await webSearchRead<{ id: number; display_name: string }>(
    'operation.details',
    { domain: [['id', 'in', ids]], specification: { display_name: {} }, limit: 200 },
  );
  return records.map((r) => ({ id: r.id, name: r.display_name }));
}

export interface Workcenter {
  id: number;
  name: string;
  workorder_count: number;
  working_state: string;
  oee_target: number;
  order_toproduce_count: number;
  order_tooutput_count: number;
  order_toqc_count: number;
}

export async function listCompanies() {
  const session = await getSession();
  return session.companies;
}

export async function listWorkcenters(): Promise<Workcenter[]> {
  const { records } = await webSearchRead<Workcenter>('mrp.workcenter', {
    specification: {
      name: {},
      color: {},
      workorder_count: {},
      working_state: {},
      oee_target: {},
      order_toproduce_count: {},
      order_tooutput_count: {},
      order_toqc_count: {},
    },
    limit: 200,
    order: 'name asc',
  });
  return records;
}
