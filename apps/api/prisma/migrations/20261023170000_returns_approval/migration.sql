-- Returns with approval. No returns exist before this migration (the returns
-- API is introduced with it), so Return columns can be replaced outright.

-- ReturnStatus gains PENDING and REJECTED. Recreated rather than ALTER TYPE
-- ... ADD VALUE, because a value added that way can't be used (as the new
-- column default) in the same transaction. The void CHECK compares status to
-- an enum literal, so it is dropped around the swap and re-added unchanged.
ALTER TABLE "Return" DROP CONSTRAINT "Return_void_check";
ALTER TYPE "ReturnStatus" RENAME TO "ReturnStatus_old";
CREATE TYPE "ReturnStatus" AS ENUM ('PENDING', 'COMPLETED', 'REJECTED', 'VOIDED');
ALTER TABLE "Return" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Return" ALTER COLUMN "status" TYPE "ReturnStatus" USING ("status"::text::"ReturnStatus");
ALTER TABLE "Return" ALTER COLUMN "status" SET DEFAULT 'PENDING';
DROP TYPE "ReturnStatus_old";
ALTER TABLE "Return" ADD CONSTRAINT "Return_void_check"
  CHECK ("status" <> 'VOIDED' OR ("voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL));

-- DropForeignKey
ALTER TABLE "Return" DROP CONSTRAINT "Return_processedById_fkey";

-- DropIndex
DROP INDEX "Return_processedById_idx";

-- ReceiptCounter becomes per series; existing rows are sale receipts.
ALTER TABLE "ReceiptCounter" DROP CONSTRAINT "ReceiptCounter_pkey",
ADD COLUMN     "series" TEXT NOT NULL DEFAULT 'S',
ADD CONSTRAINT "ReceiptCounter_pkey" PRIMARY KEY ("series", "day");
ALTER TABLE "ReceiptCounter" ALTER COLUMN "series" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Return" DROP COLUMN "processedById",
DROP COLUMN "refundMethod",
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "requestedById" UUID NOT NULL,
ADD COLUMN     "reviewedAt" TIMESTAMPTZ(3),
ADD COLUMN     "reviewedById" UUID;

-- AlterTable
ALTER TABLE "ReturnItem" ADD COLUMN     "restock" BOOLEAN NOT NULL;

-- CreateTable
CREATE TABLE "ReturnRefund" (
    "id" UUID NOT NULL,
    "returnId" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reference" TEXT,

    CONSTRAINT "ReturnRefund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReturnRefund_method_idx" ON "ReturnRefund"("method");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnRefund_returnId_method_key" ON "ReturnRefund"("returnId", "method");

-- CreateIndex
CREATE INDEX "Return_requestedById_createdAt_idx" ON "Return"("requestedById", "createdAt");

-- CreateIndex
CREATE INDEX "Return_status_createdAt_idx" ON "Return"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Return_reviewedAt_idx" ON "Return"("reviewedAt");

-- AddForeignKey
ALTER TABLE "Return" ADD CONSTRAINT "Return_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Return" ADD CONSTRAINT "Return_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRefund" ADD CONSTRAINT "ReturnRefund_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "Return"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Hand-written CHECK constraints (not expressible in schema.prisma) ───────

ALTER TABLE "ReceiptCounter" ADD CONSTRAINT "ReceiptCounter_series_check" CHECK ("series" IN ('S', 'R'));

-- Rule 6: a refund row moves real money, so it is never zero or negative.
ALTER TABLE "ReturnRefund" ADD CONSTRAINT "ReturnRefund_amount_check" CHECK ("amount" > 0);

-- Rule 8: a decided return records who decided and when; only a rejection
-- carries a rejection reason.
ALTER TABLE "Return" ADD CONSTRAINT "Return_review_check" CHECK (
  ("status" = 'PENDING' AND "reviewedAt" IS NULL AND "reviewedById" IS NULL)
  OR ("status" <> 'PENDING' AND "reviewedAt" IS NOT NULL AND "reviewedById" IS NOT NULL)
);
ALTER TABLE "Return" ADD CONSTRAINT "Return_rejection_check"
  CHECK (("status" = 'REJECTED') = ("rejectionReason" IS NOT NULL));

-- Rule 5: stock coming back from a customer says where it came from — the
-- sale line (a void) or the return line.
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_return_source_check"
  CHECK ("type" <> 'RETURN' OR "saleItemId" IS NOT NULL OR "returnItemId" IS NOT NULL);
