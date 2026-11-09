import { Router } from 'express';
import { z } from 'zod';
import { prisma, readTaggedArea, unitFieldTags } from '@dct-crm/db';
import { authenticate, AuthRequest } from '../middleware/auth';
import { listOrderBy, listViewConstraint, mergeListWhere } from '../services/listViewService';
import { Response } from 'express';
import { authorize } from '../middleware/authorization';
import { auditLog } from '../middleware/audit';
import { PaginatedResponse } from '../types';
import { Prisma } from '@prisma/client';
import { resolveUnitLocation, unitUsesBlockAndFloor } from '@dct-crm/shared';

const router = Router();

const customFieldsSchema = z.record(
  z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,80}$/),
  z.union([z.string().max(131072), z.number().finite(), z.boolean(), z.null()]),
).optional();

const optionalText = (max: number) => z.union([z.string().max(max), z.literal(''), z.null()]).optional();
const optionalId = z.union([z.string().min(1), z.literal(''), z.null()]).optional();
const optionalWholeNumber = z.union([z.number().int().min(0), z.null()]).optional();
const selectableUnitStatuses = ['AVAILABLE', 'RESERVED', 'BOOKED'] as const;

const recordFields = {
  allowedDiscount: optionalText(25),
  buildupArea: optionalWholeNumber,
  minimumBookingAmount: optionalWholeNumber,
  msp: optionalText(255),
  plc: optionalText(255),
  nonPlc: optionalText(255),
  registrationDate: z.union([z.string().max(40), z.literal(''), z.null()]).optional(),
  ownerId: optionalId,
  customerLeadId: optionalId,
  bookingLeadId: optionalId,
  opportunityLeadId: optionalId,
  areaField: z.union([z.number().min(0), z.null()]).optional(),
};

export const unitSchema = z.object({
  projectId: z.string().min(1),
  number: z.string().min(1).max(255),
  type: z.string().min(1).max(50),
  block: z.string().trim().max(255).optional(),
  floor: z.number().int().min(0).optional(),
  area: z.number().min(0).optional(),
  bedrooms: z.number().int().min(0).optional(),
  bathrooms: z.number().int().min(0).optional(),
  price: z.number().min(0),
  status: z.enum(selectableUnitStatuses).optional(),
  description: z.string().max(2000).optional(),
  features: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  customFields: customFieldsSchema,
  ...recordFields,
});

export const updateUnitSchema = unitSchema.partial().extend({
  type: z.union([z.string().min(1).max(50), z.literal('')]).optional(),
  status: z.enum(selectableUnitStatuses).optional(),
  floor: z.union([z.number().int().min(0), z.null()]).optional(),
  area: z.union([z.number().min(0), z.null()]).optional(),
  price: z.union([z.number().min(0), z.null()]).optional(),
});

const userNameSelect = { select: { id: true, firstName: true, lastName: true } } as const;
const leadNameSelect = { select: { id: true, leadNumber: true, firstName: true, lastName: true, source: true } } as const;
const unitStatusSchema = z.object({
  status: z.enum(selectableUnitStatuses),
  reason: z.string().trim().max(1000).optional(),
});

const unitDetailInclude = {
  project: { select: { id: true, name: true, address: true } },
  owner: userNameSelect,
  createdBy: userNameSelect,
  updatedBy: userNameSelect,
  customerLead: leadNameSelect,
  bookingLead: leadNameSelect,
  opportunityLead: leadNameSelect,
  quotations: {
    select: {
      id: true,
      quotationNumber: true,
      leadId: true,
      status: true,
      totalPrice: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' as const },
  },
  bookings: {
    select: {
      id: true,
      bookingNumber: true,
      status: true,
      lead: { select: { source: true } },
      receipts: {
        select: { id: true, receiptNumber: true, amount: true, approvalStatus: true, receiptDate: true },
        orderBy: { receiptDate: 'desc' as const },
      },
    },
    orderBy: { createdAt: 'desc' as const },
  },
} satisfies Prisma.UnitInclude;

function blankToNull(value: string | null | undefined) {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseRegistrationDate(value: string | null | undefined) {
  if (value == null || value.trim() === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function presentUnit<T extends {
  type?: string | null;
  price?: number | null;
  project?: { name?: string | null } | null;
  quotations?: unknown[];
  bookings?: Array<{ status?: string; lead?: { source?: string | null } | null; receipts?: unknown[] }>;
}>(unit: T) {
  const bookings = unit.bookings || [];
  const quotations = unit.quotations || [];
  const activeBooking = bookings.find((booking) => booking.status !== 'CANCELLED');
  const villa = (unit.type || '').trim().toLowerCase() === 'villa';
  const receipts = bookings.flatMap((booking) => booking.receipts || []);
  const projectName = unit.project?.name ?? '';
  const bookingSource = activeBooking?.lead?.source ?? '';
  const storedCustomFields = unit && 'customFields' in unit && unit.customFields && typeof unit.customFields === 'object' && !Array.isArray(unit.customFields)
    ? unit.customFields as Record<string, unknown>
    : {};
  const areaField = readTaggedArea(storedCustomFields);
  return {
    ...unit,
    projectName,
    bookingSource,
    areaField,
    unitPrice: unit.price ?? null,
    villaPrice: villa ? (unit.price ?? 0) : 0,
    quotationCount: quotations.length,
    receiptCount: receipts.length,
    customFields: {
      ...storedCustomFields,
      ...unitFieldTags({ ...unit, projectName, bookingSource, areaField }),
    },
  };
}

async function nextUnitCode(tenantId: string) {
  const rows = await prisma.$queryRaw<Array<{ unitCode: string }>>`
    SELECT "unitCode"
    FROM "Unit"
    WHERE "tenantId" = ${tenantId}
      AND "unitCode" ~ '^U-[0-9]+$'
    ORDER BY LENGTH("unitCode") DESC, "unitCode" DESC
    LIMIT 1
  `;
  const current = rows[0]?.unitCode ? Number(rows[0].unitCode.slice(2)) : 0;
  const next = Number.isFinite(current) ? current + 1 : 1;
  return `U-${String(next).padStart(4, '0')}`;
}

async function relationError(tenantId: string, input: {
  projectId?: string | null;
  ownerId?: string | null;
  customerLeadId?: string | null;
  bookingLeadId?: string | null;
  opportunityLeadId?: string | null;
}) {
  if (input.projectId) {
    const project = await prisma.project.findFirst({ where: { id: input.projectId, tenantId }, select: { id: true } });
    if (!project) return 'Project not found';
  }
  if (input.ownerId) {
    const owner = await prisma.user.findFirst({ where: { id: input.ownerId, tenantId }, select: { id: true } });
    if (!owner) return 'Owner not found';
  }
  const leadIds = [input.customerLeadId, input.bookingLeadId, input.opportunityLeadId].filter((id): id is string => Boolean(id));
  if (leadIds.length) {
    const leads = await prisma.lead.findMany({ where: { tenantId, id: { in: leadIds } }, select: { id: true } });
    if (leads.length !== new Set(leadIds).size) return 'One of the selected leads was not found';
  }
  return null;
}

function duplicateUnitNumberError(type: string, projectType?: string | null) {
  return unitUsesBlockAndFloor(type, projectType)
    ? 'Unit number already exists in this block and floor'
    : 'Unit number already exists in this project';
}

function unitNumberWhere(input: {
  tenantId: string;
  projectId: string;
  number: string;
  type: string;
  block: string | null;
  floor: number | null;
  projectType?: string | null;
  excludeId?: string;
}): Prisma.UnitWhereInput {
  const located = unitUsesBlockAndFloor(input.type, input.projectType);
  return {
    tenantId: input.tenantId,
    projectId: input.projectId,
    number: input.number,
    ...(input.excludeId ? { id: { not: input.excludeId } } : {}),
    ...(located
      ? { block: input.block, floor: input.floor }
      : { block: null }),
  };
}

router.get('/', authenticate, authorize('Unit', 'read'), async (req: AuthRequest, res: Response) => {
  try {
    const { tenantId } = req.user!;
    const { 
      page = 1, 
      limit = 50, 
      projectId, 
      type, 
      status,
      minPrice,
      maxPrice,
      minFloor,
      maxFloor,
      search,
      sortBy = 'createdAt', 
      sortOrder = 'desc' 
    } = req.query;

    const skip = (Number(page) - 1) * Number(limit);

    const where: Prisma.UnitWhereInput = {
      tenantId,
      ...(projectId && { projectId: projectId as string }),
      ...(type && { type: type as string }),
      ...(status && { status: status as any }),
      ...(minPrice && { price: { gte: Number(minPrice) } }),
      ...(maxPrice && { price: { lte: Number(maxPrice) } }),
      ...(minFloor && { floor: { gte: Number(minFloor) } }),
      ...(maxFloor && { floor: { lte: Number(maxFloor) } }),
      ...(search && {
        OR: [
          { number: { contains: search as string, mode: 'insensitive' } },
          { unitCode: { contains: search as string, mode: 'insensitive' } },
          { type: { contains: search as string, mode: 'insensitive' } },
        ],
      }),
    };
    const viewConstraint = await listViewConstraint(req, 'UNIT');
    if (!viewConstraint.ok) return res.status(viewConstraint.status).json({ success: false, error: viewConstraint.error });
    mergeListWhere(where, viewConstraint.where);
    const sorted = listOrderBy('UNIT', sortBy, sortOrder);
    if (!sorted.ok) return res.status(400).json({ success: false, error: sorted.error });

    const [units, total] = await Promise.all([
      prisma.unit.findMany({
        where,
        skip,
        take: Number(limit),
        orderBy: sorted.orderBy as { createdAt: 'asc' | 'desc' },
        include: {
          project: { select: { id: true, name: true, address: true } },
        },
      }),
      prisma.unit.count({ where }),
    ]);

    const response: PaginatedResponse<typeof units[0]> = {
      success: true,
      data: units,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    };

    res.json(response);
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch units' });
  }
});

router.get('/:id', authenticate, authorize('Unit', 'read'), async (req: AuthRequest, res: Response) => {
  try {
    const { tenantId } = req.user!;
    const { id } = req.params;

    const unit = await prisma.unit.findFirst({
      where: { id, tenantId },
      include: unitDetailInclude,
    });

    if (!unit) {
      return res.status(404).json({ success: false, error: 'Unit not found' });
    }

    res.json({ success: true, data: presentUnit(unit) });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch unit' });
  }
});

router.post('/', authenticate, authorize('Unit', 'create'), async (req: AuthRequest, res: Response) => {
  try {
    const { tenantId, id: userId } = req.user!;
    const data = unitSchema.parse(req.body);

    const project = await prisma.project.findFirst({ where: { id: data.projectId, tenantId } });
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const location = resolveUnitLocation({
      type: data.type,
      block: data.block,
      floor: data.floor,
      projectType: project.projectType,
    });
    if (!location.ok) {
      return res.status(400).json({ success: false, error: location.error });
    }

    const existingUnit = await prisma.unit.findFirst({
      where: unitNumberWhere({
        tenantId,
        projectId: data.projectId,
        number: data.number,
        type: location.type,
        block: location.block,
        floor: location.floor,
        projectType: project.projectType,
      }),
    });
    if (existingUnit) {
      return res.status(409).json({
        success: false,
        error: duplicateUnitNumberError(location.type, project.projectType),
      });
    }

    const {
      projectId,
      number,
      area,
      price,
      status,
      customFields,
    } = data;
    const registrationDate = parseRegistrationDate(data.registrationDate);
    if (registrationDate === undefined) {
      return res.status(400).json({ success: false, error: 'Registration date is not a valid date' });
    }
    const relationMessage = await relationError(tenantId, {
      ownerId: blankToNull(data.ownerId),
      customerLeadId: blankToNull(data.customerLeadId),
      bookingLeadId: blankToNull(data.bookingLeadId),
      opportunityLeadId: blankToNull(data.opportunityLeadId),
    });
    if (relationMessage) {
      return res.status(400).json({ success: false, error: relationMessage });
    }

    const unitCode = await nextUnitCode(tenantId);
    const storedFloor = data.floor !== undefined ? data.floor : location.floor;
    const tags = unitFieldTags({
      allowedDiscount: blankToNull(data.allowedDiscount),
      price,
      buildupArea: data.buildupArea ?? null,
      createdById: userId,
      customerLeadId: blankToNull(data.customerLeadId),
      floor: storedFloor,
      updatedById: userId,
      minimumBookingAmount: data.minimumBookingAmount ?? null,
      msp: blankToNull(data.msp),
      nonPlc: blankToNull(data.nonPlc),
      bookingLeadId: blankToNull(data.bookingLeadId),
      opportunityLeadId: blankToNull(data.opportunityLeadId),
      ownerId: blankToNull(data.ownerId),
      plc: blankToNull(data.plc),
      projectId,
      projectName: project.name,
      registrationDate,
      area: area ?? null,
      areaField: data.areaField ?? null,
      status: status || 'AVAILABLE',
      unitCode,
      number,
      type: location.type,
      block: location.block,
    });
    const [unit] = await prisma.$transaction([
      prisma.unit.create({
        data: {
          tenantId,
          projectId,
          unitCode,
          number,
          type: location.type,
          block: location.block,
          floor: storedFloor,
          price,
          createdById: userId,
          updatedById: userId,
          ...(area !== undefined ? { area } : {}),
          ...(status ? { status } : {}),
          customFields: { ...(customFields || {}), ...tags },
          ...(data.allowedDiscount !== undefined ? { allowedDiscount: blankToNull(data.allowedDiscount) } : {}),
          ...(data.buildupArea !== undefined ? { buildupArea: data.buildupArea } : {}),
          ...(data.minimumBookingAmount !== undefined ? { minimumBookingAmount: data.minimumBookingAmount } : {}),
          ...(data.msp !== undefined ? { msp: blankToNull(data.msp) } : {}),
          ...(data.plc !== undefined ? { plc: blankToNull(data.plc) } : {}),
          ...(data.nonPlc !== undefined ? { nonPlc: blankToNull(data.nonPlc) } : {}),
          ...(data.registrationDate !== undefined ? { registrationDate } : {}),
          ...(data.ownerId !== undefined ? { ownerId: blankToNull(data.ownerId) } : {}),
          ...(data.customerLeadId !== undefined ? { customerLeadId: blankToNull(data.customerLeadId) } : {}),
          ...(data.bookingLeadId !== undefined ? { bookingLeadId: blankToNull(data.bookingLeadId) } : {}),
          ...(data.opportunityLeadId !== undefined ? { opportunityLeadId: blankToNull(data.opportunityLeadId) } : {}),
        },
        include: {
          project: { select: { id: true, name: true } },
        },
      }),
      prisma.project.update({
        where: { id: data.projectId },
        data: { 
          totalUnits: { increment: 1 },
          updatedAt: new Date(),
        },
      }),
    ]);

    await auditLog(tenantId, userId, 'CREATE', 'Unit', unit.id, null, { number: data.number, projectId: data.projectId, price: data.price });

    res.status(201).json({ success: true, data: unit });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: 'Validation failed', details: error.errors });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return res.status(409).json({ success: false, error: 'Unit number already exists in this location' });
    }
    res.status(500).json({ success: false, error: 'Failed to create unit' });
  }
});

router.put('/:id', authenticate, authorize('Unit', 'edit'), async (req: AuthRequest, res: Response) => {
  try {
    const { tenantId, id: userId } = req.user!;
    const { id } = req.params;
    const data = updateUnitSchema.parse(req.body);

    const existing = await prisma.unit.findFirst({ where: { id, tenantId } });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Unit not found' });
    }

    const registrationDate = data.registrationDate !== undefined ? parseRegistrationDate(data.registrationDate) : undefined;
    if (registrationDate === undefined && data.registrationDate !== undefined) {
      return res.status(400).json({ success: false, error: 'Registration date is not a valid date' });
    }
    const nextProjectId = data.projectId ?? existing.projectId;
    const relationMessage = await relationError(tenantId, {
      projectId: data.projectId,
      ownerId: data.ownerId !== undefined ? blankToNull(data.ownerId) : undefined,
      customerLeadId: data.customerLeadId !== undefined ? blankToNull(data.customerLeadId) : undefined,
      bookingLeadId: data.bookingLeadId !== undefined ? blankToNull(data.bookingLeadId) : undefined,
      opportunityLeadId: data.opportunityLeadId !== undefined ? blankToNull(data.opportunityLeadId) : undefined,
    });
    if (relationMessage) {
      return res.status(400).json({ success: false, error: relationMessage });
    }

    if (data.number !== undefined || data.block !== undefined || data.floor !== undefined || data.type !== undefined || data.projectId !== undefined) {
      const projectRecord = await prisma.project.findFirst({
        where: { id: nextProjectId, tenantId },
        select: { projectType: true },
      });
      const nextType = data.type ?? existing.type ?? '';
      const nextNumber = data.number ?? existing.number;
      const nextBlock = data.block !== undefined ? (data.block || null) : existing.block;
      const nextFloor = data.floor !== undefined ? data.floor : existing.floor;
      const duplicate = await prisma.unit.findFirst({
        where: unitNumberWhere({
          tenantId,
          projectId: nextProjectId,
          number: nextNumber,
          type: nextType,
          block: nextBlock,
          floor: nextFloor,
          projectType: projectRecord?.projectType,
          excludeId: id,
        }),
      });
      if (duplicate) {
        return res.status(409).json({
          success: false,
          error: duplicateUnitNumberError(nextType, projectRecord?.projectType),
        });
      }
    }

    const storedCustomFields = existing.customFields && typeof existing.customFields === 'object' && !Array.isArray(existing.customFields)
      ? existing.customFields as Record<string, unknown>
      : {};
    const unit = await prisma.$transaction(async (tx) => {
      if (data.status !== undefined && data.status !== existing.status) {
        const activeBooking = await tx.booking.findFirst({
          where: { tenantId, unitId: id, status: { not: 'CANCELLED' } },
          select: { id: true },
        });
        if (activeBooking) throw new Error('UNIT_HAS_ACTIVE_BOOKING');
      }
      const updated = await tx.unit.update({
        where: { id },
        data: {
          ...(data.projectId !== undefined ? { projectId: data.projectId } : {}),
          ...(data.number !== undefined ? { number: data.number } : {}),
          ...(data.type !== undefined ? { type: data.type || null } : {}),
          ...(data.block !== undefined ? { block: data.block || null } : {}),
          ...(data.floor !== undefined ? { floor: data.floor } : {}),
          ...(data.area !== undefined ? { area: data.area } : {}),
          ...(data.price !== undefined ? { price: data.price } : {}),
          ...(data.status !== undefined ? { status: data.status } : {}),
          ...(data.allowedDiscount !== undefined ? { allowedDiscount: blankToNull(data.allowedDiscount) } : {}),
          ...(data.buildupArea !== undefined ? { buildupArea: data.buildupArea } : {}),
          ...(data.minimumBookingAmount !== undefined ? { minimumBookingAmount: data.minimumBookingAmount } : {}),
          ...(data.msp !== undefined ? { msp: blankToNull(data.msp) } : {}),
          ...(data.plc !== undefined ? { plc: blankToNull(data.plc) } : {}),
          ...(data.nonPlc !== undefined ? { nonPlc: blankToNull(data.nonPlc) } : {}),
          ...(data.registrationDate !== undefined ? { registrationDate } : {}),
          ...(data.ownerId !== undefined ? { ownerId: blankToNull(data.ownerId) } : {}),
          ...(data.customerLeadId !== undefined ? { customerLeadId: blankToNull(data.customerLeadId) } : {}),
          ...(data.bookingLeadId !== undefined ? { bookingLeadId: blankToNull(data.bookingLeadId) } : {}),
          ...(data.opportunityLeadId !== undefined ? { opportunityLeadId: blankToNull(data.opportunityLeadId) } : {}),
          customFields: {
            ...storedCustomFields,
            ...(data.customFields || {}),
            ...unitFieldTags({
              allowedDiscount: data.allowedDiscount !== undefined ? blankToNull(data.allowedDiscount) : existing.allowedDiscount,
              price: data.price !== undefined ? data.price : existing.price,
              buildupArea: data.buildupArea !== undefined ? data.buildupArea : existing.buildupArea,
              createdById: existing.createdById,
              customerLeadId: data.customerLeadId !== undefined ? blankToNull(data.customerLeadId) : existing.customerLeadId,
              floor: data.floor !== undefined ? data.floor : existing.floor,
              updatedById: userId,
              minimumBookingAmount: data.minimumBookingAmount !== undefined ? data.minimumBookingAmount : existing.minimumBookingAmount,
              msp: data.msp !== undefined ? blankToNull(data.msp) : existing.msp,
              nonPlc: data.nonPlc !== undefined ? blankToNull(data.nonPlc) : existing.nonPlc,
              bookingLeadId: data.bookingLeadId !== undefined ? blankToNull(data.bookingLeadId) : existing.bookingLeadId,
              opportunityLeadId: data.opportunityLeadId !== undefined ? blankToNull(data.opportunityLeadId) : existing.opportunityLeadId,
              ownerId: data.ownerId !== undefined ? blankToNull(data.ownerId) : existing.ownerId,
              plc: data.plc !== undefined ? blankToNull(data.plc) : existing.plc,
              projectId: nextProjectId,
              projectName: (await prisma.project.findFirst({ where: { id: nextProjectId, tenantId }, select: { name: true } }))?.name ?? null,
              registrationDate: data.registrationDate !== undefined ? registrationDate : existing.registrationDate,
              area: data.area !== undefined ? data.area : existing.area,
              areaField: data.areaField !== undefined ? data.areaField : readTaggedArea(storedCustomFields),
              status: data.status ?? existing.status,
              unitCode: existing.unitCode,
              number: data.number ?? existing.number,
              type: data.type !== undefined ? (data.type || null) : existing.type,
              block: data.block !== undefined ? (data.block || null) : existing.block,
              bookingSource: (await prisma.booking.findFirst({
                where: { unitId: id, tenantId, status: { not: 'CANCELLED' } },
                orderBy: { createdAt: 'desc' },
                select: { lead: { select: { source: true } } },
              }))?.lead?.source ?? null,
            }),
          } as Prisma.InputJsonValue,
          updatedById: userId,
          updatedAt: new Date(),
        },
        include: unitDetailInclude,
      });
      if (data.projectId && data.projectId !== existing.projectId) {
        await tx.project.update({ where: { id: existing.projectId }, data: { totalUnits: { decrement: 1 } } });
        await tx.project.update({ where: { id: data.projectId }, data: { totalUnits: { increment: 1 } } });
      }
      return updated;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    await auditLog(tenantId, userId, 'UPDATE', 'Unit', id, null, data);

    res.json({ success: true, data: presentUnit(unit) });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: 'Validation failed', details: error.errors });
    }
    if (error instanceof Error && error.message === 'UNIT_HAS_ACTIVE_BOOKING') {
      return res.status(409).json({ success: false, error: 'Unit status is controlled by its active booking' });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
      return res.status(409).json({ success: false, error: 'Unit inventory changed. Refresh and try again.' });
    }
    res.status(500).json({ success: false, error: 'Failed to update unit' });
  }
});

router.patch('/:id/status', authenticate, authorize('Unit', 'edit'), async (req: AuthRequest, res: Response) => {
  try {
    const { tenantId, id: userId } = req.user!;
    const { id } = req.params;
    const { status, reason } = unitStatusSchema.parse(req.body);

    const existing = await prisma.unit.findFirst({ where: { id, tenantId } });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Unit not found' });
    }

    const unit = await prisma.$transaction(async (tx) => {
      if (status !== existing.status) {
        const activeBooking = await tx.booking.findFirst({
          where: { tenantId, unitId: id, status: { not: 'CANCELLED' } },
          select: { id: true },
        });
        if (activeBooking) throw new Error('UNIT_HAS_ACTIVE_BOOKING');
      }
      const updated = await tx.unit.update({ where: { id }, data: { status, updatedAt: new Date() } });
      await tx.project.update({ where: { id: existing.projectId }, data: { updatedAt: new Date() } });
      return updated;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    await auditLog(tenantId, userId, 'UPDATE', 'Unit', id, null, { status, previousStatus: existing.status, reason });

    res.json({ success: true, data: unit });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: 'Invalid unit status', details: error.errors });
    }
    if (error instanceof Error && error.message === 'UNIT_HAS_ACTIVE_BOOKING') {
      return res.status(409).json({ success: false, error: 'Unit status is controlled by its active booking' });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
      return res.status(409).json({ success: false, error: 'Unit inventory changed. Refresh and try again.' });
    }
    res.status(500).json({ success: false, error: 'Failed to update unit status' });
  }
});

router.delete('/:id', authenticate, authorize('Unit', 'delete'), async (req: AuthRequest, res: Response) => {
  try {
    const { tenantId, id: userId } = req.user!;
    const { id } = req.params;

    const existing = await prisma.unit.findFirst({ where: { id, tenantId } });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Unit not found' });
    }

    await prisma.$transaction([
      prisma.unit.delete({ where: { id } }),
      prisma.project.update({
        where: { id: existing.projectId },
        data: { 
          totalUnits: { decrement: 1 },
          updatedAt: new Date(),
        },
      }),
    ]);

    await auditLog(tenantId, userId, 'DELETE', 'Unit', id, { number: existing.number, projectId: existing.projectId, status: existing.status }, null);

    res.json({ success: true, data: null });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete unit' });
  }
});

export default router;
