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
  'leadInterest',
  'Lead Interest',
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
  FALSE,
  TRUE,
  33,
  coalesce((
    SELECT "id" FROM "User"
    WHERE "tenantId" = object."tenantId" AND "isActive" = TRUE
    ORDER BY "createdAt"
    LIMIT 1
  ), 'system'),
  now(),
  now()
FROM "ObjectDefinition" object
WHERE lower(object."name") = 'lead'
ON CONFLICT ("objectId", "name") DO NOTHING;

WITH interest_options(label, value, display_order) AS (
  VALUES
    ('Prospect', 'PROSPECT', 0),
    ('Hot', 'HOT', 1),
    ('Warm', 'WARM', 2),
    ('Unable to Connect', 'UNABLE_TO_CONNECT', 3),
    ('Dropped', 'DROPPED', 4),
    ('Cold', 'COLD', 5)
)
INSERT INTO "PicklistValue" (
  "id", "tenantId", "fieldId", "label", "value", "isActive", "isDefault", "displayOrder"
)
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
  AND field."fieldType" = 'picklist'
ON CONFLICT ("fieldId", "value") DO NOTHING;

UPDATE "PageLayout" layout
SET "sections" = CASE
  WHEN EXISTS (
    SELECT 1
    FROM jsonb_array_elements(layout."sections") AS existing(section)
    WHERE section->>'name' IN ('Lead Information', 'Lead Details')
  ) THEN (
    SELECT jsonb_agg(
      CASE
        WHEN section->>'name' IN ('Lead Information', 'Lead Details')
          AND NOT coalesce(section->'fields', '[]'::JSONB) @> '["leadInterest"]'::JSONB
        THEN jsonb_set(
          section,
          '{fields}',
          coalesce(section->'fields', '[]'::JSONB) || '["leadInterest"]'::JSONB,
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
    'fields', ARRAY['leadInterest']
  ))
END
FROM "ObjectDefinition" object
WHERE object."id" = layout."objectId"
  AND lower(object."name") = 'lead'
  AND layout."isDefault" = TRUE
  AND jsonb_typeof(layout."sections") = 'array';
