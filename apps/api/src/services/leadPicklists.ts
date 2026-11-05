import { prisma } from '@dct-crm/db';

export const LEAD_PICKLIST_FIELDS = [
  'source',
  'firstCampaign',
  'lastCampaign',
  'leadInterest',
] as const;

export type LeadPicklistField = (typeof LEAD_PICKLIST_FIELDS)[number];
export type LeadPicklistOptions = Map<LeadPicklistField, Set<string>> & {
  requiredFields: Set<LeadPicklistField>;
};

export async function getLeadPicklistOptions(tenantId: string): Promise<LeadPicklistOptions> {
  const object = await prisma.objectDefinition.findFirst({
    where: { tenantId, name: { equals: 'Lead', mode: 'insensitive' } },
    select: { id: true },
  });
  if (!object) {
    const empty = new Map() as LeadPicklistOptions;
    empty.requiredFields = new Set();
    return empty;
  }

  const definitions = await prisma.fieldDefinition.findMany({
    where: {
      tenantId,
      objectId: object.id,
      name: { in: [...LEAD_PICKLIST_FIELDS] },
      isActive: true,
      fieldType: 'picklist',
    },
    select: {
      name: true,
      required: true,
      picklistValues: {
        where: { isActive: true },
        select: { value: true },
      },
    },
  });

  const options = new Map(definitions.map((field) => [
    field.name as LeadPicklistField,
    new Set(field.picklistValues.map(({ value }) => value)),
  ])) as LeadPicklistOptions;
  options.requiredFields = new Set(
    definitions.filter((field) => field.required).map((field) => field.name as LeadPicklistField),
  );
  return options;
}

export function validateLeadPicklists(
  values: Partial<Record<LeadPicklistField, unknown>>,
  options: LeadPicklistOptions,
  { validateRequired = false, partial = false }: { validateRequired?: boolean; partial?: boolean } = {},
): { field: LeadPicklistField; message: string } | null {
  for (const field of LEAD_PICKLIST_FIELDS) {
    const value = values[field];
    if (
      validateRequired &&
      options.requiredFields?.has(field) &&
      (!partial || Object.prototype.hasOwnProperty.call(values, field)) &&
      (value === undefined || value === null || value === '')
    ) {
      const label = field === 'leadInterest'
        ? 'Lead Interest'
        : field === 'firstCampaign'
          ? 'Campaign'
          : field === 'lastCampaign'
            ? 'Sub Campaign'
            : 'Lead Source';
      return { field, message: `${label} is required.` };
    }
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || !options.get(field)?.has(value)) {
      return {
        field,
        message: `Select a configured value for ${field === 'source' ? 'Lead Source' : field === 'leadInterest' ? 'Lead Interest' : field === 'firstCampaign' ? 'Campaign' : 'Sub Campaign'}.`,
      };
    }
  }
  return null;
}
