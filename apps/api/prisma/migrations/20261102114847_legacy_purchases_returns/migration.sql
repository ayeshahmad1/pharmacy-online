-- CreateTable
CREATE TABLE "LegacyPurchase" (
    "id" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "totalCost" DECIMAL(12,2),
    "purchasedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegacyPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegacyReturn" (
    "id" UUID NOT NULL,
    "cashierId" UUID NOT NULL,
    "refundTotal" DECIMAL(12,2) NOT NULL,
    "returnedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegacyReturn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegacyReturnItem" (
    "id" UUID NOT NULL,
    "legacyReturnId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "batchId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "discount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "LegacyReturnItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LegacyPurchase_batchId_purchasedAt_idx" ON "LegacyPurchase"("batchId", "purchasedAt");

-- CreateIndex
CREATE INDEX "LegacyPurchase_purchasedAt_idx" ON "LegacyPurchase"("purchasedAt");

-- CreateIndex
CREATE INDEX "LegacyPurchase_supplierId_idx" ON "LegacyPurchase"("supplierId");

-- CreateIndex
CREATE INDEX "LegacyReturn_returnedAt_idx" ON "LegacyReturn"("returnedAt");

-- CreateIndex
CREATE INDEX "LegacyReturn_cashierId_returnedAt_idx" ON "LegacyReturn"("cashierId", "returnedAt");

-- CreateIndex
CREATE INDEX "LegacyReturnItem_batchId_idx" ON "LegacyReturnItem"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "LegacyReturnItem_legacyReturnId_lineNo_key" ON "LegacyReturnItem"("legacyReturnId", "lineNo");

-- AddForeignKey
ALTER TABLE "LegacyPurchase" ADD CONSTRAINT "LegacyPurchase_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegacyPurchase" ADD CONSTRAINT "LegacyPurchase_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegacyReturn" ADD CONSTRAINT "LegacyReturn_cashierId_fkey" FOREIGN KEY ("cashierId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegacyReturnItem" ADD CONSTRAINT "LegacyReturnItem_legacyReturnId_fkey" FOREIGN KEY ("legacyReturnId") REFERENCES "LegacyReturn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegacyReturnItem" ADD CONSTRAINT "LegacyReturnItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Hand-written CHECK constraints (not expressible in schema.prisma) ───────

-- Old-system history (rule 15): whole units and money that adds up, like the
-- sale lines they mirror. A delivery with no recorded price has a NULL cost.
ALTER TABLE "LegacyPurchase" ADD CONSTRAINT "LegacyPurchase_quantity_check" CHECK ("quantity" > 0);
ALTER TABLE "LegacyPurchase" ADD CONSTRAINT "LegacyPurchase_totalCost_check" CHECK ("totalCost" > 0);
ALTER TABLE "LegacyReturn" ADD CONSTRAINT "LegacyReturn_refundTotal_check" CHECK ("refundTotal" >= 0);
ALTER TABLE "LegacyReturnItem" ADD CONSTRAINT "LegacyReturnItem_lineNo_check" CHECK ("lineNo" > 0);
ALTER TABLE "LegacyReturnItem" ADD CONSTRAINT "LegacyReturnItem_quantity_check" CHECK ("quantity" > 0);
ALTER TABLE "LegacyReturnItem" ADD CONSTRAINT "LegacyReturnItem_money_check" CHECK (
  "unitPrice" >= 0 AND "discount" >= 0 AND "lineTotal" = "quantity" * "unitPrice" - "discount"
);
