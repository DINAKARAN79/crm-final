import { prisma } from '@dct-crm/db';

export const REQUIRED_PERMISSION_NAMES = [
  'ACTIVITY_CREATE',
  'ACTIVITY_DELETE',
  'ACTIVITY_READ',
  'ACTIVITY_UPDATE',
  'AUDIT_READ',
  'CRM_RECEIPT_CREATE',
  'CRM_WELCOME_CALL_COMPLETE',
  'DASHBOARD_CREATE',
  'DASHBOARD_DELETE',
  'DASHBOARD_READ',
  'DASHBOARD_UPDATE',
  'DATA_EXPORT',
  'DATA_IMPORT',
  'ENQUIRY_CREATE',
  'ENQUIRY_DELETE',
  'ENQUIRY_READ',
  'ENQUIRY_UPDATE',
  'FOLLOW_UP_CREATE',
  'FOLLOW_UP_DELETE',
  'FOLLOW_UP_READ',
  'FOLLOW_UP_UPDATE',
  'FULL_SYSTEM_ACCESS',
  'LEAD_ASSIGN',
  'LEAD_CREATE',
  'LEAD_DELETE',
  'LEAD_READ',
  'LEAD_UPDATE',
  'PERMISSION_SET_ASSIGN',
  'PERMISSION_SET_CREATE',
  'PERMISSION_SET_DELETE',
  'PERMISSION_SET_READ',
  'PERMISSION_SET_UPDATE',
  'PROFILE_CREATE',
  'PROFILE_DELETE',
  'PROFILE_PERMISSION_MANAGE',
  'PROFILE_READ',
  'PROFILE_UPDATE',
  'PROJECT_CREATE',
  'PROJECT_DELETE',
  'PROJECT_READ',
  'PROJECT_UPDATE',
  'REPORT_CREATE',
  'REPORT_DELETE',
  'REPORT_READ',
  'REPORT_UPDATE',
  'REPORT_VIEW',
  'ROLE_CREATE',
  'ROLE_DELETE',
  'ROLE_READ',
  'ROLE_UPDATE',
  'SITE_VISIT_CREATE',
  'SITE_VISIT_DELETE',
  'SITE_VISIT_READ',
  'SITE_VISIT_UPDATE',
  'TASK_CREATE',
  'TASK_READ',
  'TELEPHONY_CALL',
  'UNIT_CREATE',
  'UNIT_DELETE',
  'UNIT_READ',
  'UNIT_UPDATE',
  'USER_CREATE',
  'USER_DELETE',
  'USER_PERMISSION_ADD',
  'USER_PERMISSION_READ',
  'USER_PERMISSION_REMOVE',
  'USER_READ',
  'USER_UPDATE',
] as const;

export const DEFAULT_ADMIN_PERMISSION_NAMES = [
  'FULL_SYSTEM_ACCESS',
  'LEAD_READ',
  'SITE_VISIT_READ',
  'PROJECT_READ',
  'UNIT_READ',
  'TASK_READ',
  'REPORT_READ',
  'REPORT_VIEW',
  'DASHBOARD_READ',
  'USER_READ',
  'ROLE_READ',
  'PROFILE_READ',
  'LEAD_CREATE',
  'SITE_VISIT_CREATE',
  'PROJECT_CREATE',
  'UNIT_CREATE',
  'TASK_CREATE',
  'REPORT_CREATE',
  'DASHBOARD_CREATE',
  'TELEPHONY_CALL',
  'ENQUIRY_READ',
] as const;

export function getMissingRequiredPermissionNames(availableNames: Iterable<string>) {
  const available = new Set(availableNames);
  return REQUIRED_PERMISSION_NAMES.filter((name) => !available.has(name));
}

function isPermissionTableMissingError(error: unknown) {
  if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'P2021') return false;
  if (!('meta' in error) || !error.meta || typeof error.meta !== 'object' || !('table' in error.meta)) return false;
  return String(error.meta.table).includes('Permission');
}

export async function warnForMissingRequiredPermissions() {
  try {
    const permissions = await prisma.permission.findMany({
      where: { name: { in: [...REQUIRED_PERMISSION_NAMES] } },
      select: { name: true },
    });
    const missing = getMissingRequiredPermissionNames(permissions.map(({ name }) => name));
    if (missing.length) {
      console.warn(`[Permission catalog] Required permissions are missing: ${missing.join(', ')}`);
    }
  } catch (error) {
    if (!isPermissionTableMissingError(error)) throw error;
    console.warn(`[Permission catalog] public."Permission" table is missing; required permissions are unavailable: ${REQUIRED_PERMISSION_NAMES.join(', ')}`);
  }
}
