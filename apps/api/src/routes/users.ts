import { Router, Response } from 'express';
import { prisma } from '@dct-crm/db';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { authenticate, AuthRequest } from '../middleware/auth';
import { authorize } from '../middleware/authorization';
import { resolveUserPhoneChange } from '../services/userPhone';
import { endAllUserSessions, liveOnlineUserIds, rejectManagedUserFields } from '../services/userPresence';

const router = Router();

router.use(authenticate);

export async function checkCapacityLimits(
  tenantId: string,
  newProfileId?: string | null,
  excludeUserId?: string,
): Promise<{ allowed: boolean; error?: string }> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return { allowed: true };

  let activeUserCount = await prisma.user.count({
    where: { tenantId, isActive: true, isSuperAdmin: false },
  });

  if (excludeUserId) {
    const existingUser = await prisma.user.findFirst({
      where: { id: excludeUserId, tenantId, isActive: true },
      select: { id: true },
    });
    if (existingUser) {
      activeUserCount -= 1;
    }
  }

  if (activeUserCount >= tenant.maxTotalUsers) {
    return { allowed: false, error: `Total user limit reached (${tenant.maxTotalUsers}/${tenant.maxTotalUsers}). Contact Super Admin to increase capacity.` };
  }

  if (newProfileId) {
    const profile = await prisma.profile.findUnique({ where: { id: newProfileId } });
    if (profile?.isAdmin) {
      let adminCount = await prisma.user.count({
        where: {
          tenantId,
          isActive: true,
          isSuperAdmin: false,
          profile: { isAdmin: true },
        },
      });

      const isCurrentAdmin = excludeUserId
        ? await prisma.user.findFirst({
            where: { id: excludeUserId, tenantId, profileId: newProfileId, isActive: true },
            select: { id: true },
          })
        : null;

      if (excludeUserId && isCurrentAdmin) {
        adminCount -= 1;
      }

      if (!isCurrentAdmin && adminCount >= tenant.maxAdminUsers) {
        return { allowed: false, error: `Admin user limit reached (${tenant.maxAdminUsers}/${tenant.maxAdminUsers}). Contact Super Admin to increase capacity.` };
      }
    }
  }

  return { allowed: true };
}

export const inviteUserSchema = z.object({
  email: z.string().email(),
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().optional().default(''),
  phone: z.string({ required_error: 'Phone is required' }).trim().min(1, 'Phone is required'),
  roleIds: z.array(z.string()).optional().default([]),
  roleId: z.string().nullable().optional(),
  password: z.string().min(8).optional(),
  profileId: z.string().optional(),
});

export const updateUserSchema = z.object({
  email: z.string().trim().email('A valid email is required').transform((email) => email.toLowerCase()).optional(),
  firstName: z.string().trim().min(1, 'First name is required').optional(),
  lastName: z.string().trim().optional(),
  phone: z.string().optional(),
  avatar: z.string().optional(),
  profileId: z.string().nullable().optional(),
  roleId: z.string().nullable().optional(),
  roleIds: z.array(z.string()).optional(),
});

const resetPasswordSchema = z.object({ password: z.string().min(8) });

async function tenantCountry(tenantId: string) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { country: true } });
  return tenant?.country;
}

router.get('/', authorize('User', 'read'), async (req: AuthRequest, res: Response) => {
  try {
    const { page = 1, limit = 20, isActive, search, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const onlineIds = await liveOnlineUserIds(req.tenantId!);
    const where: any = { tenantId: req.tenantId! };
    if (isActive !== undefined) where.isActive = isActive === 'true';
    if (req.query.online === 'true') where.id = { in: onlineIds.length ? onlineIds : ['__none__'] };
    if (search) {
      where.OR = [
        { firstName: { contains: search as string, mode: 'insensitive' } },
        { lastName: { contains: search as string, mode: 'insensitive' } },
        { email: { contains: search as string, mode: 'insensitive' } },
      ];
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          avatar: true,
          isActive: true,
          isLoggedIn: true,
          lastLoginAt: true,
          lastSeenAt: true,
          lastLogoutAt: true,
          createdAt: true,
          profileId: true,
          profile: { select: { id: true, name: true } },
          roles: {
            include: {
              role: { select: { id: true, name: true } },
            },
          },
          _count: { select: { followUps: true, activities: true } },
        },
        skip,
        take: Number(limit),
        orderBy: { [sortBy as string]: sortOrder },
      }),
      prisma.user.count({ where }),
    ]);

    const online = new Set(onlineIds);
    res.json({
      success: true,
      data: users.map((user) => ({ ...user, isLoggedIn: online.has(user.id) })),
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch users' });
  }
});

router.get('/me', authorize('User', 'read'), async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        avatar: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
        tenant: { select: { id: true, name: true, slug: true, logo: true, settings: true } },
        roles: {
          include: {
            role: {
              include: {
                permissionSets: {
                  include: {
                    permissionSet: { select: { objectName: true, permissions: true } },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    res.json({ success: true, data: user });
  } catch (error) {
    console.error('Get current user error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch user profile' });
  }
});

router.get('/:id', authorize('User', 'read'), async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        avatar: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
        profileId: true,
        profile: { select: { id: true, name: true } },
        roles: {
          include: {
            role: { select: { id: true, name: true } },
          },
        },
        _count: { select: { followUps: true, activities: true, assignedLeads: true } },
      },
    });

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    res.json({ success: true, data: user });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch user' });
  }
});

router.post('/:id/impersonate', authorize('User', 'edit'), async (req: AuthRequest, res: Response) => {
  try {
    const administrator = await prisma.user.findFirst({
      where: { id: req.user!.id, tenantId: req.tenantId! },
      select: { isSuperAdmin: true, profile: { select: { isAdmin: true } } },
    });
    if (!administrator?.isSuperAdmin && !administrator?.profile?.isAdmin) {
      return res.status(403).json({ success: false, error: 'Only administrators can log in as another user' });
    }

    const target = await prisma.user.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId!, isActive: true },
      select: { id: true, email: true, tenantId: true, isSuperAdmin: true, firstName: true, lastName: true },
    });
    if (!target) return res.status(404).json({ success: false, error: 'Active user not found' });
    if (target.id === req.user!.id) return res.status(400).json({ success: false, error: 'You are already logged in as this user' });
    if (target.isSuperAdmin && !administrator.isSuperAdmin) {
      return res.status(403).json({ success: false, error: 'Only a Super Admin can log in as another Super Admin' });
    }

    const { generateToken } = await import('../middleware/auth');
    res.json({
      success: true,
      data: {
        id: target.id,
        name: `${target.firstName} ${target.lastName}`.trim(),
        email: target.email,
        token: generateToken({ ...target, impersonatedBy: req.user!.id }),
      },
    });
  } catch (error) {
    console.error('Impersonate user error:', error);
    res.status(500).json({ success: false, error: 'Failed to log in as user' });
  }
});

router.post('/', authorize('User', 'create'), async (req: AuthRequest, res: Response) => {
  try {
    rejectManagedUserFields(req.body);
    const data = inviteUserSchema.parse(req.body);
    const phone = resolveUserPhoneChange({
      mode: 'create',
      incomingPhone: data.phone,
      country: await tenantCountry(req.tenantId!),
    });
    if (!phone.ok || !phone.phone) return res.status(400).json({ success: false, error: phone.ok ? 'Phone is required' : phone.error });
    const email = data.email.trim().toLowerCase();

    if (data.profileId) {
      const profile = await prisma.profile.findFirst({
        where: { id: data.profileId, OR: [{ tenantId: req.tenantId! }, { isGlobal: true }] },
        select: { id: true },
      });
      if (!profile) return res.status(400).json({ success: false, error: 'Profile not found in this tenant' });
    }
    const roleIds = [...new Set([...(data.roleIds || []), ...(data.roleId ? [data.roleId] : [])])];
    if (roleIds.length > 0) {
      const roleCount = await prisma.role.count({ where: { id: { in: roleIds }, tenantId: req.tenantId! } });
      if (roleCount !== roleIds.length) return res.status(400).json({ success: false, error: 'One or more roles were not found in this tenant' });
    }

    const existingUser = await prisma.user.findFirst({
      where: { tenantId: req.tenantId!, email: { equals: email, mode: 'insensitive' } },
    });

    if (existingUser) {
      return res.status(409).json({ success: false, error: 'This email is already being used in this company.' });
    }

    const capacityCheck = await checkCapacityLimits(req.tenantId!, data.profileId);
    if (!capacityCheck.allowed) {
      await prisma.auditLog.create({
        data: {
          tenantId: req.tenantId!,
          userId: req.user!.id,
          action: 'CREATE',
          objectType: 'User',
          objectId: 'blocked',
          newValues: { email, reason: 'capacity_limit', error: capacityCheck.error },
        },
      });
      return res.status(403).json({ success: false, error: capacityCheck.error });
    }

    const password = data.password || Math.random().toString(36).slice(-12);
    const passwordHash = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        tenantId: req.tenantId!,
        email,
        firstName: data.firstName,
        lastName: data.lastName,
        phone: phone.phone,
        passwordHash,
        profileId: data.profileId || undefined,
        roleId: data.roleId || undefined,
        roles: {
          create: roleIds.map((roleId) => ({ roleId })),
        },
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        isActive: true,
        createdAt: true,
        profileId: true,
        profile: { select: { id: true, name: true } },
        roles: {
          include: {
            role: { select: { id: true, name: true } },
          },
        },
      },
    });

    await prisma.auditLog.create({
      data: {
        tenantId: req.tenantId!,
        userId: req.user!.id,
        action: 'CREATE',
        objectType: 'User',
        objectId: user.id,
        newValues: { email, firstName: data.firstName, lastName: data.lastName },
      },
    });

    res.status(201).json({ success: true, data: user });
  } catch (error: any) {
    if (error.name === 'ZodError' || error.name === 'ManagedUserFieldError') {
      return res.status(400).json({ success: false, error: error.name === 'ZodError' ? error.errors[0].message : error.message });
    }
    if (
      error.code === 'P2002'
      && Array.isArray(error.meta?.target)
      && error.meta.target.includes('tenantId')
      && error.meta.target.includes('email')
    ) {
      return res.status(409).json({ success: false, error: 'This email is already being used in this company.' });
    }
    console.error('Create user error:', error);
    res.status(500).json({ success: false, error: 'Failed to create user' });
  }
});

router.put('/:id', authorize('User', 'edit'), async (req: AuthRequest, res: Response) => {
  try {
    rejectManagedUserFields(req.body);
    const existingUser = await prisma.user.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });

    if (!existingUser) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const data = updateUserSchema.parse(req.body);
    if (data.email !== undefined && data.email !== existingUser.email.toLowerCase()) {
      const emailInUse = await prisma.user.findFirst({
        where: {
          tenantId: req.tenantId!,
          id: { not: req.params.id },
          email: { equals: data.email, mode: 'insensitive' },
        },
        select: { id: true },
      });
      if (emailInUse) {
        return res.status(409).json({ success: false, error: 'This email is already being used in this company.' });
      }
    }
    const phone = resolveUserPhoneChange({
      mode: 'update',
      existingPhone: existingUser.phone,
      incomingPhone: data.phone,
      country: await tenantCountry(req.tenantId!),
    });
    if (!phone.ok) return res.status(400).json({ success: false, error: phone.error });

    if (data.profileId) {
      const profile = await prisma.profile.findFirst({
        where: { id: data.profileId, OR: [{ tenantId: req.tenantId! }, { isGlobal: true }] },
        select: { id: true },
      });
      if (!profile) return res.status(400).json({ success: false, error: 'Profile not found in this tenant' });
    }
    const roleIds = data.roleIds ?? (data.roleId ? [data.roleId] : undefined);
    if (roleIds) {
      const uniqueRoleIds = [...new Set(roleIds)];
      const roleCount = await prisma.role.count({ where: { id: { in: uniqueRoleIds }, tenantId: req.tenantId! } });
      if (roleCount !== uniqueRoleIds.length) return res.status(400).json({ success: false, error: 'One or more roles were not found in this tenant' });
    }

    if (data.profileId !== undefined && data.profileId !== existingUser.profileId) {
      const capacityCheck = await checkCapacityLimits(req.tenantId!, data.profileId, req.params.id);
      if (!capacityCheck.allowed) {
        await prisma.auditLog.create({
          data: {
            tenantId: req.tenantId!,
            userId: req.user!.id,
            action: 'UPDATE',
            objectType: 'User',
            objectId: req.params.id,
            newValues: { profileId: data.profileId, reason: 'capacity_limit', error: capacityCheck.error },
          },
        });
        return res.status(403).json({ success: false, error: capacityCheck.error });
      }
    }

    const userData = { ...data };
    delete userData.roleIds; // role assignments are handled via /api/roles endpoints, not the user update body
    if (phone.phone === undefined) delete userData.phone;
    else userData.phone = phone.phone;
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: userData,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        avatar: true,
        isActive: true,
        createdAt: true,
        profileId: true,
        profile: { select: { id: true, name: true } },
      },
    });

    if (data.email !== undefined && data.email !== existingUser.email.toLowerCase()) {
      await endAllUserSessions(existingUser.id, req.tenantId!, 'REVOKED');
    }

    if (roleIds) {
      await prisma.$transaction(async (tx) => {
        await tx.userRole.deleteMany({ where: { userId: req.params.id } });
        if (roleIds.length > 0) {
          await tx.userRole.createMany({ data: [...new Set(roleIds)].map((roleId) => ({ userId: req.params.id, roleId })) });
        }
      });
    }

    await prisma.auditLog.create({
      data: {
        tenantId: req.tenantId!,
        userId: req.user!.id,
        action: 'UPDATE',
        objectType: 'User',
        objectId: user.id,
        oldValues: existingUser,
        newValues: data,
      },
    });

    res.json({ success: true, data: user });
  } catch (error: any) {
    if (error.name === 'ZodError' || error.name === 'ManagedUserFieldError') {
      return res.status(400).json({ success: false, error: error.name === 'ZodError' ? error.errors[0].message : error.message });
    }
    if (
      error.code === 'P2002'
      && Array.isArray(error.meta?.target)
      && error.meta.target.includes('tenantId')
      && error.meta.target.includes('email')
    ) {
      return res.status(409).json({ success: false, error: 'This email is already being used in this company.' });
    }
    console.error('Update user error:', error);
    res.status(500).json({ success: false, error: 'Failed to update user' });
  }
});

router.put('/:id/password', authorize('User', 'edit'), async (req: AuthRequest, res: Response) => {
  try {
    const data = resetPasswordSchema.parse(req.body);
    const existingUser = await prisma.user.findFirst({ where: { id: req.params.id, tenantId: req.tenantId! } });
    if (!existingUser) return res.status(404).json({ success: false, error: 'User not found' });

    await prisma.user.update({ where: { id: req.params.id }, data: { passwordHash: await bcrypt.hash(data.password, 12) } });
    await endAllUserSessions(existingUser.id, req.tenantId!, 'PASSWORD_CHANGED');
    await prisma.auditLog.create({
      data: { tenantId: req.tenantId!, userId: req.user!.id, action: 'UPDATE', objectType: 'User', objectId: existingUser.id, newValues: { passwordReset: true } },
    });
    res.json({ success: true, message: 'Password reset successfully' });
  } catch (error: any) {
    if (error.name === 'ZodError') return res.status(400).json({ success: false, error: error.errors[0].message });
    console.error('Reset password error:', error);
    res.status(500).json({ success: false, error: 'Failed to reset password' });
  }
});

router.put('/:id/deactivate', authorize('User', 'edit'), async (req: AuthRequest, res: Response) => {
  try {
    const existingUser = await prisma.user.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });

    if (!existingUser) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    if (req.params.id === req.user!.id) {
      return res.status(400).json({ success: false, error: 'Cannot deactivate your own account' });
    }

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { isActive: false },
      select: { id: true, email: true, firstName: true, lastName: true, isActive: true },
    });
    await endAllUserSessions(user.id, req.tenantId!, 'USER_DEACTIVATED');

    await prisma.auditLog.create({
      data: {
        tenantId: req.tenantId!,
        userId: req.user!.id,
        action: 'STATUS_CHANGE',
        objectType: 'User',
        objectId: user.id,
        oldValues: { isActive: true },
        newValues: { isActive: false },
      },
    });

    res.json({ success: true, data: user });
  } catch (error) {
    console.error('Deactivate user error:', error);
    res.status(500).json({ success: false, error: 'Failed to deactivate user' });
  }
});

router.put('/:id/activate', authorize('User', 'edit'), async (req: AuthRequest, res: Response) => {
  try {
    const existingUser = await prisma.user.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });

    if (!existingUser) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { isActive: true },
      select: { id: true, email: true, firstName: true, lastName: true, isActive: true },
    });

    await prisma.auditLog.create({
      data: {
        tenantId: req.tenantId!,
        userId: req.user!.id,
        action: 'STATUS_CHANGE',
        objectType: 'User',
        objectId: user.id,
        oldValues: { isActive: false },
        newValues: { isActive: true },
      },
    });

    res.json({ success: true, data: user });
  } catch (error) {
    console.error('Activate user error:', error);
    res.status(500).json({ success: false, error: 'Failed to activate user' });
  }
});

router.put('/:id/roles', authorize('User', 'edit'), async (req: AuthRequest, res: Response) => {
  try {
    const roleIds: string[] | null = Array.isArray(req.body.roleIds)
      ? [...new Set((req.body.roleIds as unknown[]).filter((id): id is string => typeof id === 'string'))]
      : null;
    if (roleIds === null) return res.status(400).json({ success: false, error: 'roleIds must be an array' });

    const existingUser = await prisma.user.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });

    if (!existingUser) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const roleCount = await prisma.role.count({ where: { id: { in: roleIds }, tenantId: req.tenantId! } });
    if (roleCount !== roleIds.length) return res.status(400).json({ success: false, error: 'One or more roles were not found in this tenant' });

    await prisma.$transaction(async (tx) => {
      await tx.userRole.deleteMany({ where: { userId: req.params.id } });
      if (roleIds.length > 0) {
        await tx.userRole.createMany({
          data: roleIds.map((roleId) => ({ userId: req.params.id, roleId })),
        });
      }
    });

    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        profileId: true,
        profile: { select: { id: true, name: true } },
        roles: {
          include: {
            role: { select: { id: true, name: true } },
          },
        },
      },
    });

    await prisma.auditLog.create({
      data: {
        tenantId: req.tenantId!,
        userId: req.user!.id,
        action: 'UPDATE',
        objectType: 'User',
        objectId: req.params.id,
        newValues: { roleIds },
      },
    });

    res.json({ success: true, data: user });
  } catch (error) {
    console.error('Update user roles error:', error);
    res.status(500).json({ success: false, error: 'Failed to update user roles' });
  }
});

router.put('/:id/profile', authorize('User', 'edit'), async (req: AuthRequest, res: Response) => {
  try {
    const { profileId } = req.body;

    if (profileId !== undefined && profileId !== null && typeof profileId !== 'string') {
      return res.status(400).json({ success: false, error: 'profileId must be a string or null' });
    }

    const existingUser = await prisma.user.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });

    if (!existingUser) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    if (profileId) {
      const profile = await prisma.profile.findFirst({
        where: { id: profileId, OR: [{ tenantId: req.tenantId! }, { isGlobal: true }] },
        select: { id: true },
      });
      if (!profile) return res.status(400).json({ success: false, error: 'Profile not found in this tenant' });
    }

    if (profileId && profileId !== existingUser.profileId) {
      const capacityCheck = await checkCapacityLimits(req.tenantId!, profileId, req.params.id);
      if (!capacityCheck.allowed) {
        await prisma.auditLog.create({
          data: {
            tenantId: req.tenantId!,
            userId: req.user!.id,
            action: 'UPDATE',
            objectType: 'User',
            objectId: req.params.id,
            newValues: { profileId, reason: 'capacity_limit', error: capacityCheck.error },
          },
        });
        return res.status(403).json({ success: false, error: capacityCheck.error });
      }
    }

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { profileId: profileId || null },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        profileId: true,
        profile: { select: { id: true, name: true } },
      },
    });

    await prisma.auditLog.create({
      data: {
        tenantId: req.tenantId!,
        userId: req.user!.id,
        action: 'UPDATE',
        objectType: 'User',
        objectId: user.id,
        oldValues: { profileId: existingUser.profileId },
        newValues: { profileId },
      },
    });

    res.json({ success: true, data: user });
  } catch (error) {
    console.error('Update user profile error:', error);
    res.status(500).json({ success: false, error: 'Failed to update user profile' });
  }
});

router.delete('/:id', authorize('User', 'delete'), async (req: AuthRequest, res: Response) => {
  try {
    const existingUser = await prisma.user.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });

    if (!existingUser) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    if (req.params.id === req.user!.id) {
      return res.status(400).json({ success: false, error: 'Cannot delete your own account' });
    }

    await prisma.userRole.deleteMany({ where: { userId: req.params.id } });
    await prisma.user.delete({ where: { id: req.params.id } });

    await prisma.auditLog.create({
      data: {
        tenantId: req.tenantId!,
        userId: req.user!.id,
        action: 'DELETE',
        objectType: 'User',
        objectId: req.params.id,
        oldValues: existingUser,
      },
    });

    res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete user' });
  }
});

export { router as userRoutes };