import { Prisma } from '@prisma/client';
import { leadCreateSchema } from '@dct-crm/shared';
import { prisma } from '@dct-crm/db';
import { getNextSiteVisitNumber } from './leadWorkflowExtras';
import { createOwnerHistory } from './ownerHistory';
import {
  acquireLeadDuplicateLocks,
  duplicateLeadFields,
  findLeadDuplicatesBatch,
  findLeadDuplicates,
  type LeadDuplicateInput,
  type LeadDuplicateMatch,
  normalizeLeadEmail,
  normalizeLeadPhone,
  validateLeadContactInput,
} from './leadDuplicateDetection';
import {
  assignLeadToProjectRoundRobinInTransaction,
  assignSiteVisitToSVCInTransaction,
  findApplicableRRQueue,
  isLeadEligibleForAutoAssignment,
  RoundRobinAssignmentService,
} from './rrQueue';
import { createEnquiryInTransaction, createEnquiryInTransactionWithStatus } from './enquiryService';
import { extractEnquiryAttributes } from './enquiryFieldMap';
import {
  asCustomFieldObject,
  classifyMatchedLeadLifecycle,
  mergeOperationalLeadCustomFields,
  tagLeadEnquiryAttribution,
  tagLeadSiteVisitEvents,
} from './leadEventTagging';

export type EnquiryAction =
  | 'NEW_LEAD'
  | 'EXISTING_ACTIVE'
  | 'RE_ENGAGED'
  | 'RE_OPENED'
  | 'OUTSIDE_REENGAGEMENT_WINDOW'
  | 'DUPLICATE_CONFLICT'
  | 'IDEMPOTENT_REPLAY';

export interface EnquiryMetadata {
  source: string;
  subSource?: string;
  campaign?: string;
  subCampaign?: string;
  secondaryPhone?: string;
  tertiaryPhone?: string;
  secondaryEmail?: string;
  tertiaryEmail?: string;
  originalSubmissionId?: string;
  countryCode?: string;
  secondaryCountryCode?: string;
  tertiaryCountryCode?: string;
  medium?: string;
  description?: string;
  channelPartner?: string;
  campaignId?: string;
  subCampaignId?: string;
  enquiryDate?: Date;
  details?: Record<string, unknown>;
}

type LeadCreateData = ReturnType<typeof leadCreateSchema.parse>;

const DEFAULT_REENGAGEMENT_DAYS = 25;

export interface LeadEnquiryInput {
  tenantId: string;
  userId: string;
  salesUserId?: string;
  profileName?: string | null;
  expectedLeadId?: string;
  lead: LeadCreateData;
  enquiry: EnquiryMetadata;
  siteVisit?: { projectId?: string; scheduledAt: Date; notes?: string };
}

export function leadDuplicateInputForEnquiry(input: LeadEnquiryInput): LeadDuplicateInput {
  return {
    phones: [
      { field: 'phone', value: input.lead.phone, countryCode: input.enquiry.countryCode },
      { field: 'mobile', value: input.lead.mobile, countryCode: input.enquiry.countryCode },
      { field: 'secondaryPhone', value: input.enquiry.secondaryPhone, countryCode: input.enquiry.secondaryCountryCode || input.enquiry.countryCode },
      { field: 'tertiaryPhone', value: input.enquiry.tertiaryPhone, countryCode: input.enquiry.tertiaryCountryCode || input.enquiry.secondaryCountryCode || input.enquiry.countryCode },
    ],
    emails: [
      { field: 'email', value: normalizeLeadEmail(input.lead.email) },
      { field: 'secondaryEmail', value: normalizeLeadEmail(input.enquiry.secondaryEmail) },
      { field: 'tertiaryEmail', value: normalizeLeadEmail(input.enquiry.tertiaryEmail) },
    ],
  };
}

function settingDays(settings: unknown): number {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return DEFAULT_REENGAGEMENT_DAYS;
  }
  const value = (settings as Record<string, unknown>).reEngagementValidationDays
    ?? (settings as Record<string, unknown>).RE_ENGAGEMENT_VALIDATION_DAYS;
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : DEFAULT_REENGAGEMENT_DAYS;
}

function normalizeDateParts(date: Date, timezone: string): [number, number, number] {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return [Number(values.year), Number(values.month), Number(values.day)];
}

export function getCalendarDaysBetween(start: Date, end: Date, timezone = 'UTC'): number {
  const [startYear, startMonth, startDay] = normalizeDateParts(start, timezone);
  const [endYear, endMonth, endDay] = normalizeDateParts(end, timezone);
  return Math.floor(
    (Date.UTC(endYear, endMonth - 1, endDay) - Date.UTC(startYear, startMonth - 1, startDay)) /
    86_400_000,
  );
}

export function classifyEnquiryAction(
  status: string,
  daysSinceLost: number | null,
  validationDays: number,
): Exclude<EnquiryAction, 'DUPLICATE_CONFLICT' | 'NEW_LEAD'> {
  if (status !== 'LOST') return 'EXISTING_ACTIVE';
  return daysSinceLost !== null && daysSinceLost >= validationDays
    ? 'RE_ENGAGED'
    : 'OUTSIDE_REENGAGEMENT_WINDOW';
}

async function getLostDate(
  tx: Prisma.TransactionClient,
  lead: { id: string; tenantId: string; lostAt: Date | null; createdAt: Date },
): Promise<Date> {
  if (lead.lostAt) return lead.lostAt;
  const lastLostAudit = await tx.auditLog.findFirst({
    where: {
      tenantId: lead.tenantId,
      leadId: lead.id,
      newValues: { path: ['status'], equals: 'LOST' },
    },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  return lastLostAudit?.createdAt || lead.createdAt;
}

async function getNextLeadNumber(tx: Prisma.TransactionClient, tenantId: string): Promise<string> {
  const sequence = await tx.sequence.upsert({
    where: { tenantId_type: { tenantId, type: 'LEAD' } },
    update: { nextValue: { increment: 1 } },
    create: { tenantId, type: 'LEAD', nextValue: 1 },
  });
  return `LN${String(sequence.nextValue).padStart(6, '0')}`;
}

export function sourceEnumValue(source: string): LeadCreateData['source'] {
  return source.trim() || 'OTHER';
}

export function canonicalizeLeadSource(source: string): string {
  const normalized = source.trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (['FB', 'FB_AD', 'FB_ADS', 'FACEBOOK_AD', 'FACEBOOK_ADS', 'FACEBOOK_LEAD', 'FACEBOOK_LEAD_AD', 'META', 'META_ADS'].includes(normalized)) {
    return 'FACEBOOK';
  }
  return normalized || 'OTHER';
}

function serializeDetails(details: Record<string, unknown> | undefined): Prisma.InputJsonValue | undefined {
  if (!details) return undefined;
  return JSON.parse(JSON.stringify(details)) as Prisma.InputJsonValue;
}

export async function processLeadEnquiry(
  input: LeadEnquiryInput,
  options: {
    transaction?: Prisma.TransactionClient;
    duplicateMatches?: LeadDuplicateMatch[];
    duplicateLocksAcquired?: boolean;
    rejectDuplicates?: boolean;
  } = {},
) {
  const validationErrors = validateLeadContactInput({
    phones: [
      { field: 'phone', value: input.lead.phone, countryCode: input.enquiry.countryCode },
      { field: 'mobile', value: input.lead.mobile, countryCode: input.enquiry.countryCode },
      { field: 'secondaryPhone', value: input.enquiry.secondaryPhone, countryCode: input.enquiry.secondaryCountryCode || input.enquiry.countryCode },
      { field: 'tertiaryPhone', value: input.enquiry.tertiaryPhone, countryCode: input.enquiry.tertiaryCountryCode || input.enquiry.secondaryCountryCode || input.enquiry.countryCode },
    ],
    emails: [
      { field: 'email', value: input.lead.email },
      { field: 'secondaryEmail', value: input.enquiry.secondaryEmail },
      { field: 'tertiaryEmail', value: input.enquiry.tertiaryEmail },
    ],
  });
  if (validationErrors.length) {
    throw Object.assign(new Error('LEAD_CONTACT_VALIDATION'), { validationErrors });
  }
  const normalizedPhone = normalizeLeadPhone(input.lead.phone, input.enquiry.countryCode)?.e164;
  if (!normalizedPhone) throw new Error('PHONE_REQUIRED');
  const metadata = {
    ...input.enquiry,
    source: canonicalizeLeadSource(input.enquiry.source) || input.lead.source,
    secondaryPhone: input.enquiry.secondaryPhone
      ? normalizeLeadPhone(input.enquiry.secondaryPhone, input.enquiry.secondaryCountryCode || input.enquiry.countryCode)?.e164
      : undefined,
    tertiaryPhone: input.enquiry.tertiaryPhone
      ? normalizeLeadPhone(input.enquiry.tertiaryPhone, input.enquiry.tertiaryCountryCode || input.enquiry.secondaryCountryCode || input.enquiry.countryCode)?.e164
      : undefined,
    countryCode: input.enquiry.countryCode ? `+${input.enquiry.countryCode.replace(/\D/g, '')}` : undefined,
    secondaryCountryCode: input.enquiry.secondaryCountryCode
      ? `+${input.enquiry.secondaryCountryCode.replace(/\D/g, '')}`
      : undefined,
    tertiaryCountryCode: input.enquiry.tertiaryCountryCode
      ? `+${input.enquiry.tertiaryCountryCode.replace(/\D/g, '')}`
      : undefined,
    secondaryEmail: normalizeLeadEmail(input.enquiry.secondaryEmail) || undefined,
    tertiaryEmail: normalizeLeadEmail(input.enquiry.tertiaryEmail) || undefined,
    originalSubmissionId: input.enquiry.originalSubmissionId?.trim()
      ? `${input.enquiry.source.trim().toUpperCase()}:${input.enquiry.originalSubmissionId.trim()}`
      : undefined,
  };

  const processInTransaction = async (tx: Prisma.TransactionClient) => {
    if (metadata.originalSubmissionId) {
      await tx.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(
          ${`LEAD_SUBMISSION:${input.tenantId}:${metadata.originalSubmissionId}`}, 0
        ))
      `);
      const priorEnquiry = await tx.enquiry.findFirst({
        where: {
          tenantId: input.tenantId,
          originalSubmissionId: metadata.originalSubmissionId,
        },
        include: {
          project: { select: { id: true, name: true } },
          lead: {
            include: {
              owner: { select: { id: true, firstName: true, lastName: true } },
              project: { select: { id: true, name: true } },
            },
          },
        },
      });
      if (priorEnquiry) {
        return {
          action: 'IDEMPOTENT_REPLAY' as const,
          lead: priorEnquiry.lead,
          leadId: priorEnquiry.leadId,
          enquiry: priorEnquiry,
        };
      }
    }

    const selectedOwner = input.salesUserId
      ? await tx.user.findFirst({
          where: { id: input.salesUserId, tenantId: input.tenantId, isActive: true },
          select: { id: true, profile: { select: { name: true } } },
        })
      : null;
    if (input.salesUserId && !/^sales(?:\b|$)/i.test(selectedOwner?.profile?.name || '')) {
      throw new Error('SALES_USER_INVALID');
    }
    const ownerId = selectedOwner?.id || input.userId;
    const ownerProfileName = selectedOwner?.profile?.name || input.profileName || null;

    const duplicateInput = leadDuplicateInputForEnquiry(input);
    if (!options.duplicateLocksAcquired) {
      await acquireLeadDuplicateLocks(tx, input.tenantId, duplicateInput);
    }
    for (const projectId of new Set([input.lead.projectId, input.siteVisit?.projectId].filter(Boolean))) {
      const project = await tx.project.findFirst({
        where: { id: projectId!, tenantId: input.tenantId, isActive: true },
        select: { id: true },
      });
      if (!project) throw new Error('INVALID_PROJECT');
    }
    const createSiteVisit = async (leadId: string) => {
      if (!input.siteVisit) return null;
      const projectId = input.siteVisit.projectId || input.lead.projectId || null;
      if (!projectId) throw new Error('INVALID_PROJECT');
      const project = await tx.project.findFirst({
        where: { id: projectId, tenantId: input.tenantId, isActive: true },
        select: { name: true },
      });
      if (!project) throw new Error('INVALID_PROJECT');
      const siteVisitNumber = await getNextSiteVisitNumber(tx, input.tenantId);
      const siteVisit = await tx.siteVisit.create({
        data: {
          tenantId: input.tenantId,
          leadId,
          projectId,
          creatorId: input.userId,
          siteVisitNumber,
          scheduledAt: input.siteVisit.scheduledAt,
          status: 'SCHEDULED',
          notes: input.siteVisit.notes,
        },
        select: { id: true, siteVisitNumber: true, projectId: true, scheduledAt: true, status: true },
      });
      await tagLeadSiteVisitEvents(tx, {
        tenantId: input.tenantId,
        leadId,
        scheduledAt: input.siteVisit.scheduledAt,
        projectName: project.name,
      });
      await assignSiteVisitToSVCInTransaction(tx, {
        siteVisitId: siteVisit.id,
        tenantId: input.tenantId,
        actorId: input.userId,
      });
      await tx.auditLog.create({
        data: {
          tenantId: input.tenantId,
          userId: input.userId,
          action: 'SITE_VISIT_CREATED',
          objectType: 'SiteVisit',
          objectId: siteVisit.id,
          newValues: { leadId, scheduledAt: siteVisit.scheduledAt, siteVisitNumber, source: 'GRE' },
        },
      });
      return siteVisit;
    };

    const duplicateMatches = options.duplicateMatches
      || await findLeadDuplicates(tx, input.tenantId, duplicateInput);
    const matchingIds = duplicateMatches.map((match) => match.lead.id);
    const existingLeads = matchingIds.length
      ? await tx.lead.findMany({
          where: { tenantId: input.tenantId, id: { in: matchingIds } },
          include: {
            owner: { select: { id: true, firstName: true, lastName: true } },
            project: { select: { id: true, name: true } },
          },
        })
      : [];

    if (options.rejectDuplicates && !input.expectedLeadId && duplicateMatches.length) {
      throw Object.assign(new Error('DUPLICATE_LEAD'), {
        code: 'DUPLICATE_LEAD',
        duplicateFields: duplicateLeadFields(duplicateMatches),
      });
    }

    if (existingLeads.length > 1 || duplicateMatches.some((match) => match.ambiguous)) {
      await tx.auditLog.create({
        data: {
          tenantId: input.tenantId,
          userId: input.userId,
          action: 'DUPLICATE_MATCH_AMBIGUOUS',
          objectType: 'LeadDuplicate',
          newValues: {
            leadIds: existingLeads.map((lead) => lead.id),
            matchingFields: duplicateMatches.map((match) => ({
              leadId: match.lead.id,
              fields: match.matchedFields,
            })),
            source: metadata.source,
            projectId: input.lead.projectId || null,
            campaign: metadata.campaign || null,
            at: new Date().toISOString(),
          },
        },
      });
      return { action: 'DUPLICATE_CONFLICT' as const, leadIds: existingLeads.map((lead) => lead.id) };
    }
    if (
      input.expectedLeadId &&
      (existingLeads.length !== 1 || existingLeads[0].id !== input.expectedLeadId)
    ) {
      if (existingLeads.length === 1) {
        await tx.auditLog.create({
          data: {
            tenantId: input.tenantId,
            userId: input.userId,
            leadId: existingLeads[0].id,
            action: 'DUPLICATE_MATCH_REJECTED',
            objectType: 'LeadDuplicate',
            newValues: {
              expectedLeadId: input.expectedLeadId,
              matchedLeadId: existingLeads[0].id,
              matchingFields: duplicateMatches[0]?.matchedFields || [],
              source: metadata.source,
              projectId: input.lead.projectId || null,
              action: 'LINK_TO_DIFFERENT_LEAD_REJECTED',
            },
          },
        });
      }
      return { action: 'LEAD_MISMATCH' as const, leadIds: existingLeads.map((lead) => lead.id) };
    }

    const source = sourceEnumValue(input.lead.source || metadata.source);
    const now = new Date();
    if (existingLeads.length === 1) {
      const existing = existingLeads[0];
      const tenant = await tx.tenant.findUnique({
        where: { id: input.tenantId },
        select: { settings: true, timezone: true },
      });
      const validationDays = settingDays(tenant?.settings);
      const lostDate = existing.status === 'LOST' ? await getLostDate(tx, existing) : null;
      const timezone = tenant?.timezone || 'UTC';
      const daysDifference = lostDate ? getCalendarDaysBetween(lostDate, now, timezone) : null;
      const legacyLeadStatus = asCustomFieldObject(existing.customFields).sf_Lead_Status__c;
      const matchedLifecycle = classifyMatchedLeadLifecycle(existing.status, legacyLeadStatus);
      const isReOpened = matchedLifecycle === 'Re-Opened';
      const classifiedAction = classifyEnquiryAction(existing.status, daysDifference, validationDays);
      const action = isReOpened ? 'RE_OPENED' as const : classifiedAction;
      const proposedLeadType = isReOpened
        ? 'RE_OPENED'
        : classifiedAction === 'OUTSIDE_REENGAGEMENT_WINDOW'
          ? 'OUTSIDE_REENGAGEMENT_WINDOW'
          : 'RE_ENGAGED';
      const proposedEnquiryType = proposedLeadType;
      const enquiryResult = await createEnquiryInTransactionWithStatus(tx, {
        tenantId: input.tenantId,
        leadId: existing.id,
        leadType: proposedLeadType,
        enquiryType: proposedEnquiryType,
        source: metadata.source,
        subSource: metadata.subSource,
        campaignId: metadata.campaignId,
        campaign: metadata.campaign,
        subCampaignId: metadata.subCampaignId,
        subCampaign: metadata.subCampaign,
        projectId: input.lead.projectId || undefined,
        phone: input.lead.phone,
        countryCode: metadata.countryCode,
        secondaryPhone: input.enquiry.secondaryPhone,
        secondaryCountryCode: metadata.secondaryCountryCode,
        tertiaryPhone: input.enquiry.tertiaryPhone,
        tertiaryCountryCode: metadata.tertiaryCountryCode,
        email: input.lead.email,
        secondaryEmail: input.enquiry.secondaryEmail,
        tertiaryEmail: input.enquiry.tertiaryEmail,
        originalSubmissionId: metadata.originalSubmissionId,
        medium: metadata.medium,
        description: metadata.description,
        channelPartner: metadata.channelPartner,
        ownerId: existing.ownerId,
        attributes: extractEnquiryAttributes(existing.customFields),
        details: serializeDetails({
          ...metadata.details,
          previousLeadStatus: existing.status,
        }),
        enquiryDate: metadata.enquiryDate,
        userId: input.userId,
      });
      const { enquiry, created: enquiryCreated } = enquiryResult;
      const lifecycleType = enquiryCreated
        ? proposedLeadType
        : enquiry.leadType === 'RE_OPENED'
          ? 'RE_OPENED'
          : enquiry.leadType === 'RE_ENGAGED'
            ? 'RE_ENGAGED'
            : null;
      const processReOpened = enquiryCreated && lifecycleType === 'RE_OPENED';
      const processReEngaged = enquiryCreated && lifecycleType === 'RE_ENGAGED';

      const leadUpdates: Prisma.LeadUpdateInput = {};
      const contactOldValues: Record<string, string | null> = {};
      const contactNewValues: Record<string, string> = {};
      if (enquiryCreated) {
        const phoneSlots = [
          { field: 'phone', value: existing.phone, countryCode: existing.countryCode },
          { field: 'mobile', value: existing.mobile, countryCode: existing.countryCode },
          { field: 'secondaryPhone', value: existing.secondaryPhone, countryCode: existing.secondaryCountryCode },
          { field: 'tertiaryPhone', value: existing.tertiaryPhone, countryCode: existing.tertiaryCountryCode },
        ];
        const incomingPhones = [
          { field: 'phone', value: input.lead.phone, countryCode: metadata.countryCode },
          { field: 'mobile', value: input.lead.mobile, countryCode: metadata.countryCode },
          { field: 'secondaryPhone', value: input.enquiry.secondaryPhone, countryCode: metadata.secondaryCountryCode || metadata.countryCode },
          { field: 'tertiaryPhone', value: input.enquiry.tertiaryPhone, countryCode: metadata.tertiaryCountryCode || metadata.secondaryCountryCode || metadata.countryCode },
        ];
        for (const incoming of incomingPhones) {
          const normalized = normalizeLeadPhone(incoming.value, incoming.countryCode);
          if (!normalized) continue;
          const alreadyStored = phoneSlots.some((slot) =>
            normalizeLeadPhone(slot.value, slot.countryCode)?.e164 === normalized.e164,
          );
          if (alreadyStored) continue;
          const slot = phoneSlots.find((candidate) => !candidate.value);
          if (!slot) continue;
          contactOldValues[slot.field] = null;
          contactNewValues[slot.field] = normalized.e164;
          if (slot.field === 'phone') {
            leadUpdates.phone = normalized.e164;
            leadUpdates.countryCode = normalized.countryCode ? `+${normalized.countryCode}` : undefined;
          } else if (slot.field === 'mobile') {
            leadUpdates.mobile = normalized.e164;
            const secondarySlot = phoneSlots.find((candidate) => candidate.field === 'secondaryPhone');
            if (!secondarySlot?.value) {
              leadUpdates.secondaryPhone = normalized.e164;
              leadUpdates.secondaryCountryCode = normalized.countryCode ? `+${normalized.countryCode}` : undefined;
              if (secondarySlot) {
                secondarySlot.value = normalized.e164;
                secondarySlot.countryCode = normalized.countryCode ? `+${normalized.countryCode}` : null;
              }
            }
          } else if (slot.field === 'secondaryPhone') {
            leadUpdates.secondaryPhone = normalized.e164;
            leadUpdates.secondaryCountryCode = normalized.countryCode ? `+${normalized.countryCode}` : undefined;
            const mobileSlot = phoneSlots.find((candidate) => candidate.field === 'mobile');
            if (!mobileSlot?.value) {
              leadUpdates.mobile = normalized.e164;
              if (mobileSlot) {
                mobileSlot.value = normalized.e164;
                mobileSlot.countryCode = normalized.countryCode ? `+${normalized.countryCode}` : null;
              }
            }
          } else {
            leadUpdates.tertiaryPhone = normalized.e164;
            leadUpdates.tertiaryCountryCode = normalized.countryCode ? `+${normalized.countryCode}` : undefined;
          }
          slot.value = normalized.e164;
          slot.countryCode = normalized.countryCode ? `+${normalized.countryCode}` : null;
        }

        const emailSlots = [
          { field: 'email', value: existing.email },
          { field: 'secondaryEmail', value: existing.secondaryEmail },
          { field: 'tertiaryEmail', value: existing.tertiaryEmail || existing.alternateEmail },
        ];
        const incomingEmails = [
          input.lead.email,
          input.enquiry.secondaryEmail,
          input.enquiry.tertiaryEmail,
        ];
        for (const incoming of incomingEmails) {
          const normalized = normalizeLeadEmail(incoming);
          if (!normalized || emailSlots.some((slot) => normalizeLeadEmail(slot.value) === normalized)) continue;
          const slot = emailSlots.find((candidate) => !candidate.value);
          if (!slot) continue;
          contactOldValues[slot.field] = null;
          contactNewValues[slot.field] = normalized;
          if (slot.field === 'email') leadUpdates.email = normalized;
          else if (slot.field === 'secondaryEmail') leadUpdates.secondaryEmail = normalized;
          else leadUpdates.tertiaryEmail = normalized;
          slot.value = normalized;
        }
        leadUpdates.lastSource = metadata.source;
        leadUpdates.lastSubSource = metadata.subSource || null;
        leadUpdates.lastCampaign = metadata.campaign || null;
        leadUpdates.lastEnquiryAt = now;
        leadUpdates.enquiryCount = { increment: 1 };
        if (!existing.firstCampaign && metadata.campaign) leadUpdates.firstCampaign = metadata.campaign;
      }
      if (enquiryCreated && (processReOpened || action === 'RE_ENGAGED')) {
        Object.assign(leadUpdates, {
            status: 'NEW',
            leadType: processReOpened ? 'RE_OPENED' : 'RE_ENGAGED',
            ...(processReEngaged ? { lastReEngagedAt: now } : {}),
            lostAt: null,
            ownerId,
        });
      } else if (enquiryCreated && processReEngaged) {
        leadUpdates.leadType = 'RE_ENGAGED';
        leadUpdates.lastReEngagedAt = now;
      }
      if (Object.keys(leadUpdates).length) {
        await tx.lead.update({ where: { id: existing.id }, data: leadUpdates });
      }
      if (Object.keys(contactNewValues).length) {
        await tx.auditLog.create({
          data: {
            tenantId: input.tenantId,
            userId: input.userId,
            leadId: existing.id,
            action: 'LEAD_CONTACT_DETAILS_SYNCHRONIZED',
            objectType: 'Lead',
            objectId: existing.id,
            oldValues: contactOldValues,
            newValues: contactNewValues,
          },
        });
      }
      if (enquiryCreated && lifecycleType) {
        await tagLeadEnquiryAttribution(tx, {
          tenantId: input.tenantId,
          leadId: existing.id,
          source: metadata.source,
          subSource: metadata.subSource,
          campaign: metadata.campaign,
          campaignId: metadata.campaignId,
          subCampaignId: metadata.subCampaignId,
          projectId: input.lead.projectId || undefined,
          countryCode: metadata.countryCode,
          country: input.lead.country,
          secondaryPhone: metadata.secondaryPhone,
          secondaryCountryCode: metadata.secondaryCountryCode,
          tertiaryPhone: metadata.tertiaryPhone,
          secondaryEmail: metadata.secondaryEmail,
          occurredAt: now,
          lifecycleType: lifecycleType === 'RE_OPENED' ? 'Re-Opened' : 'Re-Engaged',
          isReEngaged: processReEngaged,
          isReOpened: processReOpened,
        });
      }
      if (enquiryCreated) {
        await tx.auditLog.create({
          data: {
            tenantId: input.tenantId,
            userId: input.userId,
            leadId: existing.id,
            action: processReOpened ? 'LEAD_REOPENED' : processReEngaged ? 'RE_ENGAGED' : 'DUPLICATE_ENQUIRY_LINKED',
            objectType: 'Enquiry',
            objectId: enquiry.id,
            oldValues: { status: existing.status, leadType: existing.leadType, ownerId: existing.ownerId },
            newValues: {
              leadId: existing.id,
              enquiryId: enquiry.id,
              previousLeadStatus: existing.status,
              newLeadStatus: processReOpened || action === 'RE_ENGAGED' ? 'NEW' : existing.status,
              previousLeadType: existing.leadType,
              newLeadType: processReOpened ? 'RE_OPENED' : 'RE_ENGAGED',
              previousOwnerId: existing.ownerId,
              newOwnerId: ownerId,
              matchingFields: duplicateMatches.find((match) => match.lead.id === existing.id)?.matchedFields || [],
              source: metadata.source,
              subSource: metadata.subSource || null,
              campaign: metadata.campaign || null,
              projectId: input.lead.projectId || null,
              at: now.toISOString(),
              action: processReOpened ? 'RE_OPENED' : 'RELATED_SOURCE_LINKED',
            },
          },
        });
      }

      let assignment: unknown = null;
      if (enquiryCreated && (processReOpened || action === 'RE_ENGAGED')) {
        const projectId = input.lead.projectId || existing.projectId;
        const projectName = input.lead.projectId
          ? (await tx.project.findFirst({ where: { id: input.lead.projectId, tenantId: input.tenantId }, select: { name: true } }))?.name || null
          : existing.project?.name || null;
        const rrQueue = input.salesUserId ? null : await findApplicableRRQueue(input.tenantId, {
          projectId,
          projectName,
          status: 'NEW',
          source: metadata.source,
        }, tx);
        if (rrQueue && isLeadEligibleForAutoAssignment({
          status: 'NEW',
          source: metadata.source,
          lastSourceOfEnquiry: metadata.source,
          projectId,
          projectName,
          leadQueueing: true,
          leadAssigned: false,
        }, { isNewLead: true })) {
          assignment = await RoundRobinAssignmentService.assignLeadInTransaction(
            tx,
            rrQueue.id,
            existing.id,
            input.tenantId,
            input.userId,
          );
        }
        const assignedLead = await tx.lead.findUnique({ where: { id: existing.id }, select: { ownerId: true } });
        if (assignedLead?.ownerId !== existing.ownerId) {
          const newOwner = assignedLead?.ownerId
            ? await tx.user.findUnique({ where: { id: assignedLead.ownerId }, select: { profile: { select: { name: true } } } })
            : null;
          await createOwnerHistory({
            tenantId: input.tenantId,
            leadId: existing.id,
            previousOwnerId: existing.ownerId,
            newOwnerId: assignedLead?.ownerId || null,
            previousProfile: null,
            newProfile: newOwner?.profile?.name || null,
            previousStatus: existing.status,
            newStatus: 'NEW',
            handoffReason: 'Lead re-engaged and assigned',
            changedById: input.userId,
          }, tx);
        }
      }

      if (enquiryCreated) {
        await tx.auditLog.create({
          data: {
            tenantId: input.tenantId,
            userId: input.userId,
            leadId: existing.id,
            action: processReOpened ? 'LEAD_REOPENED' : processReEngaged ? 'RE_ENGAGED' : 'ENQUIRY_RECEIVED',
            objectType: 'Lead',
            objectId: existing.id,
            oldValues: { status: existing.status, source: existing.source, ownerId: existing.ownerId },
            newValues: {
              status: processReOpened || action === 'RE_ENGAGED' ? 'NEW' : existing.status,
              leadAction: action,
              source: metadata.source,
              subSource: metadata.subSource || null,
              campaign: metadata.campaign || null,
              validationDays,
              daysDifference,
            },
          },
        });
      }
      const siteVisit = enquiryCreated ? await createSiteVisit(existing.id) : null;
      const lead = await tx.lead.findUnique({
        where: { id: existing.id },
        include: {
          owner: { select: { id: true, firstName: true, lastName: true } },
          project: { select: { id: true, name: true } },
        },
      });
      return { action, lead, leadId: existing.id, enquiry, validationDays, daysDifference, assignment, siteVisit };
    }

    const leadNumber = await getNextLeadNumber(tx, input.tenantId);
    const newLead = await tx.lead.create({
      data: {
        tenantId: input.tenantId,
        creatorId: input.userId,
        leadNumber,
        firstName: input.lead.firstName || undefined,
        lastName: input.lead.lastName,
        salutation: input.lead.salutation || undefined,
        title: input.lead.title || undefined,
        email: normalizeLeadEmail(input.lead.email) || undefined,
        phone: normalizedPhone,
        countryCode: metadata.countryCode,
        mobile: input.lead.mobile
          ? normalizeLeadPhone(input.lead.mobile, metadata.countryCode)?.e164
          : metadata.secondaryPhone,
        secondaryPhone: metadata.secondaryPhone,
        secondaryCountryCode: metadata.secondaryCountryCode,
        tertiaryPhone: metadata.tertiaryPhone,
        tertiaryCountryCode: metadata.tertiaryCountryCode,
        secondaryEmail: metadata.secondaryEmail,
        tertiaryEmail: metadata.tertiaryEmail,
        website: input.lead.website || undefined,
        company: input.lead.company,
        industry: input.lead.industry || undefined,
        annualRevenue: input.lead.annualRevenue || undefined,
        numberOfEmployees: input.lead.numberOfEmployees || undefined,
        source,
        lastSource: metadata.source,
        firstCampaign: input.lead.firstCampaign || metadata.campaign,
        lastEnquiryAt: now,
        enquiryCount: 1,
        leadType: 'ORIGINAL',
        firstSubSource: metadata.subSource,
        lastSubSource: metadata.subSource,
        lastCampaign: input.lead.lastCampaign || metadata.subCampaign || metadata.campaign,
        status: 'NEW',
        rating: input.lead.rating || undefined,
        leadInterest: input.lead.leadInterest || undefined,
        description: input.lead.description || undefined,
        street: input.lead.street || undefined,
        city: input.lead.city || undefined,
        stateProvince: input.lead.stateProvince || undefined,
        country: input.lead.country || undefined,
        postalCode: input.lead.postalCode || undefined,
        score: input.lead.score || 0,
        budget: input.lead.budget || undefined,
        ownerId,
        projectId: input.lead.projectId || undefined,
        customFields: mergeOperationalLeadCustomFields(input.lead.customFields, {
          source,
          status: 'NEW',
          rating: input.lead.rating || null,
          description: input.lead.description || null,
          score: input.lead.score ?? 0,
        }),
      },
      include: {
        owner: { select: { id: true, firstName: true, lastName: true } },
        project: { select: { id: true, name: true } },
      },
    });
    await tagLeadEnquiryAttribution(tx, {
      tenantId: input.tenantId,
      leadId: newLead.id,
      source: metadata.source,
      subSource: metadata.subSource,
      campaign: metadata.campaign,
      campaignId: metadata.campaignId,
      subCampaignId: metadata.subCampaignId,
      projectId: input.lead.projectId || undefined,
      countryCode: metadata.countryCode,
      country: input.lead.country,
      secondaryPhone: metadata.secondaryPhone,
      secondaryCountryCode: metadata.secondaryCountryCode,
      tertiaryPhone: metadata.tertiaryPhone,
      secondaryEmail: metadata.secondaryEmail,
      occurredAt: now,
      lifecycleType: 'Fresh',
      isLeadCreation: true,
    });
    await createOwnerHistory({
      tenantId: input.tenantId,
      leadId: newLead.id,
      previousOwnerId: null,
      newOwnerId: ownerId,
      previousProfile: null,
      newProfile: ownerProfileName,
      previousStatus: null,
      newStatus: 'NEW',
      handoffReason: 'Lead Created',
      changedById: input.userId,
    }, tx);
    let assignment: unknown = null;
    let assignmentWarning: string | undefined;
    if (!input.salesUserId) {
      try {
        assignment = await assignLeadToProjectRoundRobinInTransaction(tx, {
          tenantId: input.tenantId,
          leadId: newLead.id,
          projectId: newLead.projectId,
          userType: 'Pre Sales',
          actorId: input.userId,
          reason: 'New lead assigned to Pre Sales round robin',
        });
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !(
            error.message === 'NO_ELIGIBLE_USER' ||
            error.message === 'RR_QUEUE_NOT_CONFIGURED:Pre Sales' ||
            error.message === 'NO_ELIGIBLE_RR_MEMBER:Pre Sales'
          )
        ) {
          throw error;
        }
        assignmentWarning = 'There is no eligible Sales user (Pre Sales) available; the lead remains assigned to its current owner.';
      }
    }
    const assignedLead = await tx.lead.findUniqueOrThrow({
      where: { id: newLead.id },
      include: {
        owner: { select: { id: true, firstName: true, lastName: true } },
        project: { select: { id: true, name: true } },
      },
    });
    const enquiry = await createEnquiryInTransaction(tx, {
      tenantId: input.tenantId,
      leadId: newLead.id,
      leadType: 'ORIGINAL',
      enquiryType: 'ORIGINAL',
      source: metadata.source,
      subSource: metadata.subSource,
      campaignId: metadata.campaignId,
      campaign: metadata.campaign,
      subCampaignId: metadata.subCampaignId,
      subCampaign: metadata.subCampaign,
      projectId: input.lead.projectId,
      phone: input.lead.phone,
      secondaryPhone: metadata.secondaryPhone,
      tertiaryPhone: metadata.tertiaryPhone,
      countryCode: metadata.countryCode,
      secondaryCountryCode: metadata.secondaryCountryCode,
      tertiaryCountryCode: metadata.tertiaryCountryCode,
      email: input.lead.email,
      secondaryEmail: input.enquiry.secondaryEmail,
      tertiaryEmail: input.enquiry.tertiaryEmail,
      originalSubmissionId: metadata.originalSubmissionId,
      medium: metadata.medium,
      description: metadata.description,
      channelPartner: metadata.channelPartner,
      ownerId: assignedLead.ownerId,
      attributes: extractEnquiryAttributes(input.lead.customFields),
      details: serializeDetails(metadata.details),
      enquiryDate: metadata.enquiryDate,
      userId: input.userId,
    });
    await tx.auditLog.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        leadId: newLead.id,
        action: 'CREATE',
        objectType: 'Lead',
        objectId: newLead.id,
        newValues: {
          ...input.lead,
          source: metadata.source,
          enquiryType: 'ORIGINAL',
          assignedTo: assignedLead.owner ? `${assignedLead.owner.firstName} ${assignedLead.owner.lastName}` : null,
        },
      },
    });
    const siteVisit = await createSiteVisit(newLead.id);
    return {
      action: 'NEW_LEAD' as const,
      lead: assignedLead,
      leadId: newLead.id,
      assignment,
      assignmentWarning,
      siteVisit,
      enquiry,
    };
  };
  return options.transaction
    ? processInTransaction(options.transaction)
    : prisma.$transaction(processInTransaction);
}

export async function processLeadEnquiryBatch(
  inputs: LeadEnquiryInput[],
  options: { rejectDuplicates?: boolean } = {},
) {
  if (!inputs.length) return [];
  const tenantIds = new Set(inputs.map((input) => input.tenantId));
  if (tenantIds.size !== 1) throw new Error('LEAD_IMPORT_TENANT_MISMATCH');

  const duplicateInputs = inputs.map(leadDuplicateInputForEnquiry);
  const allContacts = {
    phones: duplicateInputs.flatMap((input) => input.phones),
    emails: duplicateInputs.flatMap((input) => input.emails),
  };

  const auditState: {
    duplicateConflictAudit?: {
      tenantId: string;
      userId: string;
      row: number;
      leadIds: string[];
      source: string;
      projectId: string | null;
      matchingFields: Array<{ leadId: string; fields: string[] }>;
    };
  } = {};
  try {
    return await prisma.$transaction(async (tx) => {
      await acquireLeadDuplicateLocks(tx, inputs[0].tenantId, allContacts);
      const batchMatches = await findLeadDuplicatesBatch(tx, inputs[0].tenantId, duplicateInputs);
      const seenContactKeys = new Set<string>();
      const results = [];
      for (let index = 0; index < inputs.length; index += 1) {
        const input = inputs[index];
        const inputKeys = new Set(duplicateInputs[index].phones.flatMap((phone) => {
          const normalized = normalizeLeadPhone(phone.value, phone.countryCode);
          return normalized ? [`PHONE:${normalized.e164}`] : [];
        }).concat(duplicateInputs[index].emails.flatMap((email) => {
          const normalized = normalizeLeadEmail(email.value);
          return normalized ? [`EMAIL:${normalized}`] : [];
        })));
        const overlapsPriorInput = [...inputKeys].some((key) => seenContactKeys.has(key));
        const duplicateMatches = overlapsPriorInput
          ? await findLeadDuplicates(tx, input.tenantId, duplicateInputs[index])
          : batchMatches[index];
        const result = await processLeadEnquiry(input, {
          transaction: tx,
          duplicateMatches,
          duplicateLocksAcquired: true,
          rejectDuplicates: options.rejectDuplicates,
        });
        if (result.action === 'DUPLICATE_CONFLICT' || result.action === 'LEAD_MISMATCH') {
          auditState.duplicateConflictAudit = {
            tenantId: input.tenantId,
            userId: input.userId,
            row: index + 2,
            leadIds: result.leadIds,
            source: input.enquiry.source,
            projectId: input.lead.projectId || null,
            matchingFields: duplicateMatches.map((match) => ({
              leadId: match.lead.id,
              fields: match.matchedFields,
            })),
          };
          throw Object.assign(new Error(result.action), {
            rowIndex: index,
            leadIds: result.leadIds,
          });
        }
        results.push(result);
        for (const key of inputKeys) seenContactKeys.add(key);
      }
      return results;
    }, { maxWait: 10000, timeout: 120000 });
  } catch (error) {
    const duplicateConflictAudit = auditState.duplicateConflictAudit;
    if (duplicateConflictAudit) {
      await prisma.auditLog.create({
        data: {
          tenantId: duplicateConflictAudit.tenantId,
          userId: duplicateConflictAudit.userId,
          action: 'DUPLICATE_MATCH_AMBIGUOUS',
          objectType: 'LeadDuplicate',
          newValues: {
            row: duplicateConflictAudit.row,
            leadIds: duplicateConflictAudit.leadIds,
            matchingFields: duplicateConflictAudit.matchingFields,
            source: duplicateConflictAudit.source,
            projectId: duplicateConflictAudit.projectId,
            action: 'REVIEW_REQUIRED',
            at: new Date().toISOString(),
          },
        },
      });
    }
    throw error;
  }
}