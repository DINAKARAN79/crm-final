import type { Prisma } from '@prisma/client';
import { BOOKING_FIELDS, BOOKING_STAGE_OPTIONS, BOOKING_OBJECT, bookingLayoutSections } from '@dct-crm/shared';
import { REPORT_OBJECTS, type ReportFieldType } from '../reports/report-metadata';
import { ensureUserObject } from './userObject';
import { DEFAULT_ADMIN_PERMISSION_NAMES, REQUIRED_PERMISSION_NAMES } from './requiredPermissionCatalog';

const STANDARD_OBJECTS = [
  { name: 'Lead', label: 'Lead', pluralLabel: 'Leads', icon: 'user', description: 'Manage sales leads' },
  { name: 'Enquiry', label: 'Enquiry', pluralLabel: 'Enquiries', icon: 'inbox', description: 'Manage lead enquiries' },
  { name: 'SiteVisit', label: 'Site Visit', pluralLabel: 'Site Visits', icon: 'map-pin', description: 'Site visit scheduling' },
  { name: 'Project', label: 'Project', pluralLabel: 'Projects', icon: 'folder-kanban', description: 'Project management' },
  { name: 'Unit', label: 'Unit', pluralLabel: 'Units', icon: 'building', description: 'Manage project units' },
  BOOKING_OBJECT,
  { name: 'Company', label: 'Company', pluralLabel: 'Companies', icon: 'building', description: 'Manage companies' },
  { name: 'CompaniesAPI', label: 'Companies API', pluralLabel: 'Companies API', icon: 'network', description: 'Company API data and related CRM records', isAvailableInNavigation: false },
  { name: 'FollowUp', label: 'Follow-up', pluralLabel: 'Follow-ups', icon: 'phone', description: 'Manage lead follow-ups' },
  { name: 'Activity', label: 'Activity', pluralLabel: 'Activities', icon: 'activity', description: 'Track CRM activities' },
  { name: 'CallDetail', label: 'Call Detail', pluralLabel: 'Call Details', icon: 'phone', description: 'Track inbound and outbound calls', isAvailableInNavigation: false },
  { name: 'User', label: 'Users', pluralLabel: 'Users', icon: 'users', description: 'Manage CRM users and their profiles', isAvailableInNavigation: false, isAvailableInReports: false },
] as const;

const MODULE_READ_PERMISSIONS = [
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
];

export interface TenantBootstrapResult {
  adminProfileId: string;
  adminRoleId: string;
}

function permissionParts(name: string) {
  const action = name.slice(name.lastIndexOf('_') + 1);
  return {
    module: name.slice(0, -(action.length + 1)),
    action,
  };
}

function fieldTypeForReport(type: ReportFieldType) {
  if (type === 'number') return 'number';
  if (type === 'date') return 'dateTime';
  if (type === 'enum') return 'picklist';
  return 'text';
}

function editableCompanyFields(
  tenantId: string,
  objectId: string,
  objectName: string,
  actorId: string,
  skipNames: ReadonlySet<string> = new Set(),
) {
  const config = REPORT_OBJECTS[objectName];
  if (!config) return [];

  return Object.entries(config.fields)
    .filter(([name]) => !skipNames.has(name))
    .map(([name, field], displayOrder) => ({
      tenantId,
      objectId,
      name,
      label: field.label,
      fieldType: fieldTypeForReport(field.type),
      required: false,
      searchable: true,
      sortable: true,
      filterable: true,
      visible: true,
      editable: true,
      isActive: true,
      isSystemField: false,
      isCustomField: true,
      isStandardField: false,
      displayOrder: skipNames.size + displayOrder,
      createdBy: actorId,
    }));
}

export async function bootstrapTenant(
  tx: Prisma.TransactionClient,
  tenantId: string,
  actorId: string,
): Promise<TenantBootstrapResult> {
  await tx.bookedBucketSetting.upsert({
    where: { tenantId },
    create: { tenantId, isActive: false },
    update: {},
  });
  const adminProfile = await tx.profile.upsert({
    where: { tenantId_name: { tenantId, name: 'System Administrator' } },
    update: { isAdmin: true, isDefault: false },
    create: {
      tenantId,
      name: 'System Administrator',
      description: 'Full administrative access to this company CRM',
      isAdmin: true,
    },
    select: { id: true },
  });
  const standardProfile = await tx.profile.upsert({
    where: { tenantId_name: { tenantId, name: 'Standard User' } },
    update: { isDefault: true, isAdmin: false },
    create: {
      tenantId,
      name: 'Standard User',
      description: 'Default profile for company users',
      isDefault: true,
    },
    select: { id: true },
  });
  const adminRole = await tx.role.upsert({
    where: { tenantId_name: { tenantId, name: 'Admin' } },
    update: { isSystem: true },
    create: { tenantId, name: 'Admin', description: 'Full company administration', isSystem: true },
    select: { id: true },
  });
  const allPermissionNames = [...new Set([...REQUIRED_PERMISSION_NAMES, ...DEFAULT_ADMIN_PERMISSION_NAMES])];
  await tx.permission.createMany({
    data: allPermissionNames.map((name) => {
      const { module, action } = permissionParts(name);
      return {
        name,
        label: name.replace(/_/g, ' '),
        module,
        action,
        isActive: true,
      };
    }),
    skipDuplicates: true,
  });
  await tx.permission.updateMany({
    where: { name: { in: [...DEFAULT_ADMIN_PERMISSION_NAMES] }, isActive: false },
    data: { isActive: true },
  });

  const permissions = await tx.permission.findMany({
    where: { name: { in: allPermissionNames } },
    select: { id: true, name: true },
  });
  const permissionIdsByName = new Map(permissions.map(({ id, name }) => [name, id]));
  await tx.userProfilePermission.createMany({
    data: DEFAULT_ADMIN_PERMISSION_NAMES.flatMap((name) => {
      const permissionId = permissionIdsByName.get(name);
      return permissionId ? [{ profileId: adminProfile.id, permissionId }] : [];
    }),
    skipDuplicates: true,
  });
  await tx.userProfilePermission.createMany({
    data: MODULE_READ_PERMISSIONS.flatMap((name) => {
      const permissionId = permissionIdsByName.get(name);
      return permissionId ? [{ profileId: standardProfile.id, permissionId }] : [];
    }),
    skipDuplicates: true,
  });

  await tx.objectDefinition.createMany({
    data: STANDARD_OBJECTS.map((object) => ({
        tenantId,
        ...object,
        objectType: 'standard',
        createdBy: actorId,
        updatedBy: actorId,
    })),
    skipDuplicates: true,
  });
  const definitions = await tx.objectDefinition.findMany({
    where: { tenantId, name: { in: STANDARD_OBJECTS.map(({ name }) => name) } },
    select: { id: true, name: true, label: true },
  });
  const objectIds = definitions.map(({ id }) => id);
  const companiesApiObject = await tx.objectDefinition.findFirst({
    where: { tenantId, name: 'CompaniesAPI' },
    select: { id: true },
  });
  if (companiesApiObject) {
    await tx.fieldDefinition.createMany({
      data: [{
        tenantId,
        objectId: companiesApiObject.id,
        name: 'companyId',
        label: 'Company',
        fieldType: 'lookup',
        lookupObject: 'Company',
        required: true,
        editable: true,
        isCustomField: true,
        isStandardField: false,
        searchable: true,
        sortable: true,
        filterable: true,
        displayOrder: 0,
        createdBy: actorId,
      }],
      skipDuplicates: true,
    });
  }

  const tenant = await tx.tenant.findUnique({
    where: { id: tenantId },
    select: {
      name: true,
      email: true,
      phone: true,
      website: true,
      address: true,
      city: true,
      state: true,
      country: true,
      postalCode: true,
    },
  });
  if (tenant && companiesApiObject) {
    const company = await tx.company.upsert({
      where: {
        tenantId_normalizedName: {
          tenantId,
          normalizedName: tenant.name.trim().toLowerCase(),
        },
      },
      update: {
        name: tenant.name,
        email: tenant.email,
        phone: tenant.phone,
        website: tenant.website,
        address: tenant.address,
        city: tenant.city,
        state: tenant.state,
        country: tenant.country,
        postalCode: tenant.postalCode,
      },
      create: {
        tenantId,
        name: tenant.name,
        normalizedName: tenant.name.trim().toLowerCase(),
        email: tenant.email,
        phone: tenant.phone,
        website: tenant.website,
        address: tenant.address,
        city: tenant.city,
        state: tenant.state,
        country: tenant.country,
        postalCode: tenant.postalCode,
      },
      select: { id: true },
    });
    const existingCompaniesApiRecord = await tx.customRecord.findFirst({
      where: {
        tenantId,
        objectId: companiesApiObject.id,
        recordNumber: company.id,
      },
      select: { id: true },
    });
    if (!existingCompaniesApiRecord) {
      await tx.customRecord.create({
        data: {
          tenantId,
          objectId: companiesApiObject.id,
          recordNumber: company.id,
          data: { companyId: company.id },
          createdBy: actorId,
          updatedBy: actorId,
        },
      });
    }
  }

  const bookingObject = await tx.objectDefinition.findFirst({
    where: { tenantId, name: BOOKING_OBJECT.name },
    select: { id: true },
  });
  if (bookingObject) {
    await tx.fieldDefinition.createMany({
      data: BOOKING_FIELDS.map((field, index) => ({
        tenantId,
        objectId: bookingObject.id,
        name: field.name,
        label: field.label,
        fieldType: field.fieldType,
        lookupObject: field.lookupObject,
        editable: field.editable !== false,
        isCustomField: true,
        isStandardField: false,
        searchable: true,
        sortable: true,
        filterable: true,
        displayOrder: index,
        createdBy: actorId,
      })),
      skipDuplicates: true,
    });
    await tx.fieldDefinition.updateMany({
      where: { tenantId, objectId: bookingObject.id },
      data: { isCustomField: true, isStandardField: false },
    });
    const stageField = await tx.fieldDefinition.findFirst({
      where: { tenantId, objectId: bookingObject.id, name: 'bookingStage' },
      select: { id: true },
    });
    if (stageField) {
      await tx.picklistValue.createMany({
        data: BOOKING_STAGE_OPTIONS.map((option, index) => ({
          tenantId,
          fieldId: stageField.id,
          ...option,
          displayOrder: index,
          isDefault: index === 0,
        })),
        skipDuplicates: true,
      });
    }
  }

  const bookingFieldNames = new Set(BOOKING_FIELDS.map((field) => field.name));
  const customFieldData = definitions.flatMap((definition) =>
    editableCompanyFields(
      tenantId,
      definition.id,
      definition.name,
      actorId,
      definition.name === BOOKING_OBJECT.name ? bookingFieldNames : new Set(),
    ),
  );
  if (customFieldData.length > 0) {
    await tx.fieldDefinition.createMany({
      data: customFieldData,
      skipDuplicates: true,
    });
  }
  const leadObject = definitions.find(({ name }) => name === 'Lead');
  if (leadObject) {
    const leadInterestField = await tx.fieldDefinition.findFirst({
      where: { tenantId, objectId: leadObject.id, name: 'leadInterest' },
      select: { id: true },
    });
    if (leadInterestField) {
      await tx.picklistValue.createMany({
        data: [
          { label: 'Prospect', value: 'PROSPECT', isDefault: true },
          { label: 'Hot', value: 'HOT', isDefault: false },
          { label: 'Warm', value: 'WARM', isDefault: false },
          { label: 'Unable to Connect', value: 'UNABLE_TO_CONNECT', isDefault: false },
          { label: 'Dropped', value: 'DROPPED', isDefault: false },
          { label: 'Cold', value: 'COLD', isDefault: false },
        ].map((option, displayOrder) => ({
          tenantId,
          fieldId: leadInterestField.id,
          ...option,
          displayOrder,
        })),
        skipDuplicates: true,
      });
    }
  }

  const existingLayouts = await tx.pageLayout.findMany({
    where: { objectId: { in: objectIds }, isDefault: true },
    select: { objectId: true },
  });
  const objectsWithDefaultLayouts = new Set(existingLayouts.map(({ objectId }) => objectId));
  await tx.pageLayout.createMany({
    data: definitions
      .filter(({ id }) => !objectsWithDefaultLayouts.has(id))
      .map((definition) => ({
        tenantId,
        objectId: definition.id,
        name: 'Default Layout',
        isDefault: true,
        sections: definition.name === BOOKING_OBJECT.name
          ? bookingLayoutSections()
          : [{
              name: `${definition.label} Information`,
              fields: editableCompanyFields(tenantId, definition.id, definition.name, actorId).map((field) => field.name),
            }, { name: 'Details', fields: [] }],
        createdBy: actorId,
      })),
    skipDuplicates: true,
  });

  const fullObjectAccess = {
    canCreate: true,
    canRead: true,
    canUpdate: true,
    canDelete: true,
    viewAll: true,
    modifyAll: true,
  };
  await tx.profileObjectPermission.updateMany({
    where: { profileId: adminProfile.id, objectId: { in: objectIds } },
    data: fullObjectAccess,
  });
  await tx.profileObjectPermission.createMany({
    data: definitions.map(({ id }) => ({
        tenantId,
        profileId: adminProfile.id,
        objectId: id,
        ...fullObjectAccess,
      })),
    skipDuplicates: true,
  });
  await tx.objectPermission.updateMany({
    where: { tenantId, roleId: adminRole.id, objectId: { in: objectIds } },
    data: fullObjectAccess,
  });
  await tx.objectPermission.createMany({
    data: definitions.map(({ id }) => ({
      tenantId,
      roleId: adminRole.id,
      objectId: id,
      ...fullObjectAccess,
    })),
    skipDuplicates: true,
  });

  await tx.sequence.createMany({
    data: ['LEAD', 'SITE_VISIT', 'FOLLOW_UP', 'ENQUIRY'].map((type) => ({ tenantId, type, nextValue: 1 })),
    skipDuplicates: true,
  });

  await ensureUserObject(tx, tenantId, actorId);

  return {
    adminProfileId: adminProfile.id,
    adminRoleId: adminRole.id,
  };
}
