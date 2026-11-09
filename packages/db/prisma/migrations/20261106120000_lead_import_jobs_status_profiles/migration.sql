CREATE TABLE "LeadImportJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "totalRows" INTEGER NOT NULL,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "linkedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LeadImportJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LeadImportStatusProfile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "profileNames" JSONB NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LeadImportStatusProfile_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Lead"
ADD COLUMN "importJobId" TEXT;

CREATE INDEX "LeadImportJob_tenantId_createdAt_idx" ON "LeadImportJob"("tenantId", "createdAt");
CREATE INDEX "LeadImportJob_tenantId_status_idx" ON "LeadImportJob"("tenantId", "status");
CREATE INDEX "LeadImportStatusProfile_tenantId_idx" ON "LeadImportStatusProfile"("tenantId");
CREATE UNIQUE INDEX "LeadImportStatusProfile_tenantId_status_key" ON "LeadImportStatusProfile"("tenantId", "status");
CREATE INDEX "Lead_importJobId_idx" ON "Lead"("importJobId");

ALTER TABLE "LeadImportJob"
ADD CONSTRAINT "LeadImportJob_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LeadImportJob"
ADD CONSTRAINT "LeadImportJob_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeadImportStatusProfile"
ADD CONSTRAINT "LeadImportStatusProfile_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Lead"
ADD CONSTRAINT "Lead_importJobId_fkey"
FOREIGN KEY ("importJobId") REFERENCES "LeadImportJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
