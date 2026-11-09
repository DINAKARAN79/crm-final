import { z } from 'zod';

export const PHONE_DUPLICATE_ERROR = 'Phone number already exists for another lead.';
export const DEFAULT_CRM_TIMEZONE = 'Asia/Kolkata';

export function resolveCRMTimezone(timeZone?: string | null): string {
  if (!timeZone) return DEFAULT_CRM_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return timeZone;
  } catch {
    return DEFAULT_CRM_TIMEZONE;
  }
}

export const PROSPECT_BUDGET_OPTIONS = [
  '5 lakhs', '10 lakhs', '15 lakhs', '20 lakhs', '25 lakhs', '30 lakhs', '35 lakhs',
  '40 lakhs', '45 lakhs', '50 lakhs', '75 lakhs', '1 crore', '1.5 crore', '2 crore',
  '3 crore', '5 crore', '10 crore', 'Not Revealed',
] as const;

export const PROSPECT_BEDROOM_OPTIONS = [
  'N/A', '1 BHK', '2 BHK', '3 BHK', '4 BHK', '5 BHK', '6+ BHK',
] as const;

export const PROSPECT_PROPERTY_TYPE_OPTIONS = [
  'Apartment', 'Commercial', 'Duplex', 'Floor Villa', 'Independent House', 'Plot', 'Villa', 'Other',
] as const;

export const PROSPECT_POSSESSION_OPTIONS = [
  'Ready to Move', 'Within 6 Months', '6-12 Months', '1-2 Years', '2+ Years',
] as const;

export const PROSPECT_REASON_TO_BUY_OPTIONS = [
  'Self Use', 'Investment', 'Rental Income', 'Family Use', 'Other',
] as const;

export const SITE_VISIT_TYPE_OPTIONS = ['Site Visit', 'Revisit', 'Booked Customer'] as const;

export const UNIT_PROPERTY_TYPES = ['Apartment', 'Plot', 'Villa'] as const;
export type UnitPropertyType = (typeof UNIT_PROPERTY_TYPES)[number];

export const APARTMENT_BLOCKS = ['Block 1', 'Block 2', 'Block 3'] as const;

export const APARTMENT_BLOCK_FLOORS: Record<(typeof APARTMENT_BLOCKS)[number], readonly number[]> = {
  'Block 1': [1, 2, 3],
  'Block 2': [1, 2, 3],
  'Block 3': [1, 2, 3],
};

export function isUnitPropertyType(value: string): value is UnitPropertyType {
  return (UNIT_PROPERTY_TYPES as readonly string[]).includes(value);
}

export function apartmentFloorsForBlock(block: string | null | undefined): number[] {
  if (!block) return [];
  const floors = APARTMENT_BLOCK_FLOORS[block as keyof typeof APARTMENT_BLOCK_FLOORS];
  return floors ? [...floors] : [];
}

export function formatApartmentFloor(floor: number): string {
  return `Floor ${floor}`;
}

export function villaRequiresBlockAndFloor(projectType?: string | null): boolean {
  const value = (projectType || '').trim().toLowerCase();
  return value.includes('block') || value.includes('floor');
}

export function unitUsesBlockAndFloor(type: string, projectType?: string | null): boolean {
  if (type === 'Apartment') return true;
  if (type === 'Villa') return villaRequiresBlockAndFloor(projectType);
  return false;
}

export function resolveUnitLocation(input: {
  type: string;
  block?: string | null;
  floor?: number | null;
  projectType?: string | null;
}): { ok: true; type: string; block: string | null; floor: number | null } | { ok: false; error: string } {
  const type = input.type.trim();
  if (!isUnitPropertyType(type)) {
    return { ok: false, error: 'Choose Apartment, Plot, or Villa.' };
  }
  if (!unitUsesBlockAndFloor(type, input.projectType)) {
    return { ok: true, type, block: null, floor: null };
  }
  const block = (input.block || '').trim();
  const floors = apartmentFloorsForBlock(block);
  if (!floors.length) {
    return { ok: false, error: 'Block is required.' };
  }
  if (input.floor == null || !floors.includes(input.floor)) {
    return { ok: false, error: 'Floor is required for this block.' };
  }
  return { ok: true, type, block, floor: input.floor };
}

export const ORGANIZATION_TYPES = ['Individual', 'Business', 'Company', 'Government'] as const;

export const INDIAN_STATES = [
  'Andaman and Nicobar Islands',
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chandigarh',
  'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jammu and Kashmir',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Ladakh',
  'Lakshadweep',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Puducherry',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
] as const;

export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/i;

export type QuotationPropertyKind = 'apartment' | 'plot' | 'villa' | 'other';

export function quotationPropertyKind(unitType?: string | null): QuotationPropertyKind {
  const value = (unitType || '').trim().toLowerCase();
  if (!value) return 'other';
  if (value.includes('apartment') || value.includes('flat')) return 'apartment';
  if (value.includes('villa')) return 'villa';
  if (value.includes('plot') || value === 'land') return 'plot';
  return 'other';
}

const quotationBlank = '—';

function quotationText(value?: string | number | null): string {
  if (value == null) return quotationBlank;
  const text = String(value).trim();
  return text || quotationBlank;
}

function quotationArea(area?: number | null): string {
  if (area == null || !Number.isFinite(area)) return quotationBlank;
  return `${area.toLocaleString('en-IN')} sq ft`;
}

export function quotationPropertyFields(input: {
  unitType?: string | null;
  unitNumber?: string | null;
  block?: string | null;
  floor?: number | null;
  area?: number | null;
}): Array<{ label: string; value: string }> {
  const kind = quotationPropertyKind(input.unitType);
  const propertyType = quotationText(input.unitType);
  if (kind === 'apartment') {
    return [
      { label: 'Property type', value: propertyType },
      { label: 'Block', value: quotationText(input.block) },
      { label: 'Floor', value: input.floor == null ? quotationBlank : formatApartmentFloor(input.floor) },
      { label: 'Unit number', value: quotationText(input.unitNumber) },
    ];
  }
  if (kind === 'plot') {
    return [
      { label: 'Property type', value: propertyType },
      { label: 'Plot number', value: quotationText(input.unitNumber) },
      { label: 'Land area', value: quotationArea(input.area) },
    ];
  }
  if (kind === 'villa') {
    return [
      { label: 'Property type', value: propertyType },
      { label: 'Villa number', value: quotationText(input.unitNumber) },
      { label: 'Built-up / land area', value: quotationArea(input.area) },
    ];
  }
  return [
    { label: 'Property type', value: propertyType },
    { label: 'Unit number', value: quotationText(input.unitNumber) },
    { label: 'Area', value: quotationArea(input.area) },
  ];
}

export function quotationScheduleAmounts(totalPrice: number, percentages: number[]): number[] {
  const amounts = percentages.map((percentage) => Math.round((totalPrice * percentage) / 100 * 100) / 100);
  const allocated = Math.round(amounts.reduce((sum, amount) => sum + amount, 0) * 100) / 100;
  const remainder = Math.round((totalPrice - allocated) * 100) / 100;
  if (amounts.length > 0) {
    amounts[amounts.length - 1] = Math.round((amounts[amounts.length - 1] + remainder) * 100) / 100;
  }
  return amounts;
}

export function quotationDueLabel(installment: { dueDays?: number | null; dueMonths?: number | null }): string {
  if (installment.dueDays != null && Number.isFinite(installment.dueDays)) {
    const days = installment.dueDays;
    if (days === 0) return 'Due after 0 days';
    if (days === 1) return 'After 1 day';
    return `After ${days} days`;
  }
  const months = installment.dueMonths ?? 0;
  if (months === 0) return 'On confirmation';
  if (months === 1) return 'After 1 month';
  return `After ${months} months`;
}

export const SITE_VISIT_RATING_OPTIONS = ['Hot', 'Warm', 'Cold'] as const;

export const SITE_VISIT_TRANSPORT_OPTIONS = ['Self', 'Cab'] as const;

export const SITE_VISIT_FUTURE_TIME_ERROR = 'Site visit can only be scheduled for a future date and time.';

export function normalizePermissionName(permissionName: string): string {
  const normalized = permissionName.trim().toUpperCase();
  const aliases: Record<string, string> = {
    EDIT: 'UPDATE',
    VIEW: 'READ',
    DELECT: 'DELETE',
  };

  return normalized.replace(/_(EDIT|VIEW|DELECT)$/, (suffix) => `_${aliases[suffix.slice(1)]}`);
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getCRMFormatter(options: Intl.DateTimeFormatOptions, timeZone = DEFAULT_CRM_TIMEZONE): Intl.DateTimeFormat {
  const resolvedTimeZone = resolveCRMTimezone(timeZone);
  const key = JSON.stringify([options, resolvedTimeZone]);
  let formatter = formatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-IN', { ...options, timeZone: resolvedTimeZone });
    formatterCache.set(key, formatter);
  }
  return formatter;
}

export function formatCRMDate(value: string | number | Date, timeZone = DEFAULT_CRM_TIMEZONE): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return getCRMFormatter({ day: 'numeric', month: 'short', year: 'numeric' }, timeZone).format(date);
}

export function formatCRMDateTime(value: string | number | Date, timeZone = DEFAULT_CRM_TIMEZONE): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return getCRMFormatter({
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }, timeZone).format(date);
}

export function crmLocalDateTimeToDate(date: string, time: string, timeZone = DEFAULT_CRM_TIMEZONE): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || !timeMatch) throw new Error('Invalid CRM date/time');
  const [, year, month, day] = match;
  const [, hour, minute] = timeMatch;
  const resolvedTimeZone = resolveCRMTimezone(timeZone);
  const desired = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: resolvedTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  let timestamp = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
    const represented = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    const next = desired - (represented - timestamp);
    if (next === timestamp) break;
    timestamp = next;
  }
  return new Date(timestamp);
}

export function crmDateToUtcStart(date: string, timeZone = DEFAULT_CRM_TIMEZONE): Date {
  return crmLocalDateTimeToDate(date, '00:00', timeZone);
}

/** Inclusive CRM-calendar range. The end bound is the start of the next day, so the selected To Date includes every timestamp on that day. */
export function crmDateRangeBounds(startDate?: string, endDate?: string, timeZone = DEFAULT_CRM_TIMEZONE): { gte?: Date; lt?: Date } | { error: string } {
  const start = startDate?.trim() || '';
  const end = endDate?.trim() || '';
  if (start && !/^\d{4}-\d{2}-\d{2}$/.test(start)) return { error: 'From Date is invalid' };
  if (end && !/^\d{4}-\d{2}-\d{2}$/.test(end)) return { error: 'To Date is invalid' };
  if (start && end && start > end) return { error: 'To Date cannot be earlier than From Date' };
  const range: { gte?: Date; lt?: Date } = {};
  if (start) range.gte = crmDateToUtcStart(start, timeZone);
  if (end) {
    const [year, month, day] = end.split('-').map(Number);
    const nextDate = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
    range.lt = crmDateToUtcStart(nextDate, timeZone);
  }
  return range;
}

export function crmDateTimeInputValue(value = new Date(), timeZone = DEFAULT_CRM_TIMEZONE): string {
  const parts = getCRMFormatter({
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }, timeZone).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

export function getCRMDayBounds(now = new Date(), timeZone = DEFAULT_CRM_TIMEZONE): { start: Date; end: Date } {
  const parts = getCRMFormatter({
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }, timeZone).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const date = `${values.year}-${values.month}-${values.day}`;
  const start = crmDateToUtcStart(date, timeZone);
  const nextDate = new Date(`${date}T00:00:00.000Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  return { start, end: crmDateToUtcStart(nextDate.toISOString().slice(0, 10), timeZone) };
}

export function normalizePhone(raw: string): string {
  return raw.replace(/\s+/g, '');
}

export const PHONE_REQUIRED_MESSAGE = 'Phone is required';
export const PHONE_INVALID_MESSAGE = 'Enter a valid phone number with 10 to 15 digits.';

const COUNTRY_DIAL_CODES: Record<string, string> = {
  india: '91',
  in: '91',
  'united states': '1',
  'united states of america': '1',
  us: '1',
  usa: '1',
  'united kingdom': '44',
  uk: '44',
  gb: '44',
  uae: '971',
  'united arab emirates': '971',
  australia: '61',
  au: '61',
  singapore: '65',
  sg: '65',
};

const NATIONAL_LENGTHS: Record<string, number> = {
  '1': 10,
  '44': 10,
  '91': 10,
  '971': 9,
  '61': 9,
  '65': 8,
};

export function countryDialCode(country: string | null | undefined, fallback = '91'): string {
  const trimmed = country?.trim() || '';
  if (!trimmed) return fallback;
  if (/^\+?\d{1,3}$/.test(trimmed)) {
    const digits = trimmed.replace(/\D/g, '').replace(/^00/, '');
    return /^[1-9]\d{0,2}$/.test(digits) ? digits : fallback;
  }
  return COUNTRY_DIAL_CODES[trimmed.toLowerCase()] || fallback;
}

export function normalizeUserPhone(
  value: string | null | undefined,
  country?: string | null,
): { e164: string } | { error: string } {
  const raw = value?.trim() ?? '';
  if (!raw) return { error: PHONE_REQUIRED_MESSAGE };
  if (/[a-z]/i.test(raw)) return { error: PHONE_INVALID_MESSAGE };

  const compact = raw.replace(/[\s().-]/g, '');
  if (!/^\+?\d+$/.test(compact) && !/^00\d+$/.test(compact)) return { error: PHONE_INVALID_MESSAGE };

  const explicitInternational = compact.startsWith('+') || compact.startsWith('00');
  let digits = compact.replace(/\D/g, '');
  if (compact.startsWith('00')) digits = digits.slice(2);
  if (!explicitInternational) {
    digits = digits.replace(/^0+/, '');
    const code = countryDialCode(country);
    const nationalLength = NATIONAL_LENGTHS[code];
    const alreadyInternational = digits.startsWith(code)
      && digits.length > (nationalLength ?? code.length)
      && digits.length <= 15;
    if (!alreadyInternational) digits = `${code}${digits}`;
  }
  if (digits.length < 10 || digits.length > 15 || !/^[1-9]\d+$/.test(digits)) {
    return { error: PHONE_INVALID_MESSAGE };
  }
  return { e164: `+${digits}` };
}

// ============================================
// AUTH SCHEMAS
// ============================================

export const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

// ============================================
// CRM SCHEMAS
// ============================================

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const LEAD_STATUS_DEFINITIONS = [
  { id: '1', value: 'NEW', defaultLabel: 'New' },
  { id: '2', value: 'INCOMING', defaultLabel: 'Incoming' },
  { id: '3', value: 'PROSPECT', defaultLabel: 'Prospect' },
  { id: '4', value: 'SITE_VISIT_SCHEDULED', defaultLabel: 'Site Visit Scheduled' },
  { id: '5', value: 'SITE_VISIT_HAPPENED', defaultLabel: 'Site Visit Happened' },
  { id: '6', value: 'BOOKED', defaultLabel: 'Booked' },
  { id: '7', value: 'LOST', defaultLabel: 'Lost' },
] as const;

export type LeadStatusValue = typeof LEAD_STATUS_DEFINITIONS[number]['value'];

export function leadStatusFromId(statusId: string | number): LeadStatusValue | undefined {
  return LEAD_STATUS_DEFINITIONS.find((status) => status.id === String(statusId))?.value;
}

export function leadStatusIdFromValue(value: string): string | undefined {
  return LEAD_STATUS_DEFINITIONS.find((status) => status.value === value)?.id;
}

export function getDefaultLeadStatusLabel(value: string): string {
  return LEAD_STATUS_DEFINITIONS.find((status) => status.value === value)?.defaultLabel || value;
}

export const leadSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string({
    required_error: 'Last name is required',
    invalid_type_error: 'Last name is required',
  }).trim().min(1, 'Last name is required'),
  salutation: z.enum(['MR', 'MS', 'MRS', 'DR', 'PROF']).optional(),
  title: z.string().optional(),
  email: z.string().trim().email().optional().or(z.literal('')),
  phone: z.string({
    required_error: 'Phone number is required.',
    invalid_type_error: 'Phone number is required.',
  }).trim().min(1, 'Phone number is required.').transform(normalizePhone),
  mobile: z.string().optional(),
  website: z.string().url().optional().or(z.literal('')),
  company: z.string({
    required_error: 'Company is required',
    invalid_type_error: 'Company is required',
  }).trim().min(1, 'Company is required'),
  industry: z.enum(['TECHNOLOGY', 'HEALTHCARE', 'FINANCE', 'EDUCATION', 'MANUFACTURING', 'RETAIL', 'REAL_ESTATE', 'CONSTRUCTION', 'HOSPITALITY', 'AUTOMOTIVE', 'ENERGY', 'TELECOMMUNICATIONS', 'MEDIA', 'GOVERNMENT', 'OTHER']).optional(),
  annualRevenue: z.number().optional(),
  numberOfEmployees: z.number().optional(),
  source: z.string({
    required_error: 'Lead Source is required.',
    invalid_type_error: 'Lead Source is required.',
  }).trim().min(1, 'Lead Source is required.'),
  status: z.enum(['NEW', 'INCOMING', 'PROSPECT', 'SITE_VISIT_SCHEDULED', 'SITE_VISIT_HAPPENED', 'BOOKED', 'LOST']).optional(),
  statusId: z.enum(['1', '2', '3', '4', '5', '6', '7']).optional(),
  rating: z.enum(['HOT', 'WARM', 'COLD']).optional(),
  leadInterest: z.string().trim().optional(),
  firstCampaign: z.string().trim().optional(),
  lastCampaign: z.string().trim().optional(),
  description: z.string().optional(),
  street: z.string().optional(),
  city: z.string().optional(),
  stateProvince: z.string().optional(),
  country: z.string().optional(),
  postalCode: z.string().optional(),
  score: z.number().optional(),
  budget: z.number().optional(),
  requirements: z.string().optional(),
  notes: z.string().optional(),
  customFields: z.record(z.string(), jsonValueSchema).optional(),
  ownerId: z.string().optional(),
  projectId: z.string().nullable().optional(),
}).strict();

export const leadCreateSchema = leadSchema.omit({
  ownerId: true,
});

export const leadUpdateSchema = leadSchema.partial().strip();

export const siteVisitSchema = z.object({
  leadId: z.string().min(1),
  projectId: z.string().min(1, 'Project is required'),
  assigneeId: z.string().optional(),
  scheduledAt: z.string().datetime(),
  notes: z.string().min(1, 'Note/reason is required'),
  customFields: z.record(z.string(), jsonValueSchema).optional(),
});

export const opportunitySchema = z.object({
  name: z.string().min(1),
  stage: z.enum(['PROSPECTING', 'QUALIFICATION', 'NEEDS_ANALYSIS', 'PROPOSAL', 'NEGOTIATION', 'CLOSED_WON', 'CLOSED_LOST']).default('PROSPECTING'),
  amount: z.number().optional(),
  expectedCloseDate: z.string().optional(),
  probability: z.number().min(0).max(100).optional(),
  description: z.string().optional(),
  leadId: z.string().optional(),
  ownerId: z.string().optional(),
  projectId: z.string().optional(),
});

export const quotationSchema = z.object({
  opportunityId: z.string().optional(),
  leadId: z.string().optional(),
  projectId: z.string().optional(),
  totalAmount: z.number().min(0),
  taxAmount: z.number().optional(),
  discount: z.number().optional(),
  validUntil: z.string().optional(),
  notes: z.string().optional(),
  items: z.array(z.object({
    unitId: z.string().optional(),
    description: z.string().min(1),
    quantity: z.number().min(1).default(1),
    unitPrice: z.number().min(0),
    totalPrice: z.number().min(0),
  })),
});

export const bookingSchema = z.object({
  leadId: z.string().optional(),
  opportunityId: z.string().optional(),
  quotationId: z.string().optional(),
  projectId: z.string().min(1),
  unitId: z.string().min(1),
  ownerId: z.string().optional(),
  totalAmount: z.number().min(0),
  notes: z.string().optional(),
});

export const paymentSchema = z.object({
  bookingId: z.string().min(1),
  amount: z.number().min(0.01),
  reference: z.string().optional(),
  notes: z.string().optional(),
});

export const projectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zipCode: z.string().optional(),
  totalUnits: z.number().optional(),
});

export const unitSchema = z.object({
  projectId: z.string().min(1),
  number: z.string().min(1),
  type: z.string().optional(),
  floor: z.number().optional(),
  area: z.number().optional(),
  price: z.number().optional(),
  status: z.enum(['AVAILABLE', 'HOLD', 'RESERVED', 'BOOKED', 'SOLD', 'BLOCKED']).default('AVAILABLE'),
});

export const taskSchema = z.object({
  title: z.string().trim().min(1, 'Title/Subject is required').max(255),
  subject: z.string().trim().min(1, 'Subject is required').max(255).optional(),
  description: z.string().max(32000).optional(),
  status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).default('PENDING'),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  salesforceStatus: z.string().max(255).optional(),
  salesforcePriority: z.string().max(255).optional(),
  dueDate: z.string().refine(
    (value) => {
      const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
      const parsed = Date.parse(dateOnly ? `${value}T00:00:00.000Z` : value);
      return !Number.isNaN(parsed) && (!dateOnly || new Date(parsed).toISOString().slice(0, 10) === value);
    },
    'Due date must be a valid date',
  ),
  completedAt: z.string().datetime().optional(),
  ownerId: z.string().min(1).optional(),
  leadId: z.string().optional(),
  siteVisitId: z.string().optional(),
  opportunityId: z.string().optional(),
  bookingId: z.string().optional(),
  projectId: z.string().optional(),
  unitId: z.string().optional(),
  callDurationInSeconds: z.number().int().min(0).max(99999999).nullable().optional(),
  callObject: z.string().max(255).nullable().optional(),
  callDisposition: z.string().max(255).nullable().optional(),
  callType: z.string().max(255).nullable().optional(),
  isRecurrence: z.boolean().optional(),
  recurrenceInterval: z.number().int().min(0).max(999999999).nullable().optional(),
  email: z.union([z.string().email().max(255), z.literal('')]).nullable().optional(),
  phone: z.string().max(255).nullable().optional(),
  isVisibleInSelfService: z.boolean().optional(),
  isReminderSet: z.boolean().optional(),
  recurrenceRegeneratedType: z.string().max(255).nullable().optional(),
  taskSubtype: z.string().max(255).nullable().optional(),
  taskType: z.string().max(255).nullable().optional(),
});

export const followUpSchema = z.object({
  title: z.string().min(1, 'Title/Note is required'),
  description: z.string().min(1, 'Description/Note is required'),
  dueDate: z.string().min(1, 'Due date is required'),
  leadId: z.string().optional(),
  enquiryId: z.string().nullable().optional(),
  bookingId: z.string().nullable().optional(),
  ownerId: z.string().min(1, 'Assigned user is required').optional(),
  assignedToId: z.string().nullable().optional(),
  subject: z.string().max(131072).nullable().optional(),
  comments: z.string().max(5000).nullable().optional(),
  previousDisposition: z.string().max(5000).nullable().optional(),
  cancelledReason: z.string().max(255).nullable().optional(),
  status: z.enum(['SCHEDULED', 'COMPLETED', 'MISSED', 'CANCELLED']).optional(),
  awaitedFollowUp: z.boolean().optional(),
  isSystemCancelled: z.boolean().optional(),
  testCheckbox: z.boolean().optional(),
});

export const activitySchema = z.object({
  type: z.enum(['CALL', 'MEETING', 'WHATSAPP', 'EMAIL', 'SITE_VISIT', 'NOTE', 'TASK', 'FOLLOW_UP', 'SYSTEM', 'SCHEDULE', 'MEMO']),
  subject: z.string().trim().min(1, 'Subject is required').max(200),
  description: z.string().trim().max(5000).optional(),
  dueDate: z.string().optional(),
  leadId: z.string().min(1).nullable().optional(),
  customerId: z.string().min(1).nullable().optional(),
  siteVisitId: z.string().min(1).nullable().optional(),
  opportunityId: z.string().min(1).nullable().optional(),
  bookingId: z.string().min(1).nullable().optional(),
  startAt: z.string().datetime({ offset: true }).nullable().optional(),
  endAt: z.string().datetime({ offset: true }).nullable().optional(),
  status: z.enum(['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  assignedToId: z.string().min(1).nullable().optional(),
  location: z.string().trim().max(300).nullable().optional(),
  meetingUrl: z.string().trim().max(2048).url('Meeting link must be a valid URL').refine(
    (value) => /^https?:\/\//i.test(value),
    'Meeting link must use http or https',
  ).nullable().optional(),
  reminderAt: z.string().datetime({ offset: true }).nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
});

// ============================================
// API RESPONSE TYPES
// ============================================

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  pagination?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// ============================================
// SEARCH TYPES
// ============================================

export interface SearchResult {
  id: string;
  type: string;
  title: string;
  subtitle?: string;
  url: string;
  tenantId: string;
}
export * from './booking-object';
export * from './quote-unit-facets';
export * from './list-view-logic';
export * from './page-layout';
