import type { Prisma } from '@prisma/client';
import { prisma } from '@dct-crm/db';
import { DEFAULT_CRM_TIMEZONE, formatCRMDateTime } from '@dct-crm/shared';
import { getTenantTimezone } from './tenantTimezone';
import { normalizeLeadEmail, normalizeLeadPhone } from './leadDuplicateDetection';

type Db = Prisma.TransactionClient | typeof prisma;

export interface CreateEnquiryInput {
  tenantId: string;
  leadId: string;
  leadType: string;
  enquiryType: string;
  source: string;
  subSource?: string | null;
  campaignId?: string | null;
  campaign?: string | null;
  subCampaignId?: string | null;
  subCampaign?: string | null;
  projectId?: string | null;
  phone?: string | null;
  secondaryPhone?: string | null;
  tertiaryPhone?: string | null;
  countryCode?: string | null;
  secondaryCountryCode?: string | null;
  tertiaryCountryCode?: string | null;
  email?: string | null;
  secondaryEmail?: string | null;
  tertiaryEmail?: string | null;
  originalSubmissionId?: string | null;
  medium?: string | null;
  description?: string | null;
  channelPartner?: string | null;
  details?: Prisma.InputJsonValue;
  attributes?: Record<string, string | boolean>;
  ownerId?: string | null;
  enquiryDate?: Date;
  userId: string;
}

function inferCountryCode(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return '91';
  return digits.length > 10 ? digits.slice(0, digits.length - 10) : null;
}

async function nextEnquiryNumber(db: Db, tenantId: string): Promise<string> {
  const latest = await db.enquiry.findFirst({
    where: { tenantId },
    orderBy: { enquiryNumber: 'desc' },
    select: { enquiryNumber: true },
  });
  const latestNumber = Number(latest?.enquiryNumber.match(/^ENQ-(\d+)$/)?.[1] || 100000);
  const sequence = await db.sequence.upsert({
    where: { tenantId_type: { tenantId, type: 'ENQUIRY' } },
    update: { nextValue: { increment: 1 } },
    create: { tenantId, type: 'ENQUIRY', nextValue: Math.max(100000, latestNumber) + 1 },
  });
  return `ENQ-${String(sequence.nextValue).padStart(6, '0')}`;
}

export async function createEnquiryInTransactionWithStatus(
  db: Prisma.TransactionClient,
  input: CreateEnquiryInput,
) {
  const countryCode = input.countryCode || inferCountryCode(input.phone);
  const secondaryCountryCode = input.secondaryCountryCode || inferCountryCode(input.secondaryPhone) || countryCode;
  const tertiaryCountryCode = input.tertiaryCountryCode || secondaryCountryCode || countryCode;
  const normalizedPhones = [
    normalizeLeadPhone(input.phone, countryCode),
    normalizeLeadPhone(input.secondaryPhone, secondaryCountryCode),
    normalizeLeadPhone(input.tertiaryPhone, tertiaryCountryCode),
  ];
  const normalizedEmails = [input.email, input.secondaryEmail, input.tertiaryEmail]
    .map((email) => normalizeLeadEmail(email))
    .filter((email): email is string => Boolean(email));
  const existingSubmission = input.originalSubmissionId
    ? await db.enquiry.findFirst({
        where: {
          tenantId: input.tenantId,
          originalSubmissionId: input.originalSubmissionId,
        },
        include: { project: { select: { id: true, name: true } } },
      })
    : null;
  if (existingSubmission) return { enquiry: existingSubmission, created: false };

  const existingSources = input.originalSubmissionId
    ? []
    : await db.enquiry.findMany({
        where: {
          tenantId: input.tenantId,
          leadId: input.leadId,
          source: input.source,
          subSource: input.subSource || null,
          campaignId: input.campaignId || null,
          campaign: input.campaign || null,
          projectId: input.projectId || null,
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          phone: true,
          secondaryPhone: true,
          tertiaryPhone: true,
          countryCode: true,
          secondaryCountryCode: true,
          tertiaryCountryCode: true,
          email: true,
          secondaryEmail: true,
          tertiaryEmail: true,
        },
      });
  const existingSource = existingSources.find((source) => {
    const sourcePhones = [
      normalizeLeadPhone(source.phone, source.countryCode),
      normalizeLeadPhone(source.secondaryPhone, source.secondaryCountryCode || source.countryCode),
      normalizeLeadPhone(source.tertiaryPhone, source.tertiaryCountryCode || source.secondaryCountryCode || source.countryCode),
    ];
    const hasPhoneMatch = normalizedPhones.some((candidate) =>
      candidate && sourcePhones.some((sourcePhone) => sourcePhone?.e164 === candidate.e164),
    );
    const sourceEmails = [source.email, source.secondaryEmail, source.tertiaryEmail]
      .map((email) => normalizeLeadEmail(email));
    const hasEmailMatch = normalizedEmails.some((email) => sourceEmails.includes(email));
    return hasPhoneMatch || hasEmailMatch;
  });
  if (existingSource) {
    const enquiry = await db.enquiry.findUniqueOrThrow({
      where: { id: existingSource.id },
      include: { project: { select: { id: true, name: true } } },
    });
    return { enquiry, created: false };
  }
  const enquiryNumber = await nextEnquiryNumber(db, input.tenantId);
  const enquiry = await db.enquiry.create({
    data: {
      enquiryNumber,
      tenantId: input.tenantId,
      leadId: input.leadId,
      leadType: input.leadType,
      enquiryType: input.enquiryType,
      source: input.source,
      subSource: input.subSource || null,
      campaignId: input.campaignId || null,
      campaign: input.campaign || null,
      subCampaignId: input.subCampaignId || null,
      subCampaign: input.subCampaign || null,
      projectId: input.projectId || null,
      phone: input.phone || null,
      secondaryPhone: input.secondaryPhone || null,
      tertiaryPhone: input.tertiaryPhone || null,
      countryCode,
      secondaryCountryCode,
      tertiaryCountryCode,
      email: input.email || null,
      secondaryEmail: input.secondaryEmail || null,
      tertiaryEmail: input.tertiaryEmail || null,
      originalSubmissionId: input.originalSubmissionId || null,
      medium: input.medium || null,
      description: input.description || null,
      channelPartner: input.channelPartner || null,
      ownerId: input.ownerId || null,
      details: input.details,
      attributes: input.attributes || {},
      enquiryDate: input.enquiryDate,
      createdById: input.userId,
      updatedById: input.userId,
    },
    include: { project: { select: { id: true, name: true } } },
  });
  return { enquiry, created: true };
}

export async function createEnquiryInTransaction(
  db: Prisma.TransactionClient,
  input: CreateEnquiryInput,
) {
  const result = await createEnquiryInTransactionWithStatus(db, input);
  return result.enquiry;
}

const enquiryLeadSelect = {
  leadNumber: true,
  firstName: true,
  lastName: true,
  owner: { select: { firstName: true, lastName: true } },
} as const;

export function presentEnquiry<T extends {
  countryCode?: string | null;
  phone?: string | null;
  createdAt?: Date | string | null;
  lead?: { leadNumber?: string | null; firstName?: string | null; lastName?: string | null; owner?: { firstName?: string | null; lastName?: string | null } | null } | null;
}>(enquiry: T, timeZone = DEFAULT_CRM_TIMEZONE) {
  const lead = enquiry.lead;
  const leadName = [lead?.firstName, lead?.lastName].filter(Boolean).join(' ').trim();
  const leadOwnerName = [lead?.owner?.firstName, lead?.owner?.lastName].filter(Boolean).join(' ').trim();
  const created = enquiry.createdAt ? new Date(enquiry.createdAt) : null;
  return {
    ...enquiry,
    leadNumber: lead?.leadNumber || null,
    leadName: leadName || null,
    leadOwnerName: leadOwnerName || null,
    phoneWithCountryCode: [enquiry.countryCode, enquiry.phone].filter(Boolean).join(' ') || null,
    createdDateDisplay: created && !Number.isNaN(created.getTime())
      ? formatCRMDateTime(created, timeZone)
      : null,
  };
}

export async function getLeadEnquiries(
  tenantId: string,
  leadId: string,
  page: number,
  limit: number,
) {
  const where = { tenantId, leadId };
  const [data, total] = await Promise.all([
    prisma.enquiry.findMany({
      where,
      include: {
        project: { select: { id: true, name: true } },
        lead: { select: enquiryLeadSelect },
      },
      orderBy: [{ createdAt: 'desc' }, { enquiryNumber: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.enquiry.count({ where }),
  ]);
    const timeZone = await getTenantTimezone(tenantId);
    return {
    data: data.map((item) => presentEnquiry(item, timeZone)),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getEnquiryById(tenantId: string | undefined, enquiryId: string) {
  const enquiry = await prisma.enquiry.findFirst({
    where: { id: enquiryId, ...(tenantId ? { tenantId } : {}) },
    include: {
      project: { select: { id: true, name: true } },
      owner: { select: { id: true, firstName: true, lastName: true } },
      lead: {
        select: {
          id: true,
          tenantId: true,
          leadNumber: true,
          firstName: true,
          lastName: true,
          company: true,
          ownerId: true,
          creatorId: true,
          owner: { select: { firstName: true, lastName: true } },
        },
      },
    },
  });
  return enquiry ? presentEnquiry(enquiry, await getTenantTimezone(tenantId || enquiry.tenantId)) : null;
}
