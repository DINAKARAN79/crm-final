import { resolveCRMTimezone } from '@dct-crm/shared';
import { prisma } from '@dct-crm/db';

export async function getTenantTimezone(tenantId: string): Promise<string> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { timezone: true },
  });
  return resolveCRMTimezone(tenant?.timezone);
}
