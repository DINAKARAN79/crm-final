import { Prisma } from '@prisma/client';
import { prisma } from '@dct-crm/db';
import { selectNextSequenceMember } from './rrQueue';
import { createOwnerHistory } from './ownerHistory';
import { appendLeadProcessNote } from './leadNotes';

export type BookedBucketSource = 'booking' | 'import' | 'backfill' | 'api';

type BucketTransaction = Prisma.TransactionClient;

function fullName(user: { firstName: string; lastName: string }): string {
  return [user.firstName, user.lastName].filter(Boolean).join(' ') || 'CRM User';
}

function asObject(value: Prisma.JsonValue): Prisma.InputJsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Prisma.JsonObject
    : {};
}

async function getAdminFallback(tx: BucketTransaction, tenantId: string, preferredId: string | null) {
  if (preferredId) {
    const preferred = await tx.user.findFirst({
      where: {
        id: preferredId,
        tenantId,
        isActive: true,
        isSuperAdmin: false,
        profile: { isAdmin: true },
      },
      select: { id: true, firstName: true, lastName: true, profile: { select: { name: true } } },
    });
    if (preferred) return preferred;
  }

  return tx.user.findFirst({
    where: { tenantId, isActive: true, isSuperAdmin: false, profile: { isAdmin: true } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, firstName: true, lastName: true, profile: { select: { name: true } } },
  });
}

export async function moveLeadToBookedBucket(
  leadId: string,
  source: BookedBucketSource,
  tx: BucketTransaction,
  actorId: string,
) {
  const lead = await tx.lead.findFirst({
    where: { id: leadId, status: 'BOOKED' },
    select: { tenantId: true },
  });
  if (!lead) throw new Error('BOOKED_BUCKET_LEAD_NOT_BOOKED');

  await tx.bookedBucketSetting.upsert({
    where: { tenantId: lead.tenantId },
    create: { tenantId: lead.tenantId, isActive: false },
    update: {},
  });
  await tx.$queryRaw`SELECT "tenantId" FROM "booked_bucket_settings" WHERE "tenantId" = ${lead.tenantId} FOR UPDATE`;

  const bookedLead = await tx.lead.findFirst({
    where: { id: leadId, tenantId: lead.tenantId, status: 'BOOKED' },
    select: {
      id: true,
      tenantId: true,
      leadNumber: true,
      ownerId: true,
      bookedById: true,
      status: true,
      customFields: true,
      owner: { select: { id: true, firstName: true, lastName: true, profile: { select: { name: true } } } },
    },
  });
  if (!bookedLead) throw new Error('BOOKED_BUCKET_LEAD_NOT_BOOKED');
  const currentLead = bookedLead;

  const setting = await tx.bookedBucketSetting.findUnique({
    where: { tenantId: lead.tenantId },
    include: {
      members: {
        where: { isActive: true, user: { isActive: true, tenantId: lead.tenantId } },
        orderBy: { sortOrder: 'asc' },
        include: { user: { select: { id: true, firstName: true, lastName: true, profile: { select: { name: true } } } } },
      },
    },
  });
  if (!setting?.isActive) return { moved: false, owner: null, usedFallback: false };

  const activeOwners = setting.members;
  const currentOwnerIsInBucket = activeOwners.some((member) => member.userId === currentLead.ownerId);
  if (currentOwnerIsInBucket) {
    if (!currentLead.bookedById && currentLead.ownerId) {
      await tx.lead.update({ where: { id: currentLead.id }, data: { bookedById: currentLead.ownerId } });
    }
    return {
      moved: false,
      owner: activeOwners.find((member) => member.userId === currentLead.ownerId)?.user ?? null,
      usedFallback: false,
    };
  }

  let newOwner: {
    id: string;
    firstName: string;
    lastName: string;
    profile: { name: string } | null;
  } | null = null;
  let usedFallback = false;

  if (activeOwners.length > 0) {
    const previousPointer = activeOwners.find((member) => member.pointer > 0)?.sortOrder ?? 0;
    const selected = selectNextSequenceMember(
      activeOwners.map((member) => ({ ...member, sequenceId: member.sortOrder })),
      previousPointer,
    );
    if (!selected) throw new Error('BOOKED_BUCKET_NO_ELIGIBLE_OWNER');
    newOwner = selected.user;
    await tx.bookedBucketMember.updateMany({
      where: { tenantId: lead.tenantId, isActive: true },
      data: { pointer: 0 },
    });
    await tx.bookedBucketMember.update({
      where: { id: selected.id },
      data: { pointer: 1 },
    });
  } else {
    newOwner = await getAdminFallback(tx, lead.tenantId, setting.fallbackUserId);
    usedFallback = true;
  }

  if (!newOwner) throw new Error('BOOKED_BUCKET_ADMIN_FALLBACK_NOT_FOUND');
  if (newOwner.id === currentLead.ownerId) {
    if (usedFallback) {
      await tx.lead.update({
        where: { id: currentLead.id },
        data: {
          bookedById: currentLead.bookedById ?? currentLead.ownerId,
          customFields: {
            ...asObject(currentLead.customFields),
            bookedBucketAssignment: 'ADMIN_FALLBACK',
          },
        },
      });
    } else if (!currentLead.bookedById) {
      await tx.lead.update({ where: { id: currentLead.id }, data: { bookedById: currentLead.ownerId } });
    }
    return { moved: false, owner: newOwner, usedFallback };
  }

  const customFields = {
    ...asObject(currentLead.customFields),
    ...(usedFallback ? { bookedBucketAssignment: 'ADMIN_FALLBACK' } : {}),
  };
  await tx.lead.update({
    where: { id: currentLead.id },
    data: {
      ownerId: newOwner.id,
      bookedById: currentLead.bookedById ?? currentLead.ownerId,
      customFields,
    },
  });
  if (setting.moveOpenFollowUps) {
    await tx.followUp.updateMany({
      where: {
        tenantId: lead.tenantId,
        leadId: currentLead.id,
        isCompleted: false,
        isMissed: false,
        status: { notIn: ['COMPLETED', 'CANCELLED'] },
      },
      data: { ownerId: newOwner.id, assignedToId: newOwner.id },
    });
  }

  await createOwnerHistory({
    tenantId: lead.tenantId,
    leadId: currentLead.id,
    previousOwnerId: currentLead.ownerId,
    newOwnerId: newOwner.id,
    previousProfile: currentLead.owner?.profile?.name ?? null,
    newProfile: newOwner.profile?.name ?? null,
    previousStatus: currentLead.status,
    newStatus: currentLead.status,
    handoffReason: source === 'backfill' ? 'Backfill to Booked Bucket' : 'Moved to Booked Bucket',
    source,
    changedById: actorId,
  }, tx);

  await tx.auditLog.create({
    data: {
      tenantId: lead.tenantId,
      userId: actorId,
      leadId: currentLead.id,
      action: 'LEAD_MOVED_TO_BOOKED_BUCKET',
      objectType: 'Lead',
      objectId: currentLead.id,
      oldValues: { ownerId: currentLead.ownerId },
      newValues: {
        ownerId: newOwner.id,
        bookedById: currentLead.bookedById ?? currentLead.ownerId,
        source,
        usedAdminFallback: usedFallback,
      },
    },
  });

  await appendLeadProcessNote(tx, {
    tenantId: lead.tenantId,
    leadId: currentLead.id,
    userId: actorId,
    content: `Moved lead ${currentLead.leadNumber} to Booked Bucket owner ${fullName(newOwner)} from ${source}${usedFallback ? ' (Assigned by Admin fallback)' : ''}.`,
  });

  if (source !== 'import') {
    await tx.notification.create({
      data: {
        tenantId: lead.tenantId,
        userId: newOwner.id,
        title: 'Booked lead assigned to you',
        message: `Lead ${currentLead.leadNumber} was moved to the Booked Bucket.`,
        type: 'LEAD_ASSIGNED',
        referenceId: currentLead.id,
        referenceType: 'Lead',
      },
    });
  }

  return { moved: true, owner: newOwner, usedFallback };
}

export async function getBookedBucketDefaultFallback(tenantId: string) {
  return prisma.user.findFirst({
    where: { tenantId, isActive: true, isSuperAdmin: false, profile: { isAdmin: true } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, firstName: true, lastName: true, phone: true, profile: { select: { name: true } } },
  });
}
