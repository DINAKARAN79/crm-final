CREATE TYPE "RefundRequestStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED');

CREATE TABLE "RefundRequest" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "leadId" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "reviewedById" TEXT,
  "requestKey" TEXT NOT NULL,
  "customerName" TEXT NOT NULL,
  "customerPhone" TEXT,
  "customerEmail" TEXT,
  "amount" DOUBLE PRECISION NOT NULL,
  "reason" TEXT NOT NULL,
  "refundReference" TEXT NOT NULL,
  "status" "RefundRequestStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  "reviewNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RefundRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RefundRequest_tenantId_requestKey_key"
  ON "RefundRequest"("tenantId", "requestKey");
CREATE INDEX "RefundRequest_tenantId_status_submittedAt_idx"
  ON "RefundRequest"("tenantId", "status", "submittedAt");
CREATE INDEX "RefundRequest_tenantId_bookingId_createdAt_idx"
  ON "RefundRequest"("tenantId", "bookingId", "createdAt");
CREATE INDEX "RefundRequest_tenantId_leadId_createdAt_idx"
  ON "RefundRequest"("tenantId", "leadId", "createdAt");
CREATE UNIQUE INDEX "Receipt_tenantId_transactionId_key"
  ON "Receipt"("tenantId", "transactionId");

ALTER TABLE "RefundRequest"
  ADD CONSTRAINT "RefundRequest_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RefundRequest"
  ADD CONSTRAINT "RefundRequest_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RefundRequest"
  ADD CONSTRAINT "RefundRequest_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RefundRequest"
  ADD CONSTRAINT "RefundRequest_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RefundRequest"
  ADD CONSTRAINT "RefundRequest_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
