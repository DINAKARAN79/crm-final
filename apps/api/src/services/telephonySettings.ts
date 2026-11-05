import { z } from 'zod';
import { prisma } from '@dct-crm/db';
import { auditLog } from '../middleware/audit';
import { assertDialpadUrl, DEFAULT_DIALPAD_URL } from './telephonyUrl';
import { maskPhone } from './telephonyNumber';

export const telephonySettingsSchema = z.object({
  isActive: z.boolean().default(false),
  dialpadUrl: z.string().trim().min(1).max(500).default(DEFAULT_DIALPAD_URL),
  dialpadMode: z.enum(['DOCKED', 'NEW_TAB']).default('DOCKED'),
  defaultDockState: z.enum(['COLLAPSED', 'EXPANDED']).default('COLLAPSED'),
  theme: z.enum(['CRM', 'LIGHT', 'DARK']).default('CRM'),
  productionOrigin: z.string().trim().max(500).optional().default(''),
  duplicateGuardSeconds: z.number().int().min(1).max(120).default(10),
  callsPerMinute: z.number().int().min(1).max(60).default(10),
  maskNumbers: z.boolean().default(false),
  sendTenantIdInDial: z.boolean().default(true),
  autoDialOnClick: z.boolean().default(false),
  blockDnc: z.boolean().default(false),
  dncNumbers: z.string().max(100_000).default(''),
});

export type TelephonyStatus = 'not_configured' | 'active' | 'inactive';

export type PublicTelephonySettings = {
  isActive: boolean;
  status: TelephonyStatus;
  statusLabel: string;
  dialpadUrl: string;
  dialpadOrigin: string;
  dialpadMode: 'DOCKED' | 'NEW_TAB';
  defaultDockState: 'COLLAPSED' | 'EXPANDED';
  theme: 'CRM' | 'LIGHT' | 'DARK';
  productionOrigin: string;
  duplicateGuardSeconds: number;
  callsPerMinute: number;
  maskNumbers: boolean;
  sendTenantIdInDial: boolean;
  autoDialOnClick: boolean;
  blockDnc: boolean;
  dncNumbers: string;
};

function publicTelephonySettings(row: {
  dialpadUrl?: string | null;
  dialpadMode?: string | null;
  isActive: boolean;
  defaultDockState?: string | null;
  theme?: string | null;
  productionOrigin?: string | null;
  duplicateGuardSeconds?: number | null;
  callsPerMinute?: number | null;
  maskNumbers?: boolean | null;
  sendTenantIdInDial?: boolean | null;
  autoDialOnClick?: boolean | null;
  blockDnc?: boolean | null;
  dncNumbers?: string | null;
} | null): PublicTelephonySettings {
  const dialpadUrl = row?.dialpadUrl || DEFAULT_DIALPAD_URL;
  const status: TelephonyStatus = !row ? 'not_configured' : row.isActive ? 'active' : 'inactive';
  return {
    isActive: Boolean(row?.isActive),
    status,
    statusLabel: status === 'active' ? 'Configured and active' : status === 'inactive' ? 'Inactive' : 'Not configured',
    dialpadUrl,
    dialpadOrigin: new URL(dialpadUrl).origin,
    dialpadMode: (row?.dialpadMode || 'DOCKED') as 'DOCKED' | 'NEW_TAB',
    defaultDockState: (row?.defaultDockState || 'COLLAPSED') as 'COLLAPSED' | 'EXPANDED',
    theme: (row?.theme || 'CRM') as 'CRM' | 'LIGHT' | 'DARK',
    productionOrigin: row?.productionOrigin || '',
    duplicateGuardSeconds: row?.duplicateGuardSeconds ?? 10,
    callsPerMinute: row?.callsPerMinute ?? 10,
    maskNumbers: row?.maskNumbers ?? false,
    sendTenantIdInDial: row?.sendTenantIdInDial ?? true,
    autoDialOnClick: row?.autoDialOnClick ?? false,
    blockDnc: row?.blockDnc ?? false,
    dncNumbers: row?.dncNumbers || '',
  };
}

export async function getTelephonySettings(tenantId: string) {
  const row = await prisma.telephonySetting.findUnique({ where: { tenantId } });
  return publicTelephonySettings(row);
}

export async function saveTelephonySettings(
  tenantId: string,
  userId: string,
  input: z.infer<typeof telephonySettingsSchema>,
) {
  const dialpadUrl = assertDialpadUrl(input.dialpadUrl);
  const dncNumbers = [...new Set(input.dncNumbers.split(/[\s,;]+/).map((number) => number.trim()).filter(Boolean))];
  if (dncNumbers.some((number) => !/^\+[1-9]\d{7,14}$/.test(number))) {
    throw new Error('DNC entries must be valid E.164 numbers (for example +14155552671).');
  }
  const productionOrigin = input.productionOrigin.trim();
  if (productionOrigin) {
    let origin: URL;
    try {
      origin = new URL(productionOrigin);
    } catch {
      throw new Error('Enter a valid production CRM origin.');
    }
    if (origin.protocol !== 'https:' || origin.origin !== productionOrigin.replace(/\/$/, '')) {
      throw new Error('Production origin must be an HTTPS origin without a path.');
    }
  }

  const existing = await prisma.telephonySetting.findUnique({ where: { tenantId } });
  const saved = await prisma.telephonySetting.upsert({
    where: { tenantId },
    create: {
      tenantId,
      isActive: input.isActive,
      updatedById: userId,
      dialpadUrl,
      dialpadMode: input.dialpadMode,
      defaultDockState: input.defaultDockState,
      theme: input.theme,
      productionOrigin: productionOrigin || null,
      duplicateGuardSeconds: input.duplicateGuardSeconds,
      callsPerMinute: input.callsPerMinute,
      maskNumbers: input.maskNumbers,
      sendTenantIdInDial: input.sendTenantIdInDial,
      autoDialOnClick: input.autoDialOnClick,
      blockDnc: input.blockDnc,
      dncNumbers: dncNumbers.join('\n'),
    },
    update: {
      isActive: input.isActive,
      updatedById: userId,
      dialpadUrl,
      dialpadMode: input.dialpadMode,
      defaultDockState: input.defaultDockState,
      theme: input.theme,
      productionOrigin: productionOrigin || null,
      duplicateGuardSeconds: input.duplicateGuardSeconds,
      callsPerMinute: input.callsPerMinute,
      maskNumbers: input.maskNumbers,
      sendTenantIdInDial: input.sendTenantIdInDial,
      autoDialOnClick: input.autoDialOnClick,
      blockDnc: input.blockDnc,
      dncNumbers: dncNumbers.join('\n'),
    },
  });

  const beforeAudit = existing ? publicTelephonySettings(existing) : null;
  const afterAudit = publicTelephonySettings(saved);
  if (JSON.stringify(beforeAudit) !== JSON.stringify(afterAudit)) {
    await auditLog(tenantId, userId, 'TELEPHONY_SETTINGS_UPDATED', 'TelephonySetting', saved.id, beforeAudit || {}, afterAudit);
  }

  return afterAudit;
}

export async function listRecentDialpadCalls(tenantId: string) {
  const calls = await prisma.callDetail.findMany({
    where: { tenantId, source: 'dialpad' },
    orderBy: { startAt: 'desc' },
    take: 50,
    select: {
      id: true,
      createdById: true,
      leadId: true,
      callTo: true,
      status: true,
      startAt: true,
    },
  });
  return calls.map((call) => ({
    id: call.id,
    userId: call.createdById,
    leadId: call.leadId,
    maskedNumber: call.callTo ? maskPhone(call.callTo) : '',
    step: call.status,
    code: call.status,
    httpStatus: null,
    durationMs: null,
    reason: null,
    createdAt: call.startAt,
  }));
}
