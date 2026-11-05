import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '@dct-crm/db';
import { auditLog } from '../../middleware/audit';
import { authenticate, AuthRequest } from '../../middleware/auth';
import { getTelephonySettings, listRecentDialpadCalls, saveTelephonySettings, telephonySettingsSchema } from '../../services/telephonySettings';
import { EffectivePermissionService } from '../../services/effectivePermissions';
import { normalizeLeadPhone } from '../../services/leadDuplicateDetection';
import { checkDialpadEmbedding } from '../../services/telephonyEmbedding';
import { getPublicApiBaseUrl } from '../../services/publicApiBaseUrl';
import { DEFAULT_DIALPAD_URL, TelephonyUrlError, buildDialpadUrl } from '../../services/telephonyUrl';
import { maskPhone } from '../../services/telephonyNumber';

const router = Router();
router.use(authenticate);
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
});

function requireAdministrator(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user?.isSuperAdmin && !req.user?.isAdmin) {
    return res.status(403).json({ success: false, ok: false, code: 'NO_PERMISSION', message: 'Administrator access is required', step: 'blocked_before_send', error: 'Administrator access is required' });
  }
  next();
}

const TELEPHONY_PERMISSION_UNAVAILABLE_MESSAGE =
  'TELEPHONY_CALL is missing from public."Permission"."name". Run scripts/repair-telephony-permission.sql as described in TELEPHONY_AWS_FIX.md.';

function isMissingPermissionTable(error: unknown) {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'P2021' &&
    'meta' in error &&
    String((error.meta as { table?: unknown } | undefined)?.table || '').includes('Permission'),
  );
}

function permissionUnavailableResponse(res: Response, tableMissing = false) {
  return res.status(503).json({
    success: false,
    ok: false,
    code: 'PERMISSION_UNAVAILABLE',
    message: tableMissing
      ? 'The public."Permission" table is missing. Run scripts/repair-telephony-permission.sql as described in TELEPHONY_AWS_FIX.md.'
      : TELEPHONY_PERMISSION_UNAVAILABLE_MESSAGE,
  });
}

router.use(requireAdministrator);

function getPublicApiUrl(req: AuthRequest) {
  const trustProxy = req.app.get('trust proxy fn') as ((address: string, index: number) => boolean) | undefined;
  const trustedProxy = Boolean(trustProxy?.(req.socket.remoteAddress || '', 0));
  return getPublicApiBaseUrl({
    nodeEnv: process.env.NODE_ENV,
    publicBaseUrl: process.env.PUBLIC_API_BASE_URL,
    allowedHosts: process.env.ALLOWED_API_HOSTS,
    trustProxy: trustedProxy,
    protocol: req.protocol,
    host: req.get('host') || '',
    forwardedProto: trustedProxy ? req.get('x-forwarded-proto') : undefined,
    forwardedHost: trustedProxy ? req.get('x-forwarded-host') : undefined,
  });
}

router.get('/environment-check', async (req: AuthRequest, res: Response) => {
  try {
    const [tables] = await prisma.$queryRaw<Array<{ settingsTable: string | null; agentTable: string | null }>>`
      SELECT
        to_regclass('public.telephony_settings')::text AS "settingsTable",
        to_regclass('public.telephony_agent_permissions')::text AS "agentTable"
    `;
    const settingsTablePresent = Boolean(tables?.settingsTable);
    const agentPermissionTablePresent = Boolean(tables?.agentTable);
    const [settings, profiles] = await Promise.all([
      settingsTablePresent
        ? prisma.telephonySetting.findUnique({
            where: { tenantId: req.tenantId! },
          select: { dialpadUrl: true },
          })
        : Promise.resolve(null),
      prisma.profile.findMany({
        where: { tenantId: req.tenantId! },
        select: {
          name: true,
          isAdmin: true,
          profilePermissions: { select: { permission: { select: { name: true } } } },
        },
      }),
    ]);
    const defaultProfiles = profiles.filter((profile) =>
      profile.isAdmin || /^(system administrator|admin|sales|pre[\s-]?sales)(\s|$)/i.test(profile.name),
    );
    const base = getPublicApiUrl(req);
    res.json({
      success: true,
      ok: true,
      data: {
        tables: {
          telephonySettings: settingsTablePresent,
          telephonyAgentPermissions: agentPermissionTablePresent,
        },
        permissionProfiles: defaultProfiles.map((profile) => ({
          name: profile.name,
          granted: profile.profilePermissions.some(({ permission }) => permission.name === 'TELEPHONY_CALL'),
        })),
        apiBaseUrl: base.baseUrl || null,
        apiBaseUrlSource: base.source,
        dialpadUrl: settings?.dialpadUrl || 'https://bizcall.cxteletech.com/embed/dialpad',
      },
    });
  } catch (error) {
    console.error('Telephony environment check failed', error instanceof Error ? error.name : 'error');
    res.status(503).json({
      success: false,
      ok: false,
      code: 'ENVIRONMENT_CHECK_UNAVAILABLE',
      message: 'The telephony environment check could not complete.',
    });
  }
});

function settingsFailure(error: unknown) {
  if (error instanceof z.ZodError) {
    return { status: 400, code: 'INVALID_SETTINGS', message: error.errors[0]?.message || 'Check the telephony settings.' };
  }
  if (error instanceof TelephonyUrlError) {
    return { status: 400, code: 'INVALID_SETTINGS', message: error.message };
  }
  if (error instanceof Error && /dialpad URL|E\.164|DNC|production origin/i.test(error.message)) {
    return { status: 400, code: 'INVALID_SETTINGS', message: error.message };
  }
  return null;
}

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const data = await getTelephonySettings(req.tenantId!);
    res.json({ success: true, ok: true, data });
  } catch (error) {
    console.error('Get telephony settings error', error instanceof Error ? error.name : 'error');
    res.status(500).json({ success: false, ok: false, code: 'SETTINGS_UNAVAILABLE', message: 'Failed to load telephony settings', step: 'blocked_before_send', error: 'Failed to load telephony settings' });
  }
});

router.put('/', async (req: AuthRequest, res: Response) => {
  try {
    const input = telephonySettingsSchema.parse(req.body || {});
    const data = await saveTelephonySettings(req.tenantId!, req.user!.id, input);
    res.json({ success: true, ok: true, code: 'SAVED', message: 'Telephony settings saved.', step: 'blocked_before_send', data });
  } catch (error) {
    const failure = settingsFailure(error);
    if (failure) {
      return res.status(failure.status).json({ success: false, ok: false, code: failure.code, message: failure.message, step: 'blocked_before_send', error: failure.message });
    }
    console.error('Save telephony settings error', error instanceof Error ? error.name : 'error');
    res.status(500).json({ success: false, ok: false, code: 'SETTINGS_UNAVAILABLE', message: 'Failed to save telephony settings', step: 'blocked_before_send', error: 'Failed to save telephony settings' });
  }
});

router.post('/check-embedding', async (req: AuthRequest, res: Response) => {
  const parsed = z.object({ origin: z.string().trim().min(1).max(500) }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, ok: false, code: 'INVALID_ORIGIN', message: 'Provide the CRM origin to check.' });
  }
  try {
    const settings = await prisma.telephonySetting.findUnique({
      where: { tenantId: req.tenantId! },
      select: { dialpadUrl: true },
    });
    const result = await checkDialpadEmbedding(settings?.dialpadUrl || 'https://bizcall.cxteletech.com/embed/dialpad', parsed.data.origin);
    return res.json({ success: true, ok: true, data: result });
  } catch (error) {
    if (error instanceof TelephonyUrlError || (error instanceof Error && error.message === 'Provide a valid CRM origin.')) {
      return res.status(400).json({ success: false, ok: false, code: 'INVALID_DIALPAD_URL', message: error.message });
    }
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    console.error('Telephony embedding check failed', error instanceof Error ? error.name : 'error');
    return res.status(timedOut ? 504 : 502).json({
      success: false,
      ok: false,
      code: timedOut ? 'EMBEDDING_CHECK_TIMEOUT' : 'EMBEDDING_CHECK_FAILED',
      message: timedOut ? 'The Bizcall embedding check timed out after 5 seconds.' : 'The Bizcall embedding headers could not be fetched.',
    });
  }
});

router.post('/open-dialpad-with-my-number', async (req: AuthRequest, res: Response) => {
  try {
    const [user, settings] = await Promise.all([
      prisma.user.findFirst({
        where: { id: req.user!.id, tenantId: req.tenantId! },
        select: { phone: true, firstName: true, lastName: true },
      }),
      prisma.telephonySetting.findUnique({ where: { tenantId: req.tenantId! } }),
    ]);
    const number = normalizeLeadPhone(user?.phone, null);
    if (!number) {
      return res.status(409).json({ success: false, ok: false, code: 'ADMIN_PHONE_MISSING', message: 'Add a valid phone number to your user profile before opening the dialpad.' });
    }
    if (!settings?.isActive) {
      return res.status(409).json({ success: false, ok: false, code: 'TELEPHONY_INACTIVE', message: 'Turn on telephony before opening the dialpad.' });
    }
    const dialpadUrl = buildDialpadUrl(settings.dialpadUrl || DEFAULT_DIALPAD_URL, {
      userId: req.user!.id,
      number: number.e164,
      autoDial: settings.autoDialOnClick ?? false,
      theme: (settings.theme || 'CRM') as 'CRM' | 'LIGHT' | 'DARK',
    });
    return res.json({ success: true, ok: true, data: { dialpadUrl, maskedNumber: maskPhone(number.e164) } });
  } catch (error) {
    const failure = settingsFailure(error);
    if (failure) {
      return res.status(failure.status).json({ success: false, ok: false, code: failure.code, message: failure.message });
    }
    console.error('Open dialpad with own number failed', error instanceof Error ? error.name : 'error');
    return res.status(500).json({ success: false, ok: false, code: 'DIALPAD_OPEN_FAILED', message: 'The dialpad could not be opened.' });
  }
});

router.get('/logs', async (req: AuthRequest, res: Response) => {
  try {
    const logs = await listRecentDialpadCalls(req.tenantId!);
    const userIds = [...new Set(logs.map((row) => row.userId))];
    const leadIds = [...new Set(logs.map((row) => row.leadId).filter((id): id is string => Boolean(id)))];
    const [users, leads] = await Promise.all([
      userIds.length
        ? prisma.user.findMany({ where: { id: { in: userIds }, tenantId: req.tenantId! }, select: { id: true, firstName: true, lastName: true } })
        : [],
      leadIds.length
        ? prisma.lead.findMany({ where: { id: { in: leadIds }, tenantId: req.tenantId! }, select: { id: true, leadNumber: true, firstName: true, lastName: true } })
        : [],
    ]);
    const userName = new Map(users.map((user) => [user.id, [user.firstName, user.lastName].filter(Boolean).join(' ') || user.id]));
    const leadLabel = new Map(leads.map((lead) => [lead.id, [lead.leadNumber, [lead.firstName, lead.lastName].filter(Boolean).join(' ')].filter(Boolean).join(' · ')]));
    res.json({
      success: true,
      ok: true,
      data: logs.map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        userName: userName.get(row.userId) || 'User',
        leadLabel: row.leadId ? leadLabel.get(row.leadId) || 'Lead' : '',
        maskedNumber: row.maskedNumber,
        step: row.step,
        code: row.code,
        httpStatus: row.httpStatus,
        durationMs: row.durationMs,
        reason: row.reason,
      })),
    });
  } catch (error) {
    console.error('Telephony logs error', error instanceof Error ? error.name : 'error');
    res.status(500).json({ success: false, ok: false, code: 'LOGS_UNAVAILABLE', message: 'Failed to load recent calls', step: 'blocked_before_send', error: 'Failed to load recent calls' });
  }
});

router.get('/agents', async (req: AuthRequest, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      where: { tenantId: req.tenantId!, isActive: true, isSuperAdmin: false },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        profile: { select: { id: true, name: true } },
      },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    });
    const rows = await Promise.all(users.map(async (user) => {
      const [canUseTelephony, lastCall] = await Promise.all([
        EffectivePermissionService.hasPermission(user.id, 'TELEPHONY_CALL'),
        prisma.callDetail.findFirst({
          where: { tenantId: req.tenantId!, createdById: user.id, callType: 'OUTBOUND' },
          orderBy: { startAt: 'desc' },
          select: { startAt: true },
        }),
      ]);
      return {
        userId: user.id,
        userName: `${user.firstName} ${user.lastName}`.trim(),
        profileId: user.profile?.id || null,
        profileName: user.profile?.name || '—',
        canUseTelephony,
        registeredInBizcall: 'unknown',
        lastCallAt: lastCall?.startAt || null,
      };
    }));
    res.json({ success: true, ok: true, data: rows });
  } catch (error) {
    console.error('Telephony agents error', error instanceof Error ? error.name : 'error');
    res.status(500).json({ success: false, ok: false, code: 'AGENTS_UNAVAILABLE', message: 'Failed to load telephony agents.' });
  }
});

router.put('/agents', async (req: AuthRequest, res: Response) => {
  const body = z.object({
    userIds: z.array(z.string().trim().min(1)).max(500).optional(),
    profileId: z.string().trim().min(1).optional(),
    enabled: z.boolean(),
  }).refine((value) => Boolean(value.userIds?.length) !== Boolean(value.profileId), {
    message: 'Provide either userIds or profileId.',
  }).safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ success: false, ok: false, code: 'INVALID_AGENTS', message: body.error.errors[0]?.message || 'Invalid agent update.' });
  }
  try {
    const permission = await prisma.permission.findUnique({ where: { name: 'TELEPHONY_CALL' }, select: { id: true } });
    if (!permission) return permissionUnavailableResponse(res);
    if (body.data.profileId) {
      const profile = await prisma.profile.findFirst({ where: { id: body.data.profileId, tenantId: req.tenantId! }, select: { id: true } });
      if (!profile) return res.status(404).json({ success: false, ok: false, code: 'PROFILE_NOT_FOUND', message: 'Profile not found.' });
      const profileUsers = await prisma.user.findMany({
        where: { tenantId: req.tenantId!, profileId: profile.id, isSuperAdmin: false },
        select: { id: true },
      });
      await prisma.$transaction(async (tx) => {
        if (body.data.enabled) {
          await tx.userProfilePermission.upsert({
            where: { profileId_permissionId: { profileId: profile.id, permissionId: permission.id } },
            create: { profileId: profile.id, permissionId: permission.id },
            update: {},
          });
        } else {
          await tx.userProfilePermission.deleteMany({ where: { profileId: profile.id, permissionId: permission.id } });
        }
      });
      EffectivePermissionService.invalidateUserPermissionsCache(profileUsers.map(({ id }) => id));
    } else {
      const userIds = [...new Set(body.data.userIds || [])];
      const users = await prisma.user.findMany({ where: { id: { in: userIds }, tenantId: req.tenantId!, isSuperAdmin: false }, select: { id: true } });
      if (users.length !== userIds.length) return res.status(404).json({ success: false, ok: false, code: 'USER_NOT_FOUND', message: 'One or more users were not found in this company.' });
      await prisma.$transaction(async (tx) => {
        await Promise.all(userIds.map((userId) => tx.telephonyAgentPermission.upsert({
          where: { tenantId_userId: { tenantId: req.tenantId!, userId } },
          create: { tenantId: req.tenantId!, userId, canUse: body.data.enabled, updatedById: req.user!.id },
          update: { canUse: body.data.enabled, updatedById: req.user!.id },
        })));
        if (body.data.enabled) {
          await tx.userDirectPermission.createMany({
            data: userIds.map((userId) => ({ userId, permissionId: permission.id })),
            skipDuplicates: true,
          });
        } else {
          await tx.userDirectPermission.deleteMany({ where: { userId: { in: userIds }, permissionId: permission.id } });
        }
      });
      EffectivePermissionService.invalidateUserPermissionsCache(userIds);
    }
    await auditLog(req.tenantId!, req.user!.id, 'TELEPHONY_AGENT_PERMISSIONS_UPDATED', 'TelephonySetting', req.tenantId!, undefined, {
      profileId: body.data.profileId || null,
      userCount: body.data.userIds?.length || 0,
      enabled: body.data.enabled,
    });
    res.json({ success: true, ok: true, message: 'Telephony agent access updated.' });
  } catch (error) {
    console.error('Update telephony agents error', error instanceof Error ? error.name : 'error');
    if (isMissingPermissionTable(error)) return permissionUnavailableResponse(res, true);
    res.status(500).json({ success: false, ok: false, code: 'AGENTS_UPDATE_FAILED', message: 'Failed to update telephony agent access.' });
  }
});

router.put('/agents/grant-default-profiles', async (req: AuthRequest, res: Response) => {
  try {
    const permission = await prisma.permission.findUnique({ where: { name: 'TELEPHONY_CALL' }, select: { id: true } });
    if (!permission) return permissionUnavailableResponse(res);
    const profiles = await prisma.profile.findMany({
      where: {
        tenantId: req.tenantId!,
        OR: [
          { isAdmin: true },
          { name: { in: ['Admin', 'Sales', 'Presales', 'Pre-Sales', 'System Administrator'], mode: 'insensitive' } },
        ],
      },
      select: { id: true, name: true },
    });
    const profileUsers = profiles.length
      ? await prisma.user.findMany({
          where: { tenantId: req.tenantId!, profileId: { in: profiles.map(({ id }) => id) }, isActive: true, isSuperAdmin: false },
          select: { id: true },
        })
      : [];
    await prisma.$transaction(async (tx) => {
      await tx.userProfilePermission.createMany({
        data: profiles.map(({ id }) => ({ profileId: id, permissionId: permission.id })),
        skipDuplicates: true,
      });
    });
    EffectivePermissionService.invalidateUserPermissionsCache(profileUsers.map(({ id }) => id));
    await auditLog(req.tenantId!, req.user!.id, 'TELEPHONY_DEFAULT_PROFILES_GRANTED', 'Permission', permission.id, undefined, {
      profileNames: profiles.map(({ name }) => name),
    });
    return res.json({
      success: true,
      ok: true,
      data: { grantedProfiles: profiles.map(({ name }) => name) },
    });
  } catch (error) {
    console.error('Grant default telephony profiles failed', error instanceof Error ? error.name : 'error');
    if (isMissingPermissionTable(error)) return permissionUnavailableResponse(res, true);
    return res.status(500).json({
      success: false,
      ok: false,
      code: 'DEFAULT_PROFILE_GRANT_FAILED',
      message: 'Failed to grant telephony access to the default profiles.',
    });
  }
});

export default router;
