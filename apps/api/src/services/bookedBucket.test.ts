import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';

const mocks = vi.hoisted(() => ({
  fallbackUser: vi.fn(),
  createOwnerHistory: vi.fn(),
  appendLeadProcessNote: vi.fn(),
}));

vi.mock('@dct-crm/db', () => ({
  prisma: { user: { findFirst: mocks.fallbackUser } },
}));
vi.mock('./ownerHistory', () => ({ createOwnerHistory: mocks.createOwnerHistory }));
vi.mock('./leadNotes', () => ({ appendLeadProcessNote: mocks.appendLeadProcessNote }));

import { moveLeadToBookedBucket } from './bookedBucket';

function makeLead(ownerId = 'previous-owner') {
  return {
    id: 'lead-a',
    tenantId: 'tenant-a',
    leadNumber: 'LN000001',
    ownerId,
    bookedById: null,
    status: 'BOOKED',
    customFields: {},
    owner: {
      id: ownerId,
      firstName: 'Previous',
      lastName: 'Owner',
      profile: { name: 'Sales' },
    },
  };
}

function makeMember(id: string, userId: string, sortOrder: number, pointer: number) {
  return {
    id,
    userId,
    sortOrder,
    pointer,
    user: {
      id: userId,
      firstName: `User ${sortOrder}`,
      lastName: 'Bucket',
      profile: { name: 'Post-Sales' },
    },
  };
}

function makeTransaction(setting: Record<string, unknown>, ownerId = 'previous-owner') {
  const lead = makeLead(ownerId);
  const tx = {
    lead: {
      findFirst: vi.fn()
        .mockResolvedValueOnce({ tenantId: 'tenant-a' })
        .mockResolvedValueOnce(lead),
      update: vi.fn().mockResolvedValue({}),
    },
    bookedBucketSetting: {
      upsert: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(setting),
    },
    bookedBucketMember: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    followUp: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    notification: { create: vi.fn().mockResolvedValue({}) },
    user: { findFirst: mocks.fallbackUser },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  return { tx: tx as unknown as Prisma.TransactionClient, lead, operations: tx };
}

describe('moveLeadToBookedBucket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rotates to the next active member and preserves the previous owner', async () => {
    const first = makeMember('member-1', 'bucket-owner-1', 1, 1);
    const second = makeMember('member-2', 'bucket-owner-2', 2, 0);
    const { tx, operations } = makeTransaction({
      isActive: true,
      fallbackUserId: null,
      moveOpenFollowUps: false,
      members: [first, second],
    });

    const result = await moveLeadToBookedBucket('lead-a', 'booking', tx, 'admin-a');

    expect(result).toMatchObject({ moved: true, owner: second.user, usedFallback: false });
    expect(operations.$queryRaw).toHaveBeenCalledOnce();
    expect(operations.bookedBucketMember.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-a', isActive: true },
      data: { pointer: 0 },
    });
    expect(operations.bookedBucketMember.update).toHaveBeenCalledWith({
      where: { id: 'member-2' },
      data: { pointer: 1 },
    });
    expect(operations.lead.update).toHaveBeenCalledWith({
      where: { id: 'lead-a' },
      data: { ownerId: 'bucket-owner-2', bookedById: 'previous-owner', customFields: {} },
    });
    expect(mocks.createOwnerHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        previousOwnerId: 'previous-owner',
        newOwnerId: 'bucket-owner-2',
        handoffReason: 'Moved to Booked Bucket',
        source: 'booking',
      }),
      tx,
    );
    expect(operations.notification.create).toHaveBeenCalledOnce();
  });

  it('uses the administrator fallback when the active bucket has no owners', async () => {
    mocks.fallbackUser.mockResolvedValue({
      id: 'admin-a',
      firstName: 'Company',
      lastName: 'Admin',
      profile: { name: 'Administrator' },
    });
    const { tx, operations } = makeTransaction({
      isActive: true,
      fallbackUserId: 'admin-a',
      moveOpenFollowUps: false,
      members: [],
    });

    const result = await moveLeadToBookedBucket('lead-a', 'import', tx, 'admin-a');

    expect(result).toMatchObject({ moved: true, owner: { id: 'admin-a' }, usedFallback: true });
    expect(operations.lead.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        ownerId: 'admin-a',
        bookedById: 'previous-owner',
        customFields: { bookedBucketAssignment: 'ADMIN_FALLBACK' },
      }),
    }));
    expect(operations.notification.create).not.toHaveBeenCalled();
  });

  it('records backfilled ownership with the backfill history reason', async () => {
    const member = makeMember('member-1', 'bucket-owner-1', 1, 0);
    const { tx } = makeTransaction({
      isActive: true,
      fallbackUserId: null,
      moveOpenFollowUps: false,
      members: [member],
    });

    await moveLeadToBookedBucket('lead-a', 'backfill', tx, 'admin-a');

    expect(mocks.createOwnerHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        handoffReason: 'Backfill to Booked Bucket',
        source: 'backfill',
      }),
      tx,
    );
  });

  it('does not reassign an already bucket-owned lead', async () => {
    const member = makeMember('member-1', 'bucket-owner-1', 1, 1);
    const { tx, operations } = makeTransaction({
      isActive: true,
      fallbackUserId: null,
      moveOpenFollowUps: false,
      members: [member],
    }, 'bucket-owner-1');

    const result = await moveLeadToBookedBucket('lead-a', 'booking', tx, 'admin-a');

    expect(result).toMatchObject({ moved: false, owner: member.user, usedFallback: false });
    expect(operations.lead.update).toHaveBeenCalledWith({
      where: { id: 'lead-a' },
      data: { bookedById: 'bucket-owner-1' },
    });
    expect(operations.bookedBucketMember.update).not.toHaveBeenCalled();
    expect(operations.notification.create).not.toHaveBeenCalled();
  });

  it('leaves ownership unchanged when the bucket is inactive', async () => {
    const { tx, operations } = makeTransaction({
      isActive: false,
      fallbackUserId: null,
      moveOpenFollowUps: false,
      members: [],
    });

    const result = await moveLeadToBookedBucket('lead-a', 'booking', tx, 'admin-a');

    expect(result).toEqual({ moved: false, owner: null, usedFallback: false });
    expect(operations.lead.update).not.toHaveBeenCalled();
    expect(operations.notification.create).not.toHaveBeenCalled();
  });
});
