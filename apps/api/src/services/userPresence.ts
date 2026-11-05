import { createHash, randomBytes } from 'crypto';
import type { Request } from 'express';
import { prisma } from '@dct-crm/db';
import { auditLog } from '../middleware/audit';
import { requestIp } from './apiKeys';
import { notifyTenantPresence } from './presenceEvents';

export const DEFAULT_IDLE_TIMEOUT_SECONDS = 120;
export const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 30;
export const SESSION_RETENTION_DAYS = 90;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const MANAGED_USER_FIELDS = ['isLoggedIn', 'lastLoginAt', 'lastSeenAt', 'lastLogoutAt'] as const;

export type SessionEndReason =
  | 'LOGOUT'
  | 'EXPIRED'
  | 'IDLE_TIMEOUT'
  | 'REVOKED'
  | 'PASSWORD_CHANGED'
  | 'USER_DEACTIVATED'
  | 'ADMIN_FORCED';

export type PresenceSession = {
  id: string;
  endedAt: Date | null;
  lastSeenAt: Date;
  isImpersonation: boolean;
};

export function newSessionSecret() {
  return randomBytes(32).toString('base64url');
}

export function hashSessionSecret(secret: string) {
  return createHash('sha256').update(secret).digest('hex');
}

export function rejectManagedUserFields(body: unknown) {
  if (!body || typeof body !== 'object') return;
  for (const key of MANAGED_USER_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      const error = new Error(`System field ${key} cannot be set.`);
      error.name = 'ManagedUserFieldError';
      throw error;
    }
  }
}

export function parseClient(userAgent: string | undefined) {
  const ua = userAgent || '';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Chrome\//.test(ua) ? 'Chrome'
      : /Firefox\//.test(ua) ? 'Firefox'
        : /Safari\//.test(ua) ? 'Safari'
          : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows'
    : /Mac OS|Macintosh/.test(ua) ? 'macOS'
      : /Android/.test(ua) ? 'Android'
        : /iPhone|iPad/.test(ua) ? 'iOS'
          : /Linux/.test(ua) ? 'Linux'
            : 'Unknown';
  const deviceType = /iPad|Tablet/.test(ua) ? 'tablet' : /Mobile|Android|iPhone/.test(ua) ? 'mobile' : 'desktop';
  return { browser, os, deviceType };
}

export function maskIp(ip: string | null | undefined) {
  if (!ip) return null;
  if (ip.includes('.')) {
    const parts = ip.split('.');
    return `${parts[0]}.${parts[1] || '0'}.*.*`;
  }
  return `${ip.slice(0, 4)}…`;
}

export function isSessionOnline(session: PresenceSession, now: Date, idleMs: number) {
  if (session.endedAt || session.isImpersonation) return false;
  return now.getTime() - session.lastSeenAt.getTime() <= idleMs;
}

export function deriveLoggedIn(sessions: PresenceSession[], now: Date, idleMs: number) {
  return sessions.some((session) => isSessionOnline(session, now, idleMs));
}

type PresenceState = {
  sessions: Array<PresenceSession & { userId: string }>;
  isLoggedIn: boolean;
  lastLogoutAt: Date | null;
};

export function reducePresence(
  state: PresenceState,
  event:
    | { type: 'login'; session: PresenceSession & { userId: string } }
    | { type: 'end'; sessionId: string; at: Date }
    | { type: 'end-all'; at: Date }
    | { type: 'seen'; sessionId: string; at: Date },
  now: Date,
  idleMs: number,
): PresenceState {
  let sessions = state.sessions.map((session) => ({ ...session }));
  if (event.type === 'login') sessions = [...sessions, event.session];
  if (event.type === 'end') {
    sessions = sessions.map((session) => session.id === event.sessionId ? { ...session, endedAt: event.at } : session);
  }
  if (event.type === 'end-all') {
    sessions = sessions.map((session) => session.endedAt ? session : { ...session, endedAt: event.at });
  }
  if (event.type === 'seen') {
    sessions = sessions.map((session) => session.id === event.sessionId && !session.endedAt
      ? { ...session, lastSeenAt: event.at }
      : session);
  }
  const online = deriveLoggedIn(sessions, now, idleMs);
  return {
    sessions,
    isLoggedIn: online,
    lastLogoutAt: state.isLoggedIn && !online ? now : state.lastLogoutAt,
  };
}

const heartbeatHits = new Map<string, number>();
const sessionAcceptance = new Map<string, { ok: boolean; at: number }>();
export const SESSION_ACCEPTANCE_TTL_MS = 5_000;

export function resetPresenceGuards() {
  heartbeatHits.clear();
  sessionAcceptance.clear();
}

export function forgetSessionAcceptance(sessionTokenHash: string) {
  sessionAcceptance.delete(sessionTokenHash);
}

export async function sessionIsAccepted(secret: string | undefined, now = Date.now()) {
  if (!secret) return true;
  const hash = hashSessionSecret(secret);
  const cached = sessionAcceptance.get(hash);
  if (cached && now - cached.at < SESSION_ACCEPTANCE_TTL_MS) return cached.ok;
  const row = await prisma.userSession.findUnique({
    where: { sessionTokenHash: hash },
    select: { endedAt: true, endReason: true },
  });
  const ok = !row?.endedAt || row.endReason === 'IDLE_TIMEOUT';
  sessionAcceptance.set(hash, { ok, at: now });
  return ok;
}

export async function liveOnlineUserIds(tenantId: string, now = new Date()) {
  const cutoff = new Date(now.getTime() - await idleTimeoutMs(tenantId));
  const rows = await prisma.userSession.findMany({
    where: { tenantId, endedAt: null, isImpersonation: false, lastSeenAt: { gte: cutoff } },
    select: { userId: true },
    distinct: ['userId'],
  });
  return rows.map((row) => row.userId);
}

export function allowHeartbeat(userId: string, now = Date.now(), minGapMs = 10_000) {
  const previous = heartbeatHits.get(userId);
  if (previous !== undefined && now - previous < minGapMs) return false;
  heartbeatHits.set(userId, now);
  return true;
}

export function validatePresenceSettings(idleTimeoutSeconds: number, heartbeatIntervalSeconds: number) {
  if (!Number.isInteger(heartbeatIntervalSeconds) || heartbeatIntervalSeconds < 15 || heartbeatIntervalSeconds > 120) {
    throw new Error('Heartbeat interval must be between 15 and 120 seconds.');
  }
  if (!Number.isInteger(idleTimeoutSeconds) || idleTimeoutSeconds < 60 || idleTimeoutSeconds > 3600) {
    throw new Error('Idle timeout must be between 1 and 60 minutes.');
  }
  if (idleTimeoutSeconds < heartbeatIntervalSeconds * 3) {
    throw new Error('Idle timeout must be at least three times the heartbeat interval.');
  }
}

async function idleTimeoutMs(tenantId: string) {
  const row = await prisma.presenceSetting.findUnique({ where: { tenantId }, select: { idleTimeoutSeconds: true } });
  return (row?.idleTimeoutSeconds || DEFAULT_IDLE_TIMEOUT_SECONDS) * 1000;
}

export async function getPresenceSettings(tenantId: string) {
  const row = await prisma.presenceSetting.findUnique({ where: { tenantId } });
  return {
    idleTimeoutSeconds: row?.idleTimeoutSeconds || DEFAULT_IDLE_TIMEOUT_SECONDS,
    heartbeatIntervalSeconds: row?.heartbeatIntervalSeconds || DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
  };
}

export async function savePresenceSettings(tenantId: string, userId: string, input: { idleTimeoutSeconds: number; heartbeatIntervalSeconds: number }) {
  validatePresenceSettings(input.idleTimeoutSeconds, input.heartbeatIntervalSeconds);
  const saved = await prisma.presenceSetting.upsert({
    where: { tenantId },
    create: { tenantId, ...input, updatedById: userId },
    update: { ...input, updatedById: userId },
  });
  await auditLog(tenantId, userId, 'PRESENCE_SETTINGS_UPDATED', 'PresenceSetting', tenantId, undefined, input);
  return {
    idleTimeoutSeconds: saved.idleTimeoutSeconds,
    heartbeatIntervalSeconds: saved.heartbeatIntervalSeconds,
  };
}

export async function recomputeLoggedIn(userId: string, tenantId: string, now = new Date()) {
  const idleMs = await idleTimeoutMs(tenantId);
  const cutoff = new Date(now.getTime() - idleMs);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    const active = await tx.userSession.count({
      where: { userId, endedAt: null, isImpersonation: false, lastSeenAt: { gte: cutoff } },
    });
    const current = await tx.user.findUnique({ where: { id: userId }, select: { isLoggedIn: true } });
    const online = active > 0;
    await tx.user.update({
      where: { id: userId },
      data: {
        isLoggedIn: online,
        ...(current?.isLoggedIn && !online ? { lastLogoutAt: now } : {}),
      },
    });
  });
}

export async function openUserSession(input: {
  userId: string;
  tenantId: string;
  sessionSecret: string;
  refreshTokenSecret?: string;
  refreshTokenExpiresAt?: Date;
  req: Request;
  isImpersonation: boolean;
}) {
  const now = new Date();
  const client = parseClient(input.req.get('user-agent'));
  await prisma.$transaction(async (tx) => {
    await tx.userSession.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        sessionTokenHash: hashSessionSecret(input.sessionSecret),
        refreshTokenHash: input.refreshTokenSecret ? hashSessionSecret(input.refreshTokenSecret) : null,
        refreshTokenExpiresAt: input.refreshTokenSecret
          ? input.refreshTokenExpiresAt || new Date(now.getTime() + REFRESH_TOKEN_TTL_MS)
          : null,
        browser: client.browser,
        os: client.os,
        deviceType: client.deviceType,
        ipAddress: requestIp(input.req) || null,
        createdAt: now,
        lastSeenAt: now,
        isImpersonation: input.isImpersonation,
      },
    });
    if (!input.isImpersonation) {
      await tx.user.update({
        where: { id: input.userId },
        data: { isLoggedIn: true, lastLoginAt: now, lastSeenAt: now },
      });
    }
  });
  if (!input.isImpersonation) await notifyTenantPresence(input.tenantId, input.userId);
}

export async function touchUserSession(input: {
  userId: string;
  tenantId: string;
  sessionSecret: string;
  req: Request;
  isImpersonation: boolean;
}) {
  const now = new Date();
  const hash = hashSessionSecret(input.sessionSecret);
  const existing = await prisma.userSession.findUnique({ where: { sessionTokenHash: hash }, select: { id: true, endedAt: true, endReason: true } });
  if (!existing) {
    await openUserSession(input);
    return { created: true, blocked: false };
  }
  if (existing.endedAt) {
    if (existing.endReason !== 'IDLE_TIMEOUT') return { created: false, blocked: true };
    const client = parseClient(input.req.get('user-agent'));
    await prisma.userSession.update({
      where: { id: existing.id },
      data: {
        endedAt: null,
        endReason: null,
        lastSeenAt: now,
        browser: client.browser,
        os: client.os,
        deviceType: client.deviceType,
        ipAddress: requestIp(input.req) || null,
      },
    });
    if (!input.isImpersonation) {
      await prisma.user.update({ where: { id: input.userId }, data: { lastSeenAt: now, isLoggedIn: true } });
      await notifyTenantPresence(input.tenantId, input.userId);
    }
    return { created: false, blocked: false, revived: true };
  }
  await prisma.userSession.update({ where: { id: existing.id }, data: { lastSeenAt: now } });
  if (!input.isImpersonation) {
    await prisma.user.update({ where: { id: input.userId }, data: { lastSeenAt: now, isLoggedIn: true } });
  }
  return { created: false, blocked: false };
}

export async function markSessionStale(secret: string) {
  const row = await prisma.userSession.findUnique({
    where: { sessionTokenHash: hashSessionSecret(secret) },
    select: { endedAt: true, lastSeenAt: true },
  });
  if (!row || row.endedAt) return;
  // A refresh sends this beacon and the new page heartbeats before the beacon
  // arrives. A heartbeat in the last 10 seconds means the browser is still open.
  if (Date.now() - row.lastSeenAt.getTime() < 10_000) return;
  await endSessionBySecret(secret, 'IDLE_TIMEOUT');
}

export async function endSessionBySecret(secret: string, reason: SessionEndReason) {
  const row = await prisma.userSession.findUnique({
    where: { sessionTokenHash: hashSessionSecret(secret) },
    select: { id: true, userId: true, tenantId: true, endedAt: true, isImpersonation: true },
  });
  if (!row || row.endedAt) return null;
  await prisma.userSession.update({
    where: { id: row.id },
    data: { endedAt: new Date(), endReason: reason },
  });
  forgetSessionAcceptance(hashSessionSecret(secret));
  if (!row.isImpersonation) {
    await recomputeLoggedIn(row.userId, row.tenantId);
    await notifyTenantPresence(row.tenantId, row.userId);
  }
  return row;
}

export async function endSessionById(sessionId: string, tenantId: string, reason: SessionEndReason) {
  const row = await prisma.userSession.findFirst({
    where: { id: sessionId, tenantId, endedAt: null },
    select: { id: true, userId: true, tenantId: true, isImpersonation: true, sessionTokenHash: true },
  });
  if (!row) return null;
  await prisma.userSession.update({
    where: { id: row.id },
    data: { endedAt: new Date(), endReason: reason },
  });
  forgetSessionAcceptance(row.sessionTokenHash);
  if (!row.isImpersonation) {
    await recomputeLoggedIn(row.userId, row.tenantId);
    await notifyTenantPresence(row.tenantId, row.userId);
  }
  return row;
}

export async function endAllUserSessions(userId: string, tenantId: string, reason: SessionEndReason) {
  const open = await prisma.userSession.findMany({
    where: { userId, tenantId, endedAt: null },
    select: { sessionTokenHash: true },
  });
  await prisma.userSession.updateMany({
    where: { userId, tenantId, endedAt: null },
    data: { endedAt: new Date(), endReason: reason },
  });
  for (const row of open) forgetSessionAcceptance(row.sessionTokenHash);
  await recomputeLoggedIn(userId, tenantId);
  await notifyTenantPresence(tenantId, userId);
}

export async function sweepIdleSessions(now = new Date()) {
  const settings = await prisma.presenceSetting.findMany({ select: { tenantId: true, idleTimeoutSeconds: true } });
  const idleByTenant = new Map(settings.map((row) => [row.tenantId, row.idleTimeoutSeconds]));
  const open = await prisma.userSession.findMany({
    where: { endedAt: null },
    select: { id: true, tenantId: true, userId: true, lastSeenAt: true },
  });
  const stale = open.filter((row) => now.getTime() - new Date(row.lastSeenAt).getTime() > (idleByTenant.get(row.tenantId) || DEFAULT_IDLE_TIMEOUT_SECONDS) * 1000);
  if (stale.length > 0) {
    await prisma.userSession.updateMany({
      where: { id: { in: stale.map((row) => row.id) } },
      data: { endedAt: now, endReason: 'IDLE_TIMEOUT' },
    });
  }
  const ended = stale.map((row) => ({ userId: row.userId, tenantId: row.tenantId }));
  const seen = new Set<string>();
  for (const row of ended) {
    if (seen.has(row.userId)) continue;
    seen.add(row.userId);
    await recomputeLoggedIn(row.userId, row.tenantId);
    await notifyTenantPresence(row.tenantId, row.userId);
  }
  const cutoff = new Date(Date.now() - SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  await prisma.userSession.deleteMany({ where: { endedAt: { lt: cutoff } } });
  return ended.length;
}

export function relativeActivity(lastSeenAt: Date, now = new Date()) {
  const seconds = Math.max(0, Math.round((now.getTime() - lastSeenAt.getTime()) / 1000));
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes ago`;
  return `${Math.round(minutes / 60)} hours ago`;
}
