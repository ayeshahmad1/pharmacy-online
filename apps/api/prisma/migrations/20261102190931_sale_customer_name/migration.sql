-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "customerName" VARCHAR(100);

-- CreateIndex
CREATE INDEX "Sale_customerName_trgm_idx" ON "Sale" USING GIN ("customerName" gin_trgm_ops);
