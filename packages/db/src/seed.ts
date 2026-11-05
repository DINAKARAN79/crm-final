import { createHash, randomBytes } from 'crypto';
import { PrismaClient, LeadStatus, SiteVisitStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const removedCommercialObjects = [
  'Approval',
  'Opportunity',
  'Payment',
  'PaymentAllocation',
  'Quotation',
  'QuotationInstallment',
  'QuotationItem',
  'Receipt',
];

async function removeCommercialMetadata() {
  await prisma.pageLayout.deleteMany({
    where: { object: { is: { name: { in: removedCommercialObjects } } } },
  });
  await prisma.permissionSetRole.deleteMany({
    where: { permissionSet: { is: { objectName: { in: removedCommercialObjects } } } },
  });
  await prisma.permissionSet.deleteMany({
    where: { objectName: { in: removedCommercialObjects } },
  });
  await prisma.objectDefinition.deleteMany({
    where: { name: { in: removedCommercialObjects } },
  });
  await prisma.permission.deleteMany({
    where: {
      module: {
        in: ['APPROVAL', 'MIS_QUOTATION_REVIEW', 'OPPORTUNITY', 'PAYMENT', 'QUOTATION', 'RECEIPT'],
      },
    },
  });
}

async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

async function main() {
  console.log('Seeding DCT CRM database...');

  await removeCommercialMetadata();

  const existingTenant = await prisma.tenant.findUnique({
    where: { slug: 'dct-re' },
    select: { name: true },
  });
  if (existingTenant) {
    console.log(`Tenant ${existingTenant.name} (dct-re) already exists; skipped duplicate seed data.`);
    return;
  }

  const defaultPassword = await hashPassword('password123');

  const tenant = await prisma.tenant.create({
    data: {
      name: 'DCT Real Estate',
      slug: 'dct-re',
      companyCode: 'DCT-RE',
      settings: {
        timezone: 'Asia/Kolkata',
        currency: 'INR',
        dateFormat: 'DD/MM/YYYY',
      },
    },
  });

  const placeholder = randomBytes(32).toString('hex');
  await prisma.apiKey.create({
    data: {
      tenantId: tenant.id,
      name: 'Default key',
      keyPrefix: `pending_${placeholder.slice(0, 12)}`,
      keyHash: createHash('sha256').update(`pending:${tenant.id}:${placeholder}`).digest('hex'),
      scopes: [
        'leads:read', 'leads:write',
        'follow-ups:read', 'follow-ups:write',
        'call-details:read', 'call-details:write',
        'site-visits:read', 'site-visits:write',
        'bookings:read', 'bookings:write',
        'projects:read', 'projects:write',
        'units:read', 'units:write',
        'enquiries:read', 'enquiries:write',
        'activities:read', 'activities:write',
      ],
      status: 'pending_reveal',
      createdById: 'seed',
    },
  });

  const adminRole = await prisma.role.create({
    data: {
      tenantId: tenant.id,
      name: 'Admin',
      description: 'Full system access',
      isSystem: true,
    },
  });

  const salesManagerRole = await prisma.role.create({
    data: {
      tenantId: tenant.id,
      name: 'Sales Manager',
      description: 'Manages sales team',
      isSystem: true,
    },
  });

  const salesExecRole = await prisma.role.create({
    data: {
      tenantId: tenant.id,
      name: 'Sales Executive',
      description: 'Handles sales activities',
      isSystem: true,
    },
  });

  const presalesExecRole = await prisma.role.create({
    data: {
      tenantId: tenant.id,
      name: 'Presales Executive',
      description: 'Handles presales and site visits',
      isSystem: true,
    },
  });

  const adminProfile = await prisma.profile.create({
    data: {
      tenantId: tenant.id,
      name: 'System Administrator',
      description: 'Full admin profile',
      isDefault: false,
      isAdmin: true,
    },
  });

  const defaultProfile = await prisma.profile.create({
    data: {
      tenantId: tenant.id,
      name: 'Standard User',
      description: 'Standard user permissions',
      isDefault: true,
    },
  });

  const crmObjects = ['Lead', 'SiteVisit', 'Project', 'Unit', 'Task', 'FollowUp', 'Activity', 'Report', 'Dashboard', 'User', 'Role', 'AuditLog', 'Notification'];

  for (const obj of crmObjects) {
    const permSet = await prisma.permissionSet.create({
      data: {
        tenantId: tenant.id,
        profileId: adminProfile.id,
        name: `${obj} - Full Access`,
        objectName: obj,
        permissions: { create: true, read: true, edit: true, delete: true, viewAll: true, modifyAll: true },
      },
    });

    await prisma.permissionSetRole.create({
      data: { permissionSetId: permSet.id, roleId: adminRole.id },
    });
  }

  for (const obj of crmObjects) {
    const permSet = await prisma.permissionSet.create({
      data: {
        tenantId: tenant.id,
        profileId: defaultProfile.id,
        name: `${obj} - Standard Access`,
        objectName: obj,
        permissions: { create: true, read: true, edit: true, delete: false, viewAll: false, modifyAll: false },
      },
    });

    await prisma.permissionSetRole.create({
      data: { permissionSetId: permSet.id, roleId: salesExecRole.id },
    });
    await prisma.permissionSetRole.create({
      data: { permissionSetId: permSet.id, roleId: presalesExecRole.id },
    });
    // Sales Manager gets the same standard access
    await prisma.permissionSetRole.create({
      data: { permissionSetId: permSet.id, roleId: salesManagerRole.id },
    });
  }

  const adminUser = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: 'admin@dctcrm.com',
      passwordHash: defaultPassword,
      firstName: 'System',
      lastName: 'Admin',
      isActive: true,
      profileId: adminProfile.id,
      roleId: adminRole.id,
    },
  });

  await prisma.userRole.create({
    data: { userId: adminUser.id, roleId: adminRole.id },
  });

  const salesManager = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: 'salesmanager@dctcrm.com',
      passwordHash: defaultPassword,
      firstName: 'Rajesh',
      lastName: 'Kumar',
      phone: '+91-9876543210',
      isActive: true,
    },
  });

  await prisma.userRole.create({
    data: { userId: salesManager.id, roleId: salesManagerRole.id },
  });

  const salesExec1 = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: 'priya@dctcrm.com',
      passwordHash: defaultPassword,
      firstName: 'Priya',
      lastName: 'Sharma',
      phone: '+91-9876543211',
      isActive: true,
    },
  });

  await prisma.userRole.create({
    data: { userId: salesExec1.id, roleId: salesExecRole.id },
  });

  const salesExec2 = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: 'amit@dctcrm.com',
      passwordHash: defaultPassword,
      firstName: 'Amit',
      lastName: 'Patel',
      phone: '+91-9876543212',
      isActive: true,
    },
  });

  await prisma.userRole.create({
    data: { userId: salesExec2.id, roleId: salesExecRole.id },
  });

  const presalesExec = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: 'neha@dctcrm.com',
      passwordHash: defaultPassword,
      firstName: 'Neha',
      lastName: 'Gupta',
      phone: '+91-9876543213',
      isActive: true,
    },
  });

  await prisma.userRole.create({
    data: { userId: presalesExec.id, roleId: presalesExecRole.id },
  });

  const leadsQueue = await prisma.queue.create({
    data: {
      tenantId: tenant.id,
      name: 'General Leads',
      description: 'Default leads queue',
      type: 'LEAD',
    },
  });

  const projects = await Promise.all([
    prisma.project.create({
      data: {
        tenantId: tenant.id,
        name: 'DCT Heights',
        description: 'Premium residential project',
        address: 'Kodambakkam, Chennai',
        city: 'Chennai',
        state: 'Tamil Nadu',
        latitude: 13.0294519,
        longitude: 80.1952235,
        totalUnits: 200,
      },
    }),
    prisma.project.create({
      data: {
        tenantId: tenant.id,
        name: 'DCT Valley',
        description: 'Affordable housing project',
        address: 'Dwarka Expressway, Gurgaon',
        city: 'Gurgaon',
        state: 'HR',
        totalUnits: 350,
      },
    }),
    prisma.project.create({
      data: {
        tenantId: tenant.id,
        name: 'DCT Paradise',
        description: 'Luxury villas and plots',
        address: 'Venkateswara Nagar, Chennai',
        city: 'Chennai',
        state: 'Tamil Nadu',
        latitude: 13.003789,
        longitude: 80.262671,
        totalUnits: 100,
      },
    }),
  ]);

  const unitTypes = ['1BHK', '2BHK', '3BHK', '4BHK', 'Penthouse', 'Villa'];
  const units: any[] = [];

  for (const project of projects) {
    for (let i = 1; i <= 30; i++) {
      const unit = await prisma.unit.create({
        data: {
          tenantId: tenant.id,
          projectId: project.id,
          number: `${project.name.replace(/\s/g, '')}-U${String(i).padStart(3, '0')}`,
          type: unitTypes[i % unitTypes.length],
          floor: Math.ceil(i / 5),
          area: 800 + (i * 100),
          price: 4000000 + (i * 500000),
          status: i <= 20 ? 'AVAILABLE' : i <= 24 ? 'HOLD' : i <= 27 ? 'SOLD' : 'BLOCKED',
        },
      });
      units.push(unit);
    }
  }

  const leadStatuses = [LeadStatus.NEW, LeadStatus.INCOMING, LeadStatus.PROSPECT, LeadStatus.SITE_VISIT_SCHEDULED, LeadStatus.SITE_VISIT_HAPPENED, LeadStatus.LOST];
  const leadSources = ['WEBSITE', 'REFERRAL', 'COLD_CALL', 'ADVERTISEMENT', 'WALK_IN', 'PORTAL', 'INSTAGRAM'];
  const firstNames = ['Vikram', 'Sunita', 'Arjun', 'Kavita', 'Rohit', 'Meera', 'Sanjay', 'Pooja', 'Manoj', 'Anita', 'Deepak', 'Sonia', 'Raj', 'Nisha', 'Vikas', 'Ritu', 'Suresh', 'Geeta', 'Ashok', 'Suman'];
  const lastNames = ['Singh', 'Verma', 'Reddy', 'Iyer', 'Mishra', 'Das', 'Bose', 'Joshi', 'Nair', 'Tiwari', 'Gupta', 'Malhotra', 'Chopra', 'Kapoor', 'Mehta', 'Shah', 'Rao', 'Menon', 'Chatterjee', 'Bhat'];
  const leadOwners = [salesExec1.id, salesExec2.id];

  for (let i = 0; i < 150; i++) {
    const firstName = firstNames[i % firstNames.length];
    const lastName = lastNames[i % lastNames.length];
    const status = leadStatuses[Math.floor(Math.random() * leadStatuses.length)];
    const source = leadSources[Math.floor(Math.random() * leadSources.length)];
    const owner = leadOwners[i % leadOwners.length];
    const project = projects[i % projects.length];

    const lead = await prisma.lead.create({
      data: {
        tenantId: tenant.id,
        creatorId: adminUser.id,
        leadNumber: `LN${String(i + 1).padStart(6, '0')}`,
        ownerId: owner,
        projectId: project.id,
        firstName,
        lastName,
        email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}${i}@example.com`,
        phone: `+91-98765${String(10000 + i).padStart(5, '0')}`,
        company: `${lastName} Corp`,
        source,
        status,
        score: Math.floor(Math.random() * 100),
        budget: 5000000 + Math.floor(Math.random() * 10000000),
        queueId: leadsQueue.id,
      },
    });

    if (status === LeadStatus.SITE_VISIT_SCHEDULED || status === LeadStatus.SITE_VISIT_HAPPENED) {
      const svSeq = await prisma.sequence.upsert({
        where: { tenantId_type: { tenantId: tenant.id, type: 'SITE_VISIT' } },
        update: { nextValue: { increment: 1 } },
        create: { tenantId: tenant.id, type: 'SITE_VISIT', nextValue: 1 },
      });
      await prisma.siteVisit.create({
        data: {
          tenantId: tenant.id,
          leadId: lead.id,
          projectId: project.id,
          assigneeId: presalesExec.id,
          creatorId: adminUser.id,
          siteVisitNumber: `SV${String(svSeq.nextValue).padStart(6, '0')}`,
          scheduledAt: new Date(Date.now() - Math.floor(Math.random() * 30) * 24 * 60 * 60 * 1000),
          completedAt: status !== LeadStatus.SITE_VISIT_SCHEDULED ? new Date() : null,
          status: status === LeadStatus.SITE_VISIT_SCHEDULED ? SiteVisitStatus.SCHEDULED : SiteVisitStatus.COMPLETED,
        },
      });
    }

  }

  await prisma.sequence.upsert({
    where: { tenantId_type: { tenantId: tenant.id, type: 'LEAD' } },
    update: { nextValue: 150 },
    create: { tenantId: tenant.id, type: 'LEAD', nextValue: 150 },
  });

  await prisma.report.create({
    data: {
      tenantId: tenant.id,
      name: 'Lead by Status',
      type: 'SUMMARY',
      objectName: 'Lead',
      columns: ['status', 'count'],
      groupBy: 'status',
      createdBy: adminUser.id,
    },
  });

  await prisma.report.create({
    data: {
      tenantId: tenant.id,
      name: 'Lead by Source',
      type: 'SUMMARY',
      objectName: 'Lead',
      columns: ['source', 'count'],
      groupBy: 'source',
      createdBy: adminUser.id,
    },
  });

  await prisma.dashboard.create({
    data: {
      tenantId: tenant.id,
      name: 'Executive Dashboard',
      description: 'Overview of all CRM metrics',
      isDefault: true,
      layout: [],
      createdBy: adminUser.id,
    },
  });

  // ============================================
  // SEED METADATA - Standard Object Definitions
  // ============================================
  console.log('Seeding object metadata...');

  const standardObjects = [
    { name: 'Lead', label: 'Lead', pluralLabel: 'Leads', icon: 'user', description: 'Manage sales leads' },
    { name: 'Enquiry', label: 'Enquiry', pluralLabel: 'Enquiries', icon: 'inbox', description: 'Manage lead enquiries' },
    { name: 'SiteVisit', label: 'Site Visit', pluralLabel: 'Site Visits', icon: 'map-pin', description: 'Site visit scheduling' },
    { name: 'Project', label: 'Project', pluralLabel: 'Projects', icon: 'folder-kanban', description: 'Project management' },
    { name: 'Unit', label: 'Unit', pluralLabel: 'Units', icon: 'building', description: 'Manage project units' },
    { name: 'Company', label: 'Company', pluralLabel: 'Companies', icon: 'building', description: 'Manage companies' },
    { name: 'Booking', label: 'Booking', pluralLabel: 'Bookings', icon: 'book-open-check', description: 'Plot bookings created from quotations' },
    { name: 'Task', label: 'Task', pluralLabel: 'Tasks', icon: 'check-square', description: 'Task management' },
    { name: 'FollowUp', label: 'Follow-up', pluralLabel: 'Follow-ups', icon: 'phone', description: 'Manage lead follow-ups' },
    { name: 'Activity', label: 'Activity', pluralLabel: 'Activities', icon: 'activity', description: 'Track CRM activities' },
    { name: 'CallDetail', label: 'Call Detail', pluralLabel: 'Call Details', icon: 'phone', description: 'Track inbound and outbound calls', isAvailableInNavigation: false },
  ];

  const createdObjects: Record<string, any> = {};

  for (const obj of standardObjects) {
    const created = await prisma.objectDefinition.create({
      data: {
        tenantId: tenant.id,
        ...obj,
        objectType: 'standard',
        createdBy: adminUser.id,
        updatedBy: adminUser.id,
      },
    });
    createdObjects[obj.name] = created;

    if (obj.name === 'CallDetail') {
      const callFields = [
        { name: 'name', label: 'Call Details Name', fieldType: 'autoNumber', isSystemField: true, editable: false, displayOrder: 0 },
        { name: 'callFrom', label: 'Call From', fieldType: 'text', displayOrder: 1 },
        { name: 'callId', label: 'Call ID', fieldType: 'text', isSystemField: true, editable: false, displayOrder: 2 },
        { name: 'callTo', label: 'Call To', fieldType: 'text', displayOrder: 3 },
        { name: 'callType', label: 'Call Type', fieldType: 'picklist', required: true, displayOrder: 4 },
        { name: 'caseId', label: 'Case', fieldType: 'lookup', lookupObject: 'Lead', displayOrder: 5 },
        { name: 'createdById', label: 'Created By', fieldType: 'lookup', lookupObject: 'User', isSystemField: true, editable: false, displayOrder: 6 },
        { name: 'duration', label: 'Duration', fieldType: 'number', isSystemField: true, editable: false, displayOrder: 7 },
        { name: 'endAt', label: 'End Time', fieldType: 'dateTime', required: true, displayOrder: 8 },
        { name: 'executiveContactNo', label: 'Executive Contact No', fieldType: 'text', displayOrder: 9 },
        { name: 'landingNumber', label: 'Landing Number', fieldType: 'text', displayOrder: 10 },
        { name: 'lastModifiedById', label: 'Last Modified By', fieldType: 'lookup', lookupObject: 'User', isSystemField: true, editable: false, displayOrder: 11 },
        { name: 'leadId', label: 'Lead', fieldType: 'lookup', lookupObject: 'Lead', required: true, isSystemField: true, editable: false, displayOrder: 12 },
        { name: 'ownerId', label: 'Owner', fieldType: 'lookup', lookupObject: 'User', displayOrder: 14 },
        { name: 'parentId', label: 'Parent ID', fieldType: 'text', displayOrder: 15 },
        { name: 'parentUrl', label: 'Parent URL', fieldType: 'url', displayOrder: 16 },
        { name: 'recordingFile', label: 'Recording File', fieldType: 'url', displayOrder: 17 },
        { name: 'startAt', label: 'Start Time', fieldType: 'dateTime', required: true, displayOrder: 18 },
        { name: 'status', label: 'Status', fieldType: 'picklist', displayOrder: 19 },
        { name: 'notes', label: 'Notes', fieldType: 'longText', displayOrder: 20 },
      ];
      for (const field of callFields) {
        await prisma.fieldDefinition.create({
          data: {
            tenantId: tenant.id,
            objectId: created.id,
            required: false,
            searchable: true,
            sortable: true,
            filterable: true,
            visible: true,
            editable: true,
            isActive: true,
            isSystemField: false,
            isCustomField: false,
            isStandardField: true,
            ...field,
            createdBy: adminUser.id,
          },
        });
      }
      for (const [fieldName, options] of Object.entries({
        callType: ['INBOUND', 'OUTBOUND'],
        status: ['COMPLETED', 'NO_ANSWER', 'BUSY', 'VOICEMAIL', 'CANCELLED'],
      })) {
        const field = await prisma.fieldDefinition.findUnique({
          where: { objectId_name: { objectId: created.id, name: fieldName } },
          select: { id: true },
        });
        if (field) {
          for (const [displayOrder, value] of options.entries()) {
            await prisma.picklistValue.create({
              data: {
                tenantId: tenant.id,
                fieldId: field.id,
                label: value.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (letter: string) => letter.toUpperCase()),
                value,
                isDefault: displayOrder === 0,
                displayOrder,
              },
            });
          }
        }
      }
    }

    // Create default layout
    await prisma.pageLayout.create({
      data: {
        tenantId: tenant.id,
        objectId: created.id,
        name: 'Default Layout',
        isDefault: true,
        sections: JSON.stringify(obj.name === 'CallDetail'
          ? [
              { name: 'Call Information', fields: ['name', 'callFrom', 'callId', 'callTo', 'callType', 'duration', 'startAt', 'endAt', 'status'] },
              { name: 'Related Records', fields: ['caseId', 'createdById', 'lastModifiedById', 'leadId', 'ownerId', 'parentId', 'parentUrl'] },
              { name: 'Details', fields: ['executiveContactNo', 'landingNumber', 'recordingFile', 'notes'] },
            ]
          : [
              { name: `${obj.label} Information`, fields: ['name', 'description'] },
              { name: 'Details', fields: [] },
            ]),
        createdBy: adminUser.id,
      },
    });

    // Create default permissions for Admin role (full access)
    await prisma.objectPermission.create({
      data: {
        tenantId: tenant.id,
        roleId: adminRole.id,
        objectId: created.id,
        canCreate: true,
        canRead: true,
        canUpdate: true,
        canDelete: true,
        viewAll: true,
        modifyAll: true,
      },
    });

    // Create default permissions for Sales Manager
    await prisma.objectPermission.create({
      data: {
        tenantId: tenant.id,
        roleId: salesManagerRole.id,
        objectId: created.id,
        canCreate: true,
        canRead: true,
        canUpdate: true,
        canDelete: false,
        viewAll: true,
        modifyAll: false,
      },
    });

    // Create default permissions for Sales Executive
    await prisma.objectPermission.create({
      data: {
        tenantId: tenant.id,
        roleId: salesExecRole.id,
        objectId: created.id,
        canCreate: true,
        canRead: true,
        canUpdate: true,
        canDelete: false,
        viewAll: false,
        modifyAll: false,
      },
    });
  }

  console.log(`Created ${standardObjects.length} standard object definitions`);

  console.log('Seed completed successfully!');
  console.log(`Tenant: ${tenant.name} (${tenant.slug})`);
  console.log(`Admin: admin@dctcrm.com / password123`);
  console.log(`Sales Manager: salesmanager@dctcrm.com / password123`);
  console.log(`Sales Exec 1: priya@dctcrm.com / password123`);
  console.log(`Sales Exec 2: amit@dctcrm.com / password123`);
  console.log(`Presales: neha@dctcrm.com / password123`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });