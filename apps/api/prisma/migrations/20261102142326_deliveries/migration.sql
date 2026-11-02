-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "Delivery" (
    "id" UUID NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "supplierId" UUID NOT NULL,
    "invoiceNumber" TEXT,
    "requestedById" UUID NOT NULL,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMPTZ(3),
    "rejectionReason" TEXT,
    "correctedById" UUID,
    "correctedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryItem" (
    "id" UUID NOT NULL,
    "deliveryId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "medicineId" UUID,
    "newName" TEXT,
    "newGenericName" TEXT,
    "newBarcode" TEXT,
    "newCategoryId" UUID,
    "newUnit" TEXT,
    "newReorderLevel" INTEGER,
    "newSellingPrice" DECIMAL(12,2),
    "batchNumber" TEXT NOT NULL,
    "expiryDate" DATE NOT NULL,
    "costPrice" DECIMAL(12,2) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "batchId" UUID,

    CONSTRAINT "DeliveryItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Delivery_status_createdAt_idx" ON "Delivery"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Delivery_requestedById_createdAt_idx" ON "Delivery"("requestedById", "createdAt");

-- CreateIndex
CREATE INDEX "Delivery_supplierId_idx" ON "Delivery"("supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryItem_batchId_key" ON "DeliveryItem"("batchId");

-- CreateIndex
CREATE INDEX "DeliveryItem_medicineId_idx" ON "DeliveryItem"("medicineId");

-- CreateIndex
CREATE INDEX "DeliveryItem_newCategoryId_idx" ON "DeliveryItem"("newCategoryId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryItem_deliveryId_lineNo_key" ON "DeliveryItem"("deliveryId", "lineNo");

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_correctedById_fkey" FOREIGN KEY ("correctedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryItem" ADD CONSTRAINT "DeliveryItem_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "Delivery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryItem" ADD CONSTRAINT "DeliveryItem_medicineId_fkey" FOREIGN KEY ("medicineId") REFERENCES "Medicine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryItem" ADD CONSTRAINT "DeliveryItem_newCategoryId_fkey" FOREIGN KEY ("newCategoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryItem" ADD CONSTRAINT "DeliveryItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written checks (Prisma can't express them).
ALTER TABLE "DeliveryItem" ADD CONSTRAINT "DeliveryItem_quantity_check" CHECK ("quantity" > 0);
ALTER TABLE "DeliveryItem" ADD CONSTRAINT "DeliveryItem_costPrice_check" CHECK ("costPrice" >= 0);
ALTER TABLE "DeliveryItem" ADD CONSTRAINT "DeliveryItem_lineNo_check" CHECK ("lineNo" > 0);
-- A line names a catalogue medicine or fully proposes a new one.
ALTER TABLE "DeliveryItem" ADD CONSTRAINT "DeliveryItem_medicine_check" CHECK (
  "medicineId" IS NOT NULL
  OR ("newName" IS NOT NULL AND "newCategoryId" IS NOT NULL AND "newUnit" IS NOT NULL
      AND "newReorderLevel" IS NOT NULL AND "newSellingPrice" IS NOT NULL)
);
-- A received line always points at its medicine.
ALTER TABLE "DeliveryItem" ADD CONSTRAINT "DeliveryItem_batch_check" CHECK ("batchId" IS NULL OR "medicineId" IS NOT NULL);
-- Reviewed exactly when no longer pending; a rejection has its reason.
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_review_check" CHECK (
  ("status" = 'PENDING') = ("reviewedById" IS NULL AND "reviewedAt" IS NULL)
  AND (("status" = 'REJECTED') = ("rejectionReason" IS NOT NULL))
);
