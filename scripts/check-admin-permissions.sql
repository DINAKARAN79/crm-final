\set ON_ERROR_STOP on
\pset pager off
\pset format aligned
\echo 'Admin permission audit (read-only; no secrets are selected)'

DO $$
BEGIN
  IF to_regclass('public."Permission"') IS NULL
    OR to_regclass('public."Profile"') IS NULL
    OR to_regclass('public."UserProfilePermission"') IS NULL
    OR to_regclass('public."Tenant"') IS NULL THEN
    RAISE EXCEPTION 'Permission check requires public."Permission", public."Profile", public."UserProfilePermission", and public."Tenant".';
  END IF;
END $$;

\echo ''
\echo 'Required catalog permissions missing'
WITH required(name) AS (VALUES
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
)
SELECT required.name AS permission_key,
       'missing' AS catalog_status
FROM required
LEFT JOIN public."Permission" permission
  ON permission."name" = required.name
WHERE permission."id" IS NULL
ORDER BY required.name;

\echo ''
\echo 'Admin profiles missing a default Admin permission grant'
WITH default_admin(name) AS (VALUES
  ('FULL_SYSTEM_ACCESS'), ('LEAD_READ'), ('SITE_VISIT_READ'), ('PROJECT_READ'),
  ('UNIT_READ'), ('TASK_READ'), ('REPORT_READ'), ('REPORT_VIEW'), ('DASHBOARD_READ'),
  ('USER_READ'), ('ROLE_READ'), ('PROFILE_READ'), ('LEAD_CREATE'), ('SITE_VISIT_CREATE'),
  ('PROJECT_CREATE'), ('UNIT_CREATE'), ('TASK_CREATE'), ('REPORT_CREATE'),
  ('DASHBOARD_CREATE'), ('TELEPHONY_CALL'), ('ENQUIRY_READ')
)
SELECT tenant."id" AS tenant_id,
       tenant."name" AS tenant_name,
       profile."id" AS profile_id,
       profile."name" AS profile_name,
       required.name AS missing_permission,
       CASE
         WHEN permission."id" IS NULL THEN 'catalog row missing'
         WHEN permission."isActive" = false THEN 'catalog row inactive'
         ELSE 'profile grant missing'
       END AS issue
FROM public."Tenant" tenant
JOIN public."Profile" profile ON profile."tenantId" = tenant."id"
CROSS JOIN default_admin required
LEFT JOIN public."Permission" permission ON permission."name" = required.name
LEFT JOIN public."UserProfilePermission" grant_row
  ON grant_row."profileId" = profile."id"
 AND grant_row."permissionId" = permission."id"
WHERE (profile."isAdmin" = true OR lower(btrim(profile."name")) = 'system administrator')
  AND (permission."id" IS NULL OR permission."isActive" = false OR grant_row."id" IS NULL)
ORDER BY tenant."name", profile."name", required.name;

\echo ''
\echo 'Required permissions and default Admin grants check'
DO $$
DECLARE
  missing_catalog_count INTEGER;
  missing_grant_count INTEGER;
  missing_catalog_names TEXT;
BEGIN
  SELECT count(*), string_agg(required.name, ', ' ORDER BY required.name)
    INTO missing_catalog_count, missing_catalog_names
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
  LEFT JOIN public."Permission" permission
    ON permission."name" = required.name
  WHERE permission."id" IS NULL;

  SELECT count(*) INTO missing_grant_count
  FROM public."Tenant" tenant
  JOIN public."Profile" profile ON profile."tenantId" = tenant."id"
  CROSS JOIN (VALUES
    ('FULL_SYSTEM_ACCESS'), ('LEAD_READ'), ('SITE_VISIT_READ'), ('PROJECT_READ'),
    ('UNIT_READ'), ('TASK_READ'), ('REPORT_READ'), ('REPORT_VIEW'), ('DASHBOARD_READ'),
    ('USER_READ'), ('ROLE_READ'), ('PROFILE_READ'), ('LEAD_CREATE'), ('SITE_VISIT_CREATE'),
    ('PROJECT_CREATE'), ('UNIT_CREATE'), ('TASK_CREATE'), ('REPORT_CREATE'),
    ('DASHBOARD_CREATE'), ('TELEPHONY_CALL'), ('ENQUIRY_READ')
  ) AS required(name)
  LEFT JOIN public."Permission" permission ON permission."name" = required.name
  LEFT JOIN public."UserProfilePermission" grant_row
    ON grant_row."profileId" = profile."id"
   AND grant_row."permissionId" = permission."id"
  WHERE (profile."isAdmin" = true OR lower(btrim(profile."name")) = 'system administrator')
    AND (permission."id" IS NULL OR permission."isActive" = false OR grant_row."id" IS NULL);

  IF missing_catalog_count > 0 OR missing_grant_count > 0 THEN
    RAISE EXCEPTION 'Permission check failed: % required catalog permissions missing [%]; % default Admin grants or active definitions missing. Run scripts/repair-admin-permissions.sql after a database snapshot.',
      missing_catalog_count, COALESCE(missing_catalog_names, ''), missing_grant_count;
  END IF;
  RAISE NOTICE 'PASS: all required catalog permissions exist and all admin profiles have the default Admin grants.';
END $$;
