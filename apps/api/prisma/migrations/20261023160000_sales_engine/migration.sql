-- Sales engine. SaleItem.lineNo has no default: no sales exist before this
-- migration (the sales API is introduced with it).

-- DropIndex
DROP INDEX "SaleItem_saleId_idx";

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "requestHash" TEXT;

-- AlterTable
ALTER TABLE "SaleItem" ADD COLUMN     "lineNo" INTEGER NOT NULL;

-- CreateTable
CREATE TABLE "ReceiptCounter" (
    "day" DATE NOT NULL,
    "lastNumber" INTEGER NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ReceiptCounter_pkey" PRIMARY KEY ("day")
);

-- CreateIndex
CREATE UNIQUE INDEX "SaleItem_saleId_lineNo_key" ON "SaleItem"("saleId", "lineNo");


-- ─── Hand-written CHECK constraints (not expressible in schema.prisma) ───────

ALTER TABLE "ReceiptCounter" ADD CONSTRAINT "ReceiptCounter_lastNumber_check" CHECK ("lastNumber" > 0);
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_lineNo_check" CHECK ("lineNo" > 0);

-- Rule 6: stored totals must add up, so a bug in the pricing code can't save a
-- sale whose lines and totals disagree. No tax is charged yet, but the column
-- is included so the identity stays true when it is.
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_totals_check"
  CHECK ("grandTotal" = "subtotal" - "discountTotal" + "taxTotal");
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_lineTotal_check"
  CHECK ("lineTotal" = "quantity" * "unitPrice" - "discount" + "tax");
