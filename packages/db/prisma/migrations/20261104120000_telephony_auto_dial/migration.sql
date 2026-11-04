ALTER TABLE public.telephony_settings
  ADD COLUMN IF NOT EXISTS "autoDialOnClick" BOOLEAN NOT NULL DEFAULT true;
