import { Router, Response } from 'express';
import { prisma } from '@dct-crm/db';
import { crmDateRangeBounds, formatCRMDateTime, followUpSchema } from '@dct-crm/shared';
import { futureFollowUpError, getNextFollowUpNumber, presentFollowUp, resolveFollowUpLinks } from '../services/followUpService';
import { authenticate, AuthRequest } from '../middleware/auth';
import { listOrderBy, listViewConstraint, mergeListWhere } from '../services/listViewService';
import { authorize } from '../middleware/authorization';
import { canAccessLeadId } from '../services/recordAccess';
import { followUpAccessWhere } from '../services/followUpAccess';
import { normalizeOverdueFollowUps, promoteNewLeadOnFirstActivity } from '../services/leadWorkflowExtras';
import { tagLeadFollowUpEvents } from '../services/leadEventTagging';
import { appendLeadProcessNote } from '../services/leadNotes';
import { getTenantTimezone } from '../services/tenantTimezone';

const router = Router();

router.use(authenticate);

router.get('/', authorize('FollowUp', 'read'), async (req: AuthRequest, res: Response) => {
  try {
    await normalizeOverdueFollowUps(req.tenantId!);
    const { page = 1, limit = 20, isCompleted, status, leadId, ownerId, search, startDate, endDate } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const access = followUpAccessWhere(req.user!, req.tenantId!);
    const filters: any = {};
    if (isCompleted !== undefined) filters.isCompleted = isCompleted === 'true';
    if (status === 'MISSED') filters.isMissed = true;
    if (status === 'COMPLETED') filters.isCompleted = true;
    if (status === 'SCHEDULED' || status === 'OPEN') {
      filters.isCompleted = false;
      filters.isMissed = false;
      filters.status = { not: 'CANCELLED' };
    }
    if (status === 'CANCELLED') filters.status = 'CANCELLED';
    if (leadId) filters.leadId = leadId;
    if (ownerId) filters.ownerId = ownerId;
    if (search) {
      const contains = { contains: search as string, mode: 'insensitive' as const };
      filters.OR = [
        { title: contains },
        { subject: contains },
        { description: contains },
        { followUpNumber: contains },
      ];
    }
    if (startDate || endDate) {
      const range = crmDateRangeBounds(
        startDate ? String(startDate) : undefined,
        endDate ? String(endDate) : undefined,
        await getTenantTimezone(req.tenantId!),
      );
      if ('error' in range) {
        return res.status(400).json({ success: false, error: range.error });
      }
      if (range.gte || range.lt) filters.dueDate = range;
    }
    const where: any = { AND: [access, filters] };
    const viewConstraint = await listViewConstraint(req, 'FOLLOW_UP');
    if (!viewConstraint.ok) return res.status(viewConstraint.status).json({ success: false, error: viewConstraint.error });
    mergeListWhere(where, viewConstraint.where);
    const sorted = typeof req.query.sortBy === 'string' && req.query.sortBy
      ? listOrderBy('FOLLOW_UP', req.query.sortBy, req.query.sortOrder || 'asc')
      : { ok: true as const, orderBy: null };
    if (!sorted.ok) return res.status(400).json({ success: false, error: sorted.error });
    const orderBy = sorted.orderBy || (req.query.statusOrder === 'true'
      ? [{ isCompleted: 'asc' as const }, { isMissed: 'asc' as const }, { dueDate: 'asc' as const }]
      : { dueDate: 'asc' as const });

    const [followUps, total] = await Promise.all([
      prisma.followUp.findMany({
        where,
        include: {
          owner: { select: { id: true, firstName: true, lastName: true, profile: { select: { name: true } } } },
          assignedTo: { select: { id: true, firstName: true, lastName: true } },
          enquiry: { select: { id: true, enquiryNumber: true } },
          booking: { select: { id: true, bookingNumber: true } },
          lead: { select: { id: true, firstName: true, lastName: true, phone: true, mobile: true, source: true, status: true, createdAt: true } },
        },
        skip,
        take: Number(limit),
        orderBy,
      }),
      prisma.followUp.count({ where }),
    ]);

    res.json({
      success: true,
      data: followUps.map((followUp) => presentFollowUp(followUp)),
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error) {
    console.error('Get follow-ups error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch follow-ups' });
  }
});

router.get('/my', authorize('FollowUp', 'read'), async (req: AuthRequest, res: Response) => {
  try {
    await normalizeOverdueFollowUps(req.tenantId!);
    const { page = 1, limit = 20, isCompleted, status, sortBy = 'dueDate', sortOrder = 'asc' } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const where: any = { AND: [followUpAccessWhere(req.user!, req.tenantId!), { ownerId: req.user!.id }] };
    if (isCompleted !== undefined) where.isCompleted = isCompleted === 'true';
    if (status === 'MISSED') where.isMissed = true;
    if (status === 'COMPLETED') where.isCompleted = true;
    if (status === 'SCHEDULED' || status === 'OPEN') {
      where.isCompleted = false;
      where.isMissed = false;
      where.status = { not: 'CANCELLED' };
    }
    if (status === 'CANCELLED') where.status = 'CANCELLED';

    const [followUps, total] = await Promise.all([
      prisma.followUp.findMany({
        where,
        include: {
          lead: { select: { id: true, firstName: true, lastName: true, phone: true } },
        },
        skip,
        take: Number(limit),
        orderBy: { [sortBy as string]: sortOrder },
      }),
      prisma.followUp.count({ where }),
    ]);

    res.json({
      success: true,
      data: followUps.map((followUp) => presentFollowUp(followUp)),
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error) {
    console.error('Get my follow-ups error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch follow-ups' });
  }
});

router.get('/:id', authorize('FollowUp', 'read'), async (req: AuthRequest, res: Response) => {
  try {
    await normalizeOverdueFollowUps(req.tenantId!);
    const followUp = await prisma.followUp.findFirst({
      where: { id: req.params.id, ...followUpAccessWhere(req.user!, req.tenantId!) },
      include: {
        owner: { select: { id: true, firstName: true, lastName: true, email: true, profile: { select: { name: true } } } },
        assignedTo: { select: { id: true, firstName: true, lastName: true, email: true } },
        enquiry: { select: { id: true, enquiryNumber: true, leadId: true } },
        booking: { select: { id: true, bookingNumber: true, leadId: true } },
        lead: {
          select: {
            id: true,
            leadNumber: true,
            firstName: true,
            lastName: true,
            company: true,
            phone: true,
            mobile: true,
            secondaryPhone: true,
            email: true,
            status: true,
            source: true,
            createdAt: true,
          },
        },
      },
    });

    if (!followUp) {
      return res.status(404).json({ success: false, error: 'Follow-up not found' });
    }

    const history = await prisma.auditLog.findMany({
      where: { tenantId: req.tenantId!, objectType: 'FollowUp', objectId: followUp.id },
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    const earlier = followUp.leadId
      ? await prisma.followUp.findMany({
          where: {
            ...followUpAccessWhere(req.user!, req.tenantId!),
            leadId: followUp.leadId,
            dueDate: { lt: followUp.dueDate },
            id: { not: followUp.id },
          },
          orderBy: { dueDate: 'desc' },
          take: 8,
          select: { followUpNumber: true, dueDate: true, status: true, title: true },
        })
      : [];
    res.json({
      success: true,
      data: presentFollowUp(
        { ...followUp, history },
        {
          followupDateBefore: earlier[0]?.dueDate || null,
          pastScheduleFollowUps: earlier.length
            ? earlier.map((item) => `${item.followUpNumber} ${item.dueDate.toISOString()} ${item.status}`).join('; ')
            : null,
        },
      ),
    });
  } catch (error) {
    console.error('Get follow-up error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch follow-up' });
  }
});

router.post('/', authorize('FollowUp', 'create'), async (req: AuthRequest, res: Response) => {
  try {
    const data = followUpSchema.parse(req.body);
    const scheduleError = data.status === 'CANCELLED' ? null : futureFollowUpError(data.dueDate);
    if (scheduleError) return res.status(400).json({ success: false, error: scheduleError });
    const links = await resolveFollowUpLinks(prisma, req.tenantId!, data);
    if ('error' in links) return res.status(400).json({ success: false, error: links.error });

    if (links.leadId && !(await canAccessLeadId(req.user!, links.leadId))) {
      return res.status(403).json({ success: false, error: 'You do not have access to the linked lead' });
    }
    const ownerId = data.ownerId || req.user!.id;
    const activeOwner = await prisma.user.findFirst({
      where: { id: ownerId, tenantId: req.tenantId!, isActive: true },
      select: { id: true },
    });
    if (!activeOwner) {
      return res.status(400).json({ success: false, error: 'Assigned user is not active in this company' });
    }

    const followUp = await prisma.$transaction(async (tx) => {
      const followUpNumber = await getNextFollowUpNumber(tx, req.tenantId!);
      const created = await tx.followUp.create({
        data: {
          tenantId: req.tenantId!,
          followUpNumber,
          ownerId,
          title: data.title,
          subject: data.subject || null,
          description: data.description,
          comments: data.comments || null,
          previousDisposition: data.previousDisposition || null,
          cancelledReason: data.cancelledReason || null,
          dueDate: new Date(data.dueDate),
          isMissed: false,
          missedAt: null,
          status: data.status || 'SCHEDULED',
          awaitedFollowUp: data.awaitedFollowUp || false,
          isSystemCancelled: data.isSystemCancelled || false,
          testCheckbox: data.testCheckbox || false,
          leadId: links.leadId || undefined,
          enquiryId: links.enquiryId || undefined,
          bookingId: links.bookingId || undefined,
          assignedToId: data.assignedToId || ownerId,
        },
        include: {
          owner: { select: { id: true, firstName: true, lastName: true } },
          lead: { select: { id: true, firstName: true, lastName: true } },
        },
      });

      if (links.leadId) {
        await promoteNewLeadOnFirstActivity(tx, {
          tenantId: req.tenantId!,
          leadId: links.leadId,
          userId: req.user!.id,
          profileName: req.user!.profileName,
          activityLabel: 'Follow-up',
        });
        await tagLeadFollowUpEvents(tx, req.tenantId!, links.leadId);
        const dueDateLabel = formatCRMDateTime(new Date(data.dueDate), await getTenantTimezone(req.tenantId!));
        await appendLeadProcessNote(tx, {
          tenantId: req.tenantId!,
          leadId: links.leadId,
          userId: req.user!.id,
          content: [
            `Follow-up scheduled: ${created.followUpNumber} · ${created.title}`,
            `Due: ${dueDateLabel}`,
            created.description && created.description !== created.title ? `Note: ${created.description}` : null,
          ].filter(Boolean).join('\n'),
        });
      }

      await tx.auditLog.create({
        data: {
          tenantId: req.tenantId!,
          userId: req.user!.id,
          leadId: links.leadId || undefined,
          action: 'FOLLOW_UP_CREATED',
          objectType: 'FollowUp',
          objectId: created.id,
          newValues: { ...data, followUpNumber },
        },
      });

      return created;
    });

    res.status(201).json({ success: true, data: followUp });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ success: false, error: error.errors[0].message });
    }
    console.error('Create follow-up error:', error);
    res.status(500).json({ success: false, error: 'Failed to create follow-up' });
  }
});

router.put('/:id', authorize('FollowUp', 'edit'), async (req: AuthRequest, res: Response) => {
  try {
    const existingFollowUp = await prisma.followUp.findFirst({
      where: { id: req.params.id, ...followUpAccessWhere(req.user!, req.tenantId!) },
    });

    if (!existingFollowUp) {
      return res.status(404).json({ success: false, error: 'Follow-up not found' });
    }

    const data = followUpSchema.partial().parse(req.body);
    if (data.dueDate) {
      const scheduleError = futureFollowUpError(data.dueDate);
      if (scheduleError) return res.status(400).json({ success: false, error: scheduleError });
    }
    if (data.leadId && data.leadId !== existingFollowUp.leadId && !(await canAccessLeadId(req.user!, data.leadId))) {
      return res.status(403).json({ success: false, error: 'You do not have access to the linked lead' });
    }
    if (data.ownerId) {
      const activeOwner = await prisma.user.findFirst({
        where: { id: data.ownerId, tenantId: req.tenantId!, isActive: true },
        select: { id: true },
      });
      if (!activeOwner) {
        return res.status(400).json({ success: false, error: 'Assigned user is not active in this company' });
      }
    }

    const links = await resolveFollowUpLinks(prisma, req.tenantId!, {
      leadId: data.leadId ?? existingFollowUp.leadId,
      enquiryId: data.enquiryId === undefined ? existingFollowUp.enquiryId : data.enquiryId,
      bookingId: data.bookingId === undefined ? existingFollowUp.bookingId : data.bookingId,
    });
    if ('error' in links) return res.status(400).json({ success: false, error: links.error });
    const updateData: any = { ...data, leadId: links.leadId, enquiryId: links.enquiryId, bookingId: links.bookingId };
    if (data.dueDate) updateData.dueDate = new Date(data.dueDate);
    if (data.status === 'COMPLETED') {
      updateData.isCompleted = true;
      updateData.completedAt = existingFollowUp.completedAt || new Date();
      updateData.isMissed = false;
      updateData.missedAt = null;
    } else if (data.status === 'CANCELLED') {
      updateData.isCompleted = false;
      updateData.isMissed = false;
      updateData.missedAt = null;
    } else if (data.dueDate || data.status === 'SCHEDULED') {
      const dueDate = data.dueDate ? new Date(data.dueDate) : existingFollowUp.dueDate;
      updateData.isMissed = !existingFollowUp.isCompleted && dueDate <= new Date();
      updateData.missedAt = updateData.isMissed ? new Date() : null;
      if (!data.status) updateData.status = updateData.isMissed ? 'MISSED' : 'SCHEDULED';
    }

    const followUp = await prisma.$transaction(async (tx) => {
      const updated = await tx.followUp.update({
        where: { id: req.params.id },
        data: updateData,
        include: {
          owner: { select: { id: true, firstName: true, lastName: true } },
          lead: { select: { id: true, firstName: true, lastName: true } },
        },
      });

      await tx.auditLog.create({
        data: {
          tenantId: req.tenantId!,
          userId: req.user!.id,
          leadId: existingFollowUp.leadId || undefined,
          action: 'UPDATE',
          objectType: 'FollowUp',
          objectId: updated.id,
          oldValues: existingFollowUp,
          newValues: data,
        },
      });
      if (existingFollowUp.leadId || updated.leadId) {
        for (const leadId of new Set([existingFollowUp.leadId, updated.leadId].filter((id): id is string => !!id))) {
          await appendLeadProcessNote(tx, {
            tenantId: req.tenantId!,
            leadId,
            userId: req.user!.id,
            content: `Follow-up updated: ${updated.title}${updated.isCompleted ? ' · Completed' : ''}`,
          });
        }
      }
      for (const leadId of new Set([existingFollowUp.leadId, updated.leadId].filter((id): id is string => !!id))) {
        await tagLeadFollowUpEvents(tx, req.tenantId!, leadId);
      }
      return updated;
    });

    res.json({ success: true, data: followUp });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ success: false, error: error.errors[0].message });
    }
    console.error('Update follow-up error:', error);
    res.status(500).json({ success: false, error: 'Failed to update follow-up' });
  }
});

router.delete('/:id', authorize('FollowUp', 'delete'), async (req: AuthRequest, res: Response) => {
  try {
    const followUp = await prisma.followUp.findFirst({
      where: { id: req.params.id, ...followUpAccessWhere(req.user!, req.tenantId!) },
    });

    if (!followUp) {
      return res.status(404).json({ success: false, error: 'Follow-up not found' });
    }

    await prisma.$transaction(async (tx) => {
      await tx.followUp.delete({ where: { id: req.params.id } });
      await tx.auditLog.create({
        data: {
          tenantId: req.tenantId!,
          userId: req.user!.id,
          leadId: followUp.leadId || undefined,
          action: 'DELETE',
          objectType: 'FollowUp',
          objectId: req.params.id,
          oldValues: followUp,
        },
      });
      if (followUp.leadId) {
        await appendLeadProcessNote(tx, {
          tenantId: req.tenantId!,
          leadId: followUp.leadId,
          userId: req.user!.id,
          content: `Follow-up deleted: ${followUp.title}`,
        });
        await tagLeadFollowUpEvents(tx, req.tenantId!, followUp.leadId);
      }
    });

    res.json({ success: true, message: 'Follow-up deleted successfully' });
  } catch (error) {
    console.error('Delete follow-up error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete follow-up' });
  }
});

router.put('/:id/complete', authorize('FollowUp', 'edit'), async (req: AuthRequest, res: Response) => {
  try {
    const followUp = await prisma.followUp.findFirst({
      where: { id: req.params.id, ...followUpAccessWhere(req.user!, req.tenantId!) },
    });

    if (!followUp) {
      return res.status(404).json({ success: false, error: 'Follow-up not found' });
    }

    if (followUp.isCompleted) {
      return res.status(400).json({ success: false, error: 'Follow-up is already completed' });
    }

    const updatedFollowUp = await prisma.$transaction(async (tx) => {
      const updated = await tx.followUp.update({
        where: { id: req.params.id },
        data: { isCompleted: true, completedAt: new Date(), isMissed: false, missedAt: null, status: 'COMPLETED', isSystemCancelled: false },
      });
      await tx.auditLog.create({
        data: {
          tenantId: req.tenantId!,
          userId: req.user!.id,
          leadId: followUp.leadId || undefined,
          action: 'STATUS_CHANGE',
          objectType: 'FollowUp',
          objectId: followUp.id,
          oldValues: { isCompleted: false, isMissed: followUp.isMissed },
          newValues: { isCompleted: true, isMissed: false },
        },
      });
      if (followUp.leadId) {
        await appendLeadProcessNote(tx, {
          tenantId: req.tenantId!,
          leadId: followUp.leadId,
          userId: req.user!.id,
          content: `Follow-up completed: ${followUp.title}`,
        });
        await tagLeadFollowUpEvents(tx, req.tenantId!, followUp.leadId);
      }
      return updated;
    });

    res.json({ success: true, data: updatedFollowUp });
  } catch (error) {
    console.error('Complete follow-up error:', error);
    res.status(500).json({ success: false, error: 'Failed to complete follow-up' });
  }
});

router.put('/:id/reopen', authorize('FollowUp', 'edit'), async (req: AuthRequest, res: Response) => {
  try {
    const followUp = await prisma.followUp.findFirst({
      where: { id: req.params.id, ...followUpAccessWhere(req.user!, req.tenantId!) },
    });

    if (!followUp) {
      return res.status(404).json({ success: false, error: 'Follow-up not found' });
    }

    if (!followUp.isCompleted) {
      return res.status(400).json({ success: false, error: 'Follow-up is not completed' });
    }

    const updatedFollowUp = await prisma.$transaction(async (tx) => {
      const updated = await tx.followUp.update({
        where: { id: req.params.id },
        data: {
          isCompleted: false,
          completedAt: null,
          isMissed: followUp.dueDate <= new Date(),
          missedAt: followUp.dueDate <= new Date() ? new Date() : null,
          status: followUp.dueDate <= new Date() ? 'MISSED' : 'SCHEDULED',
          isSystemCancelled: false,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId: req.tenantId!,
          userId: req.user!.id,
          leadId: followUp.leadId || undefined,
          action: 'STATUS_CHANGE',
          objectType: 'FollowUp',
          objectId: followUp.id,
          oldValues: { isCompleted: true, isMissed: false },
          newValues: { isCompleted: false, isMissed: followUp.dueDate <= new Date() },
        },
      });
      if (followUp.leadId) {
        await appendLeadProcessNote(tx, {
          tenantId: req.tenantId!,
          leadId: followUp.leadId,
          userId: req.user!.id,
          content: `Follow-up reopened: ${followUp.title}`,
        });
        await tagLeadFollowUpEvents(tx, req.tenantId!, followUp.leadId);
      }
      return updated;
    });

    res.json({ success: true, data: updatedFollowUp });
  } catch (error) {
    console.error('Reopen follow-up error:', error);
    res.status(500).json({ success: false, error: 'Failed to reopen follow-up' });
  }
});

export { router as followUpRoutes };
