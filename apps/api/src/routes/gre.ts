import { randomBytes, createHash } from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '@dct-crm/db';
import { GreSessionStatus, Industry, LeadStatus, Prisma, SiteVisitStatus } from '@prisma/client';
import { authenticate, AuthRequest } from '../middleware/auth';
import { getNextSiteVisitNumber } from '../services/leadWorkflowExtras';
import { assignCompletedSiteVisitToSalesInTransaction } from '../services/rrQueue';
import { coordinatesFromStoredMapUrl } from '../services/projectLocation';
import { GRE_LOCATION_MESSAGES, readStoredCoordinate, verifyGreSubmissionLocation } from '../services/siteVisitLocation';
import { crmDateRangeBounds, crmLocalDateTimeToDate, leadStatusFromId, SITE_VISIT_TYPE_OPTIONS } from '@dct-crm/shared';
import { decorateLeadStatus, decorateLeadStatuses } from '../services/leadStatusSettings';
import { createEnquiryInTransactionWithStatus } from '../services/enquiryService';
import { mergeOperationalLeadCustomFields } from '../services/leadEventTagging';
import {
  acquireLeadDuplicateLocks,
  findLeadDuplicates,
  normalizeLeadEmail,
  normalizeLeadPhone,
} from '../services/leadDuplicateDetection';
import { appendLeadProcessNote } from '../services/leadNotes';
import { getTenantTimezone } from '../services/tenantTimezone';

const router = Router();
const publicRouter = Router();

const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
});

router.use('/public', publicRouter);

export const phoneCheckSchema = z.object({
  countryCode: z.string().regex(/^\+\d{1,3}$/),
  phone: z.string().trim().min(6).max(30).regex(/^[0-9+().\s-]+$/),
  alternatePhone: z.string().trim().max(30).regex(/^[0-9+().\s-]+$/).optional().or(z.literal('')),
});

const optionalText = (max = 500) => z.string().trim().max(max).optional().or(z.literal(''));
export const greDraftSchema = z.object({
  lead: z.object({
    firstName: optionalText(100),
    lastName: optionalText(100),
    secondaryPhone: optionalText(30),
    tertiaryPhone: optionalText(30),
    email: z.string().trim().email().max(254).optional().or(z.literal('')),
    alternateEmail: z.string().trim().email().max(254).optional().or(z.literal('')),
    leadSubSource: optionalText(100),
    campaign: optionalText(150),
    projectId: optionalText(100),
    leadType: optionalText(100),
    preferredLocation: optionalText(150),
    budget: z.coerce.number().finite().min(0).max(1_000_000_000_000).optional().nullable(),
    occupation: optionalText(150),
    comments: optionalText(5000),
    dateOfBirth: optionalText(20),
    gender: optionalText(40),
  }).default({}),
  siteVisit: z.object({
    required: z.boolean().default(false),
    date: optionalText(20),
    time: optionalText(10),
    projectId: optionalText(100),
    visitorCount: z.coerce.number().int().min(1).max(50).optional().nullable(),
    visitType: optionalText(100),
    preferredLocation: optionalText(150),
    transportRequired: z.boolean().optional().nullable(),
    comments: optionalText(2000),
  }).default({}),
  company: z.object({
    name: optionalText(200),
    type: optionalText(100),
    industry: z.nativeEnum(Industry).optional().nullable().or(z.literal('')),
    email: z.string().trim().email().max(254).optional().or(z.literal('')),
    phone: optionalText(30),
    website: z.string().trim().url().max(500).optional().or(z.literal('')),
    address: optionalText(500),
    city: optionalText(100),
    state: optionalText(100),
    country: optionalText(100),
    postalCode: optionalText(20),
    designation: optionalText(100),
    department: optionalText(100),
    numberOfEmployees: z.coerce.number().int().min(0).max(10_000_000).optional().nullable(),
    gstNumber: optionalText(30),
    comments: optionalText(2000),
  }).default({}),
}).strict();

export const greLocationSchema = z.object({
  latitude: z.number().finite().gte(-90).lte(90),
  longitude: z.number().finite().gte(-180).lte(180),
  accuracy: z.number().finite().positive(),
  capturedAt: z.string().datetime(),
}).strict();

export const greSubmissionSchema = greDraftSchema.superRefine((draft, ctx) => {
  if (!draft.siteVisit.required || !draft.siteVisit.date || !draft.siteVisit.time || !draft.siteVisit.projectId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['siteVisit'],
      message: 'Site visit date, time, and project are required',
    });
  }
});

export const submissionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  phone: z.string().trim().max(30).optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  leadStatus: z.union([
    z.nativeEnum(LeadStatus),
    z.enum(['1', '2', '3', '4', '5', '6', '7']),
  ]).optional(),
  siteVisitStatus: z.nativeEnum(SiteVisitStatus).optional(),
  existingLead: z.enum(['true', 'false']).optional(),
  projectId: z.string().trim().min(1).max(100).optional(),
});

export function getGreLeadStatus(_hasCompletedSiteVisit: boolean, existingStatus?: LeadStatus): LeadStatus {
  return existingStatus ?? LeadStatus.NEW;
}

export function selectScheduledVisitToComplete<T extends { id: string; scheduledAt: Date }>(
  visits: T[],
  completedAt: Date,
): T | null {
  return [...visits].sort((left, right) => {
    const timeDifference = Math.abs(left.scheduledAt.getTime() - completedAt.getTime())
      - Math.abs(right.scheduledAt.getTime() - completedAt.getTime());
    return timeDifference || left.scheduledAt.getTime() - right.scheduledAt.getTime() || left.id.localeCompare(right.id);
  })[0] ?? null;
}

type GreDraft = z.infer<typeof greDraftSchema>;

const publicLeadSelect = {
  id: true,
  companyId: true,
  leadNumber: true,
  firstName: true,
  lastName: true,
  title: true,
  email: true,
  phone: true,
  mobile: true,
  secondaryPhone: true,
  tertiaryPhone: true,
  company: true,
  industry: true,
  budget: true,
  requirements: true,
  source: true,
  status: true,
  leadSubSource: true,
  campaign: true,
  leadType: true,
  preferredLocation: true,
  occupation: true,
  gender: true,
  city: true,
  stateProvince: true,
  country: true,
  projectId: true,
  project: { select: { id: true, name: true, city: true } },
  siteVisits: { select: { projectId: true, status: true, scheduledAt: true, visitType: true } },
  companyAccount: {
    select: {
      id: true,
      name: true,
      companyType: true,
      industry: true,
      email: true,
      phone: true,
      website: true,
      city: true,
      state: true,
      country: true,
    },
  },
} satisfies Prisma.LeadSelect;

export function normalizePhone(countryCode: string, value: string): string | null {
  const digits = value.replace(/\D/g, '');
  const dialCode = countryCode.replace(/\D/g, '');
  if (!digits || !dialCode) return null;
  let nationalNumber = digits;
  if (nationalNumber.startsWith('00')) nationalNumber = nationalNumber.slice(2);
  if (nationalNumber.startsWith(dialCode) && nationalNumber.length > 10) {
    nationalNumber = nationalNumber.slice(dialCode.length);
  }
  nationalNumber = nationalNumber.replace(/^0+/, '');
  const length = nationalNumber.length;
  if (length < 7 || length > 12) return null;
  return `+${dialCode}${nationalNumber}`;
}

export function normalizeStoredPhone(value: string | null, countryCode: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) {
    const dialCode = countryCode?.replace(/\D/g, '');
    return dialCode === '91' ? `+91${digits}` : null;
  }
  if (digits.startsWith('91') && digits.length === 12) return `+${digits}`;
  if (digits.length >= 7 && digits.length <= 15) return `+${digits}`;
  return null;
}

export function greRegistrationLeadType(existingLead: boolean, value?: string | null): 'ORIGINAL' | 'RE_ENGAGED' {
  const normalized = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (normalized === 'RE_ENGAGED' || normalized === 'REENGAGED') return 'RE_ENGAGED';
  if (normalized === 'ORIGINAL' || normalized === 'FRESH') return 'ORIGINAL';
  return existingLead ? 'RE_ENGAGED' : 'ORIGINAL';
}

export function greVisitType(value?: string | null): (typeof SITE_VISIT_TYPE_OPTIONS)[number] | undefined {
  const normalized = String(value || '').trim().toLowerCase();
  return SITE_VISIT_TYPE_OPTIONS.find((option) => option.toLowerCase() === normalized);
}

export function phoneSearchVariants(normalizedPhone: string, countryCode: string | null, originalPhone?: string | null): string[] {
  const digits = normalizedPhone.replace(/\D/g, '');
  const dialCode = countryCode?.replace(/\D/g, '') || '';
  const nationalNumber = dialCode && digits.startsWith(dialCode) ? digits.slice(dialCode.length) : digits;
  return [...new Set([
    normalizedPhone,
    digits,
    nationalNumber,
    `0${nationalNumber}`,
    `+${nationalNumber}`,
    originalPhone?.trim(),
  ].filter((value): value is string => Boolean(value)))];
}

async function findMatchingLeads(
  client: Prisma.TransactionClient | typeof prisma,
  tenantId: string,
  phone: string,
  countryCode: string | null,
  originalPhone?: string | null,
  alternatePhone?: string | null,
  emails: Array<{ field: string; value?: string | null }> = [],
  additionalPhones: Array<{ field: string; value?: string | null; countryCode?: string | null }> = [],
) {
  const duplicates = await findLeadDuplicates(client, tenantId, {
    phones: [
      { field: 'phone', value: originalPhone || phone, countryCode },
      { field: 'secondaryPhone', value: alternatePhone, countryCode },
      ...additionalPhones,
    ],
    emails,
  });
  const matches = duplicates.length
    ? await client.lead.findMany({
        where: { tenantId, id: { in: duplicates.map((match) => match.lead.id) } },
        select: { ...publicLeadSelect },
      })
    : [];
  if (matches.length === 0) return [];

  const visitsByLead = await getScheduledSiteVisits(client, tenantId, matches.map((lead) => lead.id));
  return matches.map((lead) => ({
    ...lead,
    duplicateMatchFields: duplicates.find((match) => match.lead.id === lead.id)?.matchedFields || [],
    duplicateMatchAmbiguous: duplicates.find((match) => match.lead.id === lead.id)?.ambiguous || false,
    scheduledSiteVisits: visitsByLead.get(lead.id) || [],
  }));
}

async function getScheduledSiteVisits(
  client: Pick<typeof prisma, 'siteVisit'>,
  tenantId: string,
  leadIds: string[],
) {
  const scheduledSiteVisits = await client.siteVisit.findMany({
    where: { tenantId, leadId: { in: leadIds }, status: 'SCHEDULED' },
    orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      leadId: true,
      siteVisitNumber: true,
      projectId: true,
      project: { select: { name: true } },
      scheduledAt: true,
      visitType: true,
      visitorCount: true,
      transportRequired: true,
      notes: true,
      assignee: { select: { firstName: true, lastName: true } },
    },
  });
  const visitsByLead = new Map<string, typeof scheduledSiteVisits>();
  for (const visit of scheduledSiteVisits) {
    const visits = visitsByLead.get(visit.leadId) || [];
    visits.push(visit);
    visitsByLead.set(visit.leadId, visits);
  }
  return visitsByLead;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function publicBaseUrl(): string {
  const configured = process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL;
  if (configured) return configured.replace(/\/+$/, '');
  return process.env.CORS_ORIGIN || 'http://localhost:3000';
}

function grePublicUrl(token: string, projectId?: string | null): string {
  const url = `${publicBaseUrl()}/gre/${token}`;
  return projectId ? `${url}?projectId=${encodeURIComponent(projectId)}` : url;
}

function parseDateOnly(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

function parseLocalDateTime(dateValue: string, timeValue: string, timeZone?: string | null): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue) || !/^\d{2}:\d{2}$/.test(timeValue)) return null;
  const date = parseDateOnly(dateValue);
  if (!date) return null;
  const [hours, minutes] = timeValue.split(':').map(Number);
  if (hours > 23 || minutes > 59) return null;
  return crmLocalDateTimeToDate(dateValue, timeValue, timeZone || undefined);
}

async function getActiveForm(token: string) {
  const form = await prisma.greForm.findUnique({
    where: { publicToken: token },
    include: { tenant: { select: { id: true, name: true, timezone: true, isActive: true } } },
  });
  if (!form || !form.isActive || !form.tenant.isActive) return null;
  if (form.expiresAt && form.expiresAt <= new Date()) return null;
  return form;
}

function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user?.isSuperAdmin && !req.user?.isAdmin) {
    return res.status(403).json({ success: false, error: 'Administrator access is required' });
  }
  next();
}

async function getSession(req: Request, res: Response) {
  const form = await getActiveForm(req.params.token);
  if (!form) {
    res.status(410).json({ success: false, error: 'This GRE link is unavailable or has expired' });
    return null;
  }
  const sessionToken = req.get('x-gre-session');
  if (!sessionToken || sessionToken.length < 32) {
    res.status(401).json({ success: false, error: 'GRE session is missing or expired' });
    return null;
  }
  const session = await prisma.greSession.findFirst({
    where: { formId: form.id, sessionTokenHash: tokenHash(sessionToken) },
  });
  if (!session || session.status === 'CANCELLED' || session.status === 'EXPIRED') {
    res.status(401).json({ success: false, error: 'GRE session is missing or expired' });
    return null;
  }
  if (session.status === 'COMPLETED') {
    res.status(409).json({ success: false, error: 'This form has already been submitted', referenceNumber: session.referenceNumber });
    return null;
  }
  if (session.expiresAt <= new Date()) {
    await prisma.greSession.update({ where: { id: session.id }, data: { status: 'EXPIRED' } });
    res.status(410).json({ success: false, error: 'Your form session has expired. Please start again.' });
    return null;
  }
  return { form, session };
}

const adminRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false });

publicRouter.get('/:token', async (req, res) => {
  try {
    const form = await getActiveForm(req.params.token);
    if (!form) return res.status(410).json({ success: false, error: 'This GRE link is unavailable or has expired' });
    const projects = await prisma.project.findMany({
      where: { tenantId: form.tenantId, isActive: true },
      select: { id: true, name: true, city: true },
      orderBy: { name: 'asc' },
    });
    res.json({
      success: true,
      data: {
        formName: form.name,
        tenantName: form.tenant.name,
        timezone: form.tenant.timezone,
        defaultProjectId: form.defaultProjectId,
        projects,
      },
    });
  } catch (error) {
    console.error('Load public GRE form error:', error);
    res.status(500).json({ success: false, error: 'Unable to load this form' });
  }
});

publicRouter.post('/:token/sessions', publicLimiter, async (req, res) => {
  try {
    const form = await getActiveForm(req.params.token);
    if (!form) return res.status(410).json({ success: false, error: 'This GRE link is unavailable or has expired' });
    const parsed = phoneCheckSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'Please enter a valid phone number' });
    const normalizedPhone = normalizePhone(parsed.data.countryCode, parsed.data.phone);
    if (!normalizedPhone) return res.status(400).json({ success: false, error: 'Please enter a valid phone number' });
    const normalizedAlternatePhone = parsed.data.alternatePhone
      ? normalizePhone(parsed.data.countryCode, parsed.data.alternatePhone)
      : null;
    if (parsed.data.alternatePhone && !normalizedAlternatePhone) {
      return res.status(400).json({ success: false, error: 'Please enter a valid alternate phone number' });
    }

    const matches = await findMatchingLeads(
      prisma,
      form.tenantId,
      normalizedPhone,
      parsed.data.countryCode,
      parsed.data.phone,
      normalizedAlternatePhone,
    );
    if (matches.length > 1 || matches.some((match) => match.duplicateMatchAmbiguous)) {
      await prisma.auditLog.create({
        data: {
          tenantId: form.tenantId,
          userId: form.createdById,
          action: 'DUPLICATE_MATCH_AMBIGUOUS',
          objectType: 'LeadDuplicate',
          newValues: {
            leadIds: matches.map((match) => match.id),
            matchingFields: matches.map((match) => ({
              leadId: match.id,
              fields: match.duplicateMatchFields,
            })),
            source: 'GRE',
            action: 'REVIEW_REQUIRED',
          },
        },
      });
      return res.status(409).json({ success: false, error: 'We could not safely match this number to one CRM record. Please contact the team that shared this form.' });
    }
    const sessionToken = randomBytes(32).toString('base64url');
    const session = await prisma.$transaction(async (tx) => {
      const existingLead = matches[0]
        ? await tx.lead.findFirst({
          where: { id: matches[0].id, tenantId: form.tenantId },
          select: { ownerId: true },
        })
        : null;
      const createdSession = await tx.greSession.create({
        data: {
          tenantId: form.tenantId,
          formId: form.id,
          sessionTokenHash: tokenHash(sessionToken),
          phoneCountryCode: parsed.data.countryCode,
          phone: parsed.data.phone.trim(),
          normalizedPhone,
          leadId: matches.length === 1 ? matches[0].id : undefined,
          leadWasExisting: matches.length > 0,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          currentStep: 2,
          status: 'IN_PROGRESS',
          draft: { lead: { secondaryPhone: normalizedAlternatePhone || '' }, siteVisit: { required: false }, company: {} },
        },
      });
      if (existingLead?.ownerId) {
        const projectName = matches[0].project?.name;
        await tx.notification.create({
          data: {
            tenantId: form.tenantId,
            userId: existingLead.ownerId,
            title: 'GRE registration started',
            message: `An existing lead started a GRE registration${projectName ? ` for ${projectName}` : ''}.`,
            type: 'GRE_REGISTRATION',
            referenceId: matches[0].id,
            referenceType: 'Lead',
          },
        });
      }
      return createdSession;
    });
    const leadDetails = matches[0]
      ? await decorateLeadStatus(form.tenantId, matches[0])
      : null;
    res.status(201).json({
      success: true,
      data: {
        sessionId: session.id,
        sessionToken,
        leadExists: matches.length > 0,
        leadDetails,
        alternatePhone: normalizedAlternatePhone,
        message: matches.length
          ? 'An existing CRM record will be used for this enquiry.'
          : 'No existing information was found. Please enter your details.',
      },
    });
  } catch (error) {
    console.error('Create GRE session error:', error);
    res.status(500).json({ success: false, error: 'Unable to start your form. Please try again.' });
  }
});

publicRouter.get('/:token/session', async (req, res) => {
  try {
    const context = await getSession(req, res);
    if (!context) return;
    const leadDetails = context.session.leadId
      ? await prisma.lead.findFirst({
        where: { id: context.session.leadId, tenantId: context.form.tenantId },
        select: publicLeadSelect,
      })
      : null;
    const decoratedLeadDetails = leadDetails
      ? await decorateLeadStatus(context.form.tenantId, leadDetails)
      : null;
    const scheduledVisits = leadDetails
      ? await getScheduledSiteVisits(prisma, context.form.tenantId, [leadDetails.id])
      : new Map();
    res.json({
      success: true,
      data: {
        currentStep: context.session.currentStep,
        draft: context.session.draft,
        countryCode: context.session.phoneCountryCode,
        phone: context.session.phone,
        leadExists: context.session.leadWasExisting,
        leadDetails: decoratedLeadDetails
          ? { ...decoratedLeadDetails, scheduledSiteVisits: scheduledVisits.get(decoratedLeadDetails.id) || [] }
          : null,
        expiresAt: context.session.expiresAt,
      },
    });
  } catch (error) {
    console.error('Get GRE session error:', error);
    res.status(500).json({ success: false, error: 'Unable to restore your form session' });
  }
});

publicRouter.put('/:token/session', async (req, res) => {
  try {
    const context = await getSession(req, res);
    if (!context) return;
    const parsed = greDraftSchema.safeParse(req.body.draft);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues[0]?.message || 'Please check the form values' });
    }
    const currentStep = z.number().int().min(2).max(5).safeParse(req.body.currentStep);
    const session = await prisma.greSession.update({
      where: { id: context.session.id },
      data: {
        draft: parsed.data as Prisma.InputJsonValue,
        currentStep: currentStep.success ? currentStep.data : context.session.currentStep,
        status: 'IN_PROGRESS',
      },
    });
    res.json({ success: true, data: { currentStep: session.currentStep, savedAt: session.updatedAt } });
  } catch (error) {
    console.error('Save GRE session error:', error);
    res.status(500).json({ success: false, error: 'Unable to save your form. Please try again.' });
  }
});

publicRouter.post('/:token/submit', async (req, res) => {
  let submitStage = 'validating submission';
  try {
    const context = await getSession(req, res);
    if (!context) return;
    const parsed = greSubmissionSchema.safeParse(req.body.draft);
    if (!parsed.success) return res.status(400).json({ success: false, error: parsed.error.issues[0]?.message || 'Please review your form' });
    const draft: GreDraft = parsed.data;
    if (context.form.defaultProjectId) {
      draft.lead.projectId = context.form.defaultProjectId;
      draft.siteVisit.projectId = context.form.defaultProjectId;
    }
    const session = context.session;
    const phone = session.normalizedPhone;
    if (!phone) return res.status(400).json({ success: false, error: 'Please verify your phone number first' });
    const firstName = draft.lead.firstName?.trim() || '';
    const lastName = draft.lead.lastName?.trim() || '';
    const siteVisitAt = draft.siteVisit.required
      ? parseLocalDateTime(draft.siteVisit.date!, draft.siteVisit.time!, context.form.tenant.timezone)
      : null;
    if (!siteVisitAt || siteVisitAt > new Date()) {
      return res.status(400).json({ success: false, error: 'Site visit date and time must be valid and cannot be in the future' });
    }
    if (draft.lead.projectId) {
      const project = await prisma.project.findFirst({ where: { id: draft.lead.projectId, tenantId: context.form.tenantId, isActive: true }, select: { id: true } });
      if (!project) return res.status(400).json({ success: false, error: 'Selected project is unavailable' });
    }
    const location = greLocationSchema.safeParse(req.body.location);
    if (!location.success) {
      return res.status(400).json({ success: false, error: GRE_LOCATION_MESSAGES.denied });
    }
    if (draft.siteVisit.required) {
      const project = await prisma.project.findFirst({
        where: { id: draft.siteVisit.projectId!, tenantId: context.form.tenantId, isActive: true },
        select: { id: true, latitude: true, longitude: true, mapUrl: true, allowedRadiusMeters: true },
      });
      if (!project) return res.status(400).json({ success: false, error: 'Selected site visit project is unavailable' });
      const storedMapCoordinates = coordinatesFromStoredMapUrl(project.mapUrl);
      const projectLatitude = readStoredCoordinate(project.latitude) ?? storedMapCoordinates?.latitude ?? null;
      const projectLongitude = readStoredCoordinate(project.longitude) ?? storedMapCoordinates?.longitude ?? null;
      const verification = verifyGreSubmissionLocation({
        projectLatitude,
        projectLongitude,
        radiusMeters: project.allowedRadiusMeters,
        latitude: location.data.latitude,
        longitude: location.data.longitude,
        accuracyMeters: location.data.accuracy,
        capturedAt: new Date(location.data.capturedAt),
      });
      if (process.env.NODE_ENV !== 'production') {
        console.info('[gre-location]', {
          projectId: project.id,
          projectLatitude,
          projectLongitude,
          userLatitude: location.data.latitude,
          userLongitude: location.data.longitude,
          accuracyMeters: location.data.accuracy,
          distanceMeters: verification.distanceMeters ?? null,
          radiusMeters: verification.radiusMeters ?? project.allowedRadiusMeters,
          result: verification.ok ? 'allowed' : verification.code,
        });
      }
      if (!verification.ok) {
        return res.status(409).json({ success: false, error: verification.error });
      }
    }
    if (draft.lead.dateOfBirth) {
      const dateOfBirth = parseDateOnly(draft.lead.dateOfBirth);
      if (!dateOfBirth || dateOfBirth > new Date()) {
        return res.status(400).json({ success: false, error: 'Date of birth must be a valid date in the past' });
      }
    }
    const companyName = draft.company.name?.trim() || null;
    const normalizedCompanyName = companyName?.toLowerCase().replace(/\s+/g, ' ') || null;
    const normalizedGst = draft.company.gstNumber?.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || null;

    const submitted = await prisma.$transaction(async (tx) => {
      submitStage = 'starting submission transaction';
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${context.form.tenantId}:GRE:SESSION:${session.id}`}, 0))`;
      const currentSession = await tx.greSession.findUnique({
        where: { id: session.id },
        select: { status: true, referenceNumber: true },
      });
      if (currentSession?.status === 'COMPLETED') {
        throw Object.assign(new Error(`This form has already been submitted${currentSession.referenceNumber ? ` (${currentSession.referenceNumber})` : ''}`), { statusCode: 409 });
      }

      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${context.form.tenantId}:GRE:PHONE:${phone}`}, 0))`;
      const duplicatePhones = [
        { field: 'phone', value: session.phone, countryCode: session.phoneCountryCode },
        { field: 'secondaryPhone', value: draft.lead.secondaryPhone, countryCode: session.phoneCountryCode },
        { field: 'tertiaryPhone', value: draft.lead.tertiaryPhone, countryCode: session.phoneCountryCode },
      ];
      const duplicateEmails = [
        { field: 'email', value: draft.lead.email },
        { field: 'secondaryEmail', value: draft.lead.alternateEmail },
      ];
      await acquireLeadDuplicateLocks(tx, context.form.tenantId, {
        phones: duplicatePhones,
        emails: duplicateEmails,
      });
      if (normalizedCompanyName) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${context.form.tenantId}:GRE:COMPANY:${normalizedCompanyName}`}, 0))`;
      }
      if (normalizedGst) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${context.form.tenantId}:GRE:GST:${normalizedGst}`}, 0))`;
      }

      submitStage = 'matching existing lead';
      const matchingLeads = await findMatchingLeads(
        tx,
        context.form.tenantId,
        phone,
        session.phoneCountryCode,
        session.phone,
        draft.lead.secondaryPhone,
        duplicateEmails,
        [{ field: 'tertiaryPhone', value: draft.lead.tertiaryPhone, countryCode: session.phoneCountryCode }],
      );
      if (matchingLeads.length > 1 || matchingLeads.some((lead) => lead.duplicateMatchAmbiguous)) {
        await tx.auditLog.create({
          data: {
            tenantId: context.form.tenantId,
            userId: context.form.createdById,
            action: 'DUPLICATE_MATCH_AMBIGUOUS',
            objectType: 'LeadDuplicate',
            newValues: {
              leadIds: matchingLeads.map((lead) => lead.id),
              matchingFields: matchingLeads.map((lead) => ({
                leadId: lead.id,
                fields: lead.duplicateMatchFields,
              })),
              source: 'GRE',
              greSessionId: session.id,
              projectId: draft.lead.projectId || null,
              action: 'REVIEW_REQUIRED',
            },
          },
        });
        throw Object.assign(new Error('We could not safely match this number to one CRM record. Please contact the team that shared this form.'), { statusCode: 409 });
      }
      const existingLead = matchingLeads[0] ?? null;
      if (!existingLead && !lastName) {
        throw Object.assign(new Error('Last name is required'), { statusCode: 400 });
      }

      let company: { id: string; name: string } | null = null;
      submitStage = 'resolving company';
      if (existingLead?.companyId) {
        company = await tx.company.findFirst({
          where: { id: existingLead.companyId, tenantId: context.form.tenantId },
          select: { id: true, name: true },
        });
      } else if (!existingLead && companyName && normalizedCompanyName) {
        company = await tx.company.findFirst({
          where: {
            tenantId: context.form.tenantId,
            OR: [
              { normalizedName: normalizedCompanyName },
              ...(normalizedGst ? [{ normalizedGst }] : []),
            ],
          },
          select: { id: true, name: true },
        });
        const companyData = {
          name: companyName,
          normalizedName: normalizedCompanyName,
          companyType: draft.company.type || undefined,
          industry: draft.company.industry || undefined,
          email: draft.company.email || undefined,
          phone: draft.company.phone || undefined,
          website: draft.company.website || undefined,
          address: draft.company.address || undefined,
          city: draft.company.city || undefined,
          state: draft.company.state || undefined,
          country: draft.company.country || undefined,
          postalCode: draft.company.postalCode || undefined,
          designation: draft.company.designation || undefined,
          department: draft.company.department || undefined,
          numberOfEmployees: draft.company.numberOfEmployees ?? undefined,
          gstNumber: draft.company.gstNumber || undefined,
          normalizedGst: normalizedGst || undefined,
          comments: draft.company.comments || undefined,
        };
        if (!company) {
          company = await tx.company.create({
            data: { tenantId: context.form.tenantId, ...companyData },
            select: { id: true, name: true },
          });
        }
      }

      const selectedProjectId = draft.siteVisit.required ? draft.siteVisit.projectId : draft.lead.projectId;
      if (!selectedProjectId) {
        throw Object.assign(new Error('Please select a project for this Site Visit'), { statusCode: 400 });
      }
      const leadData = {
        ...(firstName ? { firstName } : {}),
        lastName,
        ...(draft.lead.secondaryPhone ? { secondaryPhone: normalizeLeadPhone(draft.lead.secondaryPhone, session.phoneCountryCode)?.e164 } : {}),
        ...(draft.lead.secondaryPhone ? { mobile: normalizeLeadPhone(draft.lead.secondaryPhone, session.phoneCountryCode)?.e164 } : {}),
        ...(draft.lead.tertiaryPhone ? { tertiaryPhone: normalizeLeadPhone(draft.lead.tertiaryPhone, session.phoneCountryCode)?.e164 } : {}),
        ...(draft.lead.email ? { email: normalizeLeadEmail(draft.lead.email) || undefined } : {}),
        ...(draft.lead.alternateEmail ? { alternateEmail: normalizeLeadEmail(draft.lead.alternateEmail) || undefined } : {}),
        countryCode: session.phoneCountryCode,
        ...(draft.lead.secondaryPhone ? { secondaryCountryCode: session.phoneCountryCode } : {}),
        ...(draft.lead.tertiaryPhone ? { tertiaryCountryCode: session.phoneCountryCode } : {}),
        ...(draft.lead.leadSubSource ? { leadSubSource: draft.lead.leadSubSource } : {}),
        ...(draft.lead.campaign ? { campaign: draft.lead.campaign } : {}),
        leadType: greRegistrationLeadType(false, draft.lead.leadType),
        ...(draft.lead.preferredLocation ? { preferredLocation: draft.lead.preferredLocation } : {}),
        ...(draft.lead.budget != null ? { budget: draft.lead.budget } : {}),
        ...(draft.lead.occupation ? { occupation: draft.lead.occupation } : {}),
        ...(draft.lead.comments ? { notes: draft.lead.comments } : {}),
        ...(draft.lead.dateOfBirth ? { dateOfBirth: new Date(draft.lead.dateOfBirth) } : {}),
        ...(draft.lead.gender ? { gender: draft.lead.gender } : {}),
        ...(selectedProjectId ? { projectId: selectedProjectId } : {}),
        phone,
        ...(company ? { company: company.name, companyId: company.id } : {}),
        ...(draft.company.type ? { companyType: draft.company.type } : {}),
        ...(draft.company.email ? { companyEmail: draft.company.email.toLowerCase() } : {}),
        ...(draft.company.phone ? { companyPhone: draft.company.phone } : {}),
        ...(draft.company.designation ? { designation: draft.company.designation } : {}),
        ...(draft.company.department ? { department: draft.company.department } : {}),
        ...(draft.company.gstNumber ? { gstNumber: draft.company.gstNumber } : {}),
        ...(draft.company.comments ? { companyComments: draft.company.comments } : {}),
        ...(draft.company.website ? { website: draft.company.website } : {}),
        ...(draft.company.address ? { street: draft.company.address } : {}),
        ...(draft.company.city ? { city: draft.company.city } : {}),
        ...(draft.company.state ? { stateProvince: draft.company.state } : {}),
        ...(draft.company.country ? { country: draft.company.country } : {}),
        ...(draft.company.postalCode ? { postalCode: draft.company.postalCode } : {}),
        ...(draft.company.industry ? { industry: draft.company.industry } : {}),
        ...(draft.company.numberOfEmployees != null ? { numberOfEmployees: draft.company.numberOfEmployees } : {}),
      };

      let lead: { id: string; leadNumber: string | null };
      const persistedLeadStatus = getGreLeadStatus(draft.siteVisit.required, existingLead?.status);
      const leadStatusChanged = false;
      submitStage = 'saving lead';
      if (existingLead) {
        lead = { id: existingLead.id, leadNumber: null };
      } else {
        const leadSequence = await tx.sequence.upsert({
          where: { tenantId_type: { tenantId: context.form.tenantId, type: 'LEAD' } },
          update: { nextValue: { increment: 1 } },
          create: { tenantId: context.form.tenantId, type: 'LEAD', nextValue: 1 },
        });
        lead = await tx.lead.create({
          data: {
            tenantId: context.form.tenantId,
            creatorId: context.form.createdById,
            leadNumber: `LN${String(leadSequence.nextValue).padStart(6, '0')}`,
            company: company?.name || [firstName, lastName].filter(Boolean).join(' '),
            source: 'WEBSITE',
            status: persistedLeadStatus,
            customFields: mergeOperationalLeadCustomFields({}, {
              source: 'WEBSITE',
              status: persistedLeadStatus,
              rating: null,
              description: draft.lead.comments || null,
              score: 0,
            }),
            ...leadData,
          },
          select: { id: true, leadNumber: true },
        });
      }

      submitStage = 'finding scheduled site visit';
      const previousProjectVisit = existingLead
        ? await tx.siteVisit.findFirst({
          where: { tenantId: context.form.tenantId, leadId: lead.id, projectId: selectedProjectId },
          orderBy: [{ scheduledAt: 'desc' }, { createdAt: 'desc' }],
          select: {
            projectId: true,
          },
        })
        : null;
      const scheduledProjectVisits = existingLead
        ? await tx.siteVisit.findMany({
          where: {
            tenantId: context.form.tenantId,
            leadId: lead.id,
            projectId: selectedProjectId,
            status: 'SCHEDULED',
          },
          orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            scheduledAt: true,
            completedAt: true,
            status: true,
            projectId: true,
            assigneeId: true,
            createdAt: true,
            notes: true,
            completionNotes: true,
            visitorCount: true,
            visitType: true,
            transportRequired: true,
            assignee: { select: { firstName: true, lastName: true, email: true } },
          },
        })
        : [];
      const scheduledVisitToComplete = selectScheduledVisitToComplete(scheduledProjectVisits, siteVisitAt!);
      const isRevisit = Boolean(
        existingLead?.id && previousProjectVisit?.projectId === selectedProjectId,
      )
        || Boolean(scheduledVisitToComplete);
      const siteVisitType = greVisitType(draft.siteVisit.visitType) || scheduledVisitToComplete?.visitType || undefined;
      const retainedOwnerId = scheduledVisitToComplete?.assigneeId ?? null;

      const siteVisitNotes = [
        `GRE registration: ${context.form.name}`,
        `Visit category: ${isRevisit ? 'Revisit' : 'First Visit'}`,
        draft.siteVisit.visitType ? `Visit type: ${draft.siteVisit.visitType}` : '',
        draft.siteVisit.preferredLocation ? `Location: ${draft.siteVisit.preferredLocation}` : '',
        draft.siteVisit.comments,
      ].filter(Boolean).join('\n');
      const siteVisitSelect = {
        id: true,
        scheduledAt: true,
        completedAt: true,
        status: true,
        projectId: true,
        createdAt: true,
        assigneeId: true,
      } as const;
      submitStage = 'saving completed site visit';
      const siteVisit = scheduledVisitToComplete
        ? await tx.siteVisit.update({
          where: { id: scheduledVisitToComplete.id },
          data: {
            assigneeId: retainedOwnerId,
            completedAt: siteVisitAt!,
            completedById: context.form.createdById,
            status: 'COMPLETED',
            completionNotes: [scheduledVisitToComplete.completionNotes, siteVisitNotes].filter(Boolean).join('\n'),
            visitorCount: draft.siteVisit.visitorCount ?? scheduledVisitToComplete.visitorCount ?? 1,
            visitType: siteVisitType,
          },
          select: siteVisitSelect,
        })
        : await tx.siteVisit.create({
          data: {
          tenantId: context.form.tenantId,
          leadId: lead.id,
          projectId: draft.siteVisit.projectId,
          creatorId: context.form.createdById,
          siteVisitNumber: await getNextSiteVisitNumber(tx, context.form.tenantId),
          scheduledAt: siteVisitAt!,
          completedAt: siteVisitAt!,
          completedById: context.form.createdById,
          status: 'COMPLETED',
          notes: siteVisitNotes,
          completionNotes: siteVisitNotes,
          visitorCount: draft.siteVisit.visitorCount ?? 1,
          visitType: siteVisitType ?? null,
          transportRequired: null,
        },
        select: siteVisitSelect,
      });
      submitStage = 'assigning completed site visit';
      const salesHandoff = draft.siteVisit.required
        ? await assignCompletedSiteVisitToSalesInTransaction(tx, siteVisit.id, context.form.tenantId)
        : null;
      submitStage = 'finalizing GRE submission';
      const seq = await tx.sequence.upsert({
        where: { tenantId_type: { tenantId: context.form.tenantId, type: 'GRE' } },
        update: { nextValue: { increment: 1 } },
        create: { tenantId: context.form.tenantId, type: 'GRE', nextValue: 1 },
      });
      const referenceNumber = `GRE-${new Date().getFullYear()}-${String(seq.nextValue).padStart(6, '0')}`;
      await tx.greSession.update({
        where: { id: session.id },
        data: {
          leadId: lead.id,
          companyId: existingLead?.companyId || company?.id,
          siteVisitId: siteVisit?.id,
          referenceNumber,
          leadWasExisting: matchingLeads.length > 0,
          status: 'COMPLETED',
          currentStep: 6,
          draft: parsed.data as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });

      const relatedSourceResult = await createEnquiryInTransactionWithStatus(tx, {
        tenantId: context.form.tenantId,
        leadId: lead.id,
        leadType: greRegistrationLeadType(Boolean(existingLead), draft.lead.leadType),
        enquiryType: greRegistrationLeadType(Boolean(existingLead), draft.lead.leadType),
        source: 'GRE',
        subSource: draft.lead.leadSubSource,
        campaign: draft.lead.campaign,
        projectId: selectedProjectId,
        phone: session.phone,
        secondaryPhone: draft.lead.secondaryPhone
          ? draft.lead.secondaryPhone
          : undefined,
        tertiaryPhone: draft.lead.tertiaryPhone
          ? draft.lead.tertiaryPhone
          : undefined,
        countryCode: session.phoneCountryCode,
        secondaryCountryCode: draft.lead.secondaryPhone ? session.phoneCountryCode : undefined,
        tertiaryCountryCode: draft.lead.tertiaryPhone ? session.phoneCountryCode : undefined,
        email: draft.lead.email,
        secondaryEmail: draft.lead.alternateEmail,
        originalSubmissionId: `GRE:${session.id}`,
        medium: 'GRE',
        description: draft.lead.comments,
        details: {
          greFormId: context.form.id,
          greFormName: context.form.name,
          greSessionId: session.id,
          referenceNumber,
          siteVisitId: siteVisit?.id || null,
          siteVisitCategory: isRevisit ? 'REVISIT' : 'FIRST_VISIT',
          previousLeadStatus: existingLead?.status || null,
        },
        userId: context.form.createdById,
      });
      const relatedSource = relatedSourceResult.enquiry;
      if (relatedSourceResult.created) {
        const currentAttribution = await tx.lead.findUnique({
          where: { id: lead.id },
          select: { firstCampaign: true },
        });
        await tx.lead.update({
          where: { id: lead.id },
          data: {
            lastSource: 'GRE',
            lastSubSource: draft.lead.leadSubSource || null,
            lastCampaign: draft.lead.campaign || null,
            lastEnquiryAt: new Date(),
            enquiryCount: { increment: 1 },
            ...(!currentAttribution?.firstCampaign && draft.lead.campaign
              ? { firstCampaign: draft.lead.campaign }
              : {}),
          },
        });
      }
      if (existingLead) {
        await tx.auditLog.create({
          data: {
            tenantId: context.form.tenantId,
            userId: context.form.createdById,
            leadId: lead.id,
            action: 'DUPLICATE_ENQUIRY_LINKED',
            objectType: 'Enquiry',
            objectId: relatedSource.id,
            newValues: {
              leadId: lead.id,
              enquiryId: relatedSource.id,
              matchingFields: existingLead.duplicateMatchFields,
              source: 'GRE',
              projectId: selectedProjectId,
              action: 'RELATED_SOURCE_LINKED',
            },
          },
        });
      }

      await tx.auditLog.create({
        data: {
          tenantId: context.form.tenantId,
          userId: context.form.createdById,
          leadId: lead.id,
          action: existingLead ? 'GRE_LEAD_REUSED' : 'GRE_LEAD_CREATED',
          objectType: 'Lead',
          objectId: lead.id,
          oldValues: existingLead ? { status: existingLead.status } : undefined,
          newValues: {
            greSessionId: session.id,
            referenceNumber,
            companyId: existingLead?.companyId || company?.id || null,
            siteVisitId: siteVisit?.id,
            status: persistedLeadStatus,
            leadStatusChanged,
            siteVisitType: siteVisitType ?? null,
            siteVisitCategory: isRevisit ? 'REVISIT' : 'FIRST_VISIT',
            scheduledVisitCompleted: Boolean(scheduledVisitToComplete),
          },
        },
      });
      await appendLeadProcessNote(tx, {
        tenantId: context.form.tenantId,
        leadId: lead.id,
        userId: context.form.createdById,
        content: [
          `GRE registration submitted: ${referenceNumber}`,
          `Lead status: ${persistedLeadStatus}`,
          siteVisit ? `Site visit completed: ${siteVisit.id}` : null,
        ].filter(Boolean).join('\n'),
      });
      if (company && !existingLead) {
        await tx.auditLog.create({
          data: {
            tenantId: context.form.tenantId,
            userId: context.form.createdById,
            leadId: lead.id,
            action: 'GRE_COMPANY_LINKED_OR_CREATED',
            objectType: 'Company',
            objectId: company.id,
            newValues: { greSessionId: session.id, referenceNumber },
          },
        });
      }
      if (siteVisit) {
        submitStage = 'recording site visit audit';
        await tx.auditLog.create({
          data: {
            tenantId: context.form.tenantId,
            userId: context.form.createdById,
            leadId: lead.id,
            action: 'GRE_SITE_VISIT_COMPLETED',
            objectType: 'SiteVisit',
            objectId: siteVisit.id,
            newValues: {
              greSessionId: session.id,
              referenceNumber,
              status: siteVisit.status,
              scheduledAt: siteVisit.scheduledAt.toISOString(),
              completedAt: siteVisit.completedAt?.toISOString() ?? null,
              projectId: siteVisit.projectId,
              assigneeId: siteVisit.assigneeId,
              visitType: siteVisitType ?? null,
              visitCategory: isRevisit ? 'REVISIT' : 'FIRST_VISIT',
              scheduledVisitCompleted: Boolean(scheduledVisitToComplete),
            },
          },
        });
      }

      return {
        referenceNumber,
        leadWasExisting: matchingLeads.length > 0,
        leadId: lead.id,
        siteVisit,
        scheduledVisitCompleted: Boolean(scheduledVisitToComplete),
        salesHandoff,
      };
    });

    const handoffUserId = submitted.salesHandoff?.assignedUserId || null;
    const handoffUser = handoffUserId
      ? await prisma.user.findFirst({
        where: { id: handoffUserId, tenantId: context.form.tenantId },
        select: { firstName: true, lastName: true, email: true },
      })
      : null;
    const assignment = submitted.salesHandoff
      ? {
        assignedTo: handoffUser ? (`${handoffUser.firstName} ${handoffUser.lastName}`.trim() || handoffUser.email) : null,
        warning: submitted.salesHandoff.pendingReason || null,
      }
      : null;
    const savedLead = await prisma.lead.findFirst({
      where: { id: submitted.leadId, tenantId: context.form.tenantId },
      select: { id: true, status: true },
    });
    const decoratedSavedLead = savedLead
      ? await decorateLeadStatus(context.form.tenantId, savedLead)
      : null;

    res.json({
      success: true,
      data: {
        referenceNumber: submitted.referenceNumber,
        assignment,
        siteVisit: submitted.siteVisit ? {
          id: submitted.siteVisit.id,
          scheduledAt: submitted.siteVisit.scheduledAt,
          completedAt: submitted.siteVisit.completedAt,
          status: submitted.siteVisit.status,
          projectId: submitted.siteVisit.projectId,
          createdAt: submitted.siteVisit.createdAt,
        } : null,
        leadId: submitted.leadId,
        leadStatus: decoratedSavedLead?.status ?? null,
        leadStatusLabel: decoratedSavedLead?.statusLabel ?? null,
        leadWasExisting: submitted.leadWasExisting,
        message: GRE_LOCATION_MESSAGES.verified,
        scheduledVisitCompleted: submitted.scheduledVisitCompleted,
        salesHandoff: submitted.salesHandoff,
      },
    });
  } catch (error) {
    const statusCode = error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (statusCode === 409 || statusCode === 400 || statusCode === 503) {
      return res.status(statusCode).json({ success: false, error: error instanceof Error ? error.message : 'Unable to submit GRE form' });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return res.status(409).json({ success: false, error: 'A matching phone number was submitted at the same time. Please retry the form.' });
    }
    console.error('Submit GRE form error:', error);
    const response: { success: false; error: string; stage: string; detail?: string } = {
      success: false,
      error: 'Unable to submit your information. Please try again.',
      stage: submitStage,
    };
    if (process.env.NODE_ENV !== 'production' && error instanceof Error) {
      response.detail = `${submitStage}: ${error.message}`;
    }
    res.status(500).json(response);
  }
});

router.use(authenticate, adminRateLimit, requireAdmin);

router.get('/forms', async (req: AuthRequest, res: Response) => {
  try {
    const forms = await prisma.greForm.findMany({
      where: { tenantId: req.tenantId! },
      include: { _count: { select: { sessions: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({
      success: true,
      data: forms.map((form) => ({
        id: form.id,
        name: form.name,
        publicUrl: grePublicUrl(form.publicToken, form.defaultProjectId),
        isActive: form.isActive,
        expiresAt: form.expiresAt,
        defaultProjectId: form.defaultProjectId,
        sessions: form._count.sessions,
        createdAt: form.createdAt,
      })),
    });
  } catch (error) {
    console.error('List GRE forms error:', error);
    res.status(500).json({ success: false, error: 'Failed to list GRE forms' });
  }
});

router.post('/forms', async (req: AuthRequest, res: Response) => {
  try {
    const schema = z.object({
      name: z.string().trim().min(1).max(100),
      defaultProjectId: z.string().trim().min(1, 'A project is required'),
    });
    const data = schema.parse(req.body);
    const project = await prisma.project.findFirst({
      where: { id: data.defaultProjectId, tenantId: req.tenantId!, isActive: true },
      select: { id: true },
    });
    if (!project) return res.status(400).json({ success: false, error: 'Select an active project before generating a link' });
    const publicToken = randomBytes(32).toString('base64url');
    const form = await prisma.greForm.create({
      data: {
        tenantId: req.tenantId!,
        name: data.name,
        publicToken,
        expiresAt: null,
        defaultProjectId: project.id,
        createdById: req.user!.id,
      },
    });
    await prisma.auditLog.create({
      data: {
        tenantId: req.tenantId!,
        userId: req.user!.id,
        action: 'GRE_FORM_CREATED',
        objectType: 'GreForm',
        objectId: form.id,
        newValues: { name: form.name, defaultProjectId: form.defaultProjectId },
      },
    });
    res.status(201).json({
      success: true,
      data: {
        id: form.id,
        name: form.name,
        publicUrl: grePublicUrl(publicToken, form.defaultProjectId),
        isActive: form.isActive,
        expiresAt: null,
        defaultProjectId: form.defaultProjectId,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ success: false, error: error.issues[0]?.message || 'Invalid form data' });
    console.error('Create GRE form error:', error);
    res.status(500).json({ success: false, error: 'Failed to create GRE form' });
  }
});

router.patch('/forms/:id', async (req: AuthRequest, res: Response) => {
  try {
    const schema = z.object({
      name: z.string().trim().min(1).max(100).optional(),
      isActive: z.boolean().optional(),
      defaultProjectId: z.string().trim().min(1, 'A project is required').optional(),
    }).strict();
    const data = schema.parse(req.body);
    if (data.defaultProjectId) {
      const project = await prisma.project.findFirst({ where: { id: data.defaultProjectId, tenantId: req.tenantId!, isActive: true }, select: { id: true } });
      if (!project) return res.status(400).json({ success: false, error: 'Default project is not available' });
    }
    const existing = await prisma.greForm.findFirst({ where: { id: req.params.id, tenantId: req.tenantId! } });
    if (!existing) return res.status(404).json({ success: false, error: 'GRE form not found' });
    const form = await prisma.greForm.update({
      where: { id: existing.id },
      data,
    });
    await prisma.auditLog.create({
      data: {
        tenantId: req.tenantId!,
        userId: req.user!.id,
        action: 'GRE_FORM_UPDATED',
        objectType: 'GreForm',
        objectId: form.id,
        oldValues: { name: existing.name, isActive: existing.isActive, expiresAt: existing.expiresAt },
        newValues: data,
      },
    });
    res.json({ success: true, data: { id: form.id, name: form.name, publicUrl: grePublicUrl(form.publicToken, form.defaultProjectId), isActive: form.isActive, expiresAt: form.expiresAt, defaultProjectId: form.defaultProjectId } });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ success: false, error: error.issues[0]?.message || 'Invalid form data' });
    console.error('Update GRE form error:', error);
    res.status(500).json({ success: false, error: 'Failed to update GRE form' });
  }
});

router.delete('/forms/:id', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.greForm.findFirst({ where: { id: req.params.id, tenantId: req.tenantId! } });
    if (!existing) return res.status(404).json({ success: false, error: 'GRE form not found' });
    await prisma.greForm.delete({ where: { id: existing.id } });
    await prisma.auditLog.create({
      data: {
        tenantId: req.tenantId!,
        userId: req.user!.id,
        action: 'GRE_FORM_DELETED',
        objectType: 'GreForm',
        objectId: existing.id,
        oldValues: { name: existing.name, defaultProjectId: existing.defaultProjectId, publicToken: existing.publicToken },
      },
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Delete GRE form error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete GRE form' });
  }
});

router.get('/submissions', async (req: AuthRequest, res: Response) => {
  try {
    const parsedQuery = submissionsQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return res.status(400).json({ success: false, error: parsedQuery.error.issues[0]?.message || 'Invalid submissions query' });
    }
    const { page, limit, phone, from, to, leadStatus, siteVisitStatus, existingLead, projectId } = parsedQuery.data;
    const requestedLeadStatus = leadStatus ? leadStatusFromId(leadStatus) || leadStatus : undefined;
    const normalizedLeadStatus = requestedLeadStatus
      ? Object.values(LeadStatus).find((status) => status === requestedLeadStatus)
      : undefined;
    if (from && to && from > to) {
      return res.status(400).json({ success: false, error: 'The start date must be before or equal to the end date' });
    }
    let dateFrom: Date | undefined;
    let dateToExclusive: Date | undefined;
    if (from || to) {
      const dateRange = crmDateRangeBounds(from, to, await getTenantTimezone(req.tenantId!));
      if ('error' in dateRange) {
        return res.status(400).json({ success: false, error: dateRange.error });
      }
      dateFrom = dateRange.gte;
      dateToExclusive = dateRange.lt;
    }
    const phoneDigits = phone?.replace(/\D/g, '');
    const filters: Prisma.GreSessionWhereInput[] = [];
    if (phone) {
      filters.push({
        OR: [
          { phone: { contains: phone, mode: 'insensitive' } },
          ...(phoneDigits ? [{ normalizedPhone: { contains: phoneDigits } }] : []),
        ],
      });
    }
    if (projectId) {
      filters.push({
        OR: [
          { siteVisit: { projectId } },
          { lead: { projectId } },
        ],
      });
    }
    const where: Prisma.GreSessionWhereInput = {
      tenantId: req.tenantId!,
      status: GreSessionStatus.COMPLETED,
      ...(filters.length ? { AND: filters } : {}),
      ...(existingLead === 'true' ? { leadWasExisting: true } : existingLead === 'false' ? { leadWasExisting: false } : {}),
      ...(dateFrom || dateToExclusive ? {
        createdAt: {
          ...(dateFrom ? { gte: dateFrom } : {}),
          ...(dateToExclusive ? { lt: dateToExclusive } : {}),
        },
      } : {}),
      ...(phone ? {
        OR: [
          { phone: { contains: phone, mode: 'insensitive' } },
          ...(phoneDigits ? [{ normalizedPhone: { contains: phoneDigits } }] : []),
        ],
      } : {}),
      ...(normalizedLeadStatus ? { lead: { status: normalizedLeadStatus } } : {}),
      ...(siteVisitStatus ? { siteVisit: { status: siteVisitStatus } } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.greSession.findMany({
        where,
        include: {
          lead: { select: { id: true, firstName: true, lastName: true, phone: true, status: true, leadNumber: true, project: { select: { name: true } } } },
          company: { select: { id: true, name: true } },
          siteVisit: { select: { id: true, siteVisitNumber: true, scheduledAt: true, status: true, project: { select: { id: true, name: true } } } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.greSession.count({ where }),
    ]);
    const decoratedLeads = await decorateLeadStatuses(
      req.tenantId!,
      rows.flatMap((row) => row.lead ? [row.lead] : []),
    );
    const decoratedByLeadId = new Map(decoratedLeads.map((lead) => [lead.id, lead]));
    res.json({
      success: true,
      data: rows.map((row) => ({
        id: row.id,
        referenceNumber: row.referenceNumber,
        phone: row.phone,
        name: row.lead ? [row.lead.firstName, row.lead.lastName].filter(Boolean).join(' ') : '',
        leadNumber: row.lead?.leadNumber,
        leadId: row.leadId,
        leadStatus: row.lead?.status,
        leadStatusId: row.lead ? decoratedByLeadId.get(row.lead.id)?.statusId : null,
        leadStatusLabel: row.lead ? decoratedByLeadId.get(row.lead.id)?.statusLabel : null,
        leadWasExisting: row.leadWasExisting,
        company: row.company?.name || 'Individual',
        siteVisitNumber: row.siteVisit?.siteVisitNumber,
        siteVisitAt: row.siteVisit?.scheduledAt,
        siteVisitStatus: row.siteVisit?.status,
        project: row.siteVisit?.project?.name || row.lead?.project?.name || '',
        status: row.status,
        createdAt: row.createdAt,
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('List GRE submissions error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch GRE submissions' });
  }
});

export { router as greRoutes };