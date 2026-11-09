import { Router, Response } from 'express';
import { prisma } from '@dct-crm/db';
import { authenticate, AuthRequest } from '../middleware/auth';
import { authorize } from '../middleware/authorization';
import { canAccessLead } from '../services/recordAccess';
import { getEnquiryById } from '../services/enquiryService';
import { applyEnquiryAttributePatch, ENQUIRY_ATTRIBUTE_KEYS } from '../services/enquiryFieldMap';
import { backfillEnquiryAttributes } from '../services/enquiryBackfill';
import { getLeadPicklistOptions } from '../services/leadPicklists';
import { z } from 'zod';

const router = Router();

router.use(authenticate);

const optionalText = (max: number) => z.union([
  z.string().trim().max(max),
  z.null(),
]).optional();

export const enquiryUpdateSchema = z.object({
  leadType: z.enum(['ORIGINAL', 'ADDITIONAL', 'RE_ENGAGED', 'RE_OPENED', 'OUTSIDE_REENGAGEMENT_WINDOW']).optional(),
  source: z.string().trim().min(1).max(120).optional(),
  subSource: optionalText(120),
  campaignId: optionalText(160),
  campaign: optionalText(160),
  subCampaignId: optionalText(160),
  subCampaign: optionalText(160),
  projectId: optionalText(128),
  phone: optionalText(64),
  secondaryPhone: optionalText(64),
  tertiaryPhone: optionalText(64),
  countryCode: optionalText(8),
  secondaryCountryCode: optionalText(8),
  tertiaryCountryCode: optionalText(8),
  email: z.union([z.string().trim().email(), z.literal(''), z.null()]).optional().transform((value) => value || null),
  secondaryEmail: z.union([z.string().trim().email(), z.literal(''), z.null()]).optional().transform((value) => value || null),
  tertiaryEmail: z.union([z.string().trim().email(), z.literal(''), z.null()]).optional().transform((value) => value || null),
  medium: optionalText(120),
  description: optionalText(5000),
  channelPartner: optionalText(160),
  enquiryDate: z.coerce.date().optional(),
  attributes: z.record(z.string(), z.union([z.string(), z.boolean(), z.null()])).optional(),
}).strict();

router.post('/backfill', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user?.isAdmin && !req.user?.isSuperAdmin) {
      return res.status(403).json({ success: false, error: 'Only an admin can backfill enquiries' });
    }
    const report = await backfillEnquiryAttributes(req.user.isSuperAdmin ? undefined : req.user.tenantId);
    return res.json({ success: true, data: report });
  } catch (error) {
    console.error('Enquiry backfill error:', error);
    return res.status(500).json({ success: false, error: 'Failed to backfill enquiries' });
  }
});

router.get('/:id', authorize('Enquiry', 'read'), async (req: AuthRequest, res: Response) => {
  try {
    const enquiry = await getEnquiryById(
      req.user!.isSuperAdmin ? undefined : req.user!.tenantId,
      req.params.id,
    );
    if (!enquiry) return res.status(404).json({ success: false, error: 'Enquiry not found' });
    if (!(await canAccessLead(req.user!, enquiry.lead))) {
      return res.status(403).json({ success: false, error: 'You do not have access to this enquiry' });
    }

    const [createdBy, updatedBy] = await Promise.all([
      enquiry.createdById
        ? prisma.user.findFirst({
            where: { id: enquiry.createdById, tenantId: enquiry.tenantId },
            select: { id: true, firstName: true, lastName: true },
          })
        : null,
      enquiry.updatedById
        ? prisma.user.findFirst({
            where: { id: enquiry.updatedById, tenantId: enquiry.tenantId },
            select: { id: true, firstName: true, lastName: true },
          })
        : null,
    ]);
    return res.json({
      success: true,
      data: {
        ...enquiry,
        createdBy,
        lastModifiedBy: updatedBy,
      },
    });
  } catch (error) {
    console.error('Get enquiry error:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch enquiry' });
  }
});

router.put('/:id', authorize('Enquiry', 'edit'), async (req: AuthRequest, res: Response) => {
  try {
    const payload = enquiryUpdateSchema.parse(req.body);
    const attributePatch = payload.attributes
      ? Object.fromEntries(Object.entries(payload.attributes).filter(([key]) => (ENQUIRY_ATTRIBUTE_KEYS as readonly string[]).includes(key)))
      : undefined;
    const tenantId = req.user!.isSuperAdmin ? undefined : req.user!.tenantId;
    const enquiry = await prisma.enquiry.findFirst({
      where: { id: req.params.id, ...(tenantId ? { tenantId } : {}) },
      include: { lead: { select: { id: true, tenantId: true, ownerId: true, creatorId: true } } },
    });
    if (!enquiry) return res.status(404).json({ success: false, error: 'Enquiry not found' });
    if (!(await canAccessLead(req.user!, enquiry.lead))) {
      return res.status(403).json({ success: false, error: 'You do not have access to this enquiry' });
    }

    if (payload.source !== undefined && payload.source !== enquiry.source) {
      const sourceOptions = (await getLeadPicklistOptions(enquiry.tenantId)).get('source');
      if (!sourceOptions?.has(payload.source)) {
        return res.status(400).json({ success: false, error: 'Select a configured Enquiry Source for this company.' });
      }
    }

    if (payload.projectId) {
      const project = await prisma.project.findFirst({
        where: { id: payload.projectId, tenantId: enquiry.tenantId, isActive: true },
        select: { id: true },
      });
      if (!project) return res.status(400).json({ success: false, error: 'Invalid project' });
    }

    const result = await prisma.$transaction(async (tx) => {
      const { attributes: _attributes, ...enquiryFields } = payload;
      const updated = await tx.enquiry.update({
        where: { id: enquiry.id },
        data: {
          ...enquiryFields,
          ...(attributePatch ? { attributes: applyEnquiryAttributePatch(enquiry.attributes, attributePatch) } : {}),
          updatedById: req.user!.id,
        },
        include: { project: { select: { id: true, name: true } } },
      });
      await tx.auditLog.create({
        data: {
          tenantId: enquiry.tenantId,
          userId: req.user!.id,
          leadId: enquiry.leadId,
          action: 'ENQUIRY_UPDATED',
          objectType: 'Enquiry',
          objectId: enquiry.id,
          oldValues: {
            leadType: enquiry.leadType,
            source: enquiry.source,
            subSource: enquiry.subSource,
            campaign: enquiry.campaign,
            projectId: enquiry.projectId,
          },
          newValues: {
            leadType: updated.leadType,
            source: updated.source,
            subSource: updated.subSource,
            campaign: updated.campaign,
            projectId: updated.projectId,
          },
        },
      });
      return updated;
    });
    return res.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: error.issues[0]?.message || 'Invalid enquiry data' });
    }
    console.error('Update enquiry error:', error);
    return res.status(500).json({ success: false, error: 'Failed to update enquiry' });
  }
});

router.delete('/:id', authorize('Enquiry', 'delete'), async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.isSuperAdmin ? undefined : req.user!.tenantId;
    const enquiry = await prisma.enquiry.findFirst({
      where: { id: req.params.id, ...(tenantId ? { tenantId } : {}) },
      include: { lead: { select: { id: true, tenantId: true, ownerId: true, creatorId: true } } },
    });
    if (!enquiry) return res.status(404).json({ success: false, error: 'Enquiry not found' });
    if (!(await canAccessLead(req.user!, enquiry.lead))) {
      return res.status(403).json({ success: false, error: 'You do not have access to this enquiry' });
    }

    await prisma.$transaction(async (tx) => {
      await tx.auditLog.create({
        data: {
          tenantId: enquiry.tenantId,
          userId: req.user!.id,
          leadId: enquiry.leadId,
          action: 'ENQUIRY_DELETED',
          objectType: 'Enquiry',
          objectId: enquiry.id,
          oldValues: {
            enquiryNumber: enquiry.enquiryNumber,
            leadType: enquiry.leadType,
            source: enquiry.source,
            subSource: enquiry.subSource,
            campaign: enquiry.campaign,
            projectId: enquiry.projectId,
          },
        },
      });
      await tx.enquiry.delete({ where: { id: enquiry.id } });
    });
    return res.json({ success: true, message: 'Enquiry deleted' });
  } catch (error) {
    console.error('Delete enquiry error:', error);
    return res.status(500).json({ success: false, error: 'Failed to delete enquiry' });
  }
});

export default router;
