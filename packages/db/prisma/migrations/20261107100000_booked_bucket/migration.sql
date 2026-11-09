ALTER TABLE "Lead"
ADD COLUMN "bookedById" TEXT;

ALTER TABLE "LeadOwnerHistory"
ADD COLUMN "source" TEXT;

CREATE INDEX "Lead_tenantId_bookedById_idx"
ON "Lead"("tenantId", "bookedById");

ALTER TABLE "Lead"
ADD CONSTRAINT "Lead_bookedById_fkey"
FOREIGN KEY ("bookedById") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "booked_bucket_settings" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT false,
  "fallbackUserId" TEXT,
  "moveOpenFollowUps" BOOLEAN NOT NULL DEFAULT false,
  "returnToPreviousOwnerOnCancel" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "booked_bucket_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "booked_bucket_settings_tenantId_key"
ON "booked_bucket_settings"("tenantId");

ALTER TABLE "booked_bucket_settings"
ADD CONSTRAINT "booked_bucket_settings_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "booked_bucket_settings"
ADD CONSTRAINT "booked_bucket_settings_fallbackUserId_fkey"
FOREIGN KEY ("fallbackUserId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "booked_bucket_members" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "pointer" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "booked_bucket_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "booked_bucket_members_tenantId_userId_key"
ON "booked_bucket_members"("tenantId", "userId");

CREATE INDEX "booked_bucket_members_tenantId_isActive_sortOrder_idx"
ON "booked_bucket_members"("tenantId", "isActive", "sortOrder");

ALTER TABLE "booked_bucket_members"
ADD CONSTRAINT "booked_bucket_members_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "booked_bucket_settings"("tenantId")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "booked_bucket_members"
ADD CONSTRAINT "booked_bucket_members_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "booked_bucket_settings" ("id", "tenantId", "isActive", "createdAt", "updatedAt")
SELECT 'booked-bucket-' || "id", "id", false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Tenant"
ON CONFLICT ("tenantId") DO NOTHING;
