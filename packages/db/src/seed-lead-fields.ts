import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface FieldSeed {
  name: string;
  label: string;
  fieldType: string;
  description?: string;
  required?: boolean;
  unique?: boolean;
  searchable?: boolean;
  sortable?: boolean;
  filterable?: boolean;
  visible?: boolean;
  editable?: boolean;
  isSystemField?: boolean;
  isCustomField?: boolean;
  isStandardField?: boolean;
  displayOrder: number;
  minLength?: number;
  maxLength?: number;
  minValue?: number;
  maxValue?: number;
  lookupObject?: string;
  lookupField?: string;
  picklistValues?: { label: string; value: string; isDefault?: boolean; displayOrder: number }[];
}

const STANDARD_LEAD_FIELDS: FieldSeed[] = [
  // System fields
  {
    name: 'id', label: 'Lead ID', fieldType: 'autoNumber',
    isSystemField: true, isCustomField: false, isStandardField: true,
    displayOrder: 0, required: true, searchable: true, sortable: true, filterable: true, editable: false,
  },
  {
    name: 'record_number', label: 'Record Number', fieldType: 'autoNumber',
    isSystemField: true, isCustomField: false, isStandardField: true,
    displayOrder: 1, searchable: true, sortable: true, filterable: true, editable: false,
  },
  {
    name: 'owner', label: 'Owner', fieldType: 'lookup', lookupObject: 'User',
    isSystemField: true, isCustomField: false, isStandardField: true,
    displayOrder: 2, searchable: true, sortable: true, filterable: true, editable: true,
  },
  {
    name: 'created_by', label: 'Created By', fieldType: 'lookup', lookupObject: 'User',
    isSystemField: true, isCustomField: false, isStandardField: true,
    displayOrder: 3, sortable: true, editable: false,
  },
  {
    name: 'created_at', label: 'Created Date', fieldType: 'dateTime',
    isSystemField: true, isCustomField: false, isStandardField: true,
    displayOrder: 4, sortable: true, filterable: true, editable: false,
  },
  {
    name: 'updated_at', label: 'Last Modified Date', fieldType: 'dateTime',
    isSystemField: true, isCustomField: false, isStandardField: true,
    displayOrder: 5, sortable: true, editable: false,
  },
  {
    name: 'is_active', label: 'Is Active', fieldType: 'boolean',
    isSystemField: true, isCustomField: false, isStandardField: true,
    displayOrder: 6, sortable: true, filterable: true, editable: false,
  },

  // Contact Information
  {
    name: 'salutation', label: 'Salutation', fieldType: 'picklist',
    isStandardField: true, isCustomField: false,
    displayOrder: 10, searchable: true, sortable: true, filterable: true,
    picklistValues: [
      { label: 'Mr.', value: 'MR', displayOrder: 0 },
      { label: 'Ms.', value: 'MS', displayOrder: 1 },
      { label: 'Mrs.', value: 'MRS', displayOrder: 2 },
      { label: 'Dr.', value: 'DR', displayOrder: 3 },
      { label: 'Prof.', value: 'PROF', displayOrder: 4 },
    ],
  },
  {
    name: 'firstName', label: 'First Name', fieldType: 'text',
    isStandardField: true, isCustomField: false,
    displayOrder: 11, searchable: true, sortable: true, filterable: true, maxLength: 100,
  },
  {
    name: 'lastName', label: 'Last Name', fieldType: 'text',
    required: true, isStandardField: true, isCustomField: false,
    displayOrder: 12, searchable: true, sortable: true, filterable: true, maxLength: 100,
  },
  {
    name: 'title', label: 'Title', fieldType: 'text',
    isStandardField: true, isCustomField: false,
    displayOrder: 13, searchable: true, sortable: true, maxLength: 100,
  },
  {
    name: 'email', label: 'Email', fieldType: 'email',
    isStandardField: true, isCustomField: false,
    displayOrder: 14, searchable: true, sortable: true, filterable: true,
  },
  {
    name: 'phone', label: 'Phone', fieldType: 'phone',
    required: true, isStandardField: true, isCustomField: false,
    displayOrder: 15, searchable: true, sortable: true, filterable: true,
  },
  {
    name: 'mobile', label: 'Secondary Phone', fieldType: 'phone',
    isStandardField: true, isCustomField: false,
    displayOrder: 16, searchable: true, sortable: true,
  },
  {
    name: 'website', label: 'Website', fieldType: 'url',
    isStandardField: true, isCustomField: false,
    displayOrder: 17, searchable: true,
  },

  // Company Information
  {
    name: 'company', label: 'Company', fieldType: 'text',
    required: true, isStandardField: true, isCustomField: false,
    displayOrder: 20, searchable: true, sortable: true, filterable: true, maxLength: 200,
  },
  {
    name: 'industry', label: 'Industry', fieldType: 'picklist',
    isStandardField: true, isCustomField: false,
    displayOrder: 21, searchable: true, sortable: true, filterable: true,
    picklistValues: [
      { label: 'Technology', value: 'TECHNOLOGY', displayOrder: 0 },
      { label: 'Healthcare', value: 'HEALTHCARE', displayOrder: 1 },
      { label: 'Finance', value: 'FINANCE', displayOrder: 2 },
      { label: 'Education', value: 'EDUCATION', displayOrder: 3 },
      { label: 'Manufacturing', value: 'MANUFACTURING', displayOrder: 4 },
      { label: 'Retail', value: 'RETAIL', displayOrder: 5 },
      { label: 'Real Estate', value: 'REAL_ESTATE', displayOrder: 6 },
      { label: 'Construction', value: 'CONSTRUCTION', displayOrder: 7 },
      { label: 'Hospitality', value: 'HOSPITALITY', displayOrder: 8 },
      { label: 'Automotive', value: 'AUTOMOTIVE', displayOrder: 9 },
      { label: 'Energy', value: 'ENERGY', displayOrder: 10 },
      { label: 'Telecommunications', value: 'TELECOMMUNICATIONS', displayOrder: 11 },
      { label: 'Media', value: 'MEDIA', displayOrder: 12 },
      { label: 'Government', value: 'GOVERNMENT', displayOrder: 13 },
      { label: 'Other', value: 'OTHER', displayOrder: 14, isDefault: true },
    ],
  },
  {
    name: 'annualRevenue', label: 'Annual Revenue', fieldType: 'currency',
    isStandardField: true, isCustomField: false,
    displayOrder: 22, sortable: true, filterable: true, minValue: 0,
  },
  {
    name: 'numberOfEmployees', label: 'No. of Employees', fieldType: 'number',
    isStandardField: true, isCustomField: false,
    displayOrder: 23, sortable: true, filterable: true, minValue: 0,
  },

  // Lead Management
  {
    name: 'source', label: 'Lead Source', fieldType: 'picklist',
    isStandardField: false, isCustomField: true,
    displayOrder: 30, searchable: true, sortable: true, filterable: true,
    picklistValues: [
      { label: 'Website', value: 'WEBSITE', displayOrder: 0 },
      { label: 'Facebook', value: 'FACEBOOK', displayOrder: 1 },
      { label: 'Referral', value: 'REFERRAL', displayOrder: 2 },
      { label: 'Cold Call', value: 'COLD_CALL', displayOrder: 3 },
      { label: 'Advertisement', value: 'ADVERTISEMENT', displayOrder: 4 },
      { label: 'Walk-in', value: 'WALK_IN', displayOrder: 5 },
      { label: 'Portal', value: 'PORTAL', displayOrder: 6 },
      { label: 'Channel Partner', value: 'CHANNEL_PARTNER', displayOrder: 7 },
      { label: 'Instagram', value: 'INSTAGRAM', displayOrder: 8 },
      { label: 'Twitter', value: 'TWITTER', displayOrder: 9 },
      { label: 'WhatsApp', value: 'WHATSAPP', displayOrder: 10 },
      { label: 'YouTube', value: 'YOUTUBE', displayOrder: 11 },
      { label: 'Other', value: 'OTHER', displayOrder: 12, isDefault: true },
    ],
  },
  {
    name: 'firstCampaign', label: 'First Campaign', fieldType: 'picklist',
    isStandardField: true, isCustomField: false,
    displayOrder: 31, searchable: true, sortable: true, filterable: true,
  },
  {
    name: 'lastCampaign', label: 'Last Campaign', fieldType: 'picklist',
    isStandardField: true, isCustomField: false,
    displayOrder: 32, searchable: true, sortable: true, filterable: true,
  },
  {
    name: 'leadInterest', label: 'Lead Interest', fieldType: 'picklist',
    isStandardField: true, isCustomField: false,
    displayOrder: 33, searchable: true, sortable: true, filterable: true,
    picklistValues: [
      { label: 'Prospect', value: 'PROSPECT', isDefault: true, displayOrder: 0 },
      { label: 'Hot', value: 'HOT', displayOrder: 1 },
      { label: 'Warm', value: 'WARM', displayOrder: 2 },
      { label: 'Unable to Connect', value: 'UNABLE_TO_CONNECT', displayOrder: 3 },
      { label: 'Dropped', value: 'DROPPED', displayOrder: 4 },
      { label: 'Cold', value: 'COLD', displayOrder: 5 },
    ],
  },
  {
    name: 'status', label: 'Lead Status', fieldType: 'picklist',
    isStandardField: false, isCustomField: true,
    displayOrder: 34, searchable: true, sortable: true, filterable: true,
    picklistValues: [
      { label: 'New', value: 'NEW', isDefault: true, displayOrder: 0 },
      { label: 'Incoming', value: 'INCOMING', displayOrder: 1 },
      { label: 'Prospect', value: 'PROSPECT', displayOrder: 2 },
      { label: 'Site Visit Scheduled', value: 'SITE_VISIT_SCHEDULED', displayOrder: 3 },
      { label: 'Site Visit Happened', value: 'SITE_VISIT_HAPPENED', displayOrder: 4 },
      { label: 'Lost', value: 'LOST', displayOrder: 5 },
    ],
  },
  {
    name: 'rating', label: 'Rating', fieldType: 'picklist',
    isStandardField: false, isCustomField: true,
    displayOrder: 35, searchable: true, sortable: true, filterable: true,
    picklistValues: [
      { label: 'Hot', value: 'HOT', displayOrder: 0 },
      { label: 'Warm', value: 'WARM', displayOrder: 1 },
      { label: 'Cold', value: 'COLD', displayOrder: 2 },
    ],
  },
  {
    name: 'description', label: 'Description', fieldType: 'longText',
    isStandardField: false, isCustomField: true,
    displayOrder: 36, maxLength: 5000,
  },
  {
    name: 'score', label: 'Score', fieldType: 'number',
    isSystemField: false, isCustomField: true, isStandardField: false,
    displayOrder: 37, sortable: true, filterable: true, editable: false, minValue: 0, maxValue: 100, visible: false,
  },

  // Address
  {
    name: 'street', label: 'Street', fieldType: 'text',
    isStandardField: true, isCustomField: false,
    displayOrder: 40, maxLength: 500,
  },
  {
    name: 'city', label: 'City', fieldType: 'text',
    isStandardField: true, isCustomField: false,
    displayOrder: 41, searchable: true, sortable: true, filterable: true, maxLength: 100,
  },
  {
    name: 'stateProvince', label: 'State/Province', fieldType: 'text',
    isStandardField: true, isCustomField: false,
    displayOrder: 42, searchable: true, sortable: true, filterable: true, maxLength: 100,
  },
  {
    name: 'country', label: 'Country', fieldType: 'text',
    isStandardField: true, isCustomField: false,
    displayOrder: 43, searchable: true, sortable: true, filterable: true, maxLength: 100,
  },
  {
    name: 'postalCode', label: 'Postal Code', fieldType: 'text',
    isStandardField: true, isCustomField: false,
    displayOrder: 44, searchable: true, maxLength: 20,
  },
];

async function seedLeadFieldsForTenant(tenantId: string, createdBy: string) {
  const operationalCustomFieldNames = new Set([
    'source', 'firstCampaign', 'lastCampaign', 'leadInterest', 'status', 'rating', 'description', 'score',
  ]);
  const configuredPicklistFieldNames = new Set(['source', 'firstCampaign', 'lastCampaign', 'leadInterest']);
  // Find or create Lead ObjectDefinition
  let leadObject = await prisma.objectDefinition.findFirst({
    where: { tenantId, name: { equals: 'Lead', mode: 'insensitive' } },
  });

  if (!leadObject) {
    leadObject = await prisma.objectDefinition.create({
      data: {
        tenantId,
        name: 'Lead',
        label: 'Lead',
        pluralLabel: 'Leads',
        description: 'Standard Lead object for CRM',
        icon: 'user-plus',
        objectType: 'standard',
        createdBy,
        updatedBy: createdBy,
      },
    });
    console.log(`  Created Lead ObjectDefinition for tenant ${tenantId}`);
  } else {
    // Update objectType to standard if it was custom
    if (leadObject.objectType !== 'standard') {
      await prisma.objectDefinition.update({
        where: { id: leadObject.id },
        data: { objectType: 'standard' },
      });
    }
  }

  let createdCount = 0;
  let skippedCount = 0;

  for (const fieldSeed of STANDARD_LEAD_FIELDS) {
    const existing = await prisma.fieldDefinition.findFirst({
      where: { objectId: leadObject.id, name: fieldSeed.name },
    });

    if (existing) {
      if (
        configuredPicklistFieldNames.has(fieldSeed.name) &&
        existing.fieldType !== fieldSeed.fieldType
      ) {
        await prisma.fieldDefinition.update({
          where: { id: existing.id },
          data: { fieldType: fieldSeed.fieldType },
        });
      }
      if (
        operationalCustomFieldNames.has(fieldSeed.name) &&
        (
          existing.isSystemField !== (fieldSeed.isSystemField ?? false) ||
          existing.isStandardField !== (fieldSeed.isStandardField ?? false) ||
          existing.isCustomField !== (fieldSeed.isCustomField ?? false)
        )
      ) {
        await prisma.fieldDefinition.update({
          where: { id: existing.id },
          data: {
            isSystemField: fieldSeed.isSystemField ?? false,
            isStandardField: fieldSeed.isStandardField ?? false,
            isCustomField: fieldSeed.isCustomField ?? false,
          },
        });
      }
      if (fieldSeed.label && existing.label !== fieldSeed.label) {
        await prisma.fieldDefinition.update({
          where: { id: existing.id },
          data: { label: fieldSeed.label },
        });
      }
      if (fieldSeed.visible !== undefined && existing.visible !== fieldSeed.visible) {
        await prisma.fieldDefinition.update({
          where: { id: existing.id },
          data: { visible: fieldSeed.visible },
        });
      }
      if (configuredPicklistFieldNames.has(fieldSeed.name) && !existing.isActive) {
        await prisma.fieldDefinition.update({
          where: { id: existing.id },
          data: { isActive: true },
        });
      }
      if (fieldSeed.picklistValues?.length) {
        for (const value of fieldSeed.picklistValues) {
          await prisma.picklistValue.upsert({
            where: { fieldId_value: { fieldId: existing.id, value: value.value } },
            update: {
              label: value.label,
              isDefault: value.isDefault ?? false,
              displayOrder: value.displayOrder,
            },
            create: {
              tenantId,
              fieldId: existing.id,
              label: value.label,
              value: value.value,
              isDefault: value.isDefault ?? false,
              displayOrder: value.displayOrder,
            },
          });
        }
      }
      skippedCount++;
      continue;
    }

    const { picklistValues, ...fieldData } = fieldSeed;

    const field = await prisma.fieldDefinition.create({
      data: {
        tenantId,
        objectId: leadObject.id,
        ...fieldData,
        isCustomField: fieldData.isCustomField ?? false,
        createdBy,
        updatedBy: createdBy,
      },
    });

    // Create picklist values if they exist
    if (picklistValues && picklistValues.length > 0) {
      for (const pv of picklistValues) {
        await prisma.picklistValue.create({
          data: {
            tenantId,
            fieldId: field.id,
            label: pv.label,
            value: pv.value,
            isDefault: pv.isDefault ?? false,
            displayOrder: pv.displayOrder,
          },
        });
      }
    }

    createdCount++;
  }

  // Create default layout if it doesn't exist
  const existingLayout = await prisma.pageLayout.findFirst({
    where: { objectId: leadObject.id, name: 'Default Layout' },
  });

  if (!existingLayout) {
    await prisma.pageLayout.create({
      data: {
        tenantId,
        objectId: leadObject.id,
        name: 'Default Layout',
        isDefault: true,
        sections: JSON.stringify([
          {
            name: 'Contact Information',
            fields: ['salutation', 'firstName', 'lastName', 'title', 'email', 'phone', 'mobile'],
          },
          {
            name: 'Company Information',
            fields: ['company', 'industry', 'annualRevenue', 'numberOfEmployees'],
          },
          {
            name: 'Lead Details',
            fields: ['source', 'firstCampaign', 'lastCampaign', 'leadInterest', 'status', 'rating', 'description'],
          },
          {
            name: 'Address',
            fields: ['street', 'city', 'stateProvince', 'country', 'postalCode'],
          },
          {
            name: 'System Information',
            fields: ['record_number', 'owner', 'created_by', 'created_at', 'updated_at'],
          },
        ]),
        createdBy,
      },
    });
    console.log(`  Created Default Layout for Lead object`);
  }

  return { createdCount, skippedCount };
}

async function main() {
  console.log('Seeding standard Lead fields...\n');

  const tenants = await prisma.tenant.findMany({ where: { isActive: true } });

  if (tenants.length === 0) {
    console.log('No active tenants found. Skipping seed.');
    return;
  }

  for (const tenant of tenants) {
    console.log(`Processing tenant: ${tenant.name} (${tenant.id})`);

    // Find first admin user in this tenant for createdBy
    const adminUser = await prisma.user.findFirst({
      where: { tenantId: tenant.id, isActive: true },
      orderBy: { createdAt: 'asc' },
    });

    if (!adminUser) {
      console.log(`  No users found for tenant ${tenant.id}. Skipping.`);
      continue;
    }

    const result = await seedLeadFieldsForTenant(tenant.id, adminUser.id);
    console.log(`  Created: ${result.createdCount} fields, Skipped: ${result.skippedCount} existing\n`);
  }

  console.log('Standard Lead fields seeded successfully!');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
