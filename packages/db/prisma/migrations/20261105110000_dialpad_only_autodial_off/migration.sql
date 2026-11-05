ALTER TABLE "telephony_settings"
  ALTER COLUMN "autoDialOnClick" SET DEFAULT false;

UPDATE "telephony_settings"
SET "autoDialOnClick" = false
WHERE "autoDialOnClick" = true;
