BEGIN;

SELECT pg_advisory_xact_lock(hashtext('dct-crm-admin-permission-repair'));

DO $$
BEGIN
  IF to_regclass('public."Permission"') IS NULL
    OR to_regclass('public."Profile"') IS NULL
    OR to_regclass('public."UserProfilePermission"') IS NULL
    OR to_regclass('public."Tenant"') IS NULL THEN
    RAISE EXCEPTION 'Permission repair requires public."Permission", public."Profile", public."UserProfilePermission", and public."Tenant". No changes were committed.';
  END IF;
END $$;

DO $$
DECLARE
  inserted_permissions INTEGER;
BEGIN
  INSERT INTO public."Permission" ("id", "name", "label", "module", "action", "isActive", "createdAt", "updatedAt")
  SELECT md5(random()::text || clock_timestamp()::text || required.name),
         required.name,
         replace(required.name, '_', ' '),
         regexp_replace(required.name, '_[^_]+$', ''),
         regexp_replace(required.name, '^.*_', ''),
         true,
         CURRENT_TIMESTAMP,
         CURRENT_TIMESTAMP
  FROM (VALUES
    ('ACTIVITY_CREATE'), ('ACTIVITY_DELETE'), ('ACTIVITY_READ'), ('ACTIVITY_UPDATE'),
    ('AUDIT_READ'), ('CRM_RECEIPT_CREATE'), ('CRM_WELCOME_CALL_COMPLETE'),
    ('DASHBOARD_CREATE'), ('DASHBOARD_DELETE'), ('DASHBOARD_READ'), ('DASHBOARD_UPDATE'),
    ('DATA_EXPORT'), ('DATA_IMPORT'), ('ENQUIRY_CREATE'), ('ENQUIRY_DELETE'),
    ('ENQUIRY_READ'), ('ENQUIRY_UPDATE'), ('FOLLOW_UP_CREATE'), ('FOLLOW_UP_DELETE'),
    ('FOLLOW_UP_READ'), ('FOLLOW_UP_UPDATE'), ('FULL_SYSTEM_ACCESS'), ('LEAD_ASSIGN'),
    ('LEAD_CREATE'), ('LEAD_DELETE'), ('LEAD_READ'), ('LEAD_UPDATE'),
    ('PERMISSION_SET_ASSIGN'), ('PERMISSION_SET_CREATE'), ('PERMISSION_SET_DELETE'),
    ('PERMISSION_SET_READ'), ('PERMISSION_SET_UPDATE'), ('PROFILE_CREATE'),
    ('PROFILE_DELETE'), ('PROFILE_PERMISSION_MANAGE'), ('PROFILE_READ'), ('PROFILE_UPDATE'),
    ('PROJECT_CREATE'), ('PROJECT_DELETE'), ('PROJECT_READ'), ('PROJECT_UPDATE'),
    ('REPORT_CREATE'), ('REPORT_DELETE'), ('REPORT_READ'), ('REPORT_UPDATE'),
    ('REPORT_VIEW'), ('ROLE_CREATE'), ('ROLE_DELETE'), ('ROLE_READ'), ('ROLE_UPDATE'),
    ('SITE_VISIT_CREATE'), ('SITE_VISIT_DELETE'), ('SITE_VISIT_READ'), ('SITE_VISIT_UPDATE'),
    ('TASK_CREATE'), ('TASK_READ'), ('TELEPHONY_CALL'), ('UNIT_CREATE'), ('UNIT_DELETE'),
    ('UNIT_READ'), ('UNIT_UPDATE'), ('USER_CREATE'), ('USER_DELETE'), ('USER_PERMISSION_ADD'),
    ('USER_PERMISSION_READ'), ('USER_PERMISSION_REMOVE'), ('USER_READ'), ('USER_UPDATE')
  ) AS required(name)
  ON CONFLICT ("name") DO NOTHING;
  GET DIAGNOSTICS inserted_permissions = ROW_COUNT;
  RAISE NOTICE 'Permission catalog rows inserted: %', inserted_permissions;
END $$;

DO $$
DECLARE
  reactivated_permissions INTEGER;
BEGIN
  UPDATE public."Permission" permission
  SET "isActive" = true,
      "updatedAt" = CURRENT_TIMESTAMP
  FROM (VALUES
    ('FULL_SYSTEM_ACCESS'), ('LEAD_READ'), ('SITE_VISIT_READ'), ('PROJECT_READ'),
    ('UNIT_READ'), ('TASK_READ'), ('REPORT_READ'), ('REPORT_VIEW'), ('DASHBOARD_READ'),
    ('USER_READ'), ('ROLE_READ'), ('PROFILE_READ'), ('LEAD_CREATE'), ('SITE_VISIT_CREATE'),
    ('PROJECT_CREATE'), ('UNIT_CREATE'), ('TASK_CREATE'), ('REPORT_CREATE'),
    ('DASHBOARD_CREATE'), ('TELEPHONY_CALL'), ('ENQUIRY_READ')
  ) AS default_permission(name)
  WHERE permission."name" = default_permission.name
    AND permission."isActive" = false;
  GET DIAGNOSTICS reactivated_permissions = ROW_COUNT;
  RAISE NOTICE 'Default Admin permission definitions reactivated: %', reactivated_permissions;
END $$;

DO $$
DECLARE
  inserted_grants INTEGER;
BEGIN
  INSERT INTO public."UserProfilePermission" ("id", "profileId", "permissionId", "createdAt")
  SELECT md5(random()::text || clock_timestamp()::text || profile."id" || permission."id"),
         profile."id",
         permission."id",
         CURRENT_TIMESTAMP
  FROM public."Tenant" tenant
  JOIN public."Profile" profile ON profile."tenantId" = tenant."id"
  CROSS JOIN (VALUES
    ('FULL_SYSTEM_ACCESS'), ('LEAD_READ'), ('SITE_VISIT_READ'), ('PROJECT_READ'),
    ('UNIT_READ'), ('TASK_READ'), ('REPORT_READ'), ('REPORT_VIEW'), ('DASHBOARD_READ'),
    ('USER_READ'), ('ROLE_READ'), ('PROFILE_READ'), ('LEAD_CREATE'), ('SITE_VISIT_CREATE'),
    ('PROJECT_CREATE'), ('UNIT_CREATE'), ('TASK_CREATE'), ('REPORT_CREATE'),
    ('DASHBOARD_CREATE'), ('TELEPHONY_CALL'), ('ENQUIRY_READ')
  ) AS default_permission(name)
  JOIN public."Permission" permission ON permission."name" = default_permission.name
  WHERE profile."isAdmin" = true OR lower(btrim(profile."name")) = 'system administrator'
  ON CONFLICT ("profileId", "permissionId") DO NOTHING;
  GET DIAGNOSTICS inserted_grants = ROW_COUNT;
  RAISE NOTICE 'Default Admin profile grants inserted: %', inserted_grants;
END $$;

COMMIT;
