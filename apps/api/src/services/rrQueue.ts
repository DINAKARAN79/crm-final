import { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '@dct-crm/db';
import { createOwnerHistory } from './ownerHistory';

export type RRClient = Prisma.TransactionClient | PrismaClient;
export type RRMemberUserType = 'Pre Sales' | 'Sales' | 'Post Sales' | 'Recovery' | 'Channel Partner' | 'SVC' | 'CRM';

export function getRoundRobinProfileNames(userType: string): string[] {
  const profiles: Record<RRMemberUserType, string[]> = {
    'Pre Sales': ['Pre Sales', 'Presales'],
    Sales: ['Sales', 'Sales Executive'],
    'Post Sales': ['Post Sales', 'Post-Sales'],
    Recovery: ['Recovery'],
    'Channel Partner': ['Channel Partner'],
    SVC: ['SVC'],
    CRM: ['CRM'],
  };
  return Object.entries(profiles).find(([type]) => type === userType)?.[1] || [];
}

export function isEligibleRRQueueMember(member: {
  activeMember?: boolean;
  isAvailable?: boolean;
  isWorking?: boolean;
  weekOff?: boolean;
  user?: { isActive?: boolean } | null;
}): boolean {
  return Boolean(
    member.activeMember
    && member.isAvailable
    && member.isWorking
    && !member.weekOff
    && member.user?.isActive,
  );
}

function normalizeText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeText(item))
      .filter((item): item is string => item !== null);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => normalizeText(item))
      .filter((item): item is string => item !== null);
  }
  return [];
}

function matchesValue(value: string | null, list: string[]): boolean {
  if (!value) return false;
  const normalized = value.trim();
  return list.some((entry) => entry.trim().toLowerCase() === normalized.toLowerCase());
}

function isNoSourceQueue(queue: Record<string, any>): boolean {
  const configured = normalizeList(queue?.leadSource ?? queue?.sources ?? queue?.source ?? queue?.leadSources);
  return configured.some((entry) => entry.toLowerCase() === 'no source' || entry.toLowerCase() === 'nosource');
}

function projectMatchesLead(queue: Record<string, any>, projectId: string | null | undefined, projectName: string | null): boolean {
  const exactProjectId = normalizeText(queue?.projectId);
  if (exactProjectId && exactProjectId.toLowerCase() !== (projectId || '').toLowerCase()) return false;
  if (exactProjectId) return true;
  const queueProjects = normalizeList(queue?.projectInterested ?? queue?.projects ?? queue?.project ?? queue?.projectName);
  if (queueProjects.length === 0) return true;
  if (queueProjects.some((entry) => entry.toLowerCase() === 'all' || entry.toLowerCase() === '*' || entry.toLowerCase() === 'all projects')) {
    return true;
  }
  if (!projectId && !projectName) return false;
  return queueProjects.some((entry) => {
    const normalized = entry.toLowerCase();
    return normalized === (projectId || '').toLowerCase() || normalized === (projectName || '').toLowerCase();
  });
}

function hasConfiguredProjectScope(queue: Record<string, any>): boolean {
  return Boolean(
    normalizeText(queue?.projectId) ||
    normalizeList(queue?.projectInterested ?? queue?.projects ?? queue?.project ?? queue?.projectName).length,
  );
}

export function calculateQueueMatchScore(queue: Record<string, any>, lead: Record<string, any>): number {
  const queueStatus = normalizeList(queue?.leadStatus ?? queue?.statuses ?? queue?.status);
  const queuePriority = normalizeList(queue?.leadPriority ?? queue?.priority ?? queue?.priorities);
  const queueSources = normalizeList(queue?.leadSource ?? queue?.sources ?? queue?.source ?? queue?.leadSources);
  const queueSecondary = normalizeList(queue?.secondarySource ?? queue?.secondarySources ?? queue?.secondarySourceList);
  const queueTertiary = normalizeList(queue?.tertiarySource ?? queue?.tertiarySources ?? queue?.tertiarySourceList);
  const queueProjects = normalizeList(queue?.projectInterested ?? queue?.projects ?? queue?.project ?? queue?.projectInterestedList);
  const queueExcludedNoSource = normalizeList(queue?.excludeFromNoSource ?? queue?.excludedSources ?? queue?.excludeFromNoSourceList);

  const leadStatus = normalizeText(lead?.status) ?? '';
  const leadPriority = normalizeText(lead?.priority ?? lead?.rating ?? lead?.leadPriority) ?? '';
  const leadSource = normalizeText(lead?.source ?? lead?.leadSource ?? lead?.lastSourceOfEnquiry) ?? '';
  const leadSecondary = normalizeText(lead?.secondarySource ?? lead?.lastSubSource ?? lead?.secondary) ?? '';
  const leadTertiary = normalizeText(lead?.tertiarySource ?? lead?.lastTertiarySource ?? lead?.tertiary) ?? '';
  const projectId = normalizeText(lead?.projectId);
  const projectName = normalizeText(lead?.project?.name ?? lead?.projectName);

  let score = 0;

  if (queueStatus.length > 0 && !lead?.ignoreStatusCriteria) {
    if (matchesValue(leadStatus, queueStatus)) score += 1_000_000;
    else score -= 1_000_000;
  }

  if (queuePriority.length > 0) {
    if (matchesValue(leadPriority, queuePriority)) score += 100_000;
    else score -= 100_000;
  }

  if (!lead?.ignoreSourceCriteria && queueSources.length > 0) {
    const sourceMatches = matchesValue(leadSource, queueSources);
    const noSourceFallbackAllowed = isNoSourceQueue(queue) && !!leadSource && !sourceMatches && !matchesValue(leadSource, queueExcludedNoSource);
    if (sourceMatches || noSourceFallbackAllowed) score += 10_000;
    else score -= 10_000;
  }

  if (!lead?.ignoreSourceCriteria && queueSecondary.length > 0) {
    if (!leadSecondary) score -= 1_000;
    else if (matchesValue(leadSecondary, queueSecondary)) score += 1_000;
    else score -= 1_000;
  }

  if (!lead?.ignoreSourceCriteria && queueTertiary.length > 0) {
    if (!leadTertiary) score -= 100;
    else if (matchesValue(leadTertiary, queueTertiary)) score += 100;
    else score -= 100;
  }

  if (queueProjects.length > 0) {
    if (projectMatchesLead(queue, projectId, projectName)) score += 10;
    else score -= 10_000;
  } else if (normalizeText(queue?.projectId)) {
    score += projectMatchesLead(queue, projectId, projectName) ? 10 : -10_000;
  } else {
    score += 0.5;
  }

  return score;
}

function matchesConfiguredQueueCriteria(queue: Record<string, any>, lead: Record<string, any>): boolean {
  const status = normalizeList(queue?.leadStatus ?? queue?.statuses ?? queue?.status);
  const priority = normalizeList(queue?.leadPriority ?? queue?.priority ?? queue?.priorities);
  const sources = normalizeList(queue?.leadSource ?? queue?.sources ?? queue?.source ?? queue?.leadSources);
  const secondary = normalizeList(queue?.secondarySource ?? queue?.secondarySources ?? queue?.secondarySourceList);
  const tertiary = normalizeList(queue?.tertiarySource ?? queue?.tertiarySources ?? queue?.tertiarySourceList);
  const leadStatus = normalizeText(lead?.status);
  const leadPriority = normalizeText(lead?.priority ?? lead?.rating ?? lead?.leadPriority);
  const leadSource = normalizeText(lead?.source ?? lead?.leadSource ?? lead?.lastSourceOfEnquiry);
  const leadSecondary = normalizeText(lead?.secondarySource ?? lead?.lastSubSource ?? lead?.secondary);
  const leadTertiary = normalizeText(lead?.tertiarySource ?? lead?.lastTertiarySource ?? lead?.tertiary);

  if (status.length && !lead?.ignoreStatusCriteria && !matchesValue(leadStatus, status)) return false;
  if (priority.length && !matchesValue(leadPriority, priority)) return false;
  if (!lead?.ignoreSourceCriteria && secondary.length && !matchesValue(leadSecondary, secondary)) return false;
  if (!lead?.ignoreSourceCriteria && tertiary.length && !matchesValue(leadTertiary, tertiary)) return false;
  if (!lead?.ignoreSourceCriteria && sources.length) {
    const directSourceMatch = matchesValue(leadSource, sources);
    const noSourceFallback = isNoSourceQueue(queue)
      && !!leadSource
      && !directSourceMatch
      && !matchesValue(leadSource, normalizeList(queue?.excludeFromNoSource ?? queue?.excludedSources ?? queue?.excludeFromNoSourceList));
    if (!directSourceMatch && !noSourceFallback) return false;
  }

  return projectMatchesLead(queue, normalizeText(lead?.projectId), normalizeText(lead?.project?.name ?? lead?.projectName));
}

export function isLeadEligibleForAutoAssignment(lead: Record<string, any> | null | undefined, options: { isNewLead?: boolean; force?: boolean } = {}) {
  if (!lead) return false;
  if (options.force) return true;

  const leadQueueing = lead.leadQueueing === true || lead.lead_Queueing === true || lead.leadQueueing === 'true' || options.isNewLead === true;
  const leadAssigned = lead.leadAssigned === false || lead.lead_Assigned === false || lead.leadAssigned === 'false' || lead.leadReassign === true || lead.lead_Reassign === true;
  const projectPresent = !!(lead.projectId || lead.projectName || lead.project?.name);
  const sourcePresent = !!(lead.lastSourceOfEnquiry || lead.leadSource || lead.source || lead.last_Source_Of_Enquiry);
  const notDuplicate = String(lead.status || '').toUpperCase() !== 'DUPLICATE';

  return Boolean(leadQueueing && leadAssigned && projectPresent && sourcePresent && notDuplicate);
}

export function hasLeadAssignmentRelevantChanges(updateData: Record<string, unknown>): boolean {
  return ['status', 'ownerId', 'projectId', 'source'].some((field) =>
    Object.prototype.hasOwnProperty.call(updateData, field),
  );
}

export function getLeadSourceHierarchy(lead: Record<string, any> | null | undefined): string | null {
  if (!lead) return null;
  return (
    normalizeText(lead.lastSourceOfEnquiry ?? lead.last_Source_Of_Enquiry ?? lead.lastSource)
    ?? normalizeText(lead.leadSource ?? lead.source)
    ?? null
  );
}

export function getSecondarySourceHierarchy(lead: Record<string, any> | null | undefined): string | null {
  if (!lead) return null;
  return normalizeText(lead.lastSubSource ?? lead.last_Sub_Source ?? lead.secondarySource ?? lead.secondary) ?? null;
}

export function getTertiarySourceHierarchy(lead: Record<string, any> | null | undefined): string | null {
  if (!lead) return null;
  return normalizeText(lead.lastTertiarySource ?? lead.last_Tertiary_Source ?? lead.tertiarySource ?? lead.tertiary ?? lead.lastCampaign) ?? null;
}

export function rrQueueCriteriaForLead(lead: Record<string, any>, projectName?: string | null) {
  return {
    projectName: projectName ?? lead.project?.name ?? null,
    status: normalizeText(lead.status),
    ignoreStatusCriteria: true,
    source: getLeadSourceHierarchy(lead),
    secondarySource: getSecondarySourceHierarchy(lead),
    tertiarySource: getTertiarySourceHierarchy(lead),
    priority: normalizeText(lead.priority ?? lead.rating ?? lead.leadPriority),
    category: normalizeText(lead.category),
  };
}

export function selectNextSequenceMember<T extends { sequenceId: number }>(members: T[], previousId: number): T | null {
  const ordered = [...members].sort((left, right) => left.sequenceId - right.sequenceId);
  return ordered.find((member) => member.sequenceId > previousId) || ordered[0] || null;
}

export function getReusableSiteVisitOwner(
  existingLeadId: string | null,
  previousVisit: { projectId: string | null; assigneeId: string | null } | null,
  selectedProjectId: string,
): string | null {
  if (!isSiteVisitRevisit(existingLeadId, previousVisit, selectedProjectId)) return null;
  return previousVisit?.assigneeId ?? null;
}

export function isSiteVisitRevisit(
  existingLeadId: string | null,
  previousVisit: { projectId: string | null } | null,
  selectedProjectId: string,
): boolean {
  return Boolean(existingLeadId && previousVisit && previousVisit.projectId === selectedProjectId);
}

export function isNewProjectSiteVisit(
  existingLeadId: string | null,
  latestVisit: { projectId: string | null } | null,
  selectedProjectId: string,
): boolean {
  return Boolean(existingLeadId && latestVisit && latestVisit.projectId !== selectedProjectId);
}

export class RoundRobinAssignmentService {
  static async getActiveMembers(queueId: string, tenantId: string, tx: RRClient = prisma) {
    return tx.rRQueueMember.findMany({
      where: { rrQueueId: queueId, tenantId, activeMember: true, user: { isActive: true } },
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true, isActive: true } } },
      orderBy: { sequenceId: 'asc' },
    });
  }

  static async getQueueState(queueId: string, tenantId: string, tx: RRClient = prisma) {
    const queue = await tx.rRQueue.findFirst({
      where: { id: queueId, tenantId },
      include: { members: { include: { user: { select: { id: true, firstName: true, lastName: true, email: true, isActive: true, profile: { select: { name: true } } } } }, orderBy: { sequenceId: 'asc' } } },
    });
    if (!queue) return null;
    const activeMembers = queue.members.filter(isEligibleRRQueueMember);
    return { ...queue, noOfUsers: activeMembers.length, activeMembers };
  }

  static async getNextMember(queueId: string, tenantId: string, tx: RRClient = prisma, userType: RRMemberUserType = 'Sales') {
    const state = await this.getNextEligibleMember(queueId, tenantId, tx, userType);
    return state.member;
  }

  static async getNextEligibleMember(
    queueId: string,
    tenantId: string,
    tx: RRClient = prisma,
    userType: RRMemberUserType = 'Sales',
    profileNames?: string[],
  ) {
    const queue = await tx.rRQueue.findFirst({
      where: { id: queueId, tenantId },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                isActive: true,
                profile: { select: { name: true } },
              },
            },
          },
          orderBy: { sequenceId: 'asc' },
        },
      },
    });
    if (!queue) throw new Error('RR_QUEUE_NOT_FOUND');

    const members = [...queue.members].sort((a, b) => a.sequenceId - b.sequenceId);
    if (members.length === 0) return { member: null, skipped: ['No queue members configured'], fallbackOwnerId: queue.defaultOwnerId || queue.ownerId || null };

    const maxAttempts = Math.max(2, members.length * 2);
    const skipped: string[] = [];
    const eligibleProfiles = (profileNames === undefined ? getRoundRobinProfileNames(userType) : profileNames)
      .map((name) => name.trim().toLocaleLowerCase())
      .filter(Boolean);
    const startIndex = members.findIndex((member) => member.sequenceId > queue.previousId) >= 0
      ? members.findIndex((member) => member.sequenceId > queue.previousId)
      : 0;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const candidate = members[(startIndex + attempt) % members.length];
      if (!candidate) continue;
      if (candidate.userType !== userType) {
        skipped.push(`${candidate.name}: wrong user type`);
        continue;
      }
      if (!candidate.activeMember) {
        skipped.push(`${candidate.name}: member inactive`);
        continue;
      }
      if (!candidate.user?.isActive) {
        skipped.push(`${candidate.name}: user inactive`);
        continue;
      }
      if (!eligibleProfiles.includes((candidate.user.profile?.name || '').trim().toLocaleLowerCase())) {
        skipped.push(`${candidate.name}: user profile is not eligible for ${userType}`);
        continue;
      }
      if (!candidate.isAvailable || !candidate.isWorking || candidate.weekOff) {
        skipped.push(`${candidate.name}: unavailable, not working, or on week off`);
        continue;
      }
      const maxLeads = Number((candidate as any)?.maxLeadCapacity ?? (candidate as any)?.maxLeads ?? -1);
      const currentLeadCount = Number((candidate as any)?.currentLeadCount ?? 0);
      if (maxLeads >= 0 && currentLeadCount >= maxLeads) {
        skipped.push(`${candidate.name}: reached lead limit`);
        continue;
      }
      return { member: candidate, skipped, fallbackOwnerId: queue.defaultOwnerId || queue.ownerId || null };
    }

    return { member: null, skipped, fallbackOwnerId: queue.defaultOwnerId || queue.ownerId || null };
  }

  private static async selectQueueMemberInTransaction(
    tx: Prisma.TransactionClient,
    queueId: string,
    tenantId: string,
  ) {
    const queue = await tx.rRQueue.findFirst({
      where: { id: queueId, tenantId, active: true },
    });
    if (!queue) throw new Error('RR_QUEUE_NOT_FOUND');

    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "RRQueue"
      WHERE "id" = ${queueId} AND "tenantId" = ${tenantId} AND "active" = TRUE
      FOR UPDATE
    `);

    const userType: RRMemberUserType = queue.presalesQueue ? 'Pre Sales' : 'Sales';
    const next = await this.getNextEligibleMember(queueId, tenantId, tx, userType);
    if (!next.member) throw new Error('NO_ELIGIBLE_USER');
    return { queue, member: next.member };
  }

  static async assignLeadInTransaction(
    tx: Prisma.TransactionClient,
    queueId: string,
    leadId: string,
    tenantId: string,
    actorId?: string,
  ) {
    const { queue, member } = await this.selectQueueMemberInTransaction(tx, queueId, tenantId);
    const lead = await tx.lead.findFirst({
      where: { id: leadId, tenantId },
      include: { owner: { include: { profile: { select: { name: true } } } } },
    });
    if (!lead) throw new Error('LEAD_NOT_FOUND');

    await tx.rRQueue.update({
      where: { id: queue.id },
      data: { previousId: member.sequenceId, leadCount: { increment: 1 } },
    });
    await tx.rRQueueMember.update({
      where: { id: member.id },
      data: { lastAssignedAt: new Date(), currentLeadCount: { increment: 1 } },
    });
    await tx.lead.update({
      where: { id: lead.id },
      data: { ownerId: member.userId, rrQueueId: queue.id },
    });

    if (lead.ownerId !== member.userId) {
      await createOwnerHistory({
        tenantId,
        leadId: lead.id,
        previousOwnerId: lead.ownerId,
        newOwnerId: member.userId,
        previousProfile: lead.owner?.profile?.name || null,
        newProfile: member.user.profile?.name || null,
        previousStatus: lead.status,
        newStatus: lead.status,
        handoffReason: 'Round Robin assignment',
        changedById: actorId || lead.creatorId,
      }, tx);
    }

    await tx.rRQueueHistory.create({
      data: {
        tenantId,
        rrQueueId: queue.id,
        leadId: lead.id,
        field: 'Lead Owner',
        userId: member.userId,
        userName: `${member.user.firstName} ${member.user.lastName}`.trim() || member.user.email,
        originalValue: lead.ownerId,
        newValue: member.userId,
      },
    });

    return { assignedUserId: member.userId, queueId: queue.id, memberId: member.id };
  }

  static async assignSiteVisitInTransaction(
    tx: Prisma.TransactionClient,
    queueId: string,
    siteVisitId: string,
    leadId: string,
    tenantId: string,
    actorId?: string,
  ) {
    const { queue, member } = await this.selectQueueMemberInTransaction(tx, queueId, tenantId);
    const [lead, siteVisit] = await Promise.all([
      tx.lead.findFirst({
        where: { id: leadId, tenantId },
        include: { owner: { include: { profile: { select: { name: true } } } } },
      }),
      tx.siteVisit.findFirst({ where: { id: siteVisitId, tenantId, leadId } }),
    ]);
    if (!lead) throw new Error('LEAD_NOT_FOUND');
    if (!siteVisit) throw new Error('SITE_VISIT_NOT_FOUND');

    await tx.rRQueue.update({
      where: { id: queue.id },
      data: { previousId: member.sequenceId, leadCount: { increment: 1 } },
    });
    await tx.rRQueueMember.update({
      where: { id: member.id },
      data: { lastAssignedAt: new Date(), currentLeadCount: { increment: 1 } },
    });
    await tx.lead.update({
      where: { id: lead.id },
      data: { ownerId: member.userId, rrQueueId: queue.id },
    });
    await tx.siteVisit.update({
      where: { id: siteVisit.id },
      data: { assigneeId: member.userId },
    });

    if (lead.ownerId !== member.userId) {
      await createOwnerHistory({
        tenantId,
        leadId: lead.id,
        previousOwnerId: lead.ownerId,
        newOwnerId: member.userId,
        previousProfile: lead.owner?.profile?.name || null,
        newProfile: member.user.profile?.name || null,
        previousStatus: lead.status,
        newStatus: lead.status,
        handoffReason: 'Site visit round-robin assignment',
        changedById: actorId || lead.creatorId,
      }, tx);
    }

    await tx.rRQueueHistory.create({
      data: {
        tenantId,
        rrQueueId: queue.id,
        leadId: lead.id,
        field: 'Site Visit Assignee',
        userId: member.userId,
        userName: `${member.user.firstName} ${member.user.lastName}`.trim() || member.user.email,
        originalValue: siteVisit.assigneeId,
        newValue: member.userId,
      },
    });

    return { assignedUserId: member.userId, queueId: queue.id, memberId: member.id };
  }

  static async assignLeadsInBulk(tenantId: string, leads: Array<Record<string, any>>) {
    if (!leads.length) return { assignments: [], errors: [] };
    const queueIds = Array.from(new Set(leads.map((lead) => lead.rrQueueId).filter(Boolean)));
    const queues = queueIds.length ? await prisma.rRQueue.findMany({ where: { tenantId, id: { in: queueIds } }, include: { members: { include: { user: { select: { id: true, firstName: true, lastName: true, email: true, isActive: true } } }, orderBy: { sequenceId: 'asc' } } } }) : [];
    const queueMap = new Map(queues.map((queue) => [queue.id, queue]));
    const assignments: Array<Record<string, any>> = [];
    const errors: Array<Record<string, any>> = [];

    for (const lead of leads) {
      const queue = lead.rrQueueId ? queueMap.get(lead.rrQueueId) : null;
      if (!queue) {
        errors.push({ leadId: lead.id, reason: 'Queue not found' });
        continue;
      }
      const nextState = await this.getNextEligibleMember(queue.id, tenantId, prisma);
      if (!nextState.member) {
        errors.push({ leadId: lead.id, queueId: queue.id, reason: 'No active member available', fallbackOwnerId: nextState.fallbackOwnerId || queue.ownerId || null });
        continue;
      }
      assignments.push({
        leadId: lead.id,
        queueId: queue.id,
        assignedUserId: nextState.member.userId,
        previousId: queue.previousId,
        leadCount: (queue.leadCount || 0) + assignments.filter((item) => item.queueId === queue.id).length + 1,
        skipped: nextState.skipped,
      });
    }

    return { assignments, errors };
  }

  static async resetQueuePointer(queueId: string, tenantId: string) {
    return prisma.rRQueue.updateMany({ where: { id: queueId, tenantId }, data: { previousId: 0 } });
  }
}

export async function findProjectRRQueue(
  tenantId: string,
  projectId: string,
  userType: RRMemberUserType,
  tx: RRClient = prisma,
  criteria?: {
    projectName?: string | null;
    status?: string | null;
    source?: string | null;
    secondarySource?: string | null;
    tertiarySource?: string | null;
    priority?: string | null;
    category?: string | null;
    ignoreStatusCriteria?: boolean;
  },
) {
  const queues = await tx.rRQueue.findMany({
    where: { tenantId, active: true, members: { some: { userType } } },
    orderBy: { createdAt: 'asc' },
  });

  let projectName = criteria?.projectName ?? null;
  if (!projectName && typeof tx.project?.findFirst === 'function') {
    projectName = (await tx.project.findFirst({
      where: { id: projectId, tenantId },
      select: { name: true },
    }))?.name ?? null;
  }
  const lead = {
    ...criteria,
    projectId,
    projectName,
  };
  return queues
    .filter((queue) => hasConfiguredProjectScope(queue as Record<string, any>))
    .filter((queue) => projectMatchesLead(queue as Record<string, any>, projectId, projectName))
    .map((queue) => ({ queue, score: calculateQueueMatchScore(queue as Record<string, any>, lead) }))
    .filter(({ queue, score }) => score > 0 && matchesConfiguredQueueCriteria(queue as Record<string, any>, lead))
    .sort((left, right) => right.score - left.score)[0]?.queue ?? null;
}

export async function selectNextProjectRRMemberInTransaction(
  tx: Prisma.TransactionClient,
  params: {
    tenantId: string;
    projectId: string | null;
    userType: RRMemberUserType;
    criteria?: Parameters<typeof findProjectRRQueue>[4];
    profileNames?: string[];
  },
) {
  if (!params.projectId) throw new Error('RR_PROJECT_REQUIRED');
  const criteria = params.userType === 'CRM'
    ? { ...params.criteria, ignoreSourceCriteria: true }
    : params.criteria;
  const queue = await findProjectRRQueue(params.tenantId, params.projectId, params.userType, tx, criteria);
  if (!queue) throw new Error(`RR_QUEUE_NOT_CONFIGURED:${params.userType}`);
  const lockedQueue = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT "id" FROM "RRQueue"
    WHERE "id" = ${queue.id} AND "tenantId" = ${params.tenantId} AND "active" = TRUE
    FOR UPDATE
  `);
  if (!lockedQueue.length) throw new Error('RR_QUEUE_NOT_ACTIVE');
  const next = await RoundRobinAssignmentService.getNextEligibleMember(
    queue.id,
    params.tenantId,
    tx,
    params.userType,
    params.profileNames,
  );
  if (!next.member) throw new Error(`NO_ELIGIBLE_RR_MEMBER:${params.userType}`);
  const assignedAt = new Date();
  await tx.rRQueue.update({
    where: { id: queue.id },
    data: { previousId: next.member.sequenceId, leadCount: { increment: 1 } },
  });
  await tx.rRQueueMember.update({
    where: { id: next.member.id },
    data: { lastAssignedAt: assignedAt, currentLeadCount: { increment: 1 } },
  });
  return { queue, member: next.member, assignedAt };
}

export async function assignLeadToProjectRoundRobinInTransaction(
  tx: Prisma.TransactionClient,
  params: {
    tenantId: string;
    leadId: string;
    projectId: string | null;
    userType: RRMemberUserType;
    actorId: string;
    reason: string;
    leadStatus?: string;
    profileNames?: string[];
  },
) {
  if (!params.projectId) throw new Error('RR_PROJECT_REQUIRED');

  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "Lead"
    WHERE "id" = ${params.leadId} AND "tenantId" = ${params.tenantId}
    FOR UPDATE
  `);
  const lead = await tx.lead.findFirst({
    where: { id: params.leadId, tenantId: params.tenantId },
    include: { owner: { include: { profile: { select: { name: true } } } } },
  });
  if (!lead) throw new Error('LEAD_NOT_FOUND');

  const criteria = rrQueueCriteriaForLead(lead);
  const { queue, member } = await selectNextProjectRRMemberInTransaction(tx, {
    ...params,
    criteria,
    profileNames: params.profileNames,
  });
  const ownerName = `${member.user.firstName} ${member.user.lastName}`.trim() || member.user.email;
  const nextStatus = params.leadStatus || lead.status;
  await tx.lead.update({
    where: { id: lead.id },
    data: {
      ownerId: member.userId,
      rrQueueId: queue.id,
      ...(params.leadStatus ? { status: params.leadStatus as typeof lead.status } : {}),
    },
  });
  if (lead.ownerId !== member.userId || nextStatus !== lead.status) {
    await createOwnerHistory({
      tenantId: params.tenantId,
      leadId: lead.id,
      previousOwnerId: lead.ownerId,
      newOwnerId: member.userId,
      previousProfile: lead.owner?.profile?.name || null,
      newProfile: member.user.profile?.name || null,
      previousStatus: lead.status,
      newStatus: nextStatus,
      handoffReason: params.reason,
      changedById: params.actorId,
    }, tx);
  }
  await tx.rRQueueHistory.create({
    data: {
      tenantId: params.tenantId,
      rrQueueId: queue.id,
      leadId: lead.id,
      field: `${params.userType} Owner`,
      userId: member.userId,
      userName: ownerName,
      originalValue: lead.ownerId,
      newValue: member.userId,
    },
  });
  await tx.auditLog.create({
    data: {
      tenantId: params.tenantId,
      userId: params.actorId,
      leadId: lead.id,
      action: 'RR_LEAD_ASSIGNED',
      objectType: 'Lead',
      objectId: lead.id,
      oldValues: { ownerId: lead.ownerId },
      newValues: { ownerId: member.userId, queueId: queue.id, projectId: params.projectId, userType: params.userType },
    },
  });
  return { assignedUserId: member.userId, queueId: queue.id, memberId: member.id };
}

export async function assignCompletedSiteVisitToSalesInTransaction(
  tx: Prisma.TransactionClient,
  siteVisitId: string,
  tenantId: string,
) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "SiteVisit"
    WHERE "id" = ${siteVisitId} AND "tenantId" = ${tenantId}
    FOR UPDATE
  `);
  const visit = await tx.siteVisit.findFirst({
    where: { id: siteVisitId, tenantId },
    include: {
      lead: {
        include: {
          owner: { include: { profile: { select: { name: true } } } },
        },
      },
      project: { select: { id: true, name: true } },
    },
  });
  if (!visit) throw new Error('SITE_VISIT_NOT_FOUND');
  if (visit.status !== 'COMPLETED' || !visit.completedAt || !visit.completedById) {
    throw new Error('SITE_VISIT_NOT_GRE_COMPLETED');
  }
  if (visit.salesHandoffAt) {
    return {
      alreadyAssigned: true,
      assignedUserId: visit.lead.ownerId,
      queueId: visit.salesHandoffQueueId,
      pendingReason: null,
    };
  }

  const actorId = visit.completedById;
  const markPending = async (reason: string) => {
    await tx.siteVisit.update({
      where: { id: visit.id },
      data: { salesHandoffPendingReason: reason },
    });
    await tx.auditLog.create({
      data: {
        tenantId,
        userId: actorId,
        leadId: visit.leadId,
        action: 'RR_SALES_HANDOFF_PENDING',
        objectType: 'SiteVisit',
        objectId: visit.id,
        newValues: { projectId: visit.projectId, reason },
      },
    });
    return { alreadyAssigned: false, assignedUserId: null, queueId: null, pendingReason: reason };
  };

  if (!visit.projectId) return markPending('The completed site visit has no project; Sales assignment is pending.');
  const queue = await findProjectRRQueue(
    tenantId,
    visit.projectId,
    'Sales',
    tx,
    rrQueueCriteriaForLead(visit.lead, visit.project?.name),
  );
  if (!queue) return markPending(`No active Sales Round Robin queue is configured for ${visit.project?.name || 'this project'}.`);

  const lockedQueue = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT "id" FROM "RRQueue"
    WHERE "id" = ${queue.id} AND "tenantId" = ${tenantId} AND "active" = TRUE
    FOR UPDATE
  `);
  if (!lockedQueue.length) return markPending('The Sales Round Robin queue is no longer active.');
  const next = await RoundRobinAssignmentService.getNextEligibleMember(queue.id, tenantId, tx, 'Sales');
  const member = next.member;
  if (!member) {
    const reason = `No eligible Sales members are available for ${visit.project?.name || 'this project'}${next.skipped.length ? `: ${next.skipped.join('; ')}` : '.'}`;
    return markPending(reason);
  }

  const lead = visit.lead;
  const assignedAt = new Date();
  const ownerName = `${member.user.firstName} ${member.user.lastName}`.trim() || member.user.email;
  const oldOwner = lead.ownerId
    ? await tx.user.findFirst({
      where: { id: lead.ownerId, tenantId },
      select: { profile: { select: { name: true } } },
    })
    : null;

  await tx.lead.update({
    where: { id: lead.id },
    data: { ownerId: member.userId, rrQueueId: queue.id },
  });
  if (lead.ownerId !== member.userId) {
    await createOwnerHistory({
      tenantId,
      leadId: lead.id,
      previousOwnerId: lead.ownerId,
      newOwnerId: member.userId,
      previousProfile: oldOwner?.profile?.name || null,
      newProfile: member.user.profile?.name || null,
      previousStatus: lead.status,
      newStatus: lead.status,
      handoffReason: `GRE-confirmed site visit completed for ${visit.project?.name || 'project'}`,
      changedById: actorId,
    }, tx);
  }

  await tx.rRQueue.update({
    where: { id: queue.id },
    data: { previousId: member.sequenceId, leadCount: { increment: 1 } },
  });
  await tx.rRQueueMember.update({
    where: { id: member.id },
    data: { lastAssignedAt: assignedAt, currentLeadCount: { increment: 1 } },
  });
  await tx.rRQueueHistory.createMany({
    data: [
      {
        tenantId,
        rrQueueId: queue.id,
        leadId: lead.id,
        field: 'Sales Owner',
        userId: member.userId,
        userName: ownerName,
        originalValue: lead.ownerId,
        newValue: member.userId,
      },
      {
        tenantId,
        rrQueueId: queue.id,
        leadId: lead.id,
        field: 'Site Visit Handoff',
        userId: member.userId,
        userName: ownerName,
        originalValue: visit.id,
        newValue: assignedAt.toISOString(),
      },
    ],
  });
  await tx.siteVisit.update({
    where: { id: visit.id },
    data: {
      assigneeId: member.userId,
      salesHandoffAt: assignedAt,
      salesHandoffQueueId: queue.id,
      salesHandoffPendingReason: null,
    },
  });
  await tx.auditLog.create({
    data: {
      tenantId,
      userId: actorId,
      leadId: lead.id,
      action: 'RR_SALES_HANDOFF_COMPLETED',
      objectType: 'SiteVisit',
      objectId: visit.id,
      oldValues: { ownerId: lead.ownerId },
      newValues: { ownerId: member.userId, queueId: queue.id, projectId: visit.projectId },
    },
  });

  return {
    alreadyAssigned: false,
    assignedUserId: member.userId,
    queueId: queue.id,
    pendingReason: null,
  };
}

export async function assignSiteVisitToSVCInTransaction(
  tx: Prisma.TransactionClient,
  params: {
    siteVisitId: string;
    tenantId: string;
    actorId: string;
    requestedAssigneeId?: string | null;
  },
) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "SiteVisit"
    WHERE "id" = ${params.siteVisitId} AND "tenantId" = ${params.tenantId}
    FOR UPDATE
  `);
  const visit = await tx.siteVisit.findFirst({
    where: { id: params.siteVisitId, tenantId: params.tenantId },
    include: {
      lead: {
        include: {
          owner: { include: { profile: { select: { name: true } } } },
        },
      },
      project: { select: { id: true, name: true } },
    },
  });
  if (!visit) throw new Error('SITE_VISIT_NOT_FOUND');
  if (!visit.projectId) throw new Error('SITE_VISIT_PROJECT_REQUIRED');

  const queue = await findProjectRRQueue(
    params.tenantId,
    visit.projectId,
    'SVC',
    tx,
    rrQueueCriteriaForLead(visit.lead, visit.project?.name),
  );
  let selectedUserId: string | null = null;
  let selectedMember: Awaited<ReturnType<typeof RoundRobinAssignmentService.getNextEligibleMember>>['member'] = null;
  if (queue) {
    const lockedQueue = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT "id" FROM "RRQueue"
      WHERE "id" = ${queue.id} AND "tenantId" = ${params.tenantId} AND "active" = TRUE
      FOR UPDATE
    `);
    if (!lockedQueue.length) throw new Error('SVC_QUEUE_NOT_CONFIGURED');
    if (params.requestedAssigneeId) {
      const requested = await tx.rRQueueMember.findFirst({
        where: {
          rrQueueId: queue.id,
          tenantId: params.tenantId,
          userId: params.requestedAssigneeId,
          userType: 'SVC',
          activeMember: true,
          isAvailable: true,
          isWorking: true,
          weekOff: false,
          user: { isActive: true, profile: { name: 'SVC' } },
        },
        include: { user: { select: { id: true, firstName: true, lastName: true, email: true, isActive: true, profile: { select: { name: true } } } } },
      });
      if (!requested) throw new Error('SVC_ASSIGNEE_NOT_ELIGIBLE');
      selectedMember = requested;
    } else {
      selectedMember = (await RoundRobinAssignmentService.getNextEligibleMember(queue.id, params.tenantId, tx, 'SVC')).member;
    }
    if (!selectedMember) throw new Error('NO_ELIGIBLE_SVC_MEMBER');
    selectedUserId = selectedMember.userId;
    await tx.rRQueue.update({
      where: { id: queue.id },
      data: { previousId: selectedMember.sequenceId, leadCount: { increment: 1 } },
    });
    await tx.rRQueueMember.update({
      where: { id: selectedMember.id },
      data: { lastAssignedAt: new Date(), currentLeadCount: { increment: 1 } },
    });
  } else {
    throw new Error('SVC_QUEUE_NOT_CONFIGURED');
  }

  if (!selectedUserId) throw new Error('NO_ELIGIBLE_SVC_MEMBER');
  const oldOwner = visit.lead.ownerId
    ? await tx.user.findFirst({
      where: { id: visit.lead.ownerId, tenantId: params.tenantId },
      select: { profile: { select: { name: true } } },
    })
    : null;
  await tx.lead.update({
    where: { id: visit.leadId },
    data: { ownerId: selectedUserId, ...(queue ? { rrQueueId: queue.id } : {}) },
  });
  await tx.siteVisit.update({
    where: { id: visit.id },
    data: { assigneeId: selectedUserId },
  });
  if (visit.lead.ownerId !== selectedUserId) {
    await createOwnerHistory({
      tenantId: params.tenantId,
      leadId: visit.leadId,
      previousOwnerId: visit.lead.ownerId,
      newOwnerId: selectedUserId,
      previousProfile: oldOwner?.profile?.name || null,
      newProfile: 'SVC',
      previousStatus: visit.lead.status,
      newStatus: visit.lead.status,
      handoffReason: 'Lead entered the SVC site visit workflow',
      changedById: params.actorId,
    }, tx);
  }
  if (queue && selectedMember) {
    await tx.rRQueueHistory.create({
      data: {
        tenantId: params.tenantId,
        rrQueueId: queue.id,
        leadId: visit.leadId,
        field: 'SVC Owner',
        userId: selectedUserId,
        userName: `${selectedMember.user.firstName} ${selectedMember.user.lastName}`.trim() || selectedMember.user.email,
        originalValue: visit.lead.ownerId,
        newValue: selectedUserId,
      },
    });
  }
  return { siteVisitId: visit.id, leadId: visit.leadId, assignedUserId: selectedUserId, queueId: queue?.id ?? null };
}

export async function findApplicableRRQueue(
  tenantId: string,
  criteria: {
    projectId?: string | null;
    projectName?: string | null;
    status?: string | null;
    source?: string | null;
    secondarySource?: string | null;
    tertiarySource?: string | null;
    priority?: string | null;
    category?: string | null;
  },
  tx: RRClient = prisma,
) {
  const queues = await tx.rRQueue.findMany({ where: { tenantId, active: true }, orderBy: { createdAt: 'asc' } });
  if (queues.length === 0) return null;

  let resolvedProjectName: string | null = criteria.projectName ?? null;
  if (!resolvedProjectName && criteria.projectId) {
    const project = await tx.project.findFirst({ where: { id: criteria.projectId, tenantId }, select: { name: true } });
    resolvedProjectName = project?.name ?? null;
  }

  const lead = {
    status: criteria.status ?? null,
    source: criteria.source ?? null,
    secondarySource: criteria.secondarySource ?? null,
    tertiarySource: criteria.tertiarySource ?? null,
    priority: criteria.priority ?? null,
    category: criteria.category ?? null,
    projectId: criteria.projectId ?? null,
    projectName: resolvedProjectName,
  };

  const scoredQueues = queues
    .map((queue) => ({ queue, score: calculateQueueMatchScore(queue as Record<string, any>, lead) }))
    .filter(({ score, queue }) =>
      score > 0 && matchesConfiguredQueueCriteria(queue as Record<string, any>, lead),
    );

  if (scoredQueues.length === 0) return null;
  scoredQueues.sort((left, right) => right.score - left.score);
  return scoredQueues[0].queue;
}