-- CreateEnum
CREATE TYPE "OfflineConflictStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- CreateTable
CREATE TABLE "OfflineSaleConflict" (
    "id" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "cashierId" UUID NOT NULL,
    "request" JSONB NOT NULL,
    "soldAt" TIMESTAMPTZ(3) NOT NULL,
    "expectedTotal" DECIMAL(12,2) NOT NULL,
    "status" "OfflineConflictStatus" NOT NULL DEFAULT 'OPEN',
    "errorCode" TEXT NOT NULL,
    "errorMessage" TEXT NOT NULL,
    "errorDetails" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "lastAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "saleId" UUID,
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMPTZ(3),
    "dismissReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OfflineSaleConflict_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OfflineSaleConflict_idempotencyKey_key" ON "OfflineSaleConflict"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "OfflineSaleConflict_saleId_key" ON "OfflineSaleConflict"("saleId");

-- CreateIndex
CREATE INDEX "OfflineSaleConflict_status_createdAt_idx" ON "OfflineSaleConflict"("status", "createdAt");

-- CreateIndex
CREATE INDEX "OfflineSaleConflict_cashierId_createdAt_idx" ON "OfflineSaleConflict"("cashierId", "createdAt");

-- AddForeignKey
ALTER TABLE "OfflineSaleConflict" ADD CONSTRAINT "OfflineSaleConflict_cashierId_fkey" FOREIGN KEY ("cashierId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfflineSaleConflict" ADD CONSTRAINT "OfflineSaleConflict_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfflineSaleConflict" ADD CONSTRAINT "OfflineSaleConflict_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Added by hand (Prisma can't express these): a resolved conflict points at
-- the sale it became and who saved it; a dismissed one says who and why.
ALTER TABLE "OfflineSaleConflict" ADD CONSTRAINT "OfflineSaleConflict_resolution_check" CHECK (
  ("status" = 'OPEN' AND "saleId" IS NULL AND "resolvedAt" IS NULL)
  OR ("status" = 'RESOLVED' AND "saleId" IS NOT NULL AND "resolvedById" IS NOT NULL AND "resolvedAt" IS NOT NULL)
  OR ("status" = 'DISMISSED' AND "saleId" IS NULL AND "resolvedById" IS NOT NULL AND "resolvedAt" IS NOT NULL AND "dismissReason" IS NOT NULL)
);
ALTER TABLE "OfflineSaleConflict" ADD CONSTRAINT "OfflineSaleConflict_amounts_check" CHECK (
  "expectedTotal" >= 0 AND "attempts" >= 1
);
