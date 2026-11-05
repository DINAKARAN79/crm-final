ALTER TABLE "user_sessions"
ADD COLUMN IF NOT EXISTS "refreshTokenHash" TEXT,
ADD COLUMN IF NOT EXISTS "refreshTokenExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "user_sessions_refreshTokenHash_key"
ON "user_sessions"("refreshTokenHash");
