import { crmDateToUtcStart, evaluateFilterLogic, getCRMDayBounds, parseFilterLogic } from '@dct-crm/shared';

export const LIST_MODULES = ['LEAD', 'FOLLOW_UP', 'SITE_VISIT', 'BOOKING', 'PROJECT', 'UNIT', 'MIS_APPROVAL'] as const;
export type ListModule = (typeof LIST_MODULES)[number];

export const FILTER_OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'starts_with',
  'greater_than',
  'less_than',
  'is_empty',
  'is_not_empty',
  'in',
  'not_in',
  'between',
  'today',
  'this_week',
  'this_month',
  'last_30_days',
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export type FilterRule = { id?: number; field: string; operator: FilterOperator; value?: string };
export type OwnerFilter = 'ALL' | 'MINE' | 'SELECTED';
export type FilterSet = {
  logic: 'AND' | 'OR';
  rules: FilterRule[];
  version?: 2;
  ownerFilter?: OwnerFilter;
  ownerUserIds?: string[];
  filterLogic?: string | null;
};
export type ListPreset = 'recent' | 'leadOpen' | 'siteVisitOverdue' | 'siteVisitNotRescheduled' | 'approvalsReviewed';

const STRING_OPS: FilterOperator[] = ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'is_empty', 'is_not_empty'];
const ENUM_OPS: FilterOperator[] = ['equals', 'not_equals', 'is_empty', 'is_not_empty'];
const NUMBER_OPS: FilterOperator[] = ['equals', 'not_equals', 'greater_than', 'less_than', 'is_empty', 'is_not_empty'];
const DATE_OPS: FilterOperator[] = ['equals', 'greater_than', 'less_than', 'is_empty', 'is_not_empty'];
const LEAD_DATE_OPS: FilterOperator[] = ['equals', 'less_than', 'greater_than', 'between', 'today', 'this_week', 'this_month', 'last_30_days', 'is_empty', 'is_not_empty'];
const LEAD_ENUM_OPS: FilterOperator[] = ['equals', 'not_equals', 'in', 'not_in', 'is_empty', 'is_not_empty'];
const LEAD_USER_OPS: FilterOperator[] = ['equals', 'not_equals', 'in', 'is_empty', 'is_not_empty'];
const ID_OPS: FilterOperator[] = ['equals', 'not_equals', 'is_empty', 'is_not_empty'];
const NO_VALUE_OPS = new Set<FilterOperator>(['is_empty', 'is_not_empty', 'today', 'this_week', 'this_month', 'last_30_days']);
const OWNER_PATH: Partial<Record<ListModule, string>> = {
  LEAD: 'ownerId',
  FOLLOW_UP: 'ownerId',
  SITE_VISIT: 'assigneeId',
  BOOKING: 'ownerId',
  UNIT: 'ownerId',
};

type FieldKind = 'string' | 'enum' | 'number' | 'date' | 'boolean' | 'user';
type FieldDef = {
  key: string;
  label: string;
  kind: FieldKind;
  operators: FilterOperator[];
  options?: { value: string; label: string }[];
  paths?: string[];
  virtual?: 'followUpStatus';
};

const leadStatuses = [
  ['NEW', 'New'],
  ['INCOMING', 'Incoming'],
  ['PROSPECT', 'Prospect'],
  ['SITE_VISIT_SCHEDULED', 'Site Visit Scheduled'],
  ['SITE_VISIT_HAPPENED', 'Site Visit Happened'],
  ['BOOKED', 'Booked'],
  ['LOST', 'Lost'],
].map(([value, label]) => ({ value, label }));

const leadSources = ['WEBSITE', 'FACEBOOK', 'REFERRAL', 'COLD_CALL', 'ADVERTISEMENT', 'WALK_IN', 'PORTAL', 'CHANNEL_PARTNER', 'INSTAGRAM', 'TWITTER', 'WHATSAPP', 'YOUTUBE', 'OTHER']
  .map((value) => ({ value, label: value.replace(/_/g, ' ') }));

const FIELDS: Record<ListModule, FieldDef[]> = {
  LEAD: [
    { key: 'status', label: 'Lead Status', kind: 'enum', operators: LEAD_ENUM_OPS, options: leadStatuses, paths: ['status'] },
    { key: 'source', label: 'Source', kind: 'enum', operators: LEAD_ENUM_OPS, options: leadSources, paths: ['source'] },
    { key: 'leadInterest', label: 'Lead Interest', kind: 'string', operators: STRING_OPS, paths: ['leadInterest'] },
    { key: 'ownerId', label: 'Assigned To', kind: 'user', operators: LEAD_USER_OPS, paths: ['ownerId'] },
    { key: 'company', label: 'Company', kind: 'string', operators: STRING_OPS, paths: ['company'] },
    { key: 'phone', label: 'Phone', kind: 'string', operators: STRING_OPS, paths: ['phone'] },
    { key: 'email', label: 'Email', kind: 'string', operators: STRING_OPS, paths: ['email'] },
    { key: 'createdAt', label: 'Created Date', kind: 'date', operators: LEAD_DATE_OPS, paths: ['createdAt'] },
    { key: 'leadNumber', label: 'Lead Number', kind: 'string', operators: STRING_OPS, paths: ['leadNumber'] },
    { key: 'name', label: 'Name', kind: 'string', operators: STRING_OPS, paths: ['firstName', 'lastName'] },
  ],
  FOLLOW_UP: [
    { key: 'status', label: 'Status', kind: 'enum', operators: ['equals', 'not_equals'], options: [
      { value: 'SCHEDULED', label: 'Scheduled' },
      { value: 'MISSED', label: 'Missed' },
      { value: 'COMPLETED', label: 'Completed' },
    ], virtual: 'followUpStatus' },
    { key: 'ownerId', label: 'Owner', kind: 'user', operators: ID_OPS, paths: ['ownerId'] },
    { key: 'dueDate', label: 'Due Date', kind: 'date', operators: DATE_OPS, paths: ['dueDate'] },
    { key: 'lead', label: 'Related Lead', kind: 'string', operators: STRING_OPS, paths: ['lead.leadNumber', 'lead.firstName', 'lead.lastName'] },
    { key: 'title', label: 'Title', kind: 'string', operators: STRING_OPS, paths: ['title'] },
  ],
  SITE_VISIT: [
    { key: 'status', label: 'Status', kind: 'enum', operators: ENUM_OPS, options: [
      { value: 'SCHEDULED', label: 'Scheduled' },
      { value: 'COMPLETED', label: 'Completed' },
      { value: 'CANCELLED', label: 'Cancelled' },
      { value: 'MISSED', label: 'Missed' },
    ], paths: ['status'] },
    { key: 'assigneeId', label: 'Assigned User', kind: 'user', operators: ID_OPS, paths: ['assigneeId'] },
    { key: 'scheduledAt', label: 'Visit Date', kind: 'date', operators: DATE_OPS, paths: ['scheduledAt'] },
    { key: 'completedAt', label: 'Completed Date', kind: 'date', operators: DATE_OPS, paths: ['completedAt'] },
    { key: 'project', label: 'Project', kind: 'string', operators: STRING_OPS, paths: ['project.name'] },
    { key: 'lead', label: 'Related Lead', kind: 'string', operators: STRING_OPS, paths: ['lead.leadNumber', 'lead.firstName', 'lead.lastName'] },
  ],
  BOOKING: [
    { key: 'status', label: 'Booking Status', kind: 'enum', operators: ENUM_OPS, options: [
      { value: 'RESERVED', label: 'Reserved' },
      { value: 'BOOKED', label: 'Booked' },
      { value: 'CONFIRMED', label: 'Confirmed' },
      { value: 'CANCELLED', label: 'Cancelled' },
    ], paths: ['status'] },
    { key: 'customer', label: 'Customer', kind: 'string', operators: STRING_OPS, paths: ['quotation.customerName', 'lead.firstName', 'lead.lastName'] },
    { key: 'project', label: 'Project', kind: 'string', operators: STRING_OPS, paths: ['project.name'] },
    { key: 'unit', label: 'Unit', kind: 'string', operators: STRING_OPS, paths: ['unit.number'] },
    { key: 'createdAt', label: 'Booking Date', kind: 'date', operators: DATE_OPS, paths: ['createdAt'] },
    { key: 'ownerId', label: 'Owner', kind: 'user', operators: ID_OPS, paths: ['ownerId'] },
  ],
  PROJECT: [
    { key: 'name', label: 'Project Name', kind: 'string', operators: STRING_OPS, paths: ['name'] },
    { key: 'isActive', label: 'Status', kind: 'boolean', operators: ['equals'], options: [
      { value: 'true', label: 'Active' },
      { value: 'false', label: 'Inactive' },
    ], paths: ['isActive'] },
    { key: 'city', label: 'City', kind: 'string', operators: STRING_OPS, paths: ['city'] },
    { key: 'projectType', label: 'Project Type', kind: 'string', operators: STRING_OPS, paths: ['projectType'] },
  ],
  UNIT: [
    { key: 'project', label: 'Project', kind: 'string', operators: STRING_OPS, paths: ['project.name'] },
    { key: 'type', label: 'Unit Type', kind: 'string', operators: STRING_OPS, paths: ['type'] },
    { key: 'floor', label: 'Floor', kind: 'number', operators: NUMBER_OPS, paths: ['floor'] },
    { key: 'price', label: 'Price', kind: 'number', operators: NUMBER_OPS, paths: ['price'] },
    { key: 'status', label: 'Unit Status', kind: 'enum', operators: ENUM_OPS, options: [
      { value: 'AVAILABLE', label: 'Available' },
      { value: 'RESERVED', label: 'Reserved' },
      { value: 'BOOKED', label: 'Booked' },
      { value: 'HOLD', label: 'On Hold' },
      { value: 'SOLD', label: 'Sold' },
      { value: 'BLOCKED', label: 'Blocked' },
    ], paths: ['status'] },
    { key: 'number', label: 'Unit Number', kind: 'string', operators: STRING_OPS, paths: ['number'] },
  ],
  MIS_APPROVAL: [
    { key: 'approvalStatus', label: 'Approval Status', kind: 'enum', operators: ENUM_OPS, options: [
      { value: 'PENDING_APPROVAL', label: 'Pending' },
      { value: 'APPROVED', label: 'Approved' },
      { value: 'REJECTED', label: 'Rejected' },
    ], paths: ['approvalStatus'] },
    { key: 'approvalSubmittedAt', label: 'Submitted Date', kind: 'date', operators: DATE_OPS, paths: ['approvalSubmittedAt'] },
    { key: 'customer', label: 'Customer', kind: 'string', operators: STRING_OPS, paths: ['booking.quotation.customerName', 'receivedFrom', 'lead.firstName', 'lead.lastName'] },
    { key: 'project', label: 'Project', kind: 'string', operators: STRING_OPS, paths: ['booking.project.name'] },
    { key: 'unit', label: 'Unit', kind: 'string', operators: STRING_OPS, paths: ['booking.unit.number'] },
  ],
};

export type SystemListView = {
  key: string;
  module: ListModule;
  name: string;
  apiName: string;
  filters: FilterSet;
  preset?: ListPreset;
  presetLabel?: string;
};

const view = (
  module: ListModule,
  slug: string,
  name: string,
  filters: FilterSet = { logic: 'AND', rules: [] },
  extra: Pick<SystemListView, 'preset' | 'presetLabel'> = {},
): SystemListView => ({
  key: `system:${module}:${slug}`,
  module,
  name,
  apiName: slug.replace(/-/g, '_'),
  filters,
  ...extra,
});

const rule = (field: string, operator: FilterOperator, value?: string): FilterRule => ({ field, operator, value });
const and = (...rules: FilterRule[]): FilterSet => ({ logic: 'AND', rules });

export const SYSTEM_VIEWS: SystemListView[] = [
  view('LEAD', 'recently-viewed', 'Recently Viewed', and(), { preset: 'recent', presetLabel: 'Records you have opened' }),
  view('LEAD', 'today-created', "Today's Created Leads", and(rule('createdAt', 'equals', '$today'))),
  view('LEAD', 'my-leads', 'My Leads', and(rule('ownerId', 'equals', '$currentUser'))),
  view('LEAD', 'my-today', "My Today's Leads", and(rule('ownerId', 'equals', '$currentUser'), rule('createdAt', 'equals', '$today'))),
  view('LEAD', 'new', 'New Leads', and(rule('status', 'equals', 'NEW'))),
  view('LEAD', 'open', 'Open Leads', and(), { preset: 'leadOpen', presetLabel: 'Excludes booked and lost leads' }),
  view('LEAD', 'converted', 'Converted Leads', and(rule('status', 'equals', 'BOOKED')), { presetLabel: 'Booked is the converted lead status in this CRM' }),
  view('LEAD', 'all', 'All Leads'),

  view('FOLLOW_UP', 'recently-viewed', 'Recently Viewed Follow-ups', and(), { preset: 'recent', presetLabel: 'Follow-ups you have opened' }),
  view('FOLLOW_UP', 'my-today', "My Today's Follow-ups", and(rule('ownerId', 'equals', '$currentUser'), rule('dueDate', 'equals', '$today'))),
  view('FOLLOW_UP', 'my-missed', 'My Missed Follow-ups', and(rule('ownerId', 'equals', '$currentUser'), rule('status', 'equals', 'MISSED'))),
  view('FOLLOW_UP', 'my-scheduled', 'My Scheduled Follow-ups', and(rule('ownerId', 'equals', '$currentUser'), rule('status', 'equals', 'SCHEDULED'))),
  view('FOLLOW_UP', 'my-month', 'My Follow-ups for the Month', and(rule('ownerId', 'equals', '$currentUser'), rule('dueDate', 'equals', '$thisMonth'))),
  view('FOLLOW_UP', 'completed', 'Completed Follow-ups', and(rule('status', 'equals', 'COMPLETED'))),
  view('FOLLOW_UP', 'all', 'All Follow-ups'),

  view('SITE_VISIT', 'recently-viewed', 'Recently Viewed Site Visits', and(), { preset: 'recent', presetLabel: 'Site visits you have opened' }),
  view('SITE_VISIT', 'my-today', "My Today's Site Visits", and(rule('assigneeId', 'equals', '$currentUser'), rule('scheduledAt', 'equals', '$today'))),
  view('SITE_VISIT', 'my-scheduled', 'My Scheduled Site Visits', and(rule('assigneeId', 'equals', '$currentUser'), rule('status', 'equals', 'SCHEDULED'))),
  view('SITE_VISIT', 'my-overdue', 'My Overdue Site Visits', and(rule('assigneeId', 'equals', '$currentUser')), { preset: 'siteVisitOverdue', presetLabel: 'Missed, or still scheduled before today' }),
  view('SITE_VISIT', 'my-completed-month', 'My Completed Site Visits This Month', and(rule('assigneeId', 'equals', '$currentUser'), rule('status', 'equals', 'COMPLETED'), rule('completedAt', 'equals', '$thisMonth'))),
  view('SITE_VISIT', 'cancelled', 'Cancelled Site Visits', and(rule('status', 'equals', 'CANCELLED')), { preset: 'siteVisitNotRescheduled', presetLabel: 'Excludes visits that were rescheduled' }),
  view('SITE_VISIT', 'all', 'All Site Visits'),

  view('BOOKING', 'recently-viewed', 'Recently Viewed Bookings', and(), { preset: 'recent', presetLabel: 'Bookings you have opened' }),
  view('BOOKING', 'my', 'My Bookings', and(rule('ownerId', 'equals', '$currentUser'))),
  view('BOOKING', 'today', "Today's Bookings", and(rule('createdAt', 'equals', '$today'))),
  view('BOOKING', 'pending', 'Pending Bookings', and(rule('status', 'equals', 'RESERVED')), { presetLabel: 'Reserved bookings that are not yet confirmed' }),
  view('BOOKING', 'confirmed', 'Confirmed Bookings', and(rule('status', 'equals', 'CONFIRMED'))),
  view('BOOKING', 'cancelled', 'Cancelled Bookings', and(rule('status', 'equals', 'CANCELLED'))),
  view('BOOKING', 'all', 'All Bookings'),

  view('PROJECT', 'recently-viewed', 'Recently Viewed Projects', and(), { preset: 'recent', presetLabel: 'Projects you have opened' }),
  view('PROJECT', 'active', 'Active Projects', and(rule('isActive', 'equals', 'true'))),
  view('PROJECT', 'inactive', 'Inactive Projects', and(rule('isActive', 'equals', 'false'))),
  view('PROJECT', 'all', 'All Projects'),

  view('UNIT', 'recently-viewed', 'Recently Viewed Units', and(), { preset: 'recent', presetLabel: 'Units you have opened' }),
  view('UNIT', 'available', 'Available Units', and(rule('status', 'equals', 'AVAILABLE'))),
  view('UNIT', 'booked', 'Booked Units', and(rule('status', 'equals', 'BOOKED'))),
  view('UNIT', 'reserved', 'Reserved Units', and(rule('status', 'equals', 'RESERVED'))),
  view('UNIT', 'sold', 'Sold Units', and(rule('status', 'equals', 'SOLD'))),
  view('UNIT', 'on-hold', 'On-Hold Units', and(rule('status', 'equals', 'HOLD'))),
  view('UNIT', 'all', 'All Units'),

  view('MIS_APPROVAL', 'recently-viewed', 'Recently Viewed Approvals', and(), { preset: 'recent', presetLabel: 'Approvals you have opened' }),
  view('MIS_APPROVAL', 'pending', 'Pending Approvals', and(rule('approvalStatus', 'equals', 'PENDING_APPROVAL'))),
  view('MIS_APPROVAL', 'reviewed', 'Reviewed Approvals', and(), { preset: 'approvalsReviewed', presetLabel: 'Approved or rejected' }),
  view('MIS_APPROVAL', 'approved', 'Approved Approvals', and(rule('approvalStatus', 'equals', 'APPROVED'))),
  view('MIS_APPROVAL', 'rejected', 'Rejected Approvals', and(rule('approvalStatus', 'equals', 'REJECTED'))),
  view('MIS_APPROVAL', 'all', 'All Approvals'),
];

export function isListModule(value: string): value is ListModule {
  return (LIST_MODULES as readonly string[]).includes(value);
}

export function systemViewsFor(module: ListModule): SystemListView[] {
  return SYSTEM_VIEWS.filter((item) => item.module === module);
}

export function systemViewByKey(module: ListModule, key: string): SystemListView | undefined {
  return systemViewsFor(module).find((item) => item.key === key);
}

export function defaultViewKey(module: ListModule): string {
  return `system:${module}:recently-viewed`;
}

export function publicFields(module: ListModule) {
  return FIELDS[module].map(({ key, label, kind, operators, options }) => ({ key, label, kind, operators, options }));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN_RE = /^\$[a-zA-Z]+$/;
const ID_RE = /^[a-zA-Z0-9_-]{8,40}$/;

function splitList(value: string) {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function validateRuleValue(field: FieldDef, operator: FilterOperator, raw: unknown): { ok: true; value?: string } | { ok: false; error: string } {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (NO_VALUE_OPS.has(operator)) return { ok: true };
  if (!value || value.length > 500) return { ok: false, error: `${field.label} needs a value` };
  if (operator === 'between') {
    const [start, end] = splitList(value);
    if (!start || !end || !DATE_RE.test(start) || !DATE_RE.test(end)) return { ok: false, error: `${field.label} needs a start and end date` };
    if (start > end) return { ok: false, error: `${field.label} end date cannot be earlier than the start date` };
    return { ok: true, value: `${start},${end}` };
  }
  if (operator === 'in' || operator === 'not_in') {
    const values = splitList(value);
    if (values.length === 0 || values.length > 20) return { ok: false, error: `${field.label} needs at least one value` };
    for (const item of values) {
      if (field.kind === 'enum' && !field.options?.some((option) => option.value === item)) return { ok: false, error: `${field.label} has an unsupported value` };
      if (field.kind === 'user' && item !== '$currentUser' && !ID_RE.test(item)) return { ok: false, error: 'Choose a valid user' };
    }
    return { ok: true, value: values.join(',') };
  }
  if (TOKEN_RE.test(value)) {
    const allowed = field.kind === 'user' ? value === '$currentUser' : field.kind === 'date' && (value === '$today' || value === '$thisMonth');
    if (!allowed || operator !== 'equals') return { ok: false, error: `${field.label} does not accept that value` };
    return { ok: true, value };
  }
  if (field.kind === 'date' && !DATE_RE.test(value)) return { ok: false, error: `${field.label} must be a date` };
  if (field.kind === 'number' && !Number.isFinite(Number(value))) return { ok: false, error: `${field.label} must be a number` };
  if ((field.kind === 'enum' || field.kind === 'boolean') && !field.options?.some((option) => option.value === value)) {
    return { ok: false, error: `${field.label} has an unsupported value` };
  }
  if (field.kind === 'user' && !ID_RE.test(value)) return { ok: false, error: 'Choose a valid user' };
  return { ok: true, value };
}

function parseRules(module: ListModule, rules: unknown, numbered: boolean): { ok: true; rules: FilterRule[] } | { ok: false; error: string } {
  if (!Array.isArray(rules) || rules.length > (numbered ? 10 : 15)) {
    return { ok: false, error: numbered ? 'A list view can have up to 10 filters' : 'A list view can have up to 15 filters' };
  }
  const catalog = FIELDS[module];
  const parsed: FilterRule[] = [];
  const seen = new Set<number>();
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') return { ok: false, error: 'A filter is invalid' };
    const candidate = rule as FilterRule;
    const field = catalog.find((item) => item.key === candidate.field);
    if (!field) return { ok: false, error: 'That filter field is not available for this module' };
    if (!field.operators.includes(candidate.operator)) return { ok: false, error: `${field.label} does not support that operator` };
    const checked = validateRuleValue(field, candidate.operator, candidate.value);
    if (!checked.ok) return checked;
    const next: FilterRule = { field: field.key, operator: candidate.operator };
    if (checked.value) next.value = checked.value;
    if (numbered) {
      const id = candidate.id;
      if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > 10 || seen.has(id)) {
        return { ok: false, error: 'Filter rows must be numbered from 1 without duplicates' };
      }
      seen.add(id);
      next.id = id;
    }
    parsed.push(next);
  }
  return { ok: true, rules: parsed };
}

export function validateFilterSet(module: ListModule, input: unknown): { ok: true; filters: FilterSet } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'Filters are invalid' };
  const source = input as { version?: unknown; logic?: unknown; rules?: unknown; ownerFilter?: unknown; ownerUserIds?: unknown; filterLogic?: unknown };
  if (source.version === 2) {
    const ownerFilter = source.ownerFilter;
    if (ownerFilter !== 'ALL' && ownerFilter !== 'MINE' && ownerFilter !== 'SELECTED') return { ok: false, error: 'Choose who owns the records' };
    if (ownerFilter !== 'ALL' && !OWNER_PATH[module]) return { ok: false, error: 'This module does not have an owner filter' };
    const ownerUserIds = Array.isArray(source.ownerUserIds) ? source.ownerUserIds.filter((id): id is string => typeof id === 'string') : [];
    if (ownerFilter === 'SELECTED' && (ownerUserIds.length === 0 || ownerUserIds.length > 50 || ownerUserIds.some((id) => !ID_RE.test(id)))) {
      return { ok: false, error: 'Choose at least one user for the owner filter' };
    }
    const parsed = parseRules(module, source.rules, true);
    if (!parsed.ok) return parsed;
    const rawLogic = typeof source.filterLogic === 'string' ? source.filterLogic.trim() : '';
    let filterLogic: string | null = null;
    if (rawLogic) {
      const logic = parseFilterLogic(rawLogic, parsed.rules.map((rule) => rule.id || 0));
      if (!logic.ok) return logic;
      filterLogic = logic.normalized;
    }
    return {
      ok: true,
      filters: {
        version: 2,
        logic: 'AND',
        ownerFilter,
        ownerUserIds: ownerFilter === 'SELECTED' ? ownerUserIds : [],
        rules: parsed.rules,
        filterLogic,
      },
    };
  }
  const logic = source.logic;
  if (logic !== 'AND' && logic !== 'OR') return { ok: false, error: 'Filter logic must be AND or OR' };
  const parsed = parseRules(module, source.rules, false);
  if (!parsed.ok) return parsed;
  return { ok: true, filters: { logic, rules: parsed.rules } };
}

function nest(path: string, value: unknown): Record<string, unknown> {
  const keys = path.split('.');
  const root: Record<string, unknown> = {};
  let cursor = root;
  keys.forEach((key, index) => {
    if (index === keys.length - 1) cursor[key] = value;
    else {
      const next: Record<string, unknown> = {};
      cursor[key] = next;
      cursor = next;
    }
  });
  return root;
}

function monthBounds(now: Date) {
  const [year, month] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).format(now).split('-');
  const start = crmDateToUtcStart(`${year}-${month}-01`);
  const next = Number(month) === 12
    ? `${Number(year) + 1}-01-01`
    : `${year}-${String(Number(month) + 1).padStart(2, '0')}-01`;
  return { gte: start, lt: crmDateToUtcStart(next) };
}

function nextDate(iso: string) {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function weekBounds(now: Date) {
  const today = getCRMDayBounds(now).start;
  const ist = new Date(today.getTime() + 330 * 60 * 1000);
  const weekday = ist.getUTCDay();
  const daysFromMonday = weekday === 0 ? 6 : weekday - 1;
  const start = new Date(today.getTime() - daysFromMonday * 24 * 60 * 60 * 1000);
  return { gte: start, lt: new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000) };
}

function last30Bounds(now: Date) {
  const today = getCRMDayBounds(now);
  return { gte: new Date(today.start.getTime() - 29 * 24 * 60 * 60 * 1000), lt: today.end };
}

function dateRange(value: string, operator: FilterOperator, now: Date): Record<string, Date> | null {
  if (operator === 'today' || (value === '$today' && operator === 'equals')) {
    const day = getCRMDayBounds(now);
    return { gte: day.start, lt: day.end };
  }
  if (operator === 'this_month' || (value === '$thisMonth' && operator === 'equals')) return monthBounds(now);
  if (operator === 'this_week') return weekBounds(now);
  if (operator === 'last_30_days') return last30Bounds(now);
  if (operator === 'between') {
    const [start, end] = value.split(',');
    if (!DATE_RE.test(start) || !DATE_RE.test(end)) return null;
    return { gte: crmDateToUtcStart(start), lt: crmDateToUtcStart(nextDate(end)) };
  }
  if (!DATE_RE.test(value)) return null;
  if (operator === 'equals') {
    const start = crmDateToUtcStart(value);
    return { gte: start, lt: crmDateToUtcStart(nextDate(value)) };
  }
  if (operator === 'greater_than') return { gte: crmDateToUtcStart(nextDate(value)) };
  if (operator === 'less_than') return { lt: crmDateToUtcStart(value) };
  return null;
}

function textClause(path: string, operator: FilterOperator, value: string) {
  const insensitive = { mode: 'insensitive' as const };
  if (operator === 'equals') return nest(path, { equals: value, ...insensitive });
  if (operator === 'not_equals') return { NOT: nest(path, { equals: value, ...insensitive }) };
  if (operator === 'contains') return nest(path, { contains: value, ...insensitive });
  if (operator === 'not_contains') return { NOT: nest(path, { contains: value, ...insensitive }) };
  if (operator === 'starts_with') return nest(path, { startsWith: value, ...insensitive });
  if (operator === 'is_empty') return { OR: [nest(path, null), nest(path, '')] };
  return { NOT: { OR: [nest(path, null), nest(path, '')] } };
}

function combine(paths: string[], operator: FilterOperator, build: (path: string) => Record<string, unknown>) {
  const clauses = paths.map(build);
  if (clauses.length === 1) return clauses[0];
  const negative = operator === 'not_equals' || operator === 'not_contains' || operator === 'is_empty';
  return negative ? { AND: clauses } : { OR: clauses };
}

function followUpStatus(operator: FilterOperator, value: string) {
  const positive = operator === 'equals';
  const clause = value === 'COMPLETED'
    ? { isCompleted: true }
    : value === 'MISSED'
      ? { isMissed: true }
      : { isCompleted: false, isMissed: false };
  return positive ? clause : { NOT: clause };
}

function presetWhere(preset: ListPreset, recentIds: string[], now: Date): Record<string, unknown> {
  if (preset === 'recent') return { id: { in: recentIds.length ? recentIds : ['__none__'] } };
  if (preset === 'leadOpen') return { status: { notIn: ['BOOKED', 'LOST'] } };
  if (preset === 'approvalsReviewed') return { approvalStatus: { in: ['APPROVED', 'REJECTED'] } };
  if (preset === 'siteVisitNotRescheduled') {
    return {
      OR: [
        { cancellationReason: null },
        { NOT: { cancellationReason: { startsWith: 'Rescheduled to ' } } },
      ],
    };
  }
  const today = getCRMDayBounds(now).start;
  return {
    OR: [
      { status: 'MISSED' },
      { status: 'SCHEDULED', scheduledAt: { lt: today } },
    ],
  };
}

function membershipValues(value: string, userId: string) {
  return value.split(',').map((item) => item.trim()).filter(Boolean).map((item) => (item === '$currentUser' ? userId : item));
}

function ruleClause(module: ListModule, item: FilterRule, userId: string, now: Date): Record<string, unknown> {
  const field = FIELDS[module].find((entry) => entry.key === item.field)!;
  if (field.virtual === 'followUpStatus') return followUpStatus(item.operator, item.value || '');
  if (item.operator === 'in' || item.operator === 'not_in') {
    const values = membershipValues(item.value || '', userId);
    return nest(field.paths![0], { [item.operator === 'in' ? 'in' : 'notIn']: values });
  }
  if (field.kind === 'date') {
    if (item.operator === 'is_empty') return nest(field.paths![0], null);
    if (item.operator === 'is_not_empty') return { NOT: nest(field.paths![0], null) };
    return nest(field.paths![0], dateRange(item.value || '', item.operator, now));
  }
  if (field.kind === 'number') {
    if (item.operator === 'is_empty') return nest(field.paths![0], null);
    if (item.operator === 'is_not_empty') return { NOT: nest(field.paths![0], null) };
    const amount = Number(item.value);
    const op = item.operator === 'equals' ? 'equals' : item.operator === 'not_equals' ? 'not' : item.operator === 'greater_than' ? 'gt' : 'lt';
    return nest(field.paths![0], { [op]: amount });
  }
  if (field.kind === 'boolean') return nest(field.paths![0], item.value === 'true');
  if (field.kind === 'user') {
    const id = item.value === '$currentUser' ? userId : item.value;
    if (item.operator === 'is_empty') return nest(field.paths![0], null);
    if (item.operator === 'is_not_empty') return { NOT: nest(field.paths![0], null) };
    if (item.operator === 'not_equals') return { NOT: nest(field.paths![0], id) };
    return nest(field.paths![0], id);
  }
  if (field.kind === 'enum') {
    if (item.operator === 'is_empty') return nest(field.paths![0], null);
    if (item.operator === 'is_not_empty') return { NOT: nest(field.paths![0], null) };
    if (item.operator === 'not_equals') return { NOT: nest(field.paths![0], item.value) };
    return nest(field.paths![0], item.value);
  }
  return combine(field.paths || [], item.operator, (path) => textClause(path, item.operator, item.value || ''));
}

function criteriaWhere(module: ListModule, filters: FilterSet, userId: string, now: Date) {
  const clauses = filters.rules.map((item) => ruleClause(module, item, userId, now));
  if (clauses.length === 0) return {};
  if (filters.version === 2) {
    if (!filters.filterLogic) return clauses.length === 1 ? clauses[0] : { AND: clauses };
    const byId = new Map(filters.rules.map((rule, index) => [rule.id || index + 1, clauses[index]]));
    const parsed = parseFilterLogic(filters.filterLogic, [...byId.keys()]);
    if (!parsed.ok) return { AND: clauses };
    const where = evaluateFilterLogic(parsed.ast, byId);
    return 'AND' in where && Array.isArray(where.AND) && where.AND.length === 1 ? where.AND[0] as Record<string, unknown> : where;
  }
  if (filters.logic === 'OR') return { OR: clauses };
  return clauses.length === 1 ? clauses[0] : { AND: clauses };
}

function ownerWhere(module: ListModule, filters: FilterSet, userId: string) {
  const path = OWNER_PATH[module];
  if (!path || filters.ownerFilter === 'ALL' || !filters.ownerFilter) return null;
  if (filters.ownerFilter === 'MINE') return nest(path, userId);
  return nest(path, { in: filters.ownerUserIds || [] });
}

export function compileListFilters(
  module: ListModule,
  filters: FilterSet,
  context: { userId: string; now?: Date; recentIds?: string[]; presets?: ListPreset[] },
): Record<string, unknown> {
  const now = context.now ?? new Date();
  const filterWhere = criteriaWhere(module, filters, context.userId, now);
  const owner = ownerWhere(module, filters, context.userId);
  const presets = (context.presets || []).map((preset) => presetWhere(preset, context.recentIds || [], now));
  const all = [...presets, ...(owner ? [owner] : []), ...(Object.keys(filterWhere).length ? [filterWhere] : [])];
  if (all.length === 0) return {};
  if (all.length === 1) return all[0];
  return { AND: all };
}

export function emptyFilters(): FilterSet {
  return { logic: 'AND', rules: [] };
}

type SortDirection = 'asc' | 'desc';

const SORTS: Record<ListModule, Record<string, (direction: SortDirection) => Record<string, unknown>>> = {
  LEAD: {
    leadNumber: (direction) => ({ leadNumber: direction }),
    firstName: (direction) => ({ firstName: direction }),
    company: (direction) => ({ company: direction }),
    email: (direction) => ({ email: direction }),
    phone: (direction) => ({ phone: direction }),
    source: (direction) => ({ source: direction }),
    status: (direction) => ({ status: direction }),
    assignedTo: (direction) => ({ owner: { firstName: direction } }),
    createdAt: (direction) => ({ createdAt: direction }),
  },
  FOLLOW_UP: {
    followUpNumber: (direction) => ({ followUpNumber: direction }),
    title: (direction) => ({ title: direction }),
    dueDate: (direction) => ({ dueDate: direction }),
    isCompleted: (direction) => ({ isCompleted: direction }),
    owner: (direction) => ({ owner: { firstName: direction } }),
    relatedTo: (direction) => ({ lead: { firstName: direction } }),
  },
  SITE_VISIT: {
    siteVisitNumber: (direction) => ({ siteVisitNumber: direction }),
    leadNumber: (direction) => ({ lead: { leadNumber: direction } }),
    leadName: (direction) => ({ lead: { firstName: direction } }),
    projectName: (direction) => ({ project: { name: direction } }),
    visitDate: (direction) => ({ scheduledAt: direction }),
    scheduledAt: (direction) => ({ scheduledAt: direction }),
    status: (direction) => ({ status: direction }),
    assignedTo: (direction) => ({ assignee: { firstName: direction } }),
    createdAt: (direction) => ({ createdAt: direction }),
    createdBy: (direction) => ({ creator: { firstName: direction } }),
  },
  BOOKING: {
    bookingNumber: (direction) => ({ bookingNumber: direction }),
    customer: (direction) => ({ quotation: { customerName: direction } }),
    project: (direction) => ({ project: { name: direction } }),
    plan: (direction) => ({ quotation: { paymentPlanName: direction } }),
    total: (direction) => ({ quotation: { totalPrice: direction } }),
    bookingAmount: (direction) => ({ bookingAmount: direction }),
    bookingStage: (direction) => ({ bookingStage: direction }),
    status: (direction) => ({ status: direction }),
    createdAt: (direction) => ({ createdAt: direction }),
  },
  PROJECT: {
    name: (direction) => ({ name: direction }),
    location: (direction) => ({ city: direction }),
    totalUnits: (direction) => ({ totalUnits: direction }),
    startDate: (direction) => ({ createdAt: direction }),
    createdAt: (direction) => ({ createdAt: direction }),
  },
  UNIT: {
    number: (direction) => ({ number: direction }),
    type: (direction) => ({ type: direction }),
    floor: (direction) => ({ floor: direction }),
    area: (direction) => ({ area: direction }),
    price: (direction) => ({ price: direction }),
    status: (direction) => ({ status: direction }),
    createdAt: (direction) => ({ createdAt: direction }),
  },
  MIS_APPROVAL: {
    receiptNumber: (direction) => ({ receiptNumber: direction }),
    leadNumber: (direction) => ({ lead: { leadNumber: direction } }),
    customer: (direction) => ({ lead: { firstName: direction } }),
    project: (direction) => ({ booking: { project: { name: direction } } }),
    unit: (direction) => ({ booking: { unit: { number: direction } } }),
    total: (direction) => ({ booking: { quotation: { totalPrice: direction } } }),
    approvalStatus: (direction) => ({ approvalStatus: direction }),
    approvalSubmittedAt: (direction) => ({ approvalSubmittedAt: direction }),
  },
};

export function listOrderBy(module: ListModule, sortBy: unknown, sortOrder: unknown) {
  if (typeof sortBy !== 'string' || !sortBy) return { ok: true as const, orderBy: null };
  if (sortOrder !== 'asc' && sortOrder !== 'desc') return { ok: false as const, error: 'Sort direction is invalid' };
  const builder = SORTS[module][sortBy];
  if (!builder) return { ok: false as const, error: 'That column cannot be sorted' };
  return { ok: true as const, orderBy: builder(sortOrder) };
}
