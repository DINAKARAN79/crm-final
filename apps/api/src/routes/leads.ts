import { Router, Response } from 'express';
import { prisma } from '@dct-crm/db';
import {
  leadCreateSchema,
  leadUpdateSchema,
  normalizePhone,
  PHONE_DUPLICATE_ERROR,
  PROSPECT_BEDROOM_OPTIONS,
  PROSPECT_BUDGET_OPTIONS,
  PROSPECT_POSSESSION_OPTIONS,
  PROSPECT_PROPERTY_TYPE_OPTIONS,
  PROSPECT_REASON_TO_BUY_OPTIONS,
  SITE_VISIT_FUTURE_TIME_ERROR,
  SITE_VISIT_RATING_OPTIONS,
  SITE_VISIT_TRANSPORT_OPTIONS,
  SITE_VISIT_TYPE_OPTIONS,
  leadStatusFromId,
  type JsonValue,
} from '@dct-crm/shared';
import { authenticate, AuthRequest } from '../middleware/auth';
import { listOrderBy, listViewConstraint, mergeListWhere } from '../services/listViewService';
import { authorize } from '../middleware/authorization';
import { EffectivePermissionService } from '../services/effectivePermissions';
import { canScheduleSiteVisit, canTransitionStatus, canonicalProfileName, isValidStatus } from '../services/workflow';
import { createOwnerHistory, getOwnerHistory } from '../services/ownerHistory';
import {
  canAccessLead,
  getLeadRecordScope,
  leadScopeClause,
} from '../services/recordAccess';
import { followUpOwnerClause } from '../services/followUpAccess';
import { getNextSiteVisitNumber, normalizeOverdueFollowUps, normalizeOverdueSiteVisits } from '../services/leadWorkflowExtras';
import { validateObjectCustomFields } from '../services/customFieldValidation';
import { layoutWriteError } from '../services/layoutAccess';
import {
  assignLeadToProjectRoundRobinInTransaction,
  assignSiteVisitToSVCInTransaction,
  assignCompletedSiteVisitToSalesInTransaction,
  findApplicableRRQueue,
  hasLeadAssignmentRelevantChanges,
  isLeadEligibleForAutoAssignment,
  RoundRobinAssignmentService,
} from '../services/rrQueue';
import { changeLeadOwner, getEligibleLeadOwners } from '../services/leadOwnerChange';
import { processLeadEnquiry, sourceEnumValue } from '../services/enquiryProcessing';
import { getLeadEnquiries } from '../services/enquiryService';
import { mergeOperationalLeadCustomFields } from '../services/leadEventTagging';
import { appendLeadProcessNote } from '../services/leadNotes';
import { ensureProspectLeadFields, type ProspectLeadDetails } from '../services/prospectLeadFields';
import { ensureSiteVisitScheduleFields } from '../services/siteVisitScheduleFields';
import {
  duplicateLeadFields,
  duplicateLeadMessage,
  findLeadDuplicates,
  validateLeadContactInput,
} from '../services/leadDuplicateDetection';
import { getLeadPicklistOptions, validateLeadPicklists } from '../services/leadPicklists';
import { z } from 'zod';
import { decorateLeadStatus, decorateLeads, getLeadStatusSettings, isLeadStatusEnabled } from '../services/leadStatusSettings';
import { withImpersonatorNames } from '../services/impersonation';

const router = Router();
const pushToSvcRequestSchema = z.object({
  reason: z.string().trim().min(1, 'Reason/note is required for status change')
    .max(2000, 'Reason/note must be 2000 characters or fewer'),
  projectId: z.string().trim().min(1, 'Project is required'),
  prospectDetails: z.object({
    callSummaryRemarks: z.string().trim().min(1, 'Call summary/remarks are required').max(5000),
    minimumBudget: z.string().refine((value) => PROSPECT_BUDGET_OPTIONS.includes(value as typeof PROSPECT_BUDGET_OPTIONS[number])),
    maximumBudget: z.string().refine((value) => PROSPECT_BUDGET_OPTIONS.includes(value as typeof PROSPECT_BUDGET_OPTIONS[number])),
    bedroomPreference: z.array(z.string().refine((value) => PROSPECT_BEDROOM_OPTIONS.includes(value as typeof PROSPECT_BEDROOM_OPTIONS[number]))).min(1),
    propertyType: z.array(z.string().refine((value) => PROSPECT_PROPERTY_TYPE_OPTIONS.includes(value as typeof PROSPECT_PROPERTY_TYPE_OPTIONS[number]))).min(1),
    possession: z.string().refine((value) => !value || PROSPECT_POSSESSION_OPTIONS.includes(value as typeof PROSPECT_POSSESSION_OPTIONS[number])).optional(),
    reasonToBuy: z.string().refine((value) => !value || PROSPECT_REASON_TO_BUY_OPTIONS.includes(value as typeof PROSPECT_REASON_TO_BUY_OPTIONS[number])).optional(),
  }),
});

router.use(authenticate);

/**
 * A selected tenant narrows Superadmin operations to that company. Requests
 * without an explicit tenant retain the existing cross-company behavior.
 */
function leadIdScope(req: AuthRequest): { tenantId?: string } {
  if (req.impersonation) return { tenantId: req.tenantId! };
  return req.user!.isSuperAdmin && typeof req.query.tenantId !== 'string'
    ? {}
    : { tenantId: req.tenantId! };
}

async function getAccessibleDuplicateLeadIds(req: AuthRequest, leadIds: string[]): Promise<string[]> {
  const candidates = await prisma.lead.findMany({
    where: { id: { in: leadIds }, ...leadIdScope(req) },
    select: { id: true, tenantId: true, ownerId: true, creatorId: true },
  });
  const accessible = await Promise.all(candidates.map(async (lead) =>
    (await canAccessLead(req.user!, lead)) ? lead.id : null,
  ));
  return accessible.filter((id): id is string => Boolean(id));
}

const duplicatePreviewSchema = z.object({
  phone: z.string().trim().max(64).optional(),
  mobile: z.string().trim().max(64).optional(),
  secondaryPhone: z.string().trim().max(64).optional(),
  tertiaryPhone: z.string().trim().max(64).optional(),
  countryCode: z.string().trim().max(8).optional(),
  secondaryCountryCode: z.string().trim().max(8).optional(),
  tertiaryCountryCode: z.string().trim().max(8).optional(),
  email: z.string().trim().max(254).optional(),
  secondaryEmail: z.string().trim().max(254).optional(),
  tertiaryEmail: z.string().trim().max(254).optional(),
});

function duplicateContactInput(
  input: z.infer<typeof duplicatePreviewSchema>,
) {
  const countryCode = input.countryCode || '91';
  return {
    phones: [
      { field: 'phone', value: input.phone, countryCode },
      { field: 'mobile', value: input.mobile, countryCode },
      { field: 'secondaryPhone', value: input.secondaryPhone, countryCode: input.secondaryCountryCode || countryCode },
      { field: 'tertiaryPhone', value: input.tertiaryPhone, countryCode: input.tertiaryCountryCode || input.secondaryCountryCode || countryCode },
    ],
    emails: [
      { field: 'email', value: input.email },
      { field: 'secondaryEmail', value: input.secondaryEmail },
      { field: 'tertiaryEmail', value: input.tertiaryEmail },
    ],
  };
}

async function validateLeadCustomFields(
  tenantId: string,
  values: Record<string, unknown>,
  requireRequiredFields: boolean,
): Promise<string | null> {
  return validateObjectCustomFields(tenantId, 'Lead', values, requireRequiredFields);
}

/**
 * Human-facing audit display: keys whose values are user IDs. The audit
 * history endpoints resolve them to display names so the UI never shows raw
 * internal user IDs. IDs are resolved in a single batched query (no N+1).
 */
const AUDIT_USER_KEYS = new Set([
  'ownerId',
  'previousOwnerId',
  'newOwnerId',
  'changedById',
  'createdById',
  'updatedById',
  'completedById',
  'cancelledById',
  'assignedById',
  'performedById',
  'userId',
  'changedBy',
  'createdBy',
  'updatedBy',
  'assignedBy',
  'performedBy',
]);

function auditDisplayValues(
  values: Record<string, unknown> | null | undefined,
  nameById: Map<string, string>,
): Record<string, unknown> | null | undefined {
  if (!values || typeof values !== 'object') return values;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (AUDIT_USER_KEYS.has(key)) {
      const siblingNameKey = key.endsWith('Id') ? `${key.slice(0, -2)}Name` : null;
      const hasSiblingName =
        !!siblingNameKey &&
        typeof (values as Record<string, unknown>)[siblingNameKey] === 'string' &&
        String((values as Record<string, unknown>)[siblingNameKey]).length > 0;
      if (hasSiblingName) {
        // Explicit *Name sibling present: keep the pair (the UI renders the
        // name row and skips the raw id — see getAuditChanges).
        out[key] = value;
        continue;
      }
      if (typeof value === 'string' && nameById.has(value)) {
        // No name sibling: resolve the id to a display name so nothing raw
        // is ever surfaced by consumers.
        out[key] = nameById.get(value);
        continue;
      }
      if (value === null && key.endsWith('ById')) {
        out[key] = 'System';
        continue;
      }
    }
    out[key] = value;
  }
  return out;
}

async function enrichAuditLogs<T extends { oldValues?: unknown; newValues?: unknown }>(logs: T[]) {
  const ids = new Set<string>();
  for (const log of logs) {
    for (const values of [log.oldValues, log.newValues]) {
      if (!values || typeof values !== 'object') continue;
      for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
        if (AUDIT_USER_KEYS.has(key) && typeof value === 'string' && value.startsWith('c')) {
          ids.add(value);
        }
      }
    }
  }
  const users = ids.size
    ? await prisma.user.findMany({
        where: { id: { in: [...ids] } },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  const nameById = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));

  return logs.map((log) => ({
    ...log,
    oldValues: auditDisplayValues(log.oldValues as Record<string, unknown> | null | undefined, nameById),
    newValues: auditDisplayValues(log.newValues as Record<string, unknown> | null | undefined, nameById),
  }));
}

async function findPhoneConflict(
  tenantId: string,
  phone: string,
  excludeLeadId?: string,
): Promise<boolean> {
  const normalized = normalizePhone(phone);
  const candidates = await prisma.lead.findMany({
    where: {
      tenantId,
      phone: { not: null },
      ...(excludeLeadId ? { id: { not: excludeLeadId } } : {}),
    },
    select: { id: true, phone: true },
  });
  return candidates.some(
    (lead) => lead.phone != null && normalizePhone(lead.phone) === normalized,
  );
}

function isPhoneUniqueViolation(error: any): boolean {
  if (error?.code !== 'P2002') return false;
  const target = error?.meta?.target;
  if (Array.isArray(target)) return target.includes('phone');
  if (typeof target === 'string') return target.includes('phone');
  return false;
}

function uniqueLeadContactFields(error: any): Array<'phone' | 'email'> {
  if (error?.code !== 'P2002') return [];
  const target = Array.isArray(error?.meta?.target)
    ? error.meta.target.join(',')
    : String(error?.meta?.target || '');
  const fields: Array<'phone' | 'email'> = [];
  if (/normalizedPhone|phone/i.test(target)) fields.push('phone');
  if (/normalizedEmail|email/i.test(target)) fields.push('email');
  return fields;
}

type LeadDeletionStep =
  | { name: 'lead'; where: { id: string } }
  | {
      name: 'activity' | 'followUp' | 'leadOwnerHistory' | 'siteVisit' | 'callDetail';
      where: Record<string, any>;
    };

export function buildLeadDeletionPlan(leadId: string): LeadDeletionStep[] {
  return [
    { name: 'activity', where: { OR: [{ leadId }, { siteVisit: { leadId } }] } },
    { name: 'followUp', where: { leadId } },
    { name: 'leadOwnerHistory', where: { leadId } },
    { name: 'callDetail', where: { leadId } },
    { name: 'siteVisit', where: { leadId } },
    { name: 'lead', where: { id: leadId } },
  ];
}

const LEAD_DIFFABLE_FIELDS = [
  'firstName', 'lastName', 'salutation', 'title', 'email', 'phone', 'mobile',
  'website', 'company', 'industry', 'annualRevenue', 'numberOfEmployees',
  'source', 'status', 'rating', 'description', 'street', 'city',
  'stateProvince', 'country', 'postalCode', 'score', 'budget',
  'requirements', 'notes', 'ownerId', 'projectId',
  'customFields',
] as const;

function normalizeDiffValue(value: any): any {
  if (value === undefined) return null;
  if (value === '') return null;
  return value;
}

function areJsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => areJsonValuesEqual(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      areJsonValuesEqual(leftRecord[key], rightRecord[key]),
    );
}

function computeLeadDiff(
  existing: Record<string, any>,
  incoming: Record<string, any>,
): { oldValues: Record<string, any>; newValues: Record<string, any>; updateData: Record<string, any> } {
  const oldValues: Record<string, any> = {};
  const newValues: Record<string, any> = {};
  const updateData: Record<string, any> = {};

  for (const field of LEAD_DIFFABLE_FIELDS) {
    if (!(field in incoming)) continue;
    const incomingValue = normalizeDiffValue((incoming as Record<string, any>)[field]);
    const existingValue = normalizeDiffValue(existing[field]);
    if (
      field === 'customFields'
        ? areJsonValuesEqual(incomingValue, existingValue)
        : incomingValue === existingValue
    ) continue;
    oldValues[field] = existingValue;
    newValues[field] = incomingValue;
    updateData[field] = (incoming as Record<string, any>)[field] === '' ? null : (incoming as Record<string, any>)[field];
  }

  return { oldValues, newValues, updateData };
}

router.get('/', authorize('Lead', 'read'), async (req: AuthRequest, res: Response) => {
  try {
    const { page = 1, limit = 20, status, source, ownerId, search, sortBy = 'createdAt', sortOrder = 'desc', from, to } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const where: any = {};
    if (req.impersonation || !req.user!.isSuperAdmin || typeof req.query.tenantId === 'string') {
      where.tenantId = req.tenantId!;
    }
    const scope = await getLeadRecordScope(req.user!);
    const scopeClause = leadScopeClause(scope);
    if (scopeClause) {
      where.AND = Array.isArray(where.AND) ? [...where.AND, scopeClause] : [scopeClause];
    }
    if (status && status !== 'All Statuses') {
      const requestedStatus = String(status);
      const normalizedStatus = leadStatusFromId(requestedStatus) || requestedStatus;
      if (!isValidStatus(normalizedStatus)) {
        return res.status(400).json({ success: false, error: 'Invalid status filter' });
      }
      where.status = normalizedStatus;
    }
    if (source) where.source = source;
    if (ownerId) where.ownerId = ownerId;
    if (from || to) {
      const createdAtFilter: any = {};
      if (from) {
        const start = new Date(`${from}T00:00:00.000Z`);
        if (!Number.isNaN(start.getTime())) createdAtFilter.gte = start;
      }
      if (to) {
        const end = new Date(`${to}T23:59:59.999Z`);
        if (!Number.isNaN(end.getTime())) createdAtFilter.lte = end;
      }
      if (Object.keys(createdAtFilter).length > 0) {
        where.createdAt = createdAtFilter;
      }
    }
    if (search) {
      const searchTerm = search as string;
      const words = searchTerm.trim().split(/\s+/).filter(Boolean);
      const matchWord = (word: string) => [
        { leadNumber: { contains: word, mode: 'insensitive' as const } },
        { firstName: { contains: word, mode: 'insensitive' as const } },
        { lastName: { contains: word, mode: 'insensitive' as const } },
        { email: { contains: word, mode: 'insensitive' as const } },
        { phone: { contains: word } },
        { company: { contains: word, mode: 'insensitive' as const } },
        { title: { contains: word, mode: 'insensitive' as const } },
      ];
      const searchClause =
        words.length > 1
          ? { AND: words.map((word) => ({ OR: matchWord(word) })) }
          : { OR: matchWord(searchTerm) };
      where.AND = Array.isArray(where.AND) ? [...where.AND, searchClause] : [searchClause];
    }
    const viewConstraint = await listViewConstraint(req, 'LEAD');
    if (!viewConstraint.ok) return res.status(viewConstraint.status).json({ success: false, error: viewConstraint.error });
    mergeListWhere(where, viewConstraint.where);

    const sorted = listOrderBy('LEAD', sortBy, sortOrder);
    if (!sorted.ok) return res.status(400).json({ success: false, error: sorted.error });
    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        include: {
          owner: { select: { id: true, firstName: true, lastName: true } },
          project: { select: { id: true, name: true } },
          _count: { select: { siteVisits: true, activities: true } },
        },
        skip,
        take: Number(limit),
        orderBy: sorted.orderBy as { createdAt: 'asc' | 'desc' },
      }),
      prisma.lead.count({ where }),
    ]);

    res.json({
      success: true,
      data: await decorateLeads(leads),
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error) {
    console.error('Get leads error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch leads' });
  }
});

router.get('/statuses', authorize('Lead', 'read'), async (req: AuthRequest, res: Response) => {
  try {
    res.json({ success: true, data: await getLeadStatusSettings(req.tenantId!) });
  } catch (error) {
    console.error('Get lead statuses error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch lead statuses' });
  }
});

router.get('/sales-users', authorize('Lead', 'create'), async (req: AuthRequest, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      where: {
        tenantId: req.tenantId!,
        isActive: true,
        profile: { is: { name: { startsWith: 'Sales', mode: 'insensitive' } } },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        isActive: true,
        profile: { select: { name: true } },
      },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      take: 200,
    });
    res.json({ success: true, data: users });
  } catch (error) {
    console.error('Get lead sales users error:', error);
    res.status(500).json({ success: false, error: 'Failed to load sales users' });
  }
});

router.get('/:id/enquiries', authorize('Enquiry', 'read'), async (req: AuthRequest, res: Response) => {
  try {
    const lead = await prisma.lead.findFirst({
      where: { id: req.params.id, ...leadIdScope(req) },
      select: { id: true, tenantId: true, ownerId: true, creatorId: true },
    });
    if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });
    if (!(await canAccessLead(req.user!, lead))) {
      return res.status(403).json({ success: false, error: 'You do not have access to this lead' });
    }

    const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || '10'), 10) || 10));
    const result = await getLeadEnquiries(lead.tenantId, lead.id, page, limit);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Get Lead enquiries error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch Lead enquiries' });
  }
});

router.post('/:id/enquiries', authorize('Enquiry', 'create'), async (req: AuthRequest, res: Response) => {
  try {
    const payloadSchema = z.object({
      source: z.string().trim().min(1).max(120),
      subSource: z.string().trim().max(120).optional(),
      campaignId: z.string().trim().optional(),
      campaign: z.string().trim().max(160).optional(),
      subCampaignId: z.string().trim().optional(),
      subCampaign: z.string().trim().max(160).optional(),
      projectId: z.string().trim().optional(),
      phone: z.string().trim().max(64).optional(),
      secondaryPhone: z.string().trim().max(64).optional(),
      tertiaryPhone: z.string().trim().max(64).optional(),
      countryCode: z.string().trim().max(8).optional(),
      secondaryCountryCode: z.string().trim().max(8).optional(),
      tertiaryCountryCode: z.string().trim().max(8).optional(),
      email: z.string().trim().email().optional().or(z.literal('')),
      secondaryEmail: z.string().trim().email().optional().or(z.literal('')),
      tertiaryEmail: z.string().trim().email().optional().or(z.literal('')),
      originalSubmissionId: z.string().trim().min(1).max(200).optional(),
      medium: z.string().trim().max(120).optional(),
      description: z.string().trim().max(5000).optional(),
      channelPartner: z.string().trim().max(160).optional(),
      enquiryDate: z.coerce.date().optional(),
      details: z.record(z.string(), z.unknown()).optional(),
      siteVisit: z.object({
        projectId: z.string().trim().optional(),
        scheduledAt: z.coerce.date(),
        notes: z.string().trim().max(5000).optional(),
      }).optional(),
    });
    const payload = payloadSchema.parse(req.body);
    const existing = await prisma.lead.findFirst({
      where: { id: req.params.id, ...leadIdScope(req) },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Lead not found' });
    if (!(await canAccessLead(req.user!, existing))) {
      return res.status(403).json({ success: false, error: 'You do not have access to this lead' });
    }
    if (
      payload.siteVisit &&
      !req.user!.isSuperAdmin &&
      !(await EffectivePermissionService.hasPermission(req.user!.id, 'SITE_VISIT_CREATE'))
    ) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions for SiteVisit:create' });
    }

    const leadData = leadCreateSchema.parse({
      firstName: existing.firstName || undefined,
      lastName: existing.lastName,
      company: existing.company,
      source: sourceEnumValue(payload.source),
      phone: payload.phone || existing.phone,
      email: payload.email || existing.email || undefined,
      projectId: payload.projectId || undefined,
      customFields: existing.customFields,
    });
    const result = await processLeadEnquiry({
      tenantId: existing.tenantId,
      userId: req.user!.id,
      profileName: req.user!.profileName,
      expectedLeadId: existing.id,
      lead: leadData,
      enquiry: {
        source: payload.source,
        subSource: payload.subSource,
        campaignId: payload.campaignId,
        campaign: payload.campaign,
        subCampaignId: payload.subCampaignId,
        subCampaign: payload.subCampaign,
        secondaryPhone: payload.secondaryPhone,
        tertiaryPhone: payload.tertiaryPhone,
        secondaryCountryCode: payload.secondaryCountryCode,
        tertiaryCountryCode: payload.tertiaryCountryCode,
        countryCode: payload.countryCode,
        secondaryEmail: payload.secondaryEmail,
        tertiaryEmail: payload.tertiaryEmail,
        originalSubmissionId: payload.originalSubmissionId || req.get('Idempotency-Key') || undefined,
        medium: payload.medium,
        description: payload.description,
        channelPartner: payload.channelPartner,
        enquiryDate: payload.enquiryDate,
        details: payload.details,
      },
      siteVisit: payload.siteVisit
        ? {
            projectId: payload.siteVisit.projectId || payload.projectId,
            scheduledAt: payload.siteVisit.scheduledAt,
            notes: payload.siteVisit.notes,
          }
        : undefined,
    });
    if (result.action === 'DUPLICATE_CONFLICT') {
      const leadIds = await getAccessibleDuplicateLeadIds(req, result.leadIds);
      return res.status(409).json({
        success: false,
        action: result.action,
        leadIds,
        error: 'This phone number matches multiple existing Leads. Ask an administrator to resolve the duplicate records.',
      });
    }
    if (result.action === 'LEAD_MISMATCH') {
      const leadIds = await getAccessibleDuplicateLeadIds(req, result.leadIds);
      return res.status(409).json({
        success: false,
        leadIds,
        error: 'The enquiry phone number matches a different Lead. Create this enquiry from that Lead instead.',
      });
    }
    return res.status(201).json({ success: true, ...result });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: error.issues[0]?.message || 'Invalid enquiry data' });
    }
    if (error?.message === 'INVALID_PROJECT') {
      return res.status(400).json({ success: false, error: 'Invalid project' });
    }
    if (error?.message === 'RR_PROJECT_REQUIRED') {
      return res.status(409).json({ success: false, error: 'A project is required to assign this lead to Pre Sales.' });
    }
    if (error?.message === 'RR_QUEUE_NOT_CONFIGURED:Pre Sales' || error?.message === 'NO_ELIGIBLE_RR_MEMBER:Pre Sales') {
      return res.status(409).json({ success: false, error: 'No eligible Pre Sales round-robin member is configured for this project.' });
    }
    if (error?.message === 'SVC_QUEUE_NOT_CONFIGURED' || error?.message === 'NO_ELIGIBLE_SVC_MEMBER') {
      return res.status(409).json({ success: false, error: 'No eligible SVC member is available in a round-robin queue matching this project and lead source.' });
    }
    if (error?.message === 'PHONE_REQUIRED') {
      return res.status(400).json({ success: false, error: 'A phone number is required' });
    }
    console.error('Create Lead enquiry error:', error);
    return res.status(500).json({ success: false, error: 'Failed to create enquiry' });
  }
});

router.get('/:id', authorize('Lead', 'read'), async (req: AuthRequest, res: Response) => {
  try {
    await normalizeOverdueFollowUps(req.user!.tenantId);
    await normalizeOverdueSiteVisits(req.user!.tenantId);
    const lead = await prisma.lead.findFirst({
      where: { id: req.params.id, ...leadIdScope(req) },
      include: {
        owner: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
        creator: { select: { id: true, firstName: true, lastName: true } },
        project: { select: { id: true, name: true } },
        rrQueue: { select: { id: true, name: true } },
        siteVisits: {
          include: {
            assignee: { select: { id: true, firstName: true, lastName: true } },
            project: { select: { id: true, name: true } },
          },
          orderBy: { scheduledAt: 'desc' },
        },
        activities: {
          include: { user: { select: { id: true, firstName: true, lastName: true } } },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
        followUps: {
          where: followUpOwnerClause(req.user!),
          orderBy: { dueDate: 'asc' },
          take: 10,
        },
        auditLogs: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: {
            user: { select: { id: true, firstName: true, lastName: true, email: true } },
          },
        },
      },
    });

    if (!lead) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }

    if (!(await canAccessLead(req.user!, lead))) {
      return res.status(403).json({ success: false, error: 'You do not have access to this lead' });
    }

    const ownerHistory = await getOwnerHistory(lead.tenantId, req.params.id);
    const rescheduledVisitHistory = lead.siteVisits.length
      ? await prisma.auditLog.findMany({
          where: {
            tenantId: lead.tenantId,
            objectType: 'SiteVisit',
            objectId: { in: lead.siteVisits.map((siteVisit) => siteVisit.id) },
            action: 'SITE_VISIT_RESCHEDULED',
          },
          select: { objectId: true },
        })
      : [];
    const rescheduledVisitIds = new Set(
      rescheduledVisitHistory.flatMap((entry) => entry.objectId ? [entry.objectId] : []),
    );

    const lastAudit = await prisma.auditLog.findFirst({
      where: {
        tenantId: lead.tenantId,
        OR: [{ leadId: lead.id }, { objectType: 'Lead', objectId: lead.id }],
      },
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });

    const lastModified = lastAudit
      ? {
          by: lastAudit.user,
          at: lastAudit.createdAt,
          action: lastAudit.action,
        }
      : {
          by: lead.creator
            ? { id: lead.creator.id, firstName: lead.creator.firstName, lastName: lead.creator.lastName, email: null }
            : null,
          at: lead.updatedAt,
          action: 'CREATE',
        };

    const leadWithStatus = await decorateLeadStatus(lead.tenantId, lead);
    res.json({
      success: true,
      data: {
        ...leadWithStatus,
        siteVisits: lead.siteVisits.map((siteVisit) =>
          (siteVisit.status === 'SCHEDULED' && rescheduledVisitIds.has(siteVisit.id)) ||
          (siteVisit.status === 'CANCELLED' && siteVisit.cancellationReason?.startsWith('Rescheduled to '))
            ? { ...siteVisit, status: 'RESCHEDULED' }
            : siteVisit,
        ),
        auditLogs: await enrichAuditLogs(lead.auditLogs),
        ownerHistory,
        lastModified,
      },
    });
  } catch (error) {
    console.error('Get lead error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch lead' });
  }
});

router.post('/duplicates', authorize('Lead', 'create'), async (req: AuthRequest, res: Response) => {
  try {
    const parsed = duplicatePreviewSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid lead contact details',
        fieldErrors: parsed.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    const contacts = duplicateContactInput(parsed.data);
    const validationErrors = validateLeadContactInput(contacts);
    if (validationErrors.length) {
      return res.status(400).json({
        success: false,
        error: 'Please correct the highlighted contact details.',
        fieldErrors: validationErrors,
      });
    }
    for (const email of contacts.emails) {
      if (email.value?.trim() && !z.string().trim().email().safeParse(email.value).success) {
        return res.status(400).json({
          success: false,
          error: 'Please correct the highlighted contact details.',
          fieldErrors: [{ field: email.field, message: 'Enter a valid email address.' }],
        });
      }
    }
    const matches = await prisma.$transaction((tx) =>
      findLeadDuplicates(tx, req.tenantId!, contacts),
    );
    const candidates: Array<{
      id: string;
      leadNumber: string | null;
      name: string;
      projectName: string | null;
      matchedFields: string[];
    }> = [];
    for (const match of matches) {
      const accessRecord = await prisma.lead.findFirst({
        where: { id: match.lead.id, ...leadIdScope(req) },
        select: { id: true, tenantId: true, ownerId: true, creatorId: true },
      });
      if (!accessRecord || !(await canAccessLead(req.user!, accessRecord))) continue;
      const related = await prisma.lead.findUnique({
        where: { id: match.lead.id },
        select: {
          owner: { select: { firstName: true, lastName: true } },
          project: { select: { name: true } },
        },
      });
      candidates.push({
        id: match.lead.id,
        leadNumber: match.lead.leadNumber,
        name: [match.lead.firstName, match.lead.lastName].filter(Boolean).join(' '),
        projectName: related?.project?.name || null,
        matchedFields: match.matchedFields,
      });
    }
    return res.json({
      success: true,
      hasDuplicates: matches.length > 0,
      ambiguous: matches.length > 1 || matches.some((match) => match.ambiguous),
      inaccessibleMatches: matches.length > candidates.length,
      candidates,
    });
  } catch (error) {
    console.error('Lead duplicate preview failed:', error);
    return res.status(500).json({ success: false, error: 'Unable to check for duplicate Leads' });
  }
});

router.post('/', authorize('Lead', 'create'), async (req: AuthRequest, res: Response) => {
  try {
    const {
      subSource,
      campaignId,
      campaign,
      subCampaignId,
      subCampaign,
      salesUserId,
      secondaryPhone,
      tertiaryPhone,
      secondaryEmail,
      tertiaryEmail,
      originalSubmissionId,
      countryCode,
      secondaryCountryCode,
      tertiaryCountryCode,
      linkToLeadId,
      medium,
      enquiryDescription,
      channelPartner,
      enquiryDate,
      enquiryDetails,
      siteVisit,
      ...leadInput
    } = req.body || {};
    const metadata = z.object({
      subSource: z.string().trim().max(120).optional(),
      campaignId: z.string().trim().optional(),
      campaign: z.string().trim().max(160).optional(),
      subCampaignId: z.string().trim().optional(),
      subCampaign: z.string().trim().max(160).optional(),
      salesUserId: z.string().trim().optional(),
      secondaryPhone: z.string().trim().max(64).optional(),
      tertiaryPhone: z.string().trim().max(64).optional(),
      secondaryEmail: z.string().trim().email().optional().or(z.literal('')),
      tertiaryEmail: z.string().trim().email().optional().or(z.literal('')),
      originalSubmissionId: z.string().trim().min(1).max(200).optional(),
      countryCode: z.string().trim().regex(/^\+?\d{1,3}$/, 'Enter a valid primary country calling code').optional(),
      secondaryCountryCode: z.string().trim().regex(/^\+?\d{1,3}$/, 'Enter a valid secondary country calling code').optional(),
      tertiaryCountryCode: z.string().trim().regex(/^\+?\d{1,3}$/, 'Enter a valid tertiary country calling code').optional(),
      linkToLeadId: z.string().trim().min(1).optional(),
      medium: z.string().trim().max(120).optional(),
      enquiryDescription: z.string().trim().max(5000).optional(),
      channelPartner: z.string().trim().max(160).optional(),
      enquiryDate: z.coerce.date().optional(),
      enquiryDetails: z.record(z.string(), z.unknown()).optional(),
      siteVisit: z.object({
        projectId: z.string().optional(),
        scheduledAt: z.coerce.date(),
        notes: z.string().trim().max(5000).optional(),
      }).optional(),
    }).parse({
      subSource, campaignId, campaign, subCampaignId, subCampaign, salesUserId,
      secondaryPhone, tertiaryPhone, secondaryEmail, tertiaryEmail, originalSubmissionId, countryCode,
      secondaryCountryCode, tertiaryCountryCode, linkToLeadId, medium, enquiryDescription, channelPartner,
      enquiryDate, enquiryDetails, siteVisit,
    });
    const creationCustomFields = leadInput.customFields && typeof leadInput.customFields === 'object' && !Array.isArray(leadInput.customFields)
      ? leadInput.customFields as Record<string, unknown>
      : {};
    if (Object.prototype.hasOwnProperty.call(creationCustomFields, 'score')) {
      return res.status(400).json({ success: false, error: 'Score is read-only' });
    }
    for (const fieldName of ['source', 'status', 'rating', 'description'] as const) {
      if (leadInput[fieldName] === undefined && creationCustomFields[fieldName] !== undefined) {
        leadInput[fieldName] = creationCustomFields[fieldName];
      }
    }
    const requestedStatus = leadInput.statusId ?? leadInput.status;
    if (requestedStatus !== undefined) {
      const normalizedStatus = leadStatusFromId(String(requestedStatus)) || String(requestedStatus);
      if (!isValidStatus(normalizedStatus)) {
        return res.status(400).json({ success: false, error: `Invalid status ID or value: ${requestedStatus}` });
      }
      leadInput.status = normalizedStatus;
    }
    delete leadInput.statusId;
    const incomingSource = typeof leadInput.source === 'string' ? leadInput.source : 'OTHER';
    const data = leadCreateSchema.parse({
      ...leadInput,
      source: sourceEnumValue(incomingSource),
    });
    const picklistError = validateLeadPicklists(
      {
        source: data.source,
        firstCampaign: data.firstCampaign,
        lastCampaign: data.lastCampaign,
        leadInterest: data.leadInterest,
      },
      await getLeadPicklistOptions(req.tenantId!),
      { validateRequired: true },
    );
    if (picklistError) {
      return res.status(400).json({
        success: false,
        error: picklistError.message,
        fieldErrors: [picklistError],
      });
    }
    const initialStatus = data.status || 'NEW';
    if (!(await isLeadStatusEnabled(req.tenantId!, initialStatus))) {
      return res.status(400).json({ success: false, error: `Lead status ${leadStatusFromId(String(requestedStatus)) || initialStatus} is disabled for this company` });
    }
    const contacts = duplicateContactInput({
      phone: data.phone,
      mobile: data.mobile || undefined,
      secondaryPhone: metadata.secondaryPhone,
      tertiaryPhone: metadata.tertiaryPhone,
      countryCode: metadata.countryCode,
      secondaryCountryCode: metadata.secondaryCountryCode,
      tertiaryCountryCode: metadata.tertiaryCountryCode,
      email: data.email,
      secondaryEmail: metadata.secondaryEmail,
      tertiaryEmail: metadata.tertiaryEmail,
    });
    const validationErrors = validateLeadContactInput(contacts);
    if (validationErrors.length) {
      return res.status(400).json({
        success: false,
        error: 'Please correct the highlighted contact details.',
        fieldErrors: validationErrors,
      });
    }
    const customFieldsToValidate = Object.fromEntries(
      Object.entries(data.customFields || {}).filter(([name]) => name !== 'score'),
    );
    const customFieldError = await validateLeadCustomFields(
      req.tenantId!,
      customFieldsToValidate,
      true,
    );
    if (customFieldError) {
      return res.status(400).json({ success: false, error: customFieldError });
    }
    if (metadata.salesUserId) {
      const salesUser = await prisma.user.findFirst({
        where: { id: metadata.salesUserId, tenantId: req.tenantId!, isActive: true },
        select: { id: true, profile: { select: { name: true } } },
      });
      if (!salesUser || !/^sales(?:\b|$)/i.test(salesUser.profile?.name || '')) {
        return res.status(400).json({ success: false, error: 'Select an active user with a Sales profile' });
      }
    }
    if (
      metadata.siteVisit &&
      !req.user!.isSuperAdmin &&
      !(await EffectivePermissionService.hasPermission(req.user!.id, 'SITE_VISIT_CREATE'))
    ) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions for SiteVisit:create' });
    }

    const layoutError = await layoutWriteError(req, 'Lead', data as Record<string, unknown>);
    if (layoutError) {
      return res.status(400).json({ success: false, error: layoutError });
    }

    const result = await processLeadEnquiry({
      tenantId: req.tenantId!,
      userId: req.user!.id,
      salesUserId: metadata.salesUserId,
      profileName: req.user!.profileName,
      expectedLeadId: metadata.linkToLeadId,
      lead: data,
      enquiry: {
        source: incomingSource,
        subSource: metadata.subSource,
        campaignId: metadata.campaignId,
        campaign: metadata.campaign,
        subCampaignId: metadata.subCampaignId,
        subCampaign: metadata.subCampaign,
        secondaryPhone: metadata.secondaryPhone,
        tertiaryPhone: metadata.tertiaryPhone,
        secondaryEmail: metadata.secondaryEmail,
        tertiaryEmail: metadata.tertiaryEmail,
        originalSubmissionId: metadata.originalSubmissionId || req.get('Idempotency-Key') || undefined,
        countryCode: metadata.countryCode,
        secondaryCountryCode: metadata.secondaryCountryCode,
        tertiaryCountryCode: metadata.tertiaryCountryCode,
        medium: metadata.medium,
        description: metadata.enquiryDescription,
        channelPartner: metadata.channelPartner,
        enquiryDate: metadata.enquiryDate,
        details: metadata.enquiryDetails,
      },
      siteVisit: metadata.siteVisit
        ? {
            projectId: metadata.siteVisit.projectId || data.projectId || undefined,
            scheduledAt: metadata.siteVisit.scheduledAt,
            notes: metadata.siteVisit.notes,
          }
        : undefined,
    }, { rejectDuplicates: !metadata.linkToLeadId });
    if (result.action === 'DUPLICATE_CONFLICT') {
      const leadIds = await getAccessibleDuplicateLeadIds(req, result.leadIds);
      return res.status(409).json({
        success: false,
        action: result.action,
        leadIds,
        candidates: leadIds.map((id) => ({ id })),
        error: 'This phone number matches multiple existing Leads. Ask an administrator to resolve the duplicate records.',
      });
    }
    if (result.action === 'LEAD_MISMATCH') {
      return res.status(409).json({
        success: false,
        action: result.action,
        error: 'The duplicate match changed while this enquiry was being submitted. Check for duplicates again.',
      });
    }
    let canReadMatchedLead = true;
    if (result.action !== 'NEW_LEAD') {
      const matchedLead = await prisma.lead.findFirst({
        where: { id: result.leadId, ...leadIdScope(req) },
        select: { id: true, tenantId: true, ownerId: true, creatorId: true },
      });
      canReadMatchedLead = Boolean(matchedLead && await canAccessLead(req.user!, matchedLead));
    }
    res.status(result.action === 'NEW_LEAD' ? 201 : 200).json({
      success: true,
      action: result.action,
      leadId: canReadMatchedLead ? result.leadId : null,
      duplicate: result.action === 'NEW_LEAD'
        ? undefined
        : {
            linked: true,
            leadId: canReadMatchedLead ? result.leadId : null,
            visibilityRestricted: !canReadMatchedLead,
            enquiryId: result.enquiry?.id,
          },
      data: result.lead && canReadMatchedLead
        ? { ...result.lead, ...(result.assignmentWarning ? { assignmentWarning: result.assignmentWarning } : {}) }
        : null,
      validationDays: result.validationDays,
      daysDifference: result.daysDifference,
      assignment: result.assignment,
      enquiry: result.enquiry,
      siteVisit: result.siteVisit,
      ...(result.assignmentWarning ? { warning: result.assignmentWarning } : {}),
      message: result.action === 'NEW_LEAD'
        ? 'New lead created and assigned'
        : result.action === 'RE_OPENED'
          ? 'Existing lost lead reopened and linked successfully'
        : result.action === 'RE_ENGAGED'
          ? 'Existing lost lead re-engaged successfully'
          : result.action === 'OUTSIDE_REENGAGEMENT_WINDOW'
            ? 'Existing lost lead is outside the re-engagement validation period'
            : 'Lead already exists',
    });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return res.status(400).json({
        success: false,
        error: error.errors[0].message,
        fieldErrors: error.errors.map((issue: z.ZodIssue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    if (error?.message === 'LEAD_CONTACT_VALIDATION') {
      return res.status(400).json({
        success: false,
        error: 'Please correct the highlighted contact details.',
        fieldErrors: error.validationErrors,
      });
    }
    if (error?.code === 'DUPLICATE_LEAD') {
      const fields = Array.isArray(error.duplicateFields)
        ? error.duplicateFields.filter((field: unknown) => field === 'phone' || field === 'email')
        : [];
      return res.status(409).json({
        success: false,
        code: 'DUPLICATE_LEAD',
        fields,
        error: duplicateLeadMessage(fields),
      });
    }
    const uniqueFields = uniqueLeadContactFields(error);
    if (uniqueFields.length) {
      return res.status(409).json({
        success: false,
        code: 'DUPLICATE_LEAD',
        fields: uniqueFields,
        error: duplicateLeadMessage(uniqueFields),
      });
    }
    if (isPhoneUniqueViolation(error)) {
      return res.status(409).json({
        success: false,
        code: 'DUPLICATE_LEAD',
        fields: ['phone'],
        error: duplicateLeadMessage(['phone']),
      });
    }
    if (error?.message === 'INVALID_PROJECT') {
      return res.status(400).json({ success: false, error: 'Invalid project' });
    }
    if (error?.message === 'SALES_USER_INVALID') {
      return res.status(400).json({ success: false, error: 'Select an active user with a Sales profile' });
    }
    if (error?.message === 'RR_PROJECT_REQUIRED') {
      return res.status(409).json({ success: false, error: 'A project is required to assign this lead to Pre Sales.' });
    }
    if (error?.message === 'RR_QUEUE_NOT_CONFIGURED:Pre Sales' || error?.message === 'NO_ELIGIBLE_RR_MEMBER:Pre Sales') {
      return res.status(409).json({ success: false, error: 'No eligible Pre Sales round-robin member is configured for this project.' });
    }
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: error.issues[0]?.message || 'Invalid enquiry data' });
    }
    console.error('Create lead error:', error);
    res.status(500).json({ success: false, error: 'Failed to create lead' });
  }
});

router.put('/:id', authorize('Lead', 'edit'), async (req: AuthRequest, res: Response) => {
  try {
    const existingLead = await prisma.lead.findFirst({
      where: { id: req.params.id, ...leadIdScope(req) },
    });

    if (!existingLead) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }

    if (!(await canAccessLead(req.user!, existingLead))) {
      return res.status(403).json({ success: false, error: 'You do not have access to this lead' });
    }

    const bodyData = { ...req.body };
    const requestedCustomFields = bodyData.customFields && typeof bodyData.customFields === 'object' && !Array.isArray(bodyData.customFields)
      ? bodyData.customFields as Record<string, unknown>
      : {};
    const operationalFieldNames = ['source', 'status', 'rating', 'description', 'score'] as const;
    if (Object.prototype.hasOwnProperty.call(requestedCustomFields, 'score')) {
      return res.status(400).json({ success: false, error: 'Score is read-only' });
    }
    for (const fieldName of operationalFieldNames) {
      if (bodyData[fieldName] === undefined && requestedCustomFields[fieldName] !== undefined) {
        bodyData[fieldName] = requestedCustomFields[fieldName];
      }
    }
    const requestedStatus = bodyData.statusId ?? bodyData.status;
    if (requestedStatus !== undefined) {
      const normalizedStatus = leadStatusFromId(String(requestedStatus)) || String(requestedStatus);
      if (!isValidStatus(normalizedStatus)) {
        return res.status(400).json({ success: false, error: `Invalid status ID or value: ${requestedStatus}` });
      }
      bodyData.status = normalizedStatus;
    }
    delete bodyData.statusId;
    delete bodyData.leadNumber;
    const layoutError = await layoutWriteError(req, 'Lead', bodyData, existingLead as unknown as Record<string, unknown>);
    if (layoutError) {
      return res.status(400).json({ success: false, error: layoutError });
    }
    const reason =
      typeof bodyData.reason === 'string' && bodyData.reason.trim()
        ? bodyData.reason.trim()
        : undefined;
    delete bodyData.reason;
    const data = leadUpdateSchema.parse(bodyData);
    const picklistError = validateLeadPicklists(
      {
        source: data.source,
        firstCampaign: data.firstCampaign,
        lastCampaign: data.lastCampaign,
        leadInterest: data.leadInterest,
      },
      await getLeadPicklistOptions(existingLead.tenantId),
      { validateRequired: true, partial: true },
    );
    if (picklistError) {
      return res.status(400).json({
        success: false,
        error: picklistError.message,
        fieldErrors: [picklistError],
      });
    }

    if (data.customFields) {
      const fieldsToValidate = Object.fromEntries(
        Object.entries(data.customFields).filter(([name]) => name !== 'score'),
      );
      const customFieldError = await validateLeadCustomFields(
        existingLead.tenantId,
        fieldsToValidate,
        false,
      );
      if (customFieldError) {
        return res.status(400).json({ success: false, error: customFieldError });
      }
      const storedCustomFields = existingLead.customFields;
      data.customFields = {
        ...(storedCustomFields && typeof storedCustomFields === 'object' && !Array.isArray(storedCustomFields)
          ? storedCustomFields as Record<string, JsonValue>
          : {}),
        ...data.customFields,
      };
    }
    const operationalFieldUpdates = {
      ...(data.source !== undefined ? { source: data.source } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.rating !== undefined ? { rating: data.rating } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.score !== undefined ? { score: data.score } : {}),
    };
    if (Object.keys(operationalFieldUpdates).length) {
      data.customFields = mergeOperationalLeadCustomFields(
        data.customFields || existingLead.customFields,
        operationalFieldUpdates,
      );
    }

    if (data.status && !isValidStatus(data.status)) {
      return res.status(400).json({ success: false, error: `Invalid status: ${data.status}` });
    }
    if (data.status && !(await isLeadStatusEnabled(existingLead.tenantId, data.status))) {
      return res.status(400).json({ success: false, error: `Lead status ${data.status} is disabled for this company` });
    }

    if (data.phone !== undefined && data.phone !== '') {
      const phoneToCheck = normalizePhone(data.phone);
      if (await findPhoneConflict(existingLead.tenantId, phoneToCheck, req.params.id)) {
        return res.status(409).json({ success: false, error: PHONE_DUPLICATE_ERROR });
      }
      data.phone = phoneToCheck;
    }

    if (data.status) {
      const profileName = req.user!.profileName || 'Admin';

      if (profileName !== 'Admin' && profileName !== 'Manager' && profileName !== 'CRM Admin') {
        if (!canTransitionStatus(profileName, existingLead.status, data.status)) {
          return res.status(403).json({
            success: false,
            error: `Profile ${profileName} cannot change status from ${existingLead.status} to ${data.status}`,
          });
        }
      }
    }

    const { oldValues, newValues, updateData } = computeLeadDiff(existingLead, data);
    if (updateData.status) {
      updateData.lostAt = updateData.status === 'LOST' ? new Date() : null;
    }

    if (Object.keys(updateData).length === 0) {
      const unchanged = await prisma.lead.findFirst({
        where: { id: req.params.id, ...leadIdScope(req) },
        include: {
          owner: { select: { id: true, firstName: true, lastName: true } },
          project: { select: { id: true, name: true } },
        },
      });
      return res.json({ success: true, data: unchanged, unchanged: true });
    }

    const ownerChanged =
      'ownerId' in updateData &&
      normalizeDiffValue(updateData.ownerId) !== normalizeDiffValue(existingLead.ownerId);
    const shouldReassign = hasLeadAssignmentRelevantChanges(updateData);
    const result = await prisma.$transaction(async (tx) => {
      let assignment: Awaited<ReturnType<typeof assignLeadToProjectRoundRobinInTransaction>> | null = null;
      let salesHandoff: Awaited<ReturnType<typeof assignCompletedSiteVisitToSalesInTransaction>> | null = null;
      if (updateData.status === 'LOST' && existingLead.status !== 'LOST') {
        assignment = await assignLeadToProjectRoundRobinInTransaction(tx, {
          tenantId: existingLead.tenantId,
          leadId: existingLead.id,
          projectId: 'projectId' in updateData ? updateData.projectId : existingLead.projectId,
          userType: 'Recovery',
          actorId: req.user!.id,
          reason: reason || 'Lead marked Lost',
        });
      }
      if (updateData.status === 'SITE_VISIT_HAPPENED' && existingLead.status !== 'SITE_VISIT_HAPPENED') {
        const completedVisit = await tx.siteVisit.findFirst({
          where: { tenantId: existingLead.tenantId, leadId: existingLead.id, status: 'COMPLETED', completedAt: { not: null }, completedById: { not: null } },
          orderBy: [{ completedAt: 'desc' }, { updatedAt: 'desc' }],
          select: { id: true },
        });
        if (!completedVisit) throw new Error('COMPLETED_SITE_VISIT_REQUIRED');
        salesHandoff = await assignCompletedSiteVisitToSalesInTransaction(tx, completedVisit.id, existingLead.tenantId);
      }

      const persistedUpdateData = {
        ...updateData,
        ...(assignment ? { ownerId: assignment.assignedUserId, rrQueueId: assignment.queueId } : {}),
        ...(salesHandoff?.assignedUserId
          ? { ownerId: salesHandoff.assignedUserId, rrQueueId: salesHandoff.queueId }
          : {}),
      };
      const lead = await tx.lead.update({
        where: { id: req.params.id },
        data: persistedUpdateData,
        include: {
          owner: { select: { id: true, firstName: true, lastName: true } },
          project: { select: { id: true, name: true } },
        },
      });

      const workflowAssigned = !!assignment || !!salesHandoff?.assignedUserId;
      const auditNewValues = reason ? { ...newValues, reason } : newValues;
      const auditData = {
        tenantId: existingLead.tenantId,
        userId: req.user!.id,
        leadId: lead.id,
        action: ownerChanged && Object.keys(newValues).length === 1 ? 'OWNER_CHANGED' : 'UPDATE',
        objectType: 'Lead',
        objectId: lead.id,
        oldValues,
        newValues: {
          ...auditNewValues,
          ...(assignment ? { ownerId: assignment.assignedUserId, rrQueueId: assignment.queueId } : {}),
          ...(salesHandoff?.assignedUserId
            ? { ownerId: salesHandoff.assignedUserId, rrQueueId: salesHandoff.queueId }
            : {}),
        },
      };
      await tx.auditLog.create({ data: auditData });
      const processChanges = [
        existingLead.status !== lead.status ? `Status: ${existingLead.status} → ${lead.status}` : null,
        ownerChanged ? 'Lead owner changed' : null,
        existingLead.status === lead.status && !ownerChanged ? 'Lead details updated' : null,
      ].filter(Boolean);
      await appendLeadProcessNote(tx, {
        tenantId: existingLead.tenantId,
        leadId: lead.id,
        userId: req.user!.id,
        content: processChanges.join('\n'),
      });

      if (ownerChanged && !workflowAssigned) {
        const newOwnerId = normalizeDiffValue(updateData.ownerId);
        const newOwner = newOwnerId
          ? await tx.user.findUnique({
              where: { id: newOwnerId },
              select: { id: true, firstName: true, lastName: true, profile: { select: { name: true } } },
            })
          : null;

        await createOwnerHistory(
          {
            tenantId: existingLead.tenantId,
            leadId: lead.id,
            previousOwnerId: existingLead.ownerId,
            newOwnerId: newOwnerId as string | null,
            previousProfile: null,
            newProfile: newOwner?.profile?.name || null,
            previousStatus: existingLead.status,
            newStatus: lead.status,
            handoffReason: reason || 'Owner changed via lead update',
            changedById: req.user!.id,
          },
          tx,
        );
      }

      const leadForAssignment = {
        ...lead,
        projectId: Object.prototype.hasOwnProperty.call(updateData, 'projectId')
          ? updateData.projectId
          : lead.projectId || existingLead.projectId || null,
        projectName: lead.project?.name || (Object.prototype.hasOwnProperty.call(updateData, 'projectId') ? null : existingLead.projectId) || null,
        status: updateData.status ?? lead.status,
        source: updateData.source ?? lead.source,
        leadQueueing: shouldReassign,
        leadAssigned: !shouldReassign,
        leadReassign: shouldReassign,
      };

      let rrAssignment: any = null;
      if (!workflowAssigned && shouldReassign && isLeadEligibleForAutoAssignment(leadForAssignment, { isNewLead: false })) {
        const queue = await findApplicableRRQueue(existingLead.tenantId, {
          projectId: leadForAssignment.projectId,
          projectName: leadForAssignment.projectName,
          status: String(leadForAssignment.status),
          source: String(leadForAssignment.source),
          priority: String(leadForAssignment.rating || ''),
        }, tx);
        if (queue) {
          rrAssignment = await RoundRobinAssignmentService.assignLeadInTransaction(
            tx,
            queue.id,
            lead.id,
            existingLead.tenantId,
            req.user!.id,
          );
        }
      }

      return { ...lead, assignment: rrAssignment };
    });

    res.json({ success: true, data: result });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ success: false, error: error.errors[0].message });
    }
    if (error?.message === 'RR_PROJECT_REQUIRED') {
      return res.status(409).json({ success: false, error: 'A project is required for this round-robin assignment.' });
    }
    if (error?.message === 'RR_QUEUE_NOT_CONFIGURED:Recovery' || error?.message === 'NO_ELIGIBLE_RR_MEMBER:Recovery') {
      return res.status(409).json({ success: false, error: 'No eligible Recovery member is available in a round-robin queue matching this project and lead source.' });
    }
    if (error?.message === 'COMPLETED_SITE_VISIT_REQUIRED') {
      return res.status(409).json({ success: false, error: 'A completed site visit is required before assigning Sales.' });
    }
    const uniqueFields = uniqueLeadContactFields(error);
    if (uniqueFields.length) {
      return res.status(409).json({
        success: false,
        code: 'DUPLICATE_LEAD',
        fields: uniqueFields,
        error: duplicateLeadMessage(uniqueFields),
      });
    }
    if (isPhoneUniqueViolation(error)) {
      return res.status(409).json({
        success: false,
        code: 'DUPLICATE_LEAD',
        fields: ['phone'],
        error: duplicateLeadMessage(['phone']),
      });
    }
    if (error?.message === 'NO_ELIGIBLE_USER') {
      return res.status(409).json({
        success: false,
        error: 'No eligible RR queue member or fallback owner is available for this lead.',
      });
    }
    console.error('Update lead error:', error);
    res.status(500).json({ success: false, error: 'Failed to update lead' });
  }
});

router.delete('/:id', authorize('Lead', 'delete'), async (req: AuthRequest, res: Response) => {
  try {
    const lead = await prisma.lead.findFirst({
      where: { id: req.params.id, ...leadIdScope(req) },
    });

    if (!lead) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }

    if (!(await canAccessLead(req.user!, lead))) {
      return res.status(403).json({ success: false, error: 'You do not have access to this lead' });
    }

    await prisma.auditLog.create({
      data: {
        tenantId: lead.tenantId,
        userId: req.user!.id,
        action: 'DELETE',
        objectType: 'Lead',
        objectId: lead.id,
        oldValues: lead,
      },
    });

    await prisma.$transaction(async (tx) => {
      const cleanupPlan = buildLeadDeletionPlan(lead.id);

      for (const step of cleanupPlan) {
        if (step.name === 'lead') {
          await tx.lead.delete({ where: step.where });
          continue;
        }

        if (step.name === 'activity') {
          await tx.activity.deleteMany({ where: step.where as any });
          continue;
        }

        if (step.name === 'followUp') {
          await tx.followUp.deleteMany({ where: step.where as any });
          continue;
        }

        if (step.name === 'leadOwnerHistory') {
          await tx.leadOwnerHistory.deleteMany({ where: step.where as any });
          continue;
        }

        if (step.name === 'siteVisit') {
          await tx.siteVisit.deleteMany({ where: step.where as any });
          continue;
        }

        if (step.name === 'callDetail') {
          await tx.callDetail.deleteMany({ where: step.where as any });
        }
      }
    });

    res.json({ success: true, message: 'Lead deleted successfully' });
  } catch (error) {
    console.error('Delete lead error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete lead' });
  }
});

router.post('/:id/push-to-svc', authorize('Lead', 'edit'), async (req: AuthRequest, res: Response) => {
  try {
    const parsedBody = pushToSvcRequestSchema.safeParse(req.body);
    if (!parsedBody.success) {
      return res.status(400).json({ success: false, error: parsedBody.error.issues[0]?.message || 'Invalid request body' });
    }
    const { reason, projectId, prospectDetails } = parsedBody.data;

    const lead = await prisma.lead.findFirst({
      where: { id: req.params.id, ...leadIdScope(req) },
      include: { owner: { select: { id: true, firstName: true, lastName: true } } },
    });

    if (!lead) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }

    if (!(await canAccessLead(req.user!, lead))) {
      return res.status(403).json({ success: false, error: 'You do not have access to this lead' });
    }

    if (lead.status !== 'INCOMING') {
      return res.status(400).json({ success: false, error: 'Lead must be in Incoming status to push to SVC' });
    }

    const project = await prisma.project.findFirst({
      where: { id: projectId, tenantId: lead.tenantId },
      select: { id: true, name: true },
    });
    if (!project) {
      return res.status(400).json({ success: false, error: 'Project must belong to this company' });
    }

    const profileName = req.user!.profileName || 'Admin';

    if (profileName !== 'Admin' && profileName !== 'Manager' && profileName !== 'CRM Admin') {
      if (!canTransitionStatus(profileName, 'INCOMING', 'PROSPECT')) {
        return res.status(403).json({ success: false, error: 'Not authorized to push leads to SVC' });
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      await ensureProspectLeadFields(tx, lead.tenantId, req.user!.id);
      const assignment = await assignLeadToProjectRoundRobinInTransaction(tx, {
        tenantId: lead.tenantId,
        leadId: lead.id,
        projectId,
        userType: 'SVC',
        actorId: req.user!.id,
        reason: 'Lead pushed to SVC',
      });
      const existingCustomFields = lead.customFields && typeof lead.customFields === 'object' && !Array.isArray(lead.customFields)
        ? lead.customFields as Record<string, JsonValue>
        : {};
      const details: ProspectLeadDetails = prospectDetails;
      await tx.lead.update({
        where: { id: req.params.id },
        data: {
          projectId,
          status: 'PROSPECT',
          lostAt: null,
          customFields: {
            ...existingCustomFields,
            svc_call_summary_remarks: details.callSummaryRemarks,
            svc_minimum_budget: details.minimumBudget,
            svc_maximum_budget: details.maximumBudget,
            svc_bedroom_preference: details.bedroomPreference,
            svc_property_type: details.propertyType,
            svc_possession: details.possession || null,
            svc_reason_to_buy: details.reasonToBuy || null,
          },
        },
      });

      await tx.auditLog.create({
        data: {
          tenantId: lead.tenantId,
          userId: req.user!.id,
          leadId: lead.id,
          action: 'PUSH_TO_SVC',
          objectType: 'Lead',
          objectId: lead.id,
          oldValues: { status: 'INCOMING', ownerId: lead.ownerId, projectId: lead.projectId },
          newValues: {
            status: 'PROSPECT',
            ownerId: assignment.assignedUserId,
            projectId,
            note: reason,
            reason,
            prospectDetails: details,
          },
        },
      });

      await appendLeadProcessNote(tx, {
        tenantId: lead.tenantId,
        leadId: lead.id,
        userId: req.user!.id,
        content: [
          'Lead pushed to SVC and moved to Prospect.',
          `Project: ${project.name}`,
          `Call summary: ${details.callSummaryRemarks}`,
          `Budget: ${details.minimumBudget} – ${details.maximumBudget}`,
          `Bedrooms: ${details.bedroomPreference.join(', ')}`,
          `Property type: ${details.propertyType.join(', ')}`,
          details.possession ? `Possession: ${details.possession}` : null,
          details.reasonToBuy ? `Reason to buy: ${details.reasonToBuy}` : null,
        ].filter(Boolean).join('\n'),
      });

      return tx.lead.findUniqueOrThrow({
        where: { id: lead.id },
        include: {
          owner: { select: { id: true, firstName: true, lastName: true } },
          project: { select: { id: true, name: true } },
        },
      });
    });

    res.json({ success: true, data: result });
  } catch (error: any) {
    if (typeof error?.message === 'string' && error.message.startsWith('PROSPECT_FIELD_TYPE_MISMATCH:')) {
      return res.status(409).json({ success: false, error: error.message.replace('PROSPECT_FIELD_TYPE_MISMATCH: ', '') });
    }
    if (error?.message === 'RR_PROJECT_REQUIRED') {
      return res.status(409).json({ success: false, error: 'A project is required to push this lead to SVC.' });
    }
    if (error?.message === 'RR_QUEUE_NOT_CONFIGURED:SVC') {
      return res.status(409).json({ success: false, error: 'No active SVC round-robin queue matches this project and lead source.' });
    }
    if (error?.message === 'NO_ELIGIBLE_RR_MEMBER:SVC') {
      return res.status(409).json({ success: false, error: 'The matching SVC round-robin queue has no active, available SVC member.' });
    }
    console.error('Push to SVC error:', error);
    res.status(500).json({ success: false, error: 'Failed to push lead to SVC' });
  }
});

router.post('/:id/move-to-recovery', async (req: AuthRequest, res: Response) => {
  try {
    const { recoveryReason, note } = req.body;
    if (!recoveryReason || !recoveryReason.trim()) {
      return res.status(400).json({ success: false, error: 'Recovery reason is required' });
    }

    const permissions = req.user!.isSuperAdmin
      ? []
      : await EffectivePermissionService.getEffectivePermissionsCached(req.user!, req.user!.id);
    const canMoveToRecovery = req.user!.isSuperAdmin ||
      EffectivePermissionService.hasPermissionIn(permissions, 'LEAD_UPDATE') ||
      EffectivePermissionService.hasPermissionIn(permissions, 'SITE_VISIT_UPDATE') ||
      EffectivePermissionService.hasPermissionIn(permissions, 'SITE_VISIT_CREATE');
    if (!canMoveToRecovery) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions to move this lead to Recovery.' });
    }

    const lead = await prisma.lead.findFirst({
      where: { id: req.params.id, ...leadIdScope(req) },
      include: { owner: { select: { id: true, firstName: true, lastName: true } } },
    });

    if (!lead) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }

    if (!(await canAccessLead(req.user!, lead))) {
      return res.status(403).json({ success: false, error: 'You do not have access to this lead' });
    }

    if (lead.status === 'LOST') {
      return res.status(400).json({ success: false, error: 'Lead is already marked Lost.' });
    }

    const result = await prisma.$transaction(async (tx) => {
      const assignment = await assignLeadToProjectRoundRobinInTransaction(tx, {
        tenantId: lead.tenantId,
        leadId: lead.id,
        projectId: lead.projectId,
        userType: 'Recovery',
        actorId: req.user!.id,
        reason: recoveryReason,
      });
      await tx.lead.update({
        where: { id: req.params.id },
        data: { status: 'LOST', lostAt: new Date() },
      });

      await tx.auditLog.create({
        data: {
          tenantId: lead.tenantId,
          userId: req.user!.id,
          leadId: lead.id,
          action: 'MOVE_TO_RECOVERY',
          objectType: 'Lead',
          objectId: lead.id,
          oldValues: { status: lead.status, ownerId: lead.ownerId },
          newValues: { status: 'LOST', ownerId: assignment.assignedUserId, recoveryReason, recoveryNote: note, reason: recoveryReason },
        },
      });
      await appendLeadProcessNote(tx, {
        tenantId: lead.tenantId,
        leadId: lead.id,
        userId: req.user!.id,
        content: `Lead moved to Recovery. Reason: ${recoveryReason}${note ? `\nNotes: ${note}` : ''}`,
      });

      return tx.lead.findUniqueOrThrow({
        where: { id: lead.id },
        include: { owner: { select: { id: true, firstName: true, lastName: true } } },
      });
    });

    res.json({ success: true, data: result });
  } catch (error: any) {
    if (error?.message === 'RR_PROJECT_REQUIRED') {
      return res.status(409).json({ success: false, error: 'A project is required to assign this lead to Recovery.' });
    }
    if (error?.message === 'RR_QUEUE_NOT_CONFIGURED:Recovery' || error?.message === 'NO_ELIGIBLE_RR_MEMBER:Recovery') {
      return res.status(409).json({ success: false, error: 'No eligible Recovery member is available in a round-robin queue matching this project and lead source.' });
    }
    console.error('Move to recovery error:', error);
    res.status(500).json({ success: false, error: 'Failed to move lead to recovery' });
  }
});

router.post('/:id/schedule-site-visit', authorize('Lead', 'edit'), async (req: AuthRequest, res: Response) => {
  try {
    const request = z.object({
      projectId: z.string().trim().min(1, 'Project is required for site visit'),
      notes: z.string().trim().max(2000).optional(),
      scheduledAt: z.string().datetime('Visit date/time is required'),
      visitType: z.enum(SITE_VISIT_TYPE_OPTIONS, { errorMap: () => ({ message: 'Site visit type is required' }) }),
      rating: z.enum(SITE_VISIT_RATING_OPTIONS).nullable().optional(),
      transport: z.enum(SITE_VISIT_TRANSPORT_OPTIONS).nullable().optional(),
      callSummaryRemarks: z.string().trim().max(5000).optional(),
      minimumBudget: z.string().refine((value) => PROSPECT_BUDGET_OPTIONS.includes(value as typeof PROSPECT_BUDGET_OPTIONS[number])),
      maximumBudget: z.string().refine((value) => PROSPECT_BUDGET_OPTIONS.includes(value as typeof PROSPECT_BUDGET_OPTIONS[number])),
      propertyType: z.array(z.string().refine((value) => PROSPECT_PROPERTY_TYPE_OPTIONS.includes(value as typeof PROSPECT_PROPERTY_TYPE_OPTIONS[number]))).min(1),
      bedroomPreference: z.array(z.string().refine((value) => PROSPECT_BEDROOM_OPTIONS.includes(value as typeof PROSPECT_BEDROOM_OPTIONS[number]))).optional(),
    }).safeParse(req.body);
    if (!request.success) {
      return res.status(400).json({ success: false, error: request.error.issues[0].message });
    }
    const {
      scheduledAt,
      notes,
      projectId,
      visitType,
      rating,
      transport,
      callSummaryRemarks,
      minimumBudget,
      maximumBudget,
      propertyType,
      bedroomPreference,
    } = request.data;

    const lead = await prisma.lead.findFirst({
      where: { id: req.params.id, ...leadIdScope(req) },
      include: { owner: { select: { id: true, firstName: true, lastName: true } } },
    });

    if (!lead) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }

    if (!(await canAccessLead(req.user!, lead))) {
      return res.status(403).json({ success: false, error: 'You do not have access to this lead' });
    }

    const profileName = req.user!.profileName || 'Admin';
    const scheduledDate = new Date(scheduledAt);
    if (Number.isNaN(scheduledDate.getTime()) || scheduledDate.getTime() <= Date.now()) {
      return res.status(400).json({ success: false, error: SITE_VISIT_FUTURE_TIME_ERROR });
    }

    if (!canScheduleSiteVisit(profileName, lead.status)) {
      if (canonicalProfileName(profileName) === 'Presales') {
        return res.status(400).json({ success: false, error: 'Presales can schedule a site visit from a New, Incoming, or Prospect lead' });
      }
      if (lead.status !== 'PROSPECT') {
        return res.status(400).json({ success: false, error: 'Lead must be in Prospect status to schedule site visit' });
      }
      return res.status(403).json({ success: false, error: 'Not authorized to schedule site visits' });
    }

    const result = await prisma.$transaction(async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: projectId, tenantId: lead.tenantId, isActive: true },
        select: { id: true },
      });
      if (!project) {
        throw new Error('PROJECT_NOT_AVAILABLE');
      }

      await ensureSiteVisitScheduleFields(tx, lead.tenantId, req.user!.id);
      const siteVisitNumber = await getNextSiteVisitNumber(tx, lead.tenantId);
      const siteVisit = await tx.siteVisit.create({
        data: {
          tenantId: lead.tenantId,
          leadId: lead.id,
          projectId,
          creatorId: req.user!.id,
          siteVisitNumber,
          scheduledAt: new Date(scheduledAt),
          status: 'SCHEDULED',
          notes: notes || null,
          visitType,
          rating: null,
          transportRequired: null,
          customFields: {
            schedule_call_summary_remarks: callSummaryRemarks || null,
            schedule_minimum_budget: minimumBudget,
            schedule_maximum_budget: maximumBudget,
            schedule_property_type: propertyType,
            schedule_bedroom_preference: bedroomPreference || [],
            schedule_rating: rating || null,
            schedule_transport: transport || null,
          },
        },
        select: { id: true },
      });

      await assignSiteVisitToSVCInTransaction(tx, {
        siteVisitId: siteVisit.id,
        tenantId: lead.tenantId,
        actorId: req.user!.id,
      });
      const updatedLead = await tx.lead.update({
        where: { id: req.params.id },
        data: { status: 'SITE_VISIT_SCHEDULED', lostAt: null },
        include: {
          owner: { select: { id: true, firstName: true, lastName: true } },
        },
      });

      await tx.auditLog.create({
        data: {
          tenantId: lead.tenantId,
          userId: req.user!.id,
          leadId: lead.id,
          action: 'SITE_VISIT_SCHEDULED',
          objectType: 'Lead',
          objectId: lead.id,
          oldValues: { status: lead.status, ownerId: lead.ownerId },
          newValues: {
            status: 'SITE_VISIT_SCHEDULED',
            siteVisitId: siteVisit.id,
            note: notes || null,
            reason: notes || null,
            callSummaryRemarks: callSummaryRemarks || null,
          },
        },
      });
      await appendLeadProcessNote(tx, {
        tenantId: lead.tenantId,
        leadId: lead.id,
        userId: req.user!.id,
        content: [
          `Site visit scheduled: ${siteVisitNumber}`,
          `Scheduled: ${scheduledDate.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
          notes ? `Notes: ${notes}` : null,
          callSummaryRemarks ? `Call summary: ${callSummaryRemarks}` : null,
        ].filter(Boolean).join('\n'),
      });

      const assignedSiteVisit = await tx.siteVisit.findUniqueOrThrow({
        where: { id: siteVisit.id },
        include: {
          assignee: { select: { id: true, firstName: true, lastName: true } },
          project: { select: { id: true, name: true } },
        },
      });
      return { lead: updatedLead, siteVisit: assignedSiteVisit };
    });

    res.json({ success: true, data: result });
  } catch (error: any) {
    if (error?.message === 'PROJECT_NOT_AVAILABLE') {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }
    if (error?.message === 'SVC_QUEUE_NOT_CONFIGURED' || error?.message === 'NO_ELIGIBLE_SVC_MEMBER') {
      return res.status(409).json({ success: false, error: 'No eligible SVC member is available in a round-robin queue matching this project and lead source.' });
    }
    console.error('Schedule site visit error:', error);
    res.status(500).json({ success: false, error: 'Failed to schedule site visit' });
  }
});

router.put('/:id/status', authorize('Lead', 'edit'), async (_req: AuthRequest, res: Response) => {
  res.status(403).json({
    success: false,
    error: 'Lead status cannot be changed from the status bar.',
  });
});

router.patch('/:id/owner', authorize('Lead', 'assign'), async (req: AuthRequest, res: Response) => {
  try {
    const { ownerId, reason } = req.body || {};
    const data = await changeLeadOwner({
      leadId: req.params.id,
      newOwnerId: typeof ownerId === 'string' ? ownerId : '',
      reason: typeof reason === 'string' ? reason : '',
      changedBy: req.user!,
    });
    res.json({ success: true, data });
  } catch (error: any) {
    const message = error?.message || 'Failed to change lead owner';
    const status = message === 'Lead not found' ? 404
      : message.includes('access') || message.includes('permission') ? 403
      : message.includes('required') || message.includes('different') || message.includes('eligible') ? 400
      : 500;
    if (status === 500) console.error('Change lead owner error:', error);
    res.status(status).json({ success: false, error: message });
  }
});

router.put('/:id/assign', authorize('Lead', 'assign'), async (req: AuthRequest, res: Response) => {
  try {
    const data = await changeLeadOwner({
      leadId: req.params.id,
      newOwnerId: typeof req.body?.ownerId === 'string' ? req.body.ownerId : '',
      reason: typeof req.body?.reason === 'string' ? req.body.reason : '',
      changedBy: req.user!,
    });
    res.json({ success: true, data });
  } catch (error: any) {
    const message = error?.message || 'Failed to change lead owner';
    const status = message === 'Lead not found' ? 404
      : message.includes('access') ? 403
      : message.includes('required') || message.includes('different') || message.includes('eligible') ? 400
      : 500;
    if (status === 500) console.error('Assign lead error:', error);
    res.status(status).json({ success: false, error: message });
  }
});

router.get('/:id/owner-candidates', authorize('Lead', 'assign'), async (req: AuthRequest, res: Response) => {
  try {
    const lead = await prisma.lead.findFirst({
      where: { id: req.params.id, ...leadIdScope(req) },
      select: { id: true, tenantId: true, ownerId: true, creatorId: true },
    });
    if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });
    if (!(await canAccessLead(req.user!, lead))) {
      return res.status(403).json({ success: false, error: 'You do not have access to this lead' });
    }
    const candidates = await getEligibleLeadOwners(lead.tenantId, lead.ownerId);
    res.json({ success: true, data: candidates });
  } catch (error) {
    console.error('Get lead owner candidates error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch eligible owners' });
  }
});

router.get('/:id/owner-history', authorize('Lead', 'read'), async (req: AuthRequest, res: Response) => {
  try {
    const lead = await prisma.lead.findFirst({
      where: { id: req.params.id, ...leadIdScope(req) },
    });

    if (!lead) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }

    if (!(await canAccessLead(req.user!, lead))) {
      return res.status(403).json({ success: false, error: 'You do not have access to this lead' });
    }

    const history = await getOwnerHistory(lead.tenantId, req.params.id);
    res.json({ success: true, data: history });
  } catch (error) {
    console.error('Get owner history error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch owner history' });
  }
});

router.get('/:id/activity-history', authorize('Lead', 'read'), async (req: AuthRequest, res: Response) => {
  try {
    const page = Number(req.query.page ?? 1);
    const limit = Number(req.query.limit ?? 100);
    if (!Number.isInteger(page) || page < 1 || page > 100 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      return res.status(400).json({ success: false, error: 'Invalid activity history page or limit' });
    }

    const lead = await prisma.lead.findFirst({
      where: { id: req.params.id, ...leadIdScope(req) },
      select: { id: true, tenantId: true, ownerId: true, creatorId: true },
    });

    if (!lead) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }

    if (!(await canAccessLead(req.user!, lead))) {
      return res.status(403).json({ success: false, error: 'You do not have access to this lead' });
    }

    const where = { tenantId: lead.tenantId, leadId: lead.id };
    const followUpWhere = { ...where, ...followUpOwnerClause(req.user!) };
    const take = page * limit;
    const leadWorkflowActions = [
      'UPDATE',
      'MOVE_TO_RECOVERY',
      'NOTE_CREATED',
      'OWNER_CHANGED',
      'PUSH_TO_SVC',
      'SITE_VISIT_COMPLETED',
      'SITE_VISIT_MISSED',
      'SITE_VISIT_SCHEDULED',
      'STATUS_CHANGE',
    ];
    const siteVisitWorkflowActions = [
      'SITE_VISIT_CANCELLED',
      'SITE_VISIT_COMPLETED',
      'SITE_VISIT_CREATED',
      'DELETE',
      'SITE_VISIT_MISSED',
      'SITE_VISIT_REVISIT_CREATED',
      'SITE_VISIT_RESCHEDULED',
      'SITE_VISIT_UPDATED',
    ];
    const workflowWhere = {
      tenantId: lead.tenantId,
      leadId: lead.id,
      OR: [
        { objectType: 'Lead', action: { in: leadWorkflowActions } },
        { objectType: 'SiteVisit', action: { in: siteVisitWorkflowActions } },
        { objectType: 'FollowUp', action: { in: ['UPDATE', 'STATUS_CHANGE', 'DELETE', 'FOLLOW_UP_CREATED'] } },
        { objectType: 'Activity', action: { in: ['UPDATE', 'STATUS_CHANGE', 'DELETE'] } },
        { objectType: 'CallDetail', action: { in: ['UPDATE', 'DELETE'] } },
      ],
    };
    const [activityRecords, followUpRecords, callDetailRecords, workflowRecords, activityCount, followUpCount, callDetailCount, workflowCount] = await Promise.all([
      prisma.activity.findMany({
        where,
        include: {
          user: { select: { id: true, firstName: true, lastName: true } },
        },
        take,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      prisma.followUp.findMany({
        where: followUpWhere,
        include: {
          owner: { select: { id: true, firstName: true, lastName: true } },
        },
        take,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      prisma.callDetail.findMany({
        where: { tenantId: lead.tenantId, leadId: lead.id },
        include: {
          createdBy: { select: { id: true, firstName: true, lastName: true } },
        },
        take,
        orderBy: [{ startAt: 'desc' }, { id: 'desc' }],
      }),
      prisma.auditLog.findMany({
        where: workflowWhere,
        include: {
          user: { select: { id: true, firstName: true, lastName: true } },
        },
        take,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      prisma.activity.count({ where }),
      prisma.followUp.count({ where: followUpWhere }),
      prisma.callDetail.count({ where: { tenantId: lead.tenantId, leadId: lead.id } }),
      prisma.auditLog.count({
        where: workflowWhere,
      }),
    ]);
    const workflowSummaries: Record<string, { subject: string; description: string }> = {
      MOVE_TO_RECOVERY: { subject: 'Moved to Recovery', description: 'Lead marked Lost and assigned to Recovery.' },
      NOTE_CREATED: { subject: 'Note Added', description: 'A note was added to this lead.' },
      OWNER_CHANGED: { subject: 'Owner Changed', description: 'Lead owner was changed.' },
      PUSH_TO_SVC: { subject: 'Pushed to SVC', description: 'Lead moved to Prospect and assigned to SVC.' },
      SITE_VISIT_COMPLETED: { subject: 'Site Visit Completed', description: 'Site visit marked completed.' },
      SITE_VISIT_CANCELLED: { subject: 'Site Visit Cancelled', description: 'Site visit was cancelled.' },
      SITE_VISIT_CREATED: { subject: 'Site Visit Scheduled', description: 'A site visit was scheduled.' },
      SITE_VISIT_MISSED: { subject: 'Site Visit Missed', description: 'Site visit marked missed.' },
      SITE_VISIT_SCHEDULED: { subject: 'Site Visit Scheduled', description: 'A site visit was scheduled.' },
      SITE_VISIT_REVISIT_CREATED: { subject: 'Revisit Scheduled', description: 'A site visit revisit was scheduled.' },
      SITE_VISIT_RESCHEDULED: { subject: 'Site Visit Rescheduled', description: 'The scheduled date or time for this site visit was changed.' },
      SITE_VISIT_UPDATED: { subject: 'Site Visit Updated', description: 'Site visit details were updated.' },
      TASK_UPDATED: { subject: 'Task Updated', description: 'Task details or status were updated.' },
      TASK_COMPLETED: { subject: 'Task Completed', description: 'Task was completed.' },
      ASSIGN: { subject: 'Task Assigned', description: 'Task was assigned.' },
      UPDATE: { subject: 'Record Updated', description: 'Record details were updated.' },
      STATUS_CHANGE: { subject: 'Status Updated', description: 'Record status was updated.' },
      DELETE: { subject: 'Record Deleted', description: 'A related record was deleted.' },
    };
    const uniqueWorkflowRecords = workflowRecords.filter((record) => {
      if (record.objectType !== 'Lead' || !['SITE_VISIT_SCHEDULED', 'SITE_VISIT_COMPLETED', 'SITE_VISIT_CANCELLED'].includes(record.action)) {
        return true;
      }
      const values = record.newValues;
      const siteVisitId =
        values && typeof values === 'object' && !Array.isArray(values) &&
        'siteVisitId' in values && typeof values.siteVisitId === 'string'
          ? values.siteVisitId
          : null;
      return !siteVisitId || !workflowRecords.some((candidate) =>
        candidate.objectType === 'SiteVisit' &&
        candidate.action === record.action &&
        candidate.objectId === siteVisitId,
      );
    });
    const combined = [
      ...activityRecords.map((activity) => ({ ...activity, feedType: activity.type })),
      ...followUpRecords.map((followUp) => ({
        ...followUp,
        type: 'FOLLOW_UP',
        subject: followUp.title,
        notes: followUp.description,
        status: followUp.isCompleted ? 'COMPLETED' : 'PLANNED',
        createdAt: followUp.createdAt,
        user: followUp.owner,
        feedType: 'FOLLOW_UP',
      })),
      ...callDetailRecords.map((callDetail) => ({
        ...callDetail,
        type: 'CALL_DETAIL',
        subject: `${callDetail.callType === 'INBOUND' ? 'Inbound' : 'Outbound'} Call`,
        createdAt: callDetail.startAt,
        user: callDetail.createdBy,
        feedType: 'CALL_DETAIL',
      })),
      ...uniqueWorkflowRecords.map((record) => ({
        id: record.id,
        type: 'WORKFLOW',
        action: record.action,
        objectType: record.objectType,
        objectId: record.objectId,
        oldValues: record.oldValues,
        newValues: record.newValues,
        subject: workflowSummaries[record.action]?.subject || 'Lead Updated',
        description:
          record.action === 'NOTE_CREATED' &&
          record.newValues &&
          typeof record.newValues === 'object' &&
          !Array.isArray(record.newValues) &&
          'note' in record.newValues &&
          typeof record.newValues.note === 'string'
            ? record.newValues.note
            : workflowSummaries[record.action]?.description || 'Lead workflow was updated.',
        notes: null,
        status: null,
        createdAt: record.createdAt,
        user: record.user,
        impersonatedById: record.impersonatedById,
        feedType: 'WORKFLOW',
      })),
    ].sort((first, second) =>
      second.createdAt.getTime() - first.createdAt.getTime() || second.id.localeCompare(first.id),
    );
    const activities = await withImpersonatorNames(combined.slice((page - 1) * limit, page * limit));
    const totalEntries = activityCount + followUpCount + callDetailCount + workflowCount;

    res.json({
      success: true,
      data: activities,
      pagination: {
        page,
        limit,
        total: totalEntries,
        totalPages: Math.ceil(totalEntries / limit),
      },
    });
  } catch (error) {
    console.error('Get lead activity history error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch lead activity history' });
  }
});

router.get('/:id/audit-history', authorize('Lead', 'read'), async (req: AuthRequest, res: Response) => {
  try {
    const { page = 1, limit = 20, action } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const lead = await prisma.lead.findFirst({
      where: { id: req.params.id, ...leadIdScope(req) },
      select: { id: true, tenantId: true, ownerId: true, creatorId: true },
    });

    if (!lead) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }

    if (!(await canAccessLead(req.user!, lead))) {
      return res.status(403).json({ success: false, error: 'You do not have access to this lead' });
    }

    const where: any = {
      tenantId: lead.tenantId,
      OR: [{ leadId: lead.id }, { objectType: 'Lead', objectId: lead.id }],
    };
    if (action) where.action = action;

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: {
          user: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
        skip,
        take: Number(limit),
        orderBy: { createdAt: 'desc' },
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({
      success: true,
      data: await withImpersonatorNames(await enrichAuditLogs(logs)),
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error) {
    console.error('Get lead audit history error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch lead audit history' });
  }
});

export { router as leadRoutes };