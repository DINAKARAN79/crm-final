import type { Prisma } from '@prisma/client';
import { resolveCRMTimezone } from '@dct-crm/shared';

function formatTenantTimestamp(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'long',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || '';
  return `${value('month')} ${value('day')}, ${value('year')} ${value('hour')}:${value('minute')}:${value('second')} ${value('dayPeriod')}`;
}

export async function appendLeadProcessNote(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string;
    leadId: string;
    userId: string;
    content: string;
  },
): Promise<void> {
  const [lead, author, tenant] = await Promise.all([
    tx.lead.findFirst({
      where: { id: input.leadId, tenantId: input.tenantId },
      select: { notes: true },
    }),
    tx.user.findFirst({
      where: { id: input.userId, tenantId: input.tenantId },
      select: { firstName: true, lastName: true },
    }),
    tx.tenant.findUnique({
      where: { id: input.tenantId },
      select: { timezone: true },
    }),
  ]);
  if (!lead) throw new Error('Lead not found while saving process note');
  if (!author) throw new Error('User not found while saving process note');

  await tx.$queryRaw`SELECT "id" FROM "Lead" WHERE "id" = ${input.leadId} AND "tenantId" = ${input.tenantId} FOR UPDATE`;
  const currentLead = await tx.lead.findFirst({
    where: { id: input.leadId, tenantId: input.tenantId },
    select: { notes: true },
  });
  if (!currentLead) throw new Error('Lead not found while saving process note');

  const existingNotes = currentLead.notes || '';
  const existingNumbers = Array.from(existingNotes.matchAll(/\bNote\s+(\d+):/gi), (match) => Number(match[1]));
  const noteNumber = Math.max(0, ...existingNumbers) + 1;
  const authorName = [author.firstName, author.lastName].filter(Boolean).join(' ') || 'CRM User';
  const timezone = resolveCRMTimezone(tenant?.timezone);
  const entry = `Note ${noteNumber}: (${authorName}) - (${formatTenantTimestamp(new Date(), timezone)}):\n${input.content.trim()}`;

  await tx.lead.update({
    where: { id: input.leadId },
    data: { notes: existingNotes ? `${existingNotes}\n\n${entry}` : entry },
  });
}
