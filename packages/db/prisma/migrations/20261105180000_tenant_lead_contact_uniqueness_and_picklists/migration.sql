ALTER TABLE "Lead"
  ADD COLUMN IF NOT EXISTS "normalizedEmail" TEXT,
  ADD COLUMN IF NOT EXISTS "normalizedPhone" TEXT;

ALTER TABLE "Lead" ALTER COLUMN "source" DROP DEFAULT;
ALTER TABLE "Lead" ALTER COLUMN "source" TYPE TEXT USING "source"::TEXT;
ALTER TABLE "Lead" ALTER COLUMN "source" SET DEFAULT 'OTHER';

CREATE OR REPLACE FUNCTION "crm_normalize_lead_phone"(phone_value TEXT, country_code TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $function$
DECLARE
  phone_digits TEXT;
  calling_code TEXT;
BEGIN
  IF phone_value IS NULL OR btrim(phone_value) = '' THEN
    RETURN NULL;
  END IF;

  phone_digits := regexp_replace(phone_value, '[^0-9]', '', 'g');
  IF phone_digits = '' THEN
    RETURN NULL;
  END IF;
  IF btrim(phone_value) LIKE '00%' THEN
    RETURN NULLIF(substring(phone_digits FROM 3), '');
  END IF;
  IF btrim(phone_value) LIKE '+%' THEN
    RETURN phone_digits;
  END IF;

  calling_code := nullif(regexp_replace(coalesce(country_code, ''), '[^0-9]', '', 'g'), '');
  IF calling_code IS NULL THEN
    RETURN phone_digits;
  END IF;
  IF left(phone_digits, length(calling_code)) = calling_code
     AND length(phone_digits) - length(calling_code) >= 7 THEN
    RETURN phone_digits;
  END IF;
  RETURN calling_code || ltrim(phone_digits, '0');
END;
$function$;

WITH normalized AS (
  SELECT
    "id",
    "tenantId",
    "crm_normalize_lead_phone"("phone", "countryCode") AS value
  FROM "Lead"
),
unique_values AS (
  SELECT "tenantId", value
  FROM normalized
  WHERE value IS NOT NULL
  GROUP BY "tenantId", value
  HAVING count(*) = 1
)
UPDATE "Lead" lead
SET "normalizedPhone" = normalized.value
FROM normalized
JOIN unique_values USING ("tenantId", value)
WHERE lead."id" = normalized."id";

WITH normalized AS (
  SELECT "id", "tenantId", lower(btrim("email")) AS value
  FROM "Lead"
  WHERE nullif(btrim("email"), '') IS NOT NULL
),
unique_values AS (
  SELECT "tenantId", value
  FROM normalized
  GROUP BY "tenantId", value
  HAVING count(*) = 1
)
UPDATE "Lead" lead
SET "normalizedEmail" = normalized.value
FROM normalized
JOIN unique_values USING ("tenantId", value)
WHERE lead."id" = normalized."id";

CREATE UNIQUE INDEX IF NOT EXISTS "Lead_tenantId_normalizedPhone_key"
  ON "Lead" ("tenantId", "normalizedPhone");
CREATE UNIQUE INDEX IF NOT EXISTS "Lead_tenantId_normalizedEmail_key"
  ON "Lead" ("tenantId", "normalizedEmail");

CREATE OR REPLACE FUNCTION "crm_enforce_tenant_lead_contact_uniqueness"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE
  contact_lock TEXT;
  lock_keys TEXT[] := ARRAY[]::TEXT[];
  phone_conflict BOOLEAN := FALSE;
  email_conflict BOOLEAN := FALSE;
BEGIN
  NEW."normalizedPhone" := "crm_normalize_lead_phone"(NEW."phone", NEW."countryCode");
  NEW."normalizedEmail" := nullif(lower(btrim(coalesce(NEW."email", ''))), '');

  IF NEW."normalizedPhone" IS NOT NULL THEN
    lock_keys := array_append(
      lock_keys,
      'LEAD_CONTACT:' || NEW."tenantId" || ':PHONE:' || NEW."normalizedPhone"
    );
  END IF;
  IF NEW."normalizedEmail" IS NOT NULL THEN
    lock_keys := array_append(
      lock_keys,
      'LEAD_CONTACT:' || NEW."tenantId" || ':EMAIL:' || NEW."normalizedEmail"
    );
  END IF;

  FOR contact_lock IN
    SELECT DISTINCT key FROM unnest(lock_keys) AS key ORDER BY key
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(contact_lock, 0));
  END LOOP;

  SELECT
    coalesce(bool_or(
      NEW."normalizedPhone" IS NOT NULL
      AND coalesce(lead."normalizedPhone", "crm_normalize_lead_phone"(lead."phone", lead."countryCode"))
        = NEW."normalizedPhone"
    ), FALSE),
    coalesce(bool_or(
      NEW."normalizedEmail" IS NOT NULL
      AND coalesce(lead."normalizedEmail", nullif(lower(btrim(coalesce(lead."email", ''))), ''))
        = NEW."normalizedEmail"
    ), FALSE)
  INTO phone_conflict, email_conflict
  FROM "Lead" lead
  WHERE lead."tenantId" = NEW."tenantId"
    AND lead."id" IS DISTINCT FROM NEW."id";

  IF phone_conflict AND email_conflict THEN
    RAISE EXCEPTION 'Duplicate tenant lead phone and email'
      USING ERRCODE = '23505', CONSTRAINT = 'Lead_tenantId_normalizedPhone_normalizedEmail_key';
  ELSIF phone_conflict THEN
    RAISE EXCEPTION 'Duplicate tenant lead phone'
      USING ERRCODE = '23505', CONSTRAINT = 'Lead_tenantId_normalizedPhone_key';
  ELSIF email_conflict THEN
    RAISE EXCEPTION 'Duplicate tenant lead email'
      USING ERRCODE = '23505', CONSTRAINT = 'Lead_tenantId_normalizedEmail_key';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS "Lead_tenant_contact_uniqueness" ON "Lead";
CREATE TRIGGER "Lead_tenant_contact_uniqueness"
BEFORE INSERT OR UPDATE OF "tenantId", "phone", "countryCode", "email"
ON "Lead"
FOR EACH ROW
EXECUTE FUNCTION "crm_enforce_tenant_lead_contact_uniqueness"();

INSERT INTO "FieldDefinition" (
  "id", "tenantId", "objectId", "name", "label", "fieldType",
  "required", "unique", "searchable", "sortable", "filterable",
  "visible", "editable", "isActive", "isSystemField", "isCustomField",
  "isStandardField", "displayOrder", "createdBy", "createdAt", "updatedAt"
)
SELECT
  md5(random()::TEXT || clock_timestamp()::TEXT),
  object."tenantId",
  object."id",
  field.name,
  field.label,
  'picklist',
  FALSE,
  FALSE,
  TRUE,
  TRUE,
  TRUE,
  TRUE,
  TRUE,
  TRUE,
  FALSE,
  field.is_custom_field,
  field.is_standard_field,
  field.display_order,
  coalesce((
    SELECT "id" FROM "User"
    WHERE "tenantId" = object."tenantId" AND "isActive" = TRUE
    ORDER BY "createdAt"
    LIMIT 1
  ), 'system'),
  now(),
  now()
FROM "ObjectDefinition" object
CROSS JOIN (
  VALUES
    ('firstCampaign', 'First Campaign', 33, FALSE, TRUE),
    ('lastCampaign', 'Last Campaign', 34, FALSE, TRUE),
    ('leadInterest', 'Lead Interest', 35, FALSE, TRUE),
    ('source', 'Lead Source', 30, TRUE, FALSE)
) AS field(name, label, display_order, is_custom_field, is_standard_field)
WHERE lower(object."name") = 'lead'
ON CONFLICT ("objectId", "name") DO UPDATE SET
  "label" = EXCLUDED."label",
  "fieldType" = 'picklist',
  "visible" = TRUE,
  "editable" = TRUE,
  "isActive" = TRUE,
  "isSystemField" = FALSE,
  "isCustomField" = EXCLUDED."isCustomField",
  "isStandardField" = EXCLUDED."isStandardField",
  "updatedAt" = now();

UPDATE "PageLayout" layout
SET "sections" = CASE
  WHEN EXISTS (
    SELECT 1
    FROM jsonb_array_elements(layout."sections") AS existing(section)
    WHERE section->>'name' IN ('Lead Information', 'Lead Details')
  ) THEN (
    SELECT jsonb_agg(
      CASE
        WHEN section->>'name' IN ('Lead Information', 'Lead Details') THEN
          jsonb_set(
            section,
            '{fields}',
            coalesce(section->'fields', '[]'::JSONB) || coalesce((
            SELECT jsonb_agg(to_jsonb(added.field_name))
            FROM unnest(ARRAY['firstCampaign', 'lastCampaign', 'leadInterest']) AS added(field_name)
            WHERE NOT coalesce(section->'fields', '[]'::JSONB) @> jsonb_build_array(added.field_name)
            ), '[]'::JSONB),
            TRUE
          )
        ELSE section
      END
      ORDER BY section_order
    )
    FROM jsonb_array_elements(layout."sections") WITH ORDINALITY AS current(section, section_order)
  )
  ELSE layout."sections" || jsonb_build_array(jsonb_build_object(
    'name', 'Lead Information',
    'fields', ARRAY['firstCampaign', 'lastCampaign', 'leadInterest']
  ))
END
FROM "ObjectDefinition" object
WHERE object."id" = layout."objectId"
  AND lower(object."name") = 'lead'
  AND layout."name" = 'Default Layout'
  AND jsonb_typeof(layout."sections") = 'array';

WITH interest_options(label, value, display_order) AS (
  VALUES
    ('Prospect', 'PROSPECT', 0),
    ('Hot', 'HOT', 1),
    ('Warm', 'WARM', 2),
    ('Unable to Connect', 'UNABLE_TO_CONNECT', 3),
    ('Dropped', 'DROPPED', 4),
    ('Cold', 'COLD', 5)
)
INSERT INTO "PicklistValue" ("id", "tenantId", "fieldId", "label", "value", "isActive", "isDefault", "displayOrder")
SELECT
  md5(random()::TEXT || clock_timestamp()::TEXT),
  field."tenantId",
  field."id",
  option.label,
  option.value,
  TRUE,
  option.display_order = 0,
  option.display_order
FROM "FieldDefinition" field
JOIN "ObjectDefinition" object ON object."id" = field."objectId"
CROSS JOIN interest_options option
WHERE lower(object."name") = 'lead'
  AND field."name" = 'leadInterest'
ON CONFLICT ("fieldId", "value") DO NOTHING;

WITH campaign_values AS (
  SELECT
    lead."tenantId",
    field_name.name,
    btrim(value.raw_value) AS value,
    row_number() OVER (
      PARTITION BY lead."tenantId", field_name.name
      ORDER BY lower(btrim(value.raw_value)), btrim(value.raw_value)
    )::INTEGER - 1 AS display_order
  FROM "Lead" lead
  CROSS JOIN LATERAL (
    VALUES
      ('firstCampaign', lead."firstCampaign"),
      ('lastCampaign', lead."lastCampaign")
  ) AS value(name, raw_value)
  JOIN (VALUES ('firstCampaign'), ('lastCampaign')) AS field_name(name)
    ON field_name.name = value.name
  WHERE nullif(btrim(value.raw_value), '') IS NOT NULL
  GROUP BY lead."tenantId", field_name.name, btrim(value.raw_value)
)
INSERT INTO "PicklistValue" ("id", "tenantId", "fieldId", "label", "value", "isActive", "isDefault", "displayOrder")
SELECT
  md5(random()::TEXT || clock_timestamp()::TEXT),
  field."tenantId",
  field."id",
  campaign.value,
  campaign.value,
  TRUE,
  FALSE,
  campaign.display_order
FROM campaign_values campaign
JOIN "ObjectDefinition" object
  ON object."tenantId" = campaign."tenantId" AND lower(object."name") = 'lead'
JOIN "FieldDefinition" field
  ON field."objectId" = object."id" AND field."name" = campaign.name
ON CONFLICT ("fieldId", "value") DO NOTHING;

WITH source_options(label, value, display_order) AS (
  VALUES
    ('Website', 'WEBSITE', 0),
    ('Facebook', 'FACEBOOK', 1),
    ('Referral', 'REFERRAL', 2),
    ('Cold Call', 'COLD_CALL', 3),
    ('Advertisement', 'ADVERTISEMENT', 4),
    ('Walk-in', 'WALK_IN', 5),
    ('Portal', 'PORTAL', 6),
    ('Channel Partner', 'CHANNEL_PARTNER', 7),
    ('Instagram', 'INSTAGRAM', 8),
    ('Twitter', 'TWITTER', 9),
    ('WhatsApp', 'WHATSAPP', 10),
    ('YouTube', 'YOUTUBE', 11),
    ('Other', 'OTHER', 12)
)
INSERT INTO "PicklistValue" ("id", "tenantId", "fieldId", "label", "value", "isActive", "isDefault", "displayOrder")
SELECT
  md5(random()::TEXT || clock_timestamp()::TEXT),
  field."tenantId",
  field."id",
  option.label,
  option.value,
  TRUE,
  option.value = 'OTHER',
  option.display_order
FROM "FieldDefinition" field
JOIN "ObjectDefinition" object ON object."id" = field."objectId"
CROSS JOIN source_options option
WHERE lower(object."name") = 'lead'
  AND field."name" = 'source'
ON CONFLICT ("fieldId", "value") DO NOTHING;
