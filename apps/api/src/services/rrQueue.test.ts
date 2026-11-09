import { describe, expect, it, vi } from 'vitest';
import {
  assignLeadToProjectRoundRobinInTransaction,
  assignCompletedSiteVisitToSalesInTransaction,
  assignSiteVisitToSVCInTransaction,
  calculateQueueMatchScore,
  findApplicableRRQueue,
  findProjectRRQueue,
  getLeadSourceHierarchy,
  getTertiarySourceHierarchy,
  hasLeadAssignmentRelevantChanges,
  RoundRobinAssignmentService,
  rrQueueCriteriaForLead,
  selectNextProjectRRMemberInTransaction,
  selectNextSequenceMember,
} from './rrQueue';

function mockTransaction() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'queue-1' }]),
    siteVisit: { findFirst: vi.fn(), update: vi.fn() },
    rRQueue: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
    rRQueueMember: { update: vi.fn() },
    lead: { findFirst: vi.fn(), update: vi.fn() },
    user: { findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
    rRQueueHistory: { create: vi.fn(), createMany: vi.fn() },
    leadOwnerHistory: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn(), update: vi.fn() },
  } as any;
}

const completedVisit = (overrides: Record<string, unknown> = {}) => ({
  id: 'visit-1',
  tenantId: 'tenant-1',
  leadId: 'lead-1',
  projectId: 'project-1',
  status: 'COMPLETED',
  completedAt: new Date('2026-10-04T10:00:00Z'),
  completedById: 'gre-user',
  salesHandoffAt: null,
  salesHandoffQueueId: null,
  lead: {
    id: 'lead-1',
    ownerId: 'svc-user',
    status: 'SITE_VISIT_HAPPENED',
    owner: { profile: { name: 'SVC' } },
  },
  project: { id: 'project-1', name: 'DCT Heights' },
  ...overrides,
});

const salesQueue = () => ({
  id: 'sales-queue',
  tenantId: 'tenant-1',
  projectId: 'project-1',
  active: true,
  previousId: 0,
  leadCount: 0,
  defaultOwnerId: null,
  ownerId: null,
  members: [{
    id: 'member-1',
    name: 'UID-0001',
    userId: 'sales-user',
    userType: 'Sales',
    sequenceId: 1,
    activeMember: true,
    isAvailable: true,
    isWorking: true,
    weekOff: false,
    maxLeadCapacity: -1,
    currentLeadCount: 0,
    user: {
      id: 'sales-user',
      firstName: 'Sales',
      lastName: 'Executive',
      email: 'sales@example.test',
      isActive: true,
      profile: { name: 'Sales Executive' },
    },
  }],
});

const svcQueue = () => {
  const queue = salesQueue();
  queue.id = 'svc-queue';
  queue.members = [{
    ...queue.members[0],
    id: 'svc-member',
    userId: 'svc-user',
    userType: 'SVC',
    user: {
      ...queue.members[0].user,
      id: 'svc-user',
      firstName: 'Service',
      lastName: 'Consultant',
      email: 'svc@example.test',
      profile: { name: 'SVC' },
    },
  }];
  return queue;
};

describe('calculateQueueMatchScore', () => {
  it('favors the queue with the highest weighted match and source hierarchy', () => {
    const lead = {
      projectId: 'proj-1',
      projectName: 'Sameera Iris',
      status: 'NEW',
      priority: 'HOT',
      source: 'FACEBOOK',
      secondarySource: 'INSTAGRAM',
      tertiarySource: 'Campaign A',
    };

    const queueA = {
      leadStatus: ['NEW'],
      leadPriority: ['HOT'],
      leadSource: ['FACEBOOK'],
      secondarySource: ['INSTAGRAM'],
      tertiarySource: ['Campaign A'],
      projectInterested: ['Sameera Iris'],
    };

    const queueB = {
      leadStatus: ['NEW'],
      leadSource: ['FACEBOOK'],
      projectInterested: ['Sameera Iris'],
    };

    expect(calculateQueueMatchScore(queueA, lead)).toBeGreaterThan(calculateQueueMatchScore(queueB, lead));
    expect(calculateQueueMatchScore(queueA, lead)).toBe(1_111_110);
  });

  it('respects no-source fallback exclusions', () => {
    const lead = { status: 'NEW', source: 'INSTAGRAM', projectId: 'proj-1', projectName: 'Sameera Iris' };
    const queue = {
      leadStatus: ['NEW'],
      leadSource: ['FACEBOOK', 'GOOGLE', 'NO SOURCE'],
      excludeFromNoSource: ['INSTAGRAM'],
      projectInterested: ['Sameera Iris'],
    };

    expect(calculateQueueMatchScore(queue, lead)).toBe(990_010);
  });

  it('does not match an explicitly project-scoped queue to another project', () => {
    expect(calculateQueueMatchScore(
      { projectId: 'heights-id', projectInterested: [] },
      { projectId: 'iris-id', projectName: 'Sameera Iris' },
    )).toBeLessThan(0);
  });
});

describe('findApplicableRRQueue', () => {
  it('picks the best-scoring queue from a shortlist', async () => {
    const queues = [
      { id: 'q-1', createdAt: new Date('2024-01-01'), leadStatus: ['NEW'], leadSource: ['FACEBOOK'], projectInterested: ['Sameera Iris'] },
      { id: 'q-2', createdAt: new Date('2024-01-02'), leadStatus: ['NEW'], leadPriority: ['HOT'], leadSource: ['FACEBOOK'], projectInterested: ['Sameera Iris'] },
      { id: 'q-3', createdAt: new Date('2024-01-03'), leadStatus: ['NEW'], leadSource: ['FACEBOOK'], projectInterested: ['Other Project'] },
    ];

    const tx = {
      rRQueue: { findMany: async () => queues },
      project: { findFirst: async () => ({ name: 'Sameera Iris' }) },
    } as any;

    const result = await findApplicableRRQueue('tenant-1', { projectId: 'proj-1', status: 'NEW', source: 'FACEBOOK', priority: 'HOT' }, tx);
    expect(result?.id).toBe('q-2');
  });

  it('does not route a lead to a queue whose configured source mismatches', async () => {
    const queues = [{
      id: 'q-facebook',
      projectId: 'proj-1',
      leadStatus: ['NEW'],
      leadSource: ['FACEBOOK'],
    }];
    const tx = {
      rRQueue: { findMany: async () => queues },
      project: { findFirst: async () => ({ name: 'Sameera Iris' }) },
    } as any;

    const result = await findApplicableRRQueue('tenant-1', {
      projectId: 'proj-1',
      status: 'NEW',
      source: 'WEBSITE',
    }, tx);

    expect(result).toBeNull();
  });
});

describe('findProjectRRQueue', () => {
  it('selects the project queue that matches the lead status and source', async () => {
    const queues = [
      { id: 'q-facebook', projectId: 'project-1', leadStatus: ['NEW'], leadSource: ['FACEBOOK'] },
      { id: 'q-website', projectId: 'project-1', leadStatus: ['NEW'], leadSource: ['WEBSITE'] },
    ];
    const tx = { rRQueue: { findMany: vi.fn().mockResolvedValue(queues) } } as any;

    const result = await findProjectRRQueue('tenant-1', 'project-1', 'SVC', tx, {
      status: 'NEW',
      source: 'WEBSITE',
    });

    expect(result?.id).toBe('q-website');
  });

  it('matches a project-interested queue to the correct project, source, and requested member type', async () => {
    const queues = [
      {
        id: 'q-other-project',
        projectId: null,
        projectInterested: ['DCT Valley'],
        leadSource: ['WEBSITE'],
      },
      {
        id: 'q-facebook',
        projectId: null,
        projectInterested: ['DCT Heights'],
        leadSource: ['FACEBOOK'],
      },
      {
        id: 'q-heights-website-svc',
        projectId: null,
        projectInterested: ['DCT Heights'],
        leadSource: ['WEBSITE'],
        members: [{ userType: 'SVC' }],
      },
    ];
    const tx = {
      rRQueue: { findMany: vi.fn().mockResolvedValue(queues) },
      project: { findFirst: vi.fn().mockResolvedValue({ name: 'DCT Heights' }) },
    } as any;

    const result = await findProjectRRQueue('tenant-1', 'heights-id', 'SVC', tx, {
      status: 'PROSPECT',
      source: 'WEBSITE',
    });

    expect(result?.id).toBe('q-heights-website-svc');
    expect(tx.rRQueue.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 'tenant-1', active: true, members: { some: { userType: 'SVC' } } },
    }));
  });

  it('uses last source of enquiry before the Lead source enum for routing', () => {
    expect(getLeadSourceHierarchy({ source: 'WEBSITE', lastSource: 'GOOGLE ADS' })).toBe('GOOGLE ADS');
    expect(getTertiarySourceHierarchy({ lastCampaign: 'Campaign A' })).toBe('Campaign A');
  });

  it('matches a workflow queue by project and source even when its status is a different workflow stage', async () => {
    const queue = {
      ...svcQueue(),
      projectId: 'project-1',
      leadStatus: ['NEW'],
      leadSource: ['WEBSITE'],
    };
    const tx = { rRQueue: { findMany: vi.fn().mockResolvedValue([queue]) } } as any;

    const selected = await findProjectRRQueue(
      'tenant-1',
      'project-1',
      'SVC',
      tx,
      rrQueueCriteriaForLead({ projectId: 'project-1', status: 'INCOMING', lastSource: 'WEBSITE' }),
    );

    expect(selected?.id).toBe('svc-queue');
  });

  it('does not route a lead when no project queue matches its configured criteria', async () => {
    const tx = {
      rRQueue: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'q-facebook', projectId: 'project-1', leadStatus: ['NEW'], leadSource: ['FACEBOOK'] },
        ]),
      },
    } as any;

    const result = await findProjectRRQueue('tenant-1', 'project-1', 'SVC', tx, {
      status: 'NEW',
      source: 'WEBSITE',
    });

    expect(result).toBeNull();
  });

  it('assigns CRM from the project queue when the latest enquiry source is outside the queue sources', async () => {
    const queue = {
      id: 'q-paradise',
      projectId: 'project-paradise',
      leadSource: ['FACEBOOK', 'WEBSITE', 'REFERRAL'],
      previousId: 0,
      members: [{
        id: 'crm-member',
        name: 'UID-0015',
        userId: 'crm-user',
        userType: 'CRM',
        sequenceId: 1,
        activeMember: true,
        isAvailable: true,
        isWorking: true,
        weekOff: false,
        maxLeadCapacity: -1,
        currentLeadCount: 0,
        user: {
          id: 'crm-user',
          firstName: 'Crm',
          lastName: 'Test',
          email: 'crm@example.test',
          isActive: true,
          profile: { name: 'CRM' },
        },
      }],
    };
    const tx = {
      ...mockTransaction(),
      rRQueue: {
        findMany: vi.fn().mockResolvedValue([queue]),
        findFirst: vi.fn().mockResolvedValue(queue),
        update: vi.fn().mockResolvedValue({}),
      },
      rRQueueMember: { update: vi.fn().mockResolvedValue({}) },
    };

    const direct = await findProjectRRQueue(
      'tenant-1',
      'project-paradise',
      'CRM',
      tx,
      rrQueueCriteriaForLead({
        projectId: 'project-paradise',
        status: 'SITE_VISIT_HAPPENED',
        source: 'FACEBOOK',
        lastSource: 'GRE',
      }, 'DCT Paradise'),
    );
    expect(direct).toBeNull();

    const selected = await selectNextProjectRRMemberInTransaction(tx, {
      tenantId: 'tenant-1',
      projectId: 'project-paradise',
      userType: 'CRM',
      criteria: rrQueueCriteriaForLead({
        projectId: 'project-paradise',
        status: 'SITE_VISIT_HAPPENED',
        source: 'FACEBOOK',
        lastSource: 'GRE',
      }, 'DCT Paradise'),
    });

    expect(selected.queue.id).toBe('q-paradise');
    expect(selected.member.userId).toBe('crm-user');
  });
});

describe('selectNextSequenceMember', () => {
  const members = [{ sequenceId: 1 }, { sequenceId: 2 }, { sequenceId: 3 }];

  it('assigns in sequence and wraps', () => {
    expect(selectNextSequenceMember(members, 0)?.sequenceId).toBe(1);
    expect(selectNextSequenceMember(members, 1)?.sequenceId).toBe(2);
    expect(selectNextSequenceMember(members, 2)?.sequenceId).toBe(3);
    expect(selectNextSequenceMember(members, 3)?.sequenceId).toBe(1);
  });

  it('selects only members matching the requested functional user type', async () => {
    const queue = {
      id: 'queue-1',
      previousId: 0,
      defaultOwnerId: null,
      ownerId: null,
      members: [
        { ...salesQueue().members[0], id: 'svc-member', userId: 'svc-user', userType: 'SVC', sequenceId: 1, user: { ...salesQueue().members[0].user, id: 'svc-user', profile: { name: 'SVC' } } },
        { ...salesQueue().members[0], sequenceId: 2 },
      ],
    };
    const tx = { rRQueue: { findFirst: vi.fn().mockResolvedValue(queue) } } as any;

    const sales = await RoundRobinAssignmentService.getNextEligibleMember('queue-1', 'tenant-1', tx, 'Sales');
    const svc = await RoundRobinAssignmentService.getNextEligibleMember('queue-1', 'tenant-1', tx, 'SVC');

    expect(sales.member?.userId).toBe('sales-user');
    expect(svc.member?.userId).toBe('svc-user');
  });

  it('matches tenant-configured profile names without case sensitivity', async () => {
    const queue = salesQueue();
    queue.members[0].user.profile.name = 'Custom Sales';
    const tx = { rRQueue: { findFirst: vi.fn().mockResolvedValue(queue) } } as any;

    const selected = await RoundRobinAssignmentService.getNextEligibleMember(
      'queue-1',
      'tenant-1',
      tx,
      'Sales',
      ['custom sales'],
    );

    expect(selected.member?.userId).toBe('sales-user');
  });

  it('selects and advances a member only from the requested project and user type', async () => {
    const queue = salesQueue();
    const tx = mockTransaction();
    tx.rRQueue.findMany.mockResolvedValue([salesQueue()]);
    tx.rRQueue.findFirst.mockResolvedValue(queue);
    tx.rRQueue.update.mockResolvedValue({});
    tx.rRQueueMember.update.mockResolvedValue({});

    const selected = await selectNextProjectRRMemberInTransaction(tx, {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userType: 'Sales',
    });

    expect(selected.queue.id).toBe('sales-queue');
    expect(selected.member.userId).toBe('sales-user');
    expect(tx.rRQueue.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 'tenant-1', active: true, members: { some: { userType: 'Sales' } } },
    }));
    expect(tx.rRQueue.update).toHaveBeenCalledWith({
      where: { id: 'sales-queue' },
      data: { previousId: 1, leadCount: { increment: 1 } },
    });
  });

  it('does not fall back to another project queue when the requested type is missing', async () => {
    const tx = mockTransaction();
    tx.rRQueue.findMany.mockResolvedValue([]);

    await expect(selectNextProjectRRMemberInTransaction(tx, {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userType: 'CRM',
    })).rejects.toThrow('RR_QUEUE_NOT_CONFIGURED:CRM');
    expect(tx.rRQueue.findMany).toHaveBeenCalledTimes(1);
  });

  it('requires a project before selecting a round-robin member', async () => {
    const tx = mockTransaction();
    await expect(selectNextProjectRRMemberInTransaction(tx, {
      tenantId: 'tenant-1',
      projectId: null,
      userType: 'Pre Sales',
    })).rejects.toThrow('RR_PROJECT_REQUIRED');
    expect(tx.rRQueue.findFirst).not.toHaveBeenCalled();
  });

  it('assigns a lead and rotation state atomically to a project member', async () => {
    const tx = mockTransaction();
    const queue = salesQueue();
    tx.rRQueue.findMany.mockResolvedValue([queue]);
    tx.rRQueue.findFirst.mockResolvedValue(queue);
    tx.rRQueue.update.mockResolvedValue({});
    tx.rRQueueMember.update.mockResolvedValue({});
    tx.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      ownerId: 'old-owner',
      status: 'NEW',
      owner: { profile: { name: 'Admin' } },
    });
    tx.lead.update.mockResolvedValue({});
    tx.user.findFirst.mockResolvedValue({ firstName: 'Admin', lastName: 'User' });
    tx.rRQueueHistory.create.mockResolvedValue({});
    tx.auditLog.create.mockResolvedValue({});

    const assigned = await assignLeadToProjectRoundRobinInTransaction(tx, {
      tenantId: 'tenant-1',
      leadId: 'lead-1',
      projectId: 'project-1',
      userType: 'Sales',
      actorId: 'admin',
      reason: 'Test assignment',
    });

    expect(assigned).toMatchObject({ assignedUserId: 'sales-user', queueId: 'sales-queue' });
    expect(tx.lead.update).toHaveBeenCalledWith({
      where: { id: 'lead-1' },
      data: { ownerId: 'sales-user', rrQueueId: 'sales-queue' },
    });
  });

  it('marks the lead booked when MIS approval asks for that status', async () => {
    const tx = mockTransaction();
    const queue = salesQueue();
    tx.rRQueue.findMany.mockResolvedValue([queue]);
    tx.rRQueue.findFirst.mockResolvedValue(queue);
    tx.rRQueue.update.mockResolvedValue({});
    tx.rRQueueMember.update.mockResolvedValue({});
    tx.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      ownerId: 'sales-user',
      status: 'SITE_VISIT_HAPPENED',
      owner: { profile: { name: 'Sales' } },
    });
    tx.lead.update.mockResolvedValue({});
    tx.rRQueueHistory.create.mockResolvedValue({});
    tx.auditLog.create.mockResolvedValue({});

    await assignLeadToProjectRoundRobinInTransaction(tx, {
      tenantId: 'tenant-1',
      leadId: 'lead-1',
      projectId: 'project-1',
      userType: 'Sales',
      actorId: 'mis-user',
      reason: 'MIS approved',
      leadStatus: 'BOOKED',
    });

    expect(tx.lead.update).toHaveBeenCalledWith({
      where: { id: 'lead-1' },
      data: { ownerId: 'sales-user', rrQueueId: 'sales-queue', status: 'BOOKED' },
    });
    expect(tx.leadOwnerHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        previousStatus: 'SITE_VISIT_HAPPENED',
        newStatus: 'BOOKED',
        newOwnerId: 'sales-user',
      }),
    }));
  });

  it.each(['SVC', 'Recovery', 'CRM', 'Sales'])('%s assignment does not fall back across projects or lead sources', async (userType) => {
    const tx = mockTransaction();
    tx.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      ownerId: 'presales-user',
      status: 'INCOMING',
      owner: { profile: { name: 'Presales' } },
      lastSource: 'WEBSITE',
    });
    tx.rRQueue.findMany.mockResolvedValue([{
      ...svcQueue(),
      projectId: null,
      projectInterested: ['Another Project'],
      leadSource: ['FACEBOOK'],
    }]);
    await expect(assignLeadToProjectRoundRobinInTransaction(tx, {
      tenantId: 'tenant-1',
      leadId: 'lead-1',
      projectId: 'project-1',
      userType: userType as any,
      actorId: 'admin',
      reason: 'Test assignment',
    })).rejects.toThrow(`RR_QUEUE_NOT_CONFIGURED:${userType}`);
    expect(tx.lead.update).not.toHaveBeenCalled();
  });

  describe('SVC to Sales site visit handoff', () => {
    it('assigns scheduled visits and the lead only to the project SVC member', async () => {
      const tx = mockTransaction();
      tx.siteVisit.findFirst.mockResolvedValue({
        ...completedVisit({ status: 'SCHEDULED', completedAt: null, completedById: null }),
        lead: {
          id: 'lead-1',
          ownerId: 'sales-user',
          status: 'PROSPECT',
          owner: { profile: { name: 'Sales Executive' } },
        },
      });
      tx.rRQueue.findMany.mockResolvedValue([svcQueue()]);
      tx.rRQueue.findFirst.mockResolvedValue(svcQueue());
      tx.rRQueue.update.mockResolvedValue({});
      tx.rRQueueMember.update.mockResolvedValue({});
      tx.user.findFirst.mockResolvedValue({ profile: { name: 'Sales Executive' } });

      const result = await assignSiteVisitToSVCInTransaction(tx, {
        siteVisitId: 'visit-1',
        tenantId: 'tenant-1',
        actorId: 'svc-user',
      });

      expect(result.assignedUserId).toBe('svc-user');
      expect(tx.lead.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ ownerId: 'svc-user' }),
      }));
      expect(tx.siteVisit.update).toHaveBeenCalledWith(expect.objectContaining({
        data: { assigneeId: 'svc-user' },
      }));
      expect(tx.rRQueue.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { tenantId: 'tenant-1', active: true, members: { some: { userType: 'SVC' } } },
      }));
    });

    it('does not fall back to the actor when a project has no SVC queue', async () => {
      const tx = mockTransaction();
      tx.siteVisit.findFirst.mockResolvedValue(completedVisit({ status: 'SCHEDULED', completedAt: null, completedById: null }));
      tx.rRQueue.findMany.mockResolvedValue([]);

      await expect(assignSiteVisitToSVCInTransaction(tx, {
        siteVisitId: 'visit-1',
        tenantId: 'tenant-1',
        actorId: 'svc-user',
      })).rejects.toThrow('SVC_QUEUE_NOT_CONFIGURED');
      expect(tx.lead.update).not.toHaveBeenCalled();
    });

    it('assigns only to the Sales queue matching the completed visit project', async () => {
      const tx = mockTransaction();
      const queue = salesQueue();
      tx.siteVisit.findFirst.mockResolvedValue(completedVisit());
      tx.rRQueue.findMany.mockResolvedValue([queue]);
      tx.rRQueue.findFirst.mockResolvedValue(queue);
      tx.user.findFirst.mockResolvedValue({ profile: { name: 'SVC' } });

      const result = await assignCompletedSiteVisitToSalesInTransaction(tx, 'visit-1', 'tenant-1');

      expect(result).toMatchObject({ assignedUserId: 'sales-user', queueId: 'sales-queue', pendingReason: null });
      expect(tx.rRQueue.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { tenantId: 'tenant-1', active: true, members: { some: { userType: 'Sales' } } },
      }));
      expect(tx.lead.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'lead-1' },
        data: { ownerId: 'sales-user', rrQueueId: 'sales-queue' },
      }));
      expect(tx.rRQueue.update).toHaveBeenCalledWith(expect.objectContaining({
        data: { previousId: 1, leadCount: { increment: 1 } },
      }));
      expect(tx.rRQueueMember.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ lastAssignedAt: expect.any(Date), currentLeadCount: { increment: 1 } }),
      }));
      expect(tx.siteVisit.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ assigneeId: 'sales-user', salesHandoffQueueId: 'sales-queue', salesHandoffPendingReason: null }),
      }));
    });

    it('leaves a completed visit pending instead of selecting an unrelated project queue', async () => {
      const tx = mockTransaction();
      tx.siteVisit.findFirst.mockResolvedValue(completedVisit());
      tx.rRQueue.findMany.mockResolvedValue([]);

      const result = await assignCompletedSiteVisitToSalesInTransaction(tx, 'visit-1', 'tenant-1');

      expect(result.assignedUserId).toBeNull();
      expect(result.pendingReason).toContain('No active Sales Round Robin queue');
      expect(tx.lead.update).not.toHaveBeenCalled();
      expect(tx.siteVisit.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ salesHandoffPendingReason: result.pendingReason }),
      }));
    });

    it('does not reassign a site visit already handed off', async () => {
      const tx = mockTransaction();
      tx.siteVisit.findFirst.mockResolvedValue(completedVisit({
        salesHandoffAt: new Date(),
        salesHandoffQueueId: 'sales-queue',
        lead: {
          id: 'lead-1',
          ownerId: 'sales-user',
          status: 'SITE_VISIT_HAPPENED',
          owner: { profile: { name: 'Sales Executive' } },
        },
      }));

      const result = await assignCompletedSiteVisitToSalesInTransaction(tx, 'visit-1', 'tenant-1');

      expect(result).toMatchObject({ alreadyAssigned: true, assignedUserId: 'sales-user', queueId: 'sales-queue' });
      expect(tx.rRQueue.findFirst).not.toHaveBeenCalled();
      expect(tx.lead.update).not.toHaveBeenCalled();
    });

    it('does not send an unavailable or inactive member to Sales', async () => {
      const tx = mockTransaction();
      const queue = salesQueue();
      queue.members[0].isAvailable = false;
      tx.siteVisit.findFirst.mockResolvedValue(completedVisit());
      tx.rRQueue.findMany.mockResolvedValue([queue]);
      tx.rRQueue.findFirst.mockResolvedValue(queue);

      const result = await assignCompletedSiteVisitToSalesInTransaction(tx, 'visit-1', 'tenant-1');

      expect(result.assignedUserId).toBeNull();
      expect(result.pendingReason).toContain('unavailable');
      expect(tx.lead.update).not.toHaveBeenCalled();
    });

    it('rejects non-completed visits from triggering Sales assignment', async () => {
      const tx = mockTransaction();
      tx.siteVisit.findFirst.mockResolvedValue(completedVisit({ status: 'SCHEDULED' }));

      await expect(assignCompletedSiteVisitToSalesInTransaction(tx, 'visit-1', 'tenant-1'))
        .rejects.toThrow('SITE_VISIT_NOT_GRE_COMPLETED');
      expect(tx.rRQueue.findMany).not.toHaveBeenCalled();
    });
  });

  describe('hasLeadAssignmentRelevantChanges', () => {
    it('only requests reassignment when assignment criteria changed', () => {
      expect(hasLeadAssignmentRelevantChanges({ lastName: 'Updated' })).toBe(false);
      expect(hasLeadAssignmentRelevantChanges({ status: 'PROSPECT' })).toBe(true);
      expect(hasLeadAssignmentRelevantChanges({ ownerId: null })).toBe(true);
      expect(hasLeadAssignmentRelevantChanges({ projectId: null })).toBe(true);
      expect(hasLeadAssignmentRelevantChanges({ source: 'WEBSITE' })).toBe(true);
    });
  });

  it('skips inactive members supplied by the caller', () => {
    const active = members.filter((member) => member.sequenceId !== 2);
    expect(selectNextSequenceMember(active, 1)?.sequenceId).toBe(3);
    expect(selectNextSequenceMember(active, 3)?.sequenceId).toBe(1);
  });

  it('does not select by lead count or random order', () => {
    const unordered = [{ sequenceId: 3 }, { sequenceId: 1 }, { sequenceId: 2 }];
    expect(selectNextSequenceMember(unordered, 1)?.sequenceId).toBe(2);
  });

  it('returns no member when every member is inactive', () => {
    expect(selectNextSequenceMember([], 2)).toBeNull();
  });

  it('continues from the next active sequence after a member is removed', () => {
    expect(selectNextSequenceMember([{ sequenceId: 1 }, { sequenceId: 3 }], 1)?.sequenceId).toBe(3);
    expect(selectNextSequenceMember([{ sequenceId: 1 }, { sequenceId: 3 }], 3)?.sequenceId).toBe(1);
  });
});