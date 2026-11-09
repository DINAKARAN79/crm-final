import { Router, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '@dct-crm/db';
import {
  crmDateRangeBounds,
  formatCRMDateTime,
  PROSPECT_BEDROOM_OPTIONS,
  PROSPECT_BUDGET_OPTIONS,
  PROSPECT_PROPERTY_TYPE_OPTIONS,
  SITE_VISIT_FUTURE_TIME_ERROR,
  SITE_VISIT_RATING_OPTIONS,
  SITE_VISIT_TRANSPORT_OPTIONS,
  SITE_VISIT_TYPE_OPTIONS,
} from '@dct-crm/shared';
import { z } from 'zod';
import { authenticate, AuthRequest } from '../middleware/auth';
import { withImpersonatorNames } from '../services/impersonation';
import { listOrderBy, listViewConstraint, mergeListWhere } from '../services/listViewService';
import { authorize } from '../middleware/authorization';
import {
  applyScope,
  canAccessLead,
  canAccessLeadId,
  canAccessSiteVisit,
  getScopeClause,
} from '../services/recordAccess';
import { getNextSiteVisitNumber, normalizeOverdueSiteVisits } from '../services/leadWorkflowExtras';
import { canTransitionStatus } from '../services/workflow';
import {
  assignCompletedSiteVisitToSalesInTransaction,
  assignSiteVisitToSVCInTransaction,
} from '../services/rrQueue';
import { validateObjectCustomFields } from '../services/customFieldValidation';
import { tagLeadSiteVisitEvents } from '../services/leadEventTagging';
import { ensureSiteVisitScheduleFields } from '../services/siteVisitScheduleFields';
import { appendLeadProcessNote } from '../services/leadNotes';
import { getTenantTimezone } from '../services/tenantTimezone';
import {
  applySiteVisitCompletion,
  assertVisitCanBeCompleted,
  CompleteSiteVisitError,
  parseCompletedAt,
} from '../services/completeSiteVisit';

const router = Router();

router.use(authenticate);

const RESCHEDULED_REASON_PREFIX = 'Rescheduled to ';

function presentSiteVisitStatus<T extends { id: string; status: string; cancellationReason?: string | null }>(
  siteVisit: T,
  hasRescheduleHistory = false,
) {
  return (hasRescheduleHistory && siteVisit.status === 'SCHEDULED') ||
    (siteVisit.status === 'CANCELLED' && siteVisit.cancellationReason?.startsWith(RESCHEDULED_REASON_PREFIX))
    ? { ...siteVisit, status: 'RESCHEDULED' }
    : siteVisit;
}

async function getRescheduledSiteVisitIds(tenantId: string, siteVisitIds: string[]): Promise<Set<string>> {
  if (!siteVisitIds.length) return new Set();
  const history = await prisma.auditLog.findMany({
    where: {
      tenantId,
      objectType: 'SiteVisit',
      objectId: { in: siteVisitIds },
      action: 'SITE_VISIT_RESCHEDULED',
    },
    select: { objectId: true },
  });
  return new Set(history.flatMap((entry) => entry.objectId ? [entry.objectId] : []));
}

export const siteVisitSchema = z.object({
  leadId: z.string().min(1, 'Lead ID is required'),
  projectId: z.string().min(1, 'Project is required'),
  assigneeId: z.string().optional(),
  queueId: z.string().optional(),
  scheduledAt: z.string().datetime(),
  status: z.enum(['SCHEDULED', 'COMPLETED', 'CANCELLED']).optional(),
  notes: z.string().min(1, 'Note/reason is required').max(2000),
  feedback: z.string().max(1000).optional(),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  visitType: z.string().max(100).nullable().optional(),
  transportRequired: z.boolean().nullable().optional(),
  customFields: z.record(z.unknown()).optional(),
});

export const updateSiteVisitSchema = siteVisitSchema.partial();

const adminCompleteSiteVisitSchema = z.object({
  completedAt: z.string().min(1, 'Completed date and time are required'),
  rating: z.enum(['Hot', 'Warm', 'Cold'], { errorMap: () => ({ message: 'Rating is required' }) }),
  feedback: z.string().trim().min(1, 'Feedback is required').max(2000, 'Feedback must be 2000 characters or fewer'),
  minimumBudget: z.string().optional(),
  maximumBudget: z.string().optional(),
  propertyType: z.union([z.string(), z.array(z.string())]).optional(),
  bedroomPreference: z.union([z.string(), z.array(z.string())]).optional(),
});

const completeSiteVisitSchema = z.object({
  completedAt: z.string().datetime('Completion time is required'),
  customerFeedback: z.string().min(1, 'Customer feedback is required').refine((v) => v.trim().length > 0, 'Customer feedback is required'),
  completionNotes: z.string().min(1, 'Completion notes are required').refine((v) => v.trim().length > 0, 'Completion notes are required'),
});

class SiteVisitCompletionConflict extends Error {}

const cancelSiteVisitSchema = z.object({
  reason: z.string().min(1, 'Reason is required').refine((v) => v.trim().length > 0, {
    message: 'Reason is required',
  }),
});

const revisitSiteVisitSchema = z.object({
  reason: z.string().trim().max(2000).optional(),
  scheduledAt: z.string().datetime({ message: 'Visit date/time is required' }),
  projectId: z.string().min(1, 'Project is required'),
  assigneeId: z.string().optional(),
  notes: z.string().max(2000).optional(),
  visitType: z.enum(SITE_VISIT_TYPE_OPTIONS, { errorMap: () => ({ message: 'Site visit type is required' }) }),
  rating: z.enum(SITE_VISIT_RATING_OPTIONS).nullable().optional(),
  transport: z.enum(SITE_VISIT_TRANSPORT_OPTIONS).nullable().optional(),
  callSummaryRemarks: z.string().trim().max(5000).optional(),
  minimumBudget: z.string().refine((value) => PROSPECT_BUDGET_OPTIONS.includes(value as typeof PROSPECT_BUDGET_OPTIONS[number])),
  maximumBudget: z.string().refine((value) => PROSPECT_BUDGET_OPTIONS.includes(value as typeof PROSPECT_BUDGET_OPTIONS[number])),
  propertyType: z.array(z.string().refine((value) => PROSPECT_PROPERTY_TYPE_OPTIONS.includes(value as typeof PROSPECT_PROPERTY_TYPE_OPTIONS[number]))).min(1),
  bedroomPreference: z.array(z.string().refine((value) => PROSPECT_BEDROOM_OPTIONS.includes(value as typeof PROSPECT_BEDROOM_OPTIONS[number]))).optional(),
});

router.get('/', authorize('SiteVisit', 'read'), async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    await normalizeOverdueSiteVisits(tenantId);
    const {
      page = 1,
      limit = 20,
      leadId,
      projectId,
      assigneeId,
      status,
      search,
      startDate,
      endDate,
      sortBy = 'scheduledAt',
      sortOrder = 'desc',
    } = req.query;

    const skip = (Number(page) - 1) * Number(limit);

    let where: any = { tenantId };
    if (leadId) where.leadId = leadId;
    if (projectId) where.projectId = projectId;
    if (assigneeId) where.assigneeId = assigneeId;
    if (status === 'CANCELLED') {
      where.status = 'CANCELLED';
      where.AND = [{
        OR: [
          { cancellationReason: null },
          { cancellationReason: { not: { startsWith: RESCHEDULED_REASON_PREFIX } } },
        ],
      }];
    } else if (status && status !== 'RESCHEDULED' && status !== 'SCHEDULED') {
      where.status = status;
    }
    if (search && String(search).trim()) {
      const term = String(search).trim();
      where.OR = [
        { siteVisitNumber: { contains: term, mode: 'insensitive' } },
        { lead: { leadNumber: { contains: term, mode: 'insensitive' } } },
        { lead: { firstName: { contains: term, mode: 'insensitive' } } },
        { lead: { lastName: { contains: term, mode: 'insensitive' } } },
        { lead: { phone: { contains: term } } },
        { lead: { company: { contains: term, mode: 'insensitive' } } },
        { lead: { email: { contains: term, mode: 'insensitive' } } },
      ];
    }
    if (startDate || endDate) {
      const range = crmDateRangeBounds(
        startDate ? String(startDate) : undefined,
        endDate ? String(endDate) : undefined,
        await getTenantTimezone(tenantId),
      );
      if ('error' in range) {
        return res.status(400).json({ success: false, error: range.error });
      }
      if (range.gte || range.lt) where.scheduledAt = range;
    }
    where = applyScope(where, await getScopeClause(req.user!, 'siteVisit'));

    let filteredRescheduledIds = new Set<string>();
    if (status === 'RESCHEDULED' || status === 'SCHEDULED') {
      const scheduledCandidates = await prisma.siteVisit.findMany({
        where: { ...where, status: 'SCHEDULED' },
        select: { id: true },
      });
      filteredRescheduledIds = await getRescheduledSiteVisitIds(
        tenantId,
        scheduledCandidates.map((visit) => visit.id),
      );
      const statusCondition = status === 'RESCHEDULED'
        ? {
            OR: [
              {
                status: 'CANCELLED',
                cancellationReason: { startsWith: RESCHEDULED_REASON_PREFIX },
              },
              { status: 'SCHEDULED', id: { in: [...filteredRescheduledIds] } },
            ],
          }
        : {
            AND: [
              { status: 'SCHEDULED' },
              { id: { notIn: [...filteredRescheduledIds] } },
            ],
          };
      where.AND = [...(where.AND || []), statusCondition];
    }
    const viewConstraint = await listViewConstraint(req, 'SITE_VISIT');
    if (!viewConstraint.ok) return res.status(viewConstraint.status).json({ success: false, error: viewConstraint.error });
    mergeListWhere(where, viewConstraint.where);
    const sorted = listOrderBy('SITE_VISIT', sortBy, sortOrder);
    if (!sorted.ok) return res.status(400).json({ success: false, error: sorted.error });

    const [siteVisits, total] = await Promise.all([
      prisma.siteVisit.findMany({
        where,
        skip,
        take: Number(limit),
        orderBy: sorted.orderBy as { scheduledAt: 'asc' | 'desc' },
        include: {
          lead: { select: { id: true, leadNumber: true, firstName: true, lastName: true, phone: true, company: true, email: true } },
          project: { select: { id: true, name: true, allowedRadiusMeters: true } },
          assignee: { select: { id: true, firstName: true, lastName: true } },
          creator: { select: { id: true, firstName: true, lastName: true, email: true, profile: { select: { name: true } } } },
          completedBy: { select: { id: true, firstName: true, lastName: true, email: true, profile: { select: { name: true } } } },
          cancelledBy: { select: { id: true, firstName: true, lastName: true, email: true, profile: { select: { name: true } } } },
        },
      }),
      prisma.siteVisit.count({ where }),
    ]);

    const rescheduledIds = status === 'RESCHEDULED' || status === 'SCHEDULED'
      ? filteredRescheduledIds
      : await getRescheduledSiteVisitIds(tenantId, siteVisits.map((visit) => visit.id));
    res.json({
      success: true,
      data: siteVisits.map((siteVisit) => presentSiteVisitStatus(siteVisit, rescheduledIds.has(siteVisit.id))),
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error) {
    console.error('Get site visits error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch site visits' });
  }
});

router.get('/:id', authorize('SiteVisit', 'read'), async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    await normalizeOverdueSiteVisits(tenantId);

    const siteVisit = await prisma.siteVisit.findFirst({
      where: { id: req.params.id, tenantId },
      include: {
        lead: { select: { id: true, leadNumber: true, firstName: true, lastName: true, phone: true, company: true, email: true, status: true, customFields: true, owner: { select: { id: true, firstName: true, lastName: true, email: true, profile: { select: { name: true } } } } } },
        project: { select: { id: true, name: true, allowedRadiusMeters: true } },
        assignee: { select: { id: true, firstName: true, lastName: true, email: true } },
        creator: { select: { id: true, firstName: true, lastName: true, email: true, profile: { select: { name: true } } } },
        completedBy: { select: { id: true, firstName: true, lastName: true, email: true, profile: { select: { name: true } } } },
        cancelledBy: { select: { id: true, firstName: true, lastName: true, email: true, profile: { select: { name: true } } } },
        previousSiteVisit: { select: { id: true, siteVisitNumber: true, status: true, scheduledAt: true } },
        activities: { take: 10, orderBy: { createdAt: 'desc' } },
      },
    });

    if (!siteVisit) {
      return res.status(404).json({ success: false, error: 'Site visit not found' });
    }

    if (!(await canAccessSiteVisit(req.user!, siteVisit))) {
      return res.status(403).json({ success: false, error: 'You do not have access to this site visit' });
    }

    const rescheduledIds = await getRescheduledSiteVisitIds(tenantId, [siteVisit.id]);
    res.json({ success: true, data: presentSiteVisitStatus(siteVisit, rescheduledIds.has(siteVisit.id)) });
  } catch (error) {
    console.error('Get site visit error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch site visit' });
  }
});

router.get('/:id/history', authorize('SiteVisit', 'read'), async (req: AuthRequest, res: Response) => {
  try {
    const page = Number(req.query.page ?? 1);
    const limit = Number(req.query.limit ?? 100);
    if (!Number.isInteger(page) || page < 1 || page > 100 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      return res.status(400).json({ success: false, error: 'Invalid site visit history page or limit' });
    }

    const siteVisit = await prisma.siteVisit.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
      select: { id: true, leadId: true, tenantId: true, assigneeId: true, creatorId: true },
    });

    if (!siteVisit) {
      return res.status(404).json({ success: false, error: 'Site visit not found' });
    }
    if (!(await canAccessSiteVisit(req.user!, siteVisit))) {
      return res.status(403).json({ success: false, error: 'You do not have access to this site visit' });
    }

    const where = {
      tenantId: siteVisit.tenantId,
      objectType: 'SiteVisit',
      objectId: siteVisit.id,
    };
    const [entries, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: {
          user: { select: { id: true, firstName: true, lastName: true, profile: { select: { name: true } } } },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({
      success: true,
      data: await withImpersonatorNames(entries),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('Get site visit history error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch site visit history' });
  }
});

router.post('/', authorize('SiteVisit', 'create'), async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const { id: userId } = req.user!;
    const data = siteVisitSchema.parse(req.body);
    const customFieldError = data.customFields
      ? await validateObjectCustomFields(tenantId, 'SiteVisit', data.customFields, false)
      : null;
    if (customFieldError) {
      return res.status(400).json({ success: false, error: customFieldError });
    }

    const lead = await prisma.lead.findFirst({
      where: { id: data.leadId, tenantId },
      select: {
        id: true,
        tenantId: true,
        ownerId: true,
        creatorId: true,
        status: true,
        source: true,
        leadSubSource: true,
        rating: true,
      },
    });
    if (!lead) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }
    if (!(await canAccessLead(req.user!, lead))) {
      return res.status(403).json({ success: false, error: 'You do not have access to this lead' });
    }

    const siteVisitStatus = data.status || 'SCHEDULED';
    if (siteVisitStatus === 'COMPLETED') {
      return res.status(400).json({ success: false, error: 'Use the completion action to complete a site visit.' });
    }
    const result = await prisma.$transaction(async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: data.projectId, tenantId, isActive: true },
        select: { id: true, name: true },
      });
      if (!project) throw new Error('PROJECT_NOT_AVAILABLE');

      const siteVisitNumber = await getNextSiteVisitNumber(tx, tenantId);
      const siteVisit = await tx.siteVisit.create({
        data: {
          tenantId,
          leadId: data.leadId,
          projectId: data.projectId,
          creatorId: userId,
          siteVisitNumber,
          scheduledAt: new Date(data.scheduledAt),
          status: siteVisitStatus,
          notes: data.notes,
          feedback: data.feedback,
          rating: data.rating,
          visitType: data.visitType,
          transportRequired: data.transportRequired,
          customFields: (data.customFields || {}) as Prisma.InputJsonObject,
        },
        select: { id: true },
      });
      if (siteVisitStatus === 'SCHEDULED') {
        await assignSiteVisitToSVCInTransaction(tx, {
          siteVisitId: siteVisit.id,
          tenantId,
          actorId: userId,
          requestedAssigneeId: data.assigneeId,
        });
      }

      const profileName = req.user!.profileName || 'Admin';
      if (
        siteVisitStatus === 'SCHEDULED' &&
        lead.status === 'PROSPECT' &&
        canTransitionStatus(profileName, 'PROSPECT', 'SITE_VISIT_SCHEDULED')
      ) {
        await tx.lead.update({
          where: { id: lead.id },
          data: { status: 'SITE_VISIT_SCHEDULED' },
        });
        await tx.auditLog.create({
          data: {
            tenantId,
            userId,
            leadId: lead.id,
            action: 'SITE_VISIT_SCHEDULED',
            objectType: 'Lead',
            objectId: lead.id,
            oldValues: { status: 'PROSPECT' },
            newValues: { status: 'SITE_VISIT_SCHEDULED', siteVisitId: siteVisit.id, siteVisitNumber, reason: data.notes },
          },
        });
      }
      if (siteVisitStatus === 'SCHEDULED') {
        await tagLeadSiteVisitEvents(tx, {
          tenantId,
          leadId: lead.id,
          scheduledAt: new Date(data.scheduledAt),
          projectName: project.name,
          leadStatus:
            lead.status === 'PROSPECT' &&
            canTransitionStatus(profileName, 'PROSPECT', 'SITE_VISIT_SCHEDULED')
              ? 'Site Visit Scheduled'
              : undefined,
        });
      }

      await tx.auditLog.create({
        data: {
          tenantId,
          userId,
          leadId: data.leadId,
          action: 'SITE_VISIT_CREATED',
          objectType: 'SiteVisit',
          objectId: siteVisit.id,
          newValues: { leadId: data.leadId, scheduledAt: data.scheduledAt, siteVisitNumber },
        },
      });
      await appendLeadProcessNote(tx, {
        tenantId,
        leadId: data.leadId,
        userId,
        content: `Site visit ${siteVisitStatus.toLowerCase()}: ${siteVisitNumber}\nScheduled: ${formatCRMDateTime(new Date(data.scheduledAt), await getTenantTimezone(tenantId))}${data.notes ? `\nNotes: ${data.notes}` : ''}`,
      });
      return tx.siteVisit.findUniqueOrThrow({
        where: { id: siteVisit.id },
        include: {
          lead: { select: { id: true, firstName: true, lastName: true } },
          project: { select: { id: true, name: true } },
          assignee: { select: { id: true, firstName: true, lastName: true } },
        },
      });
    });

    res.status(201).json({ success: true, data: result });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ success: false, error: error.errors[0].message });
    }
    if (error instanceof Error && error.message === 'PROJECT_NOT_AVAILABLE') {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }
    if (error instanceof Error && ['SVC_QUEUE_NOT_CONFIGURED', 'NO_ELIGIBLE_SVC_MEMBER', 'SVC_ASSIGNEE_NOT_ELIGIBLE'].includes(error.message)) {
      return res.status(409).json({ success: false, error: 'No eligible SVC owner is configured for this project.' });
    }
    console.error('Create site visit error:', error);
    res.status(500).json({ success: false, error: 'Failed to create site visit' });
  }
});

router.put('/:id', authorize('SiteVisit', 'edit'), async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const { id: userId } = req.user!;

    const existing = await prisma.siteVisit.findFirst({
      where: { id: req.params.id, tenantId },
      include: {
        lead: { select: { id: true, status: true, source: true, leadSubSource: true, rating: true } },
      },
    });

    if (!existing) {
      return res.status(404).json({ success: false, error: 'Site visit not found' });
    }
    if (!(await canAccessSiteVisit(req.user!, existing))) {
      return res.status(403).json({ success: false, error: 'You do not have access to this site visit' });
    }
    if (existing.status !== 'SCHEDULED') {
      return res.status(400).json({ success: false, error: 'Historical site visits cannot be edited' });
    }

    const data = updateSiteVisitSchema.parse(req.body);
    if (data.scheduledAt) {
      const scheduledDate = new Date(data.scheduledAt);
      if (Number.isNaN(scheduledDate.getTime()) || scheduledDate.getTime() <= Date.now()) {
        return res.status(400).json({ success: false, error: SITE_VISIT_FUTURE_TIME_ERROR });
      }
    }
    if (data.visitType && !(SITE_VISIT_TYPE_OPTIONS as readonly string[]).includes(data.visitType)) {
      return res.status(400).json({ success: false, error: 'Site visit type is required' });
    }
    if (data.customFields) {
      await prisma.$transaction((tx) =>
        ensureSiteVisitScheduleFields(tx, tenantId, req.user!.id),
      );
      const customFieldError = await validateObjectCustomFields(
        tenantId,
        'SiteVisit',
        data.customFields,
        false,
      );
      if (customFieldError) {
        return res.status(400).json({ success: false, error: customFieldError });
      }
      const storedCustomFields = existing.customFields;
      data.customFields = {
        ...(storedCustomFields && typeof storedCustomFields === 'object' && !Array.isArray(storedCustomFields)
          ? storedCustomFields as Record<string, unknown>
          : {}),
        ...data.customFields,
      };
    }
    if (data.status === 'COMPLETED') {
      return res.status(400).json({ success: false, error: 'Use the completion action to complete a site visit.' });
    }
    if (data.status === 'CANCELLED') {
      return res.status(400).json({ success: false, error: 'Use the cancel action to cancel a site visit.' });
    }
    if (data.leadId && data.leadId !== existing.leadId && !(await canAccessLeadId(req.user!, data.leadId))) {
      return res.status(403).json({ success: false, error: 'You do not have access to the linked lead' });
    }

    const updateData: Record<string, unknown> = { ...data };
    if (data.scheduledAt) updateData.scheduledAt = new Date(data.scheduledAt);
    if (data.customFields) updateData.customFields = data.customFields as Prisma.InputJsonObject;

    const projectChanged = !!data.projectId && data.projectId !== existing.projectId;
    if (projectChanged) {
      delete updateData.assigneeId;
      delete updateData.queueId;
      updateData.queueId = null;
    }

    const siteVisit = await prisma.$transaction(async (tx) => {
      const updated = await tx.siteVisit.update({
        where: { id: req.params.id },
        data: updateData,
      });

      let projectName: string | undefined;
      if (projectChanged && data.projectId) {
        const project = await tx.project.findFirst({
          where: { id: data.projectId, tenantId, isActive: true },
          select: { id: true, name: true },
        });
        if (!project) throw new Error('PROJECT_NOT_AVAILABLE');
        projectName = project.name;
      }
      if (existing.status === 'SCHEDULED' && (projectChanged || data.assigneeId)) {
        await assignSiteVisitToSVCInTransaction(tx, {
          siteVisitId: updated.id,
          tenantId,
          actorId: userId,
          requestedAssigneeId: data.assigneeId,
        });
      }
      await tx.auditLog.create({
        data: {
          tenantId,
          userId,
          leadId: updated.leadId,
          action: data.scheduledAt ? 'SITE_VISIT_RESCHEDULED' : 'SITE_VISIT_UPDATED',
          objectType: 'SiteVisit',
          objectId: updated.id,
          oldValues: {
            status: existing.status,
            scheduledAt: existing.scheduledAt,
            projectId: existing.projectId,
            assigneeId: existing.assigneeId,
          },
          newValues: {
            scheduledAt: updated.scheduledAt,
            status: updated.status,
            projectId: updated.projectId,
            assigneeId: updated.assigneeId,
            notes: updated.notes,
          },
        },
      });
      await appendLeadProcessNote(tx, {
        tenantId,
        leadId: updated.leadId,
        userId,
        content: data.scheduledAt
          ? `Site visit rescheduled: ${updated.siteVisitNumber}\nNew schedule: ${formatCRMDateTime(new Date(data.scheduledAt), await getTenantTimezone(tenantId))}${data.notes ? `\nNotes: ${data.notes}` : ''}`
          : `Site visit updated: ${updated.siteVisitNumber}${data.notes ? `\nNotes: ${data.notes}` : ''}`,
      });
      if (existing.leadId !== updated.leadId) {
        await appendLeadProcessNote(tx, {
          tenantId,
          leadId: existing.leadId,
          userId,
          content: `Site visit ${updated.siteVisitNumber} was moved to another lead.`,
        });
      }
      const affectedLeadIds = new Set([existing.leadId, updated.leadId]);
      if (data.scheduledAt || projectChanged || updated.leadId !== existing.leadId) {
        if (!projectName && updated.leadId !== existing.leadId) {
          projectName = updated.projectId
            ? (await tx.project.findFirst({
                where: { id: updated.projectId, tenantId },
                select: { name: true },
              }))?.name
            : undefined;
        }
        for (const leadId of affectedLeadIds) {
          await tagLeadSiteVisitEvents(tx, {
            tenantId,
            leadId,
            scheduledAt: updated.leadId === leadId ? updated.scheduledAt : undefined,
            projectName: updated.leadId === leadId ? projectName : undefined,
          });
        }
      }

      return tx.siteVisit.findUniqueOrThrow({
        where: { id: req.params.id },
        include: {
          project: { select: { id: true, name: true } },
          assignee: { select: { id: true, firstName: true, lastName: true } },
        },
      });
    });

    res.json({
      success: true,
      data: presentSiteVisitStatus(siteVisit, Boolean(data.scheduledAt)),
    });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ success: false, error: error.errors[0].message });
    }
    if (error instanceof Error && error.message === 'PROJECT_NOT_AVAILABLE') {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }
    if (error instanceof Error && ['SVC_QUEUE_NOT_CONFIGURED', 'NO_ELIGIBLE_SVC_MEMBER', 'SVC_ASSIGNEE_NOT_ELIGIBLE'].includes(error.message)) {
      return res.status(409).json({ success: false, error: 'No eligible SVC owner is configured for this project.' });
    }
    console.error('Update site visit error:', error);
    res.status(500).json({ success: false, error: 'Failed to update site visit' });
  }
});

router.post('/:id/complete', async (req: AuthRequest, res: Response) => {
  if (!req.user?.isAdmin && !req.user?.isSuperAdmin) {
    return res.status(403).json({ success: false, error: 'Only an admin can complete a site visit' });
  }
  try {
    const tenantId = req.tenantId!;
    const userId = req.user.id;
    const parsed = adminCompleteSiteVisitSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.errors[0]?.message || 'Completion details are required' });
    }
    const completedAt = parseCompletedAt(parsed.data.completedAt);
    const existing = await prisma.siteVisit.findFirst({
      where: { id: req.params.id, tenantId },
      include: { lead: { select: { id: true, status: true } } },
    });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Site visit not found' });
    }
    const rescheduledIds = await getRescheduledSiteVisitIds(tenantId, [existing.id]);
    assertVisitCanBeCompleted(existing, rescheduledIds.has(existing.id));
    const actor = await prisma.user.findFirst({
      where: { id: userId },
      select: { firstName: true, lastName: true, profile: { select: { name: true } } },
    });
    if (!actor) {
      return res.status(401).json({ success: false, error: 'Authenticated user is no longer available' });
    }
    const actorName = `${actor.firstName} ${actor.lastName}`.trim();
    const profileName = actor.profile?.name || req.user.profileName || actorName;

    const result = await prisma.$transaction(async (tx) => {
      const applied = await applySiteVisitCompletion(tx, existing, {
        tenantId,
        siteVisitId: existing.id,
        userId,
        actorName,
        profileName,
        completedAt,
        rating: parsed.data.rating,
        feedback: parsed.data.feedback,
        minimumBudget: parsed.data.minimumBudget,
        maximumBudget: parsed.data.maximumBudget,
        propertyType: parsed.data.propertyType,
        bedroomPreference: parsed.data.bedroomPreference,
        rescheduled: rescheduledIds.has(existing.id),
      });
      if (!applied.idempotent) {
        await appendLeadProcessNote(tx, {
          tenantId,
          leadId: existing.leadId,
          userId,
          content: `Site visit completed: ${applied.siteVisit.siteVisitNumber}\nCompleted: ${formatCRMDateTime(completedAt, await getTenantTimezone(tenantId))}\nRating: ${parsed.data.rating}\nFeedback: ${parsed.data.feedback.trim()}`,
        });
        await tagLeadSiteVisitEvents(tx, {
          tenantId,
          leadId: existing.leadId,
          leadStatus: applied.leadStatus === 'SITE_VISIT_HAPPENED' ? 'Site Visit Completed' : undefined,
          feedback: parsed.data.feedback.trim(),
        });
        if (applied.leadStatus === 'SITE_VISIT_HAPPENED' && existing.lead?.status !== 'SITE_VISIT_HAPPENED') {
          await assignCompletedSiteVisitToSalesInTransaction(tx, existing.id, tenantId);
        }
      }
      return applied;
    });

    res.json({
      success: true,
      data: {
        ...presentSiteVisitStatus(result.siteVisit, false),
        leadStatus: result.leadStatus,
      },
    });
  } catch (error) {
    if (error instanceof CompleteSiteVisitError) {
      return res.status(error.status).json({ success: false, error: error.message });
    }
    console.error('Admin complete site visit error:', error);
    res.status(500).json({ success: false, error: 'Failed to complete site visit' });
  }
});

router.patch('/:id/complete', authorize('SiteVisit', 'edit'), async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const { id: userId } = req.user!;
    const parsed = completeSiteVisitSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.errors[0]?.message || 'Completion details are required' });
    }
    const { completedAt, customerFeedback, completionNotes } = parsed.data;

    const existing = await prisma.siteVisit.findFirst({
      where: { id: req.params.id, tenantId },
      include: {
        lead: {
          select: {
            id: true,
            status: true,
            source: true,
            leadSubSource: true,
            rating: true,
            owner: { select: { profile: { select: { name: true } } } },
          },
        },
      },
    });

    if (!existing) {
      return res.status(404).json({ success: false, error: 'Site visit not found' });
    }

    if (!(await canAccessSiteVisit(req.user!, existing))) {
      return res.status(403).json({ success: false, error: 'You do not have access to this site visit' });
    }

    if (existing.status !== 'SCHEDULED') {
      return res.status(400).json({ success: false, error: 'Only scheduled site visits can be completed' });
    }
    const profileName = req.user!.profileName || 'Admin';
    const canConfirmSiteVisit =
      req.user!.isSuperAdmin ||
      ['GRE', 'Admin', 'CRM Admin', 'Manager'].includes(profileName);
    if (!canConfirmSiteVisit) {
      return res.status(403).json({
        success: false,
        error: 'Only GRE or admin users can confirm that a site visit happened',
      });
    }
    if (
      existing.lead &&
      existing.lead.status === 'SITE_VISIT_SCHEDULED' &&
      !req.user!.isSuperAdmin &&
      !canTransitionStatus(profileName, 'SITE_VISIT_SCHEDULED', 'SITE_VISIT_HAPPENED')
    ) {
      return res.status(403).json({ success: false, error: 'Not authorized to complete this site visit' });
    }

    const completedBy = await prisma.user.findFirst({
      where: { id: userId, tenantId },
      select: { firstName: true, lastName: true },
    });
    if (!completedBy) {
      return res.status(401).json({ success: false, error: 'Authenticated user is no longer available' });
    }
    const completedByName = `${completedBy.firstName} ${completedBy.lastName}`.trim();

    const result = await prisma.$transaction(async (tx) => {
      const updateResult = await tx.siteVisit.updateMany({
        where: { id: req.params.id, tenantId, status: 'SCHEDULED' },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(completedAt),
          completedById: userId,
          customerFeedback: customerFeedback.trim(),
          completionNotes: completionNotes.trim(),
          feedback: customerFeedback.trim(),
        },
      });
      if (updateResult.count !== 1) {
        throw new SiteVisitCompletionConflict('This Site Visit has already been completed or changed. Refresh and try again.');
      }

      const siteVisit = await tx.siteVisit.findFirst({
        where: { id: req.params.id, tenantId },
        include: {
          completedBy: { select: { id: true, firstName: true, lastName: true } },
          project: { select: { id: true, name: true } },
        },
      });
      if (!siteVisit) throw new Error('Completed Site Visit could not be loaded.');

      let leadStatus = existing.lead?.status || null;
      let leadStatusTag: string | undefined;
      if (existing.lead && existing.lead.status === 'SITE_VISIT_SCHEDULED') {
        const lead = await tx.lead.update({
          where: { id: existing.leadId },
          data: { status: 'SITE_VISIT_HAPPENED' },
          select: { status: true },
        });
        leadStatus = lead.status;
        leadStatusTag = 'Site Visit Completed';

        await tx.auditLog.create({
          data: {
            tenantId,
            userId,
            leadId: existing.leadId,
            action: 'SITE_VISIT_COMPLETED',
            objectType: 'Lead',
            objectId: existing.leadId,
            oldValues: { status: 'SITE_VISIT_SCHEDULED' },
            newValues: {
              status: 'SITE_VISIT_HAPPENED',
              siteVisitId: existing.id,
              completedAt,
              completedById: userId,
              completedByName,
              customerFeedback,
              completionNotes,
            },
          },
        });
      }
      await tagLeadSiteVisitEvents(tx, {
        tenantId,
        leadId: existing.leadId,
        leadStatus: leadStatusTag,
        feedback: customerFeedback,
      });

      await tx.auditLog.create({
        data: {
          tenantId,
          userId,
          leadId: existing.leadId,
          action: 'SITE_VISIT_COMPLETED',
          objectType: 'SiteVisit',
          objectId: siteVisit.id,
          oldValues: { status: 'SCHEDULED' },
          newValues: {
            status: 'COMPLETED',
            completedAt,
            completedById: userId,
            completedByName,
            customerFeedback,
            completionNotes,
          },
        },
      });
      await appendLeadProcessNote(tx, {
        tenantId,
        leadId: existing.leadId,
        userId,
        content: `Site visit completed: ${siteVisit.siteVisitNumber}\nCompleted: ${formatCRMDateTime(new Date(completedAt), await getTenantTimezone(tenantId))}\nCustomer feedback: ${customerFeedback.trim()}\nCompletion notes: ${completionNotes.trim()}`,
      });

      const salesHandoff = await assignCompletedSiteVisitToSalesInTransaction(tx, siteVisit.id, tenantId);
      const updatedSiteVisit = await tx.siteVisit.findUniqueOrThrow({
        where: { id: siteVisit.id },
        include: {
          assignee: { select: { id: true, firstName: true, lastName: true } },
          project: { select: { id: true, name: true } },
          completedBy: { select: { id: true, firstName: true, lastName: true } },
        },
      });
      const updatedLead = await tx.lead.findUniqueOrThrow({
        where: { id: existing.leadId },
        include: { owner: { select: { id: true, firstName: true, lastName: true } } },
      });
      return { siteVisit: updatedSiteVisit, lead: updatedLead, leadStatus, salesHandoff };
    });

    res.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof SiteVisitCompletionConflict) {
      return res.status(409).json({ success: false, error: error.message });
    }
    console.error('Complete site visit error:', error);
    res.status(500).json({ success: false, error: 'Failed to complete site visit' });
  }
});

router.post('/:id/retry-sales-assignment', authorize('SiteVisit', 'edit'), async (req: AuthRequest, res: Response) => {
  if (!req.user!.isAdmin && !req.user!.isSuperAdmin && req.user!.profileName !== 'CRM Admin') {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }
  try {
    const result = await prisma.$transaction((tx) =>
      assignCompletedSiteVisitToSalesInTransaction(tx, req.params.id, req.tenantId!),
    );
    if (result.pendingReason) {
      return res.status(409).json({ success: false, error: result.pendingReason, data: result });
    }
    res.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof Error && error.message === 'SITE_VISIT_NOT_FOUND') {
      return res.status(404).json({ success: false, error: 'Site visit not found' });
    }
    if (error instanceof Error && error.message === 'SITE_VISIT_NOT_GRE_COMPLETED') {
      return res.status(409).json({ success: false, error: 'Only a completed GRE visit can be assigned to Sales' });
    }
    console.error('Retry Sales assignment error:', error);
    res.status(500).json({ success: false, error: 'Failed to retry Sales assignment' });
  }
});

router.patch('/:id/cancel', authorize('SiteVisit', 'edit'), async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const { id: userId } = req.user!;
    const parsed = cancelSiteVisitSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.errors[0]?.message || 'Reason is required' });
    }
    const reason = parsed.data.reason.trim();

    const existing = await prisma.siteVisit.findFirst({
      where: { id: req.params.id, tenantId },
      include: { lead: { select: { id: true, status: true, ownerId: true } } },
    });

    if (!existing) {
      return res.status(404).json({ success: false, error: 'Site visit not found' });
    }

    if (!(await canAccessSiteVisit(req.user!, existing))) {
      return res.status(403).json({ success: false, error: 'You do not have access to this site visit' });
    }

    if (existing.status !== 'SCHEDULED') {
      return res.status(400).json({ success: false, error: 'Only scheduled site visits can be cancelled' });
    }

    const profileName = req.user!.profileName || 'Admin';
    if (
      existing.lead &&
      existing.lead.status === 'SITE_VISIT_SCHEDULED' &&
      !canTransitionStatus(profileName, 'SITE_VISIT_SCHEDULED', 'PROSPECT')
    ) {
      return res.status(403).json({ success: false, error: 'Not authorized to cancel this site visit' });
    }

    const result = await prisma.$transaction(async (tx) => {
      const siteVisit = await tx.siteVisit.update({
        where: { id: req.params.id },
        data: { status: 'CANCELLED', cancellationReason: reason, cancelledAt: new Date(), cancelledById: userId },
      });
      await tagLeadSiteVisitEvents(tx, {
        tenantId,
        leadId: existing.leadId,
      });

      if (existing.lead && existing.lead.status === 'SITE_VISIT_SCHEDULED') {
        const otherScheduled = await tx.siteVisit.count({
          where: {
            tenantId,
            leadId: existing.leadId,
            status: 'SCHEDULED',
            id: { not: existing.id },
          },
        });
        if (otherScheduled === 0) {
          await tx.lead.update({
            where: { id: existing.leadId },
            data: { status: 'PROSPECT' },
          });
          await tx.auditLog.create({
            data: {
              tenantId,
              userId,
              leadId: existing.leadId,
              action: 'SITE_VISIT_CANCELLED',
              objectType: 'Lead',
              objectId: existing.leadId,
              oldValues: { status: 'SITE_VISIT_SCHEDULED' },
              newValues: { status: 'PROSPECT', siteVisitId: existing.id, reason },
            },
          });
        }
      }

      await tx.auditLog.create({
        data: {
          tenantId,
          userId,
          leadId: existing.leadId,
          action: 'SITE_VISIT_CANCELLED',
          objectType: 'SiteVisit',
          objectId: siteVisit.id,
          oldValues: { status: 'SCHEDULED' },
          newValues: { status: 'CANCELLED', cancellationReason: reason, cancelledById: userId, cancelledAt: new Date().toISOString() },
        },
      });
      await appendLeadProcessNote(tx, {
        tenantId,
        leadId: existing.leadId,
        userId,
        content: `Site visit cancelled: ${siteVisit.siteVisitNumber}\nReason: ${reason}`,
      });

      return siteVisit;
    });

    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Cancel site visit error:', error);
    res.status(500).json({ success: false, error: 'Failed to cancel site visit' });
  }
});

router.post('/:id/revisit', authorize('SiteVisit', 'create'), async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const { id: userId } = req.user!;
    const parsed = revisitSiteVisitSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.errors[0]?.message || 'Required site visit fields are missing' });
    }
    const reason = parsed.data.reason?.trim() || 'Revisit scheduled';

    const existing = await prisma.siteVisit.findFirst({
      where: { id: req.params.id, tenantId },
      include: {
        lead: {
          select: {
            id: true,
            status: true,
            ownerId: true,
            source: true,
            leadSubSource: true,
            rating: true,
          },
        },
        project: { select: { id: true } },
      },
    });

    if (!existing) {
      return res.status(404).json({ success: false, error: 'Site visit not found' });
    }
    if (!['COMPLETED', 'CANCELLED'].includes(existing.status)) {
      if (existing.status === 'SCHEDULED') {
        return res.status(400).json({ success: false, error: 'Scheduled site visits must be rescheduled in place.' });
      }
      return res.status(400).json({ success: false, error: 'Invalid site visit status' });
    }

    if (!(await canAccessSiteVisit(req.user!, existing))) {
      return res.status(403).json({ success: false, error: 'You do not have access to this site visit' });
    }

    const revisitScheduledAt = new Date(parsed.data.scheduledAt);
    if (Number.isNaN(revisitScheduledAt.getTime()) || revisitScheduledAt.getTime() <= Date.now()) {
      return res.status(400).json({ success: false, error: SITE_VISIT_FUTURE_TIME_ERROR });
    }

    const revisitNotes = parsed.data.notes?.trim()
      ? `${parsed.data.notes.trim()} (Revisit reason: ${reason})`
      : `Revisit reason: ${reason}`;

    const result = await prisma.$transaction(async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: parsed.data.projectId, tenantId, isActive: true },
        select: { id: true, name: true },
      });
      if (!project) throw new Error('PROJECT_NOT_AVAILABLE');

      await ensureSiteVisitScheduleFields(tx, tenantId, userId);
      const sameProject = existing.projectId === parsed.data.projectId;

      const siteVisitNumber = await getNextSiteVisitNumber(tx, tenantId);
      const siteVisit = await tx.siteVisit.create({
        data: {
          tenantId,
          leadId: existing.leadId,
          projectId: parsed.data.projectId,
          assigneeId: sameProject ? existing.assigneeId : null,
          creatorId: userId,
          queueId: sameProject ? existing.queueId : null,
          siteVisitNumber,
          previousSiteVisitId: existing.id,
          scheduledAt: new Date(parsed.data.scheduledAt),
          status: 'SCHEDULED',
          notes: revisitNotes,
          visitType: parsed.data.visitType,
          rating: null,
          transportRequired: null,
          customFields: {
            schedule_call_summary_remarks: parsed.data.callSummaryRemarks || null,
            schedule_minimum_budget: parsed.data.minimumBudget,
            schedule_maximum_budget: parsed.data.maximumBudget,
            schedule_property_type: parsed.data.propertyType,
            schedule_bedroom_preference: parsed.data.bedroomPreference || [],
            schedule_rating: parsed.data.rating || null,
            schedule_transport: parsed.data.transport || null,
          },
        },
        include: {
          lead: { select: { id: true, firstName: true, lastName: true } },
          project: { select: { id: true, name: true } },
          previousSiteVisit: { select: { id: true, status: true, scheduledAt: true, siteVisitNumber: true } },
        },
      });

      if (!sameProject) {
        await assignSiteVisitToSVCInTransaction(tx, {
          siteVisitId: siteVisit.id,
          tenantId,
          actorId: userId,
        });
      }
      await tagLeadSiteVisitEvents(tx, {
        tenantId,
        leadId: existing.leadId,
        scheduledAt: new Date(parsed.data.scheduledAt),
        projectName: project.name,
      });

      await tx.auditLog.create({
        data: {
          tenantId,
          userId,
          leadId: existing.leadId,
          action: 'SITE_VISIT_REVISIT_CREATED',
          objectType: 'SiteVisit',
          objectId: siteVisit.id,
          oldValues: { previousSiteVisitId: existing.id, previousSiteVisitNumber: (existing as any).siteVisitNumber },
          newValues: {
            siteVisitNumber,
            reason,
            scheduledAt: parsed.data.scheduledAt,
            leadId: existing.leadId,
            projectId: parsed.data.projectId,
            assignedToSVCQueue: !sameProject,
          },
        },
      });
      await appendLeadProcessNote(tx, {
        tenantId,
        leadId: existing.leadId,
        userId,
        content: `Site visit revisit scheduled: ${siteVisitNumber}\nScheduled: ${formatCRMDateTime(revisitScheduledAt, await getTenantTimezone(tenantId))}\nReason: ${reason}`,
      });

      return tx.siteVisit.findUniqueOrThrow({
        where: { id: siteVisit.id },
        include: {
          lead: { select: { id: true, firstName: true, lastName: true } },
          project: { select: { id: true, name: true } },
          assignee: { select: { id: true, firstName: true, lastName: true } },
          previousSiteVisit: { select: { id: true, status: true, scheduledAt: true, siteVisitNumber: true } },
        },
      });
    });

    res.status(201).json({ success: true, data: result });
  } catch (error) {
    if (error instanceof Error && error.message === 'PROJECT_NOT_AVAILABLE') {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }
    if (error instanceof Error && error.message === 'SVC_QUEUE_NOT_CONFIGURED') {
      return res.status(409).json({ success: false, error: 'No matching SVC Round Robin queue is configured for the selected project and lead criteria.' });
    }
    if (error instanceof Error && error.message === 'NO_ELIGIBLE_SVC_MEMBER') {
      return res.status(409).json({ success: false, error: 'The selected project SVC Round Robin queue has no eligible members.' });
    }
    console.error('Revisit site visit error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create revisit site visit',
    });
  }
});

router.delete('/:id', authorize('SiteVisit', 'delete'), async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const { id: userId } = req.user!;

    const existing = await prisma.siteVisit.findFirst({
      where: { id: req.params.id, tenantId },
    });

    if (!existing) {
      return res.status(404).json({ success: false, error: 'Site visit not found' });
    }

    if (!(await canAccessSiteVisit(req.user!, existing))) {
      return res.status(403).json({ success: false, error: 'You do not have access to this site visit' });
    }

    await prisma.$transaction(async (tx) => {
      await tx.auditLog.create({
        data: {
          tenantId,
          userId,
          leadId: existing.leadId,
          action: 'DELETE',
          objectType: 'SiteVisit',
          objectId: existing.id,
          oldValues: existing,
        },
      });
      await appendLeadProcessNote(tx, {
        tenantId,
        leadId: existing.leadId,
        userId,
        content: `Site visit deleted: ${existing.siteVisitNumber}`,
      });
      await tx.siteVisit.delete({ where: { id: req.params.id } });
    });

    res.json({ success: true, data: null });
  } catch (error) {
    console.error('Delete site visit error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete site visit' });
  }
});

export default router;