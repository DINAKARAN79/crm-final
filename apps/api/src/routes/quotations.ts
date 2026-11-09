import fs from 'fs';
import path from 'path';
import { Router, Response } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@dct-crm/db';
import { quotationScheduleAmounts } from '@dct-crm/shared';
import { authenticate, AuthRequest } from '../middleware/auth';
import { authorize } from '../middleware/authorization';
import { auditLog } from '../middleware/audit';
import { canAccessLead } from '../services/recordAccess';
import { renderQuotationPdf } from '../services/quotationPdf';

const router = Router();

const quotationSchema = z.object({
  siteVisitId: z.string().min(1),
  projectId: z.string().min(1),
  unitId: z.string().min(1),
  pricePerSqFt: z.number().positive().finite(),
  plcAmount: z.number().min(0).finite(),
  discountPercent: z.number().min(0).finite(),
  paymentPlan: z.object({
    name: z.string().trim().min(1).max(120),
    installments: z.array(z.object({
      milestone: z.string().trim().min(1, 'Milestone name is required').max(120),
      percentage: z.number().positive('Percentage must be greater than 0').max(100, 'Percentage cannot exceed 100'),
      dueDays: z.number().int('Enter a whole number of days').min(0, 'Due days cannot be negative').max(3650, 'Due days cannot exceed 3650'),
    }).strict()).min(1).max(12).superRefine((installments, context) => {
      const total = Math.round(installments.reduce((sum, item) => sum + item.percentage, 0) * 100) / 100;
      if (total !== 100) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Total installment percentage must equal 100%. Current total: ${Number.isInteger(total) ? total : total.toFixed(2)}%.`,
        });
      }
      const names = installments.map((item) => item.milestone.trim().toLowerCase());
      if (new Set(names).size !== names.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Milestone names must be unique',
        });
      }
    }),
  }),
  terms: z.string().max(5000).optional(),
});

router.get(
  '/lead/:leadId',
  authenticate,
  authorize('Lead', 'read'),
  async (req: AuthRequest, res: Response) => {
    try {
      const { tenantId } = req.user!;
      const lead = await prisma.lead.findFirst({
        where: { id: req.params.leadId, tenantId },
        select: { id: true, tenantId: true, ownerId: true, creatorId: true },
      });
      if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });
      if (!(await canAccessLead(req.user!, lead))) {
        return res.status(403).json({ success: false, error: 'You do not have access to this lead' });
      }
      const quotations = await prisma.quotation.findMany({
        where: { tenantId, leadId: lead.id },
        include: {
          createdBy: { select: { id: true, firstName: true, lastName: true } },
          booking: { select: { id: true, bookingNumber: true, status: true, profession: true } },
          unit: { select: { id: true, number: true, type: true, block: true, floor: true, area: true } },
          project: { select: { id: true, name: true, address: true, city: true, state: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
      return res.json({ success: true, data: quotations });
    } catch (error) {
      console.error('Failed to fetch lead quotations:', error);
      return res.status(500).json({ success: false, error: 'Failed to fetch quotations' });
    }
  },
);

router.post(
  '/lead/:leadId',
  authenticate,
  authorize('Lead', 'edit'),
  async (req: AuthRequest, res: Response) => {
    try {
      const input = quotationSchema.parse(req.body);
      const { tenantId, id: userId } = req.user!;
      const lead = await prisma.lead.findFirst({
        where: { id: req.params.leadId, tenantId },
      });
      if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });
      if (!(await canAccessLead(req.user!, lead))) {
        return res.status(403).json({ success: false, error: 'You do not have access to this lead' });
      }
      if (!z.string().trim().email().safeParse(lead.email).success) {
        return res.status(400).json({ success: false, error: 'A valid email address is required on the lead before creating a quotation' });
      }

      const [siteVisit, project, unit] = await Promise.all([
        prisma.siteVisit.findFirst({
          where: {
            id: input.siteVisitId,
            leadId: lead.id,
            tenantId,
            status: 'COMPLETED',
          },
          select: { id: true },
        }),
        prisma.project.findFirst({
          where: { id: input.projectId, tenantId, isActive: true },
          select: { id: true, name: true },
        }),
        prisma.unit.findFirst({
          where: { id: input.unitId, tenantId, projectId: input.projectId },
          select: { id: true, number: true, type: true, area: true, price: true, status: true },
        }),
      ]);

      if (!siteVisit) {
        return res.status(400).json({ success: false, error: 'Select a completed site visit for this lead' });
      }
      if (!project) {
        return res.status(400).json({ success: false, error: 'Select an active project' });
      }
      if (!unit || unit.status !== 'AVAILABLE') {
        return res.status(409).json({ success: false, error: 'This unit is no longer available. Select another unit.' });
      }
      const unitArea = unit.area;
      if (!unitArea || unitArea <= 0) {
        return res.status(400).json({ success: false, error: 'The selected unit must have a valid area before quoting' });
      }

      const basePrice = unitArea * input.pricePerSqFt;
      const subtotal = basePrice + input.plcAmount;
      const discountAmount = Math.round((basePrice * input.discountPercent / 100) * 100) / 100;
      const totalPrice = subtotal - discountAmount;
      if (![basePrice, subtotal, discountAmount, totalPrice].every(Number.isFinite)) {
        return res.status(400).json({ success: false, error: 'Quotation price calculations must be finite' });
      }
      if (totalPrice < 0) {
        return res.status(400).json({ success: false, error: 'Quotation total cannot be negative' });
      }
      const installmentAmounts = quotationScheduleAmounts(
        totalPrice,
        input.paymentPlan.installments.map((installment) => installment.percentage),
      );
      const paymentPlan = {
        name: input.paymentPlan.name,
        installments: input.paymentPlan.installments.map((installment, index) => ({
          milestone: installment.milestone,
          percentage: installment.percentage,
          dueDays: installment.dueDays,
          amount: installmentAmounts[index],
        })),
      };

      const quotation = await prisma.$transaction(async (tx) => {
        const stillAvailable = await tx.unit.findFirst({
          where: { id: unit.id, tenantId, projectId: project.id, status: 'AVAILABLE' },
          select: { id: true },
        });
        if (!stillAvailable) {
          throw new Error('UNIT_UNAVAILABLE');
        }
        const sequence = await tx.sequence.upsert({
          where: { tenantId_type: { tenantId, type: 'QUOTATION' } },
          update: { nextValue: { increment: 1 } },
          create: { tenantId, type: 'QUOTATION', nextValue: 1 },
        });
        const quotationNumber = `QT-${new Date().getFullYear()}-${String(sequence.nextValue).padStart(6, '0')}`;

        return tx.quotation.create({
          data: {
            tenantId,
            leadId: lead.id,
            siteVisitId: siteVisit.id,
            projectId: project.id,
            unitId: unit.id,
            createdById: userId,
            quotationNumber,
            customerName: [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.company,
            customerPhone: lead.mobile || lead.phone,
            customerEmail: lead.email?.trim() ?? null,
            customerAddress: [lead.street, lead.city, lead.stateProvince, lead.postalCode, lead.country]
              .filter(Boolean)
              .join(', '),
            projectName: project.name,
            unitNumber: unit.number,
            unitType: unit.type,
            area: unitArea,
            pricePerSqFt: input.pricePerSqFt,
            basePrice,
            plcAmount: input.plcAmount,
            discountAmount,
            totalPrice,
            paymentPlanName: paymentPlan.name,
            paymentPlan: paymentPlan as Prisma.InputJsonValue,
            terms: input.terms?.trim() || null,
          },
          include: {
            createdBy: { select: { id: true, firstName: true, lastName: true } },
          },
        });
      });

      await auditLog(
        tenantId,
        userId,
        'CREATE',
        'Quotation',
        quotation.id,
        undefined,
        quotation,
        req.ip,
      );

      return res.status(201).json({ success: true, data: quotation });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ success: false, error: error.issues[0]?.message || 'Invalid quotation details' });
      }
      if (error instanceof Error && error.message === 'UNIT_UNAVAILABLE') {
        return res.status(409).json({ success: false, error: 'This unit is no longer available. Select another unit.' });
      }
      console.error('Failed to create quotation:', error);
      return res.status(500).json({ success: false, error: 'Failed to create quotation' });
    }
  },
);

function organizationTypeOf(value: Prisma.JsonValue | null | undefined): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const organizationType = (value as Prisma.JsonObject).organizationType;
  return typeof organizationType === 'string' && organizationType.trim() ? organizationType.trim() : null;
}

function locationLine(parts: Array<string | null | undefined>): string {
  const seen = new Set<string>();
  const items: string[] = [];
  parts.forEach((part) => {
    if (!part) return;
    part.split(',').forEach((piece) => {
      const cleaned = piece.trim();
      const key = cleaned.toLowerCase();
      if (!cleaned || seen.has(key)) return;
      seen.add(key);
      items.push(cleaned);
    });
  });
  return items.join(', ');
}

function companyLogo(filename?: string | null): Buffer | null {
  if (!filename) return null;
  const safeName = path.basename(filename);
  if (safeName !== filename) return null;
  const extension = path.extname(safeName).toLowerCase();
  if (!['.png', '.jpg', '.jpeg'].includes(extension)) return null;
  const logoPath = path.resolve(__dirname, '../../../uploads/logos', safeName);
  if (!fs.existsSync(logoPath)) return null;
  return fs.readFileSync(logoPath);
}

function paymentInstallments(value: Prisma.JsonValue): Array<{ milestone: string; percentage: number; dueMonths: number; dueDays?: number }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const installments = (value as Prisma.JsonObject).installments;
  if (!Array.isArray(installments)) return [];
  return installments.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Prisma.JsonObject;
    const percentage = Number(record.percentage);
    const dueMonths = Number(record.dueMonths);
    const dueDays = Number(record.dueDays);
    if (!Number.isFinite(percentage)) return [];
    return [{
      milestone: typeof record.milestone === 'string' ? record.milestone : 'Installment',
      percentage,
      dueMonths: Number.isFinite(dueMonths) ? dueMonths : 0,
      ...(Number.isFinite(dueDays) ? { dueDays } : {}),
    }];
  });
}

router.get(
  '/lead/:leadId/:quotationId/pdf',
  authenticate,
  authorize('Lead', 'read'),
  async (req: AuthRequest, res: Response) => {
    try {
      const { tenantId } = req.user!;
      const lead = await prisma.lead.findFirst({
        where: { id: req.params.leadId, tenantId },
        select: { id: true, tenantId: true, ownerId: true, creatorId: true },
      });
      if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });
      if (!(await canAccessLead(req.user!, lead))) {
        return res.status(403).json({ success: false, error: 'You do not have access to this lead' });
      }

      const quotation = await prisma.quotation.findFirst({
        where: { id: req.params.quotationId, leadId: lead.id, tenantId },
        include: {
          unit: { select: { number: true, type: true, block: true, floor: true, area: true } },
          project: { select: { name: true, address: true, city: true, state: true } },
          createdBy: { select: { firstName: true, lastName: true } },
          booking: { select: { id: true, status: true, profession: true } },
        },
      });
      if (!quotation) return res.status(404).json({ success: false, error: 'Quotation not found' });

      const tenant = await prisma.tenant.findFirst({
        where: { id: tenantId },
        select: { name: true, logo: true, email: true, phone: true, website: true, address: true, city: true, state: true, country: true, postalCode: true, timezone: true },
      });

      const fileName = `${quotation.quotationNumber.replace(/[^A-Za-z0-9_-]/g, '-')}.pdf`;
      const pdf = await renderQuotationPdf({
        companyName: tenant?.name || 'DCT CRM',
        companyAddress: locationLine([tenant?.address, tenant?.city, tenant?.state, tenant?.postalCode, tenant?.country]),
        companyPhone: tenant?.phone,
        companyEmail: tenant?.email,
        companyWebsite: tenant?.website,
        logo: companyLogo(tenant?.logo),
        quotationNumber: quotation.quotationNumber,
        quotationDate: quotation.confirmedAt,
        timeZone: tenant?.timezone,
        status: quotation.booking ? 'Booked' : quotation.status,
        customerName: quotation.customerName,
        customerPhone: quotation.customerPhone,
        customerEmail: quotation.customerEmail,
        customerAddress: quotation.customerAddress,
        projectName: quotation.projectName,
        projectAddress: locationLine([quotation.project?.address, quotation.project?.city, quotation.project?.state]),
        unitType: quotation.unitType || quotation.unit?.type,
        unitNumber: quotation.unitNumber,
        block: quotation.unit?.block,
        floor: quotation.unit?.floor,
        area: quotation.area,
        pricePerSqFt: quotation.pricePerSqFt,
        basePrice: quotation.basePrice,
        plcAmount: quotation.plcAmount,
        discountAmount: quotation.discountAmount,
        totalPrice: quotation.totalPrice,
        paymentPlanName: quotation.paymentPlanName,
        installments: paymentInstallments(quotation.paymentPlan),
        terms: quotation.terms,
        preparedBy: [quotation.createdBy?.firstName, quotation.createdBy?.lastName].filter(Boolean).join(' '),
        organizationType: organizationTypeOf(quotation.booking?.profession),
      });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('Content-Length', pdf.length);
      return res.send(pdf);
    } catch (error) {
      console.error('Failed to export quotation PDF:', error);
      return res.status(500).json({ success: false, error: 'Failed to export quotation PDF' });
    }
  },
);

export default router;
