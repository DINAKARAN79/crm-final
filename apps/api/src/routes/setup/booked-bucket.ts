import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '@dct-crm/db';
import { authenticate, AuthRequest } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permissions';

const router = Router();
router.use(authenticate);

function requireAdministrator(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user?.isSuperAdmin && !req.user?.isAdmin) {
    return res.status(403).json({ success: false, error: 'Administrator access is required' });
  }
  next();
}

const settingsSchema = z.object({
  isActive: z.boolean(),
  fallbackUserId: z.string().min(1).nullable(),
  memberIds: z.array(z.string().min(1)).max(500),
  moveOpenFollowUps: z.boolean(),
  returnToPreviousOwnerOnCancel: z.boolean(),
}).superRefine(({ memberIds }, context) => {
  if (new Set(memberIds).size !== memberIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['memberIds'], message: 'Bucket owners must be unique' });
  }
});

router.get('/preview', requirePermission('USER_READ'), requireAdministrator, async (req: AuthRequest, res: Response) => {
  const tenantId = req.tenantId!;
  try {
    const [setting, ownerGroups, projectGroups] = await Promise.all([
      prisma.bookedBucketSetting.findUnique({
        where: { tenantId },
        select: {
          isActive: true,
          members: {
            where: { isActive: true, user: { isActive: true, tenantId } },
            select: { userId: true },
          },
        },
      }),
      prisma.lead.groupBy({
        by: ['ownerId'],
        where: { tenantId, status: 'BOOKED' },
        _count: { _all: true },
      }),
      prisma.lead.groupBy({
        by: ['projectId'],
        where: { tenantId, status: 'BOOKED' },
        _count: { _all: true },
      }),
    ]);

    const ownerIds = ownerGroups.map(({ ownerId }) => ownerId).filter((id): id is string => Boolean(id));
    const projectIds = projectGroups.map(({ projectId }) => projectId).filter((id): id is string => Boolean(id));
    const [users, projects] = await Promise.all([
      ownerIds.length
        ? prisma.user.findMany({
            where: { tenantId, id: { in: ownerIds } },
            select: { id: true, firstName: true, lastName: true },
          })
        : [],
      projectIds.length
        ? prisma.project.findMany({
            where: { tenantId, id: { in: projectIds } },
            select: { id: true, name: true },
          })
        : [],
    ]);
    const userNames = new Map(users.map((user) => [user.id, [user.firstName, user.lastName].filter(Boolean).join(' ')]));
    const projectNames = new Map(projects.map((project) => [project.id, project.name]));
    const bucketOwnerIds = new Set((setting?.members || []).map((member) => member.userId));
    const totalBooked = ownerGroups.reduce((total, group) => total + group._count._all, 0);
    const wouldMove = ownerGroups
      .filter((group) => !group.ownerId || !bucketOwnerIds.has(group.ownerId))
      .reduce((total, group) => total + group._count._all, 0);

    return res.json({
      success: true,
      data: {
        isActive: setting?.isActive ?? false,
        totalBooked,
        wouldMove,
        byOwner: ownerGroups.map(({ ownerId, _count }) => ({
          ownerId,
          ownerName: ownerId ? userNames.get(ownerId) || 'Unknown user' : 'Unassigned',
          count: _count._all,
        })),
        byProject: projectGroups.map(({ projectId, _count }) => ({
          projectId,
          projectName: projectId ? projectNames.get(projectId) || 'Unknown project' : 'No project',
          count: _count._all,
        })),
      },
    });
  } catch (error) {
    console.error('Failed to preview Booked Bucket:', error);
    return res.status(500).json({ success: false, error: 'Failed to load Booked Bucket preview' });
  }
});

router.get('/', requirePermission('USER_READ'), requireAdministrator, async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const [setting, users] = await Promise.all([
      prisma.bookedBucketSetting.findUnique({
        where: { tenantId },
        include: {
          fallbackUser: { select: { id: true, firstName: true, lastName: true, phone: true, profile: { select: { name: true } } } },
          members: {
            orderBy: { sortOrder: 'asc' },
            include: { user: { select: { id: true, firstName: true, lastName: true, phone: true, isActive: true, profile: { select: { name: true } } } } },
          },
        },
      }),
      prisma.user.findMany({
        where: { tenantId, isActive: true },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
        take: 500,
        select: {
          id: true,
          firstName: true,
          lastName: true,
          phone: true,
          isSuperAdmin: true,
          profile: { select: { name: true, isAdmin: true } },
        },
      }),
    ]);
    return res.json({
      success: true,
      data: {
        setting: setting
          ? {
              isActive: setting.isActive,
              fallbackUserId: setting.fallbackUserId,
              fallbackUser: setting.fallbackUser,
              moveOpenFollowUps: setting.moveOpenFollowUps,
              returnToPreviousOwnerOnCancel: setting.returnToPreviousOwnerOnCancel,
              members: setting.members,
            }
          : {
              isActive: false,
              fallbackUserId: null,
              fallbackUser: null,
              moveOpenFollowUps: false,
              returnToPreviousOwnerOnCancel: false,
              members: [],
            },
        users,
      },
    });
  } catch (error) {
    console.error('Failed to load Booked Bucket settings:', error);
    return res.status(500).json({ success: false, error: 'Failed to load Booked Bucket settings' });
  }
});

router.put('/', requirePermission('USER_UPDATE'), requireAdministrator, async (req: AuthRequest, res: Response) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: parsed.error.issues[0]?.message || 'Invalid Booked Bucket settings',
    });
  }

  const tenantId = req.tenantId!;
  const actorId = req.user!.id;
  const { isActive, fallbackUserId, memberIds, moveOpenFollowUps, returnToPreviousOwnerOnCancel } = parsed.data;
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const users = await tx.user.findMany({
        where: { tenantId, isActive: true, id: { in: [...memberIds, ...(fallbackUserId ? [fallbackUserId] : [])] } },
        select: { id: true, isSuperAdmin: true, profile: { select: { isAdmin: true } } },
      });
      if (users.length !== new Set([...memberIds, ...(fallbackUserId ? [fallbackUserId] : [])]).size) {
        throw Object.assign(new Error('Choose active users from this company only'), { statusCode: 400 });
      }
      if (fallbackUserId && (
        users.find((user) => user.id === fallbackUserId)?.isSuperAdmin
        || !users.find((user) => user.id === fallbackUserId)?.profile?.isAdmin
      )) {
        throw Object.assign(new Error('The fallback user must be an active company administrator'), { statusCode: 400 });
      }

      const previousSetting = await tx.bookedBucketSetting.findUnique({
        where: { tenantId },
        select: {
          isActive: true,
          fallbackUserId: true,
          moveOpenFollowUps: true,
          returnToPreviousOwnerOnCancel: true,
          members: { where: { isActive: true }, select: { userId: true } },
        },
      });
      const setting = await tx.bookedBucketSetting.upsert({
        where: { tenantId },
        create: { tenantId, isActive, fallbackUserId, moveOpenFollowUps, returnToPreviousOwnerOnCancel },
        update: { isActive, fallbackUserId, moveOpenFollowUps, returnToPreviousOwnerOnCancel },
        select: { id: true, isActive: true, fallbackUserId: true },
      });
      await tx.bookedBucketMember.updateMany({
        where: { tenantId, isActive: true },
        data: { isActive: false },
      });
      for (const [sortOrder, userId] of memberIds.entries()) {
        await tx.bookedBucketMember.upsert({
          where: { tenantId_userId: { tenantId, userId } },
          create: { tenantId, userId, sortOrder: sortOrder + 1, isActive: true },
          update: { sortOrder: sortOrder + 1, isActive: true },
        });
      }
      await tx.auditLog.create({
        data: {
          tenantId,
          userId: actorId,
          action: 'BOOKED_BUCKET_SETTINGS_UPDATED',
          objectType: 'BookedBucket',
          objectId: setting.id,
          ...(previousSetting
            ? { oldValues: {
                isActive: previousSetting.isActive,
                fallbackUserId: previousSetting.fallbackUserId,
                moveOpenFollowUps: previousSetting.moveOpenFollowUps,
                returnToPreviousOwnerOnCancel: previousSetting.returnToPreviousOwnerOnCancel,
                memberIds: previousSetting.members.map((member) => member.userId),
              } }
            : {}),
          newValues: { isActive, fallbackUserId, memberIds, moveOpenFollowUps, returnToPreviousOwnerOnCancel },
        },
      });
      return setting;
    });
    return res.json({ success: true, data: updated });
  } catch (error) {
    const statusCode = typeof error === 'object' && error && 'statusCode' in error
      ? Number(error.statusCode)
      : 500;
    if (statusCode === 500) console.error('Failed to save Booked Bucket settings:', error);
    return res.status(statusCode).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save Booked Bucket settings',
    });
  }
});

export default router;
