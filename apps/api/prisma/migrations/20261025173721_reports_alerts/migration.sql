-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('OUT_OF_STOCK', 'LOW_STOCK', 'EXPIRING_SOON', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('WARNING', 'CRITICAL');

-- CreateTable
CREATE TABLE "Alert" (
    "id" UUID NOT NULL,
    "type" "AlertType" NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "openKey" TEXT,
    "medicineId" UUID NOT NULL,
    "batchId" UUID,
    "message" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "acknowledgedAt" TIMESTAMPTZ(3),
    "acknowledgedById" UUID,
    "resolvedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Alert_openKey_key" ON "Alert"("openKey");

-- CreateIndex
CREATE INDEX "Alert_resolvedAt_acknowledgedAt_idx" ON "Alert"("resolvedAt", "acknowledgedAt");

-- CreateIndex
CREATE INDEX "Alert_createdAt_idx" ON "Alert"("createdAt");

-- CreateIndex
CREATE INDEX "Alert_medicineId_idx" ON "Alert"("medicineId");

-- CreateIndex
CREATE INDEX "Alert_batchId_idx" ON "Alert"("batchId");

-- CreateIndex
CREATE INDEX "Sale_voidedAt_idx" ON "Sale"("voidedAt");

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_medicineId_fkey" FOREIGN KEY ("medicineId") REFERENCES "Medicine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Hand-written CHECK constraints (not expressible in schema.prisma) ───────
-- An unresolved alert holds its condition's key; a resolved one gives it up,
-- so the same condition can raise a new alert later.
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_open_key_check"
  CHECK (("resolvedAt" IS NULL) = ("openKey" IS NOT NULL));
-- Expiry alerts are about a batch; stock alerts are about the medicine as a whole.
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_batch_check"
  CHECK (("type" IN ('EXPIRING_SOON', 'EXPIRED')) = ("batchId" IS NOT NULL));
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_acknowledged_check"
  CHECK (("acknowledgedAt" IS NULL) = ("acknowledgedById" IS NULL));
