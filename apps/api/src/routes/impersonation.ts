import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticate, AuthRequest, generateToken } from '../middleware/auth';
import { requireSuperAdmin } from '../middleware/superAdmin';
import {
  ImpersonationError,
  exitImpersonation,
  getNotifySetting,
  impersonationExpirySeconds,
  impersonationStatus,
  listImpersonationLog,
  requestMeta,
  setNotifySetting,
  startImpersonation,
} from '../services/impersonation';
import { endSessionBySecret, newSessionSecret, openUserSession } from '../services/userPresence';
import { clearRefreshTokenCookie, setRefreshTokenCookie } from '../services/sessionTokens';

const router = Router();
const companyRouter = Router({ mergeParams: true });

const startSchema = z.object({
  adminUserId: z.string().trim().min(1).optional(),
  viewOnly: z.boolean().optional(),
  confirmInactive: z.boolean().optional(),
  password: z.string().min(1).max(200).optional(),
});

const settingSchema = z.object({
  notifyOnAccess: z.boolean(),
});

function sendImpersonationError(res: Response, error: unknown) {
  if (error instanceof ImpersonationError) {
    return res.status(error.status).json({
      success: false,
      error: error.message,
      code: error.code,
      admins: error.admins,
    });
  }
  if (error instanceof z.ZodError) {
    return res.status(400).json({ success: false, error: error.errors[0]?.message || 'Invalid impersonation request.' });
  }
  console.error('Impersonation error:', error);
  return res.status(500).json({ success: false, error: 'Failed to open the company.' });
}

companyRouter.use(authenticate, requireSuperAdmin);

companyRouter.post('/impersonate', async (req: AuthRequest, res: Response) => {
  try {
    if (req.impersonation) {
      throw new ImpersonationError(403, 'Cannot start another impersonation from this session.', 'nested_impersonation');
    }
    const body = startSchema.parse(req.body || {});
    const tenantId = String(req.params.tenantId || '');
    const meta = requestMeta(req);
    const started = await startImpersonation({
      superadminId: req.user!.id,
      tenantId,
      loginAt: req.sessionLoginAt,
      adminUserId: body.adminUserId,
      viewOnly: Boolean(body.viewOnly),
      confirmInactive: Boolean(body.confirmInactive),
      password: body.password,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    const sessionSecret = newSessionSecret();
    const refreshToken = newSessionSecret();
    await openUserSession({
      userId: started.actingUser.id,
      tenantId: started.actingUser.tenantId,
      sessionSecret,
      refreshTokenSecret: refreshToken,
      refreshTokenExpiresAt: started.session.hardExpiresAt,
      req,
      isImpersonation: true,
    });
    const token = generateToken({
      id: started.actingUser.id,
      email: started.actingUser.email,
      tenantId: started.actingUser.tenantId,
      isSuperAdmin: false,
      impersonatedBy: req.user!.id,
      loginAt: req.sessionLoginAt,
      sessionId: sessionSecret,
      isImpersonation: true,
      impersonationId: started.session.id,
      viewOnly: started.session.viewOnly,
    }, impersonationExpirySeconds(started.session.hardExpiresAt));
    setRefreshTokenCookie(res, sessionSecret, refreshToken, started.session.hardExpiresAt);
    res.status(201).json({
      success: true,
      data: {
        token,
        tenantId: started.session.tenantId,
        tenantName: started.tenantName,
        actingAs: started.actingAs,
        viewOnly: started.session.viewOnly,
        returnPath: started.session.returnPath,
        hardExpiresAt: started.session.hardExpiresAt.toISOString(),
      },
    });
  } catch (error) {
    sendImpersonationError(res, error);
  }
});

companyRouter.get('/impersonation-log', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = String(req.params.tenantId || '');
    res.json({ success: true, data: await listImpersonationLog(tenantId) });
  } catch (error) {
    sendImpersonationError(res, error);
  }
});

companyRouter.get('/impersonation-settings', async (req: AuthRequest, res: Response) => {
  try {
    res.json({ success: true, data: await getNotifySetting(String(req.params.tenantId || '')) });
  } catch (error) {
    sendImpersonationError(res, error);
  }
});

companyRouter.put('/impersonation-settings', async (req: AuthRequest, res: Response) => {
  try {
    const body = settingSchema.parse(req.body || {});
    res.json({ success: true, data: await setNotifySetting(String(req.params.tenantId || ''), body.notifyOnAccess) });
  } catch (error) {
    sendImpersonationError(res, error);
  }
});

router.post('/exit', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.impersonation) {
      return res.status(400).json({ success: false, error: 'You are not viewing a company as its admin.' });
    }
    if (req.sessionSecret) {
      await endSessionBySecret(req.sessionSecret, 'LOGOUT');
      clearRefreshTokenCookie(res, req.sessionSecret);
    }
    const restored = await exitImpersonation(req.impersonation.id);
    const token = generateToken({
      id: restored.superadmin.id,
      email: restored.superadmin.email,
      tenantId: restored.superadmin.tenantId,
      isSuperAdmin: true,
      loginAt: restored.loginAt,
    });
    res.json({ success: true, data: { token, returnPath: restored.returnPath } });
  } catch (error) {
    sendImpersonationError(res, error);
  }
});

router.get('/status', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const status = await impersonationStatus(req);
    const expiresAt = req.tokenExpiresAt ? new Date(req.tokenExpiresAt * 1000).toISOString() : null;
    res.json({ success: true, data: { ...status, expiresAt } });
  } catch (error) {
    sendImpersonationError(res, error);
  }
});

export { companyRouter as companyImpersonationRouter };
export default router;
