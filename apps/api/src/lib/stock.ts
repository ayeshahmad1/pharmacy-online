// Stock ledger primitives shared by every stock-changing module (inventory
// now, sales and returns later). Stock is never stored: a batch's quantity is
// always SUM(StockMovement.quantity) for that batch (CLAUDE.md rule 5).

import { Prisma, type PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Locks the given batch rows until the transaction ends, in id order so two
 * transactions locking overlapping sets can't deadlock. Call this before
 * reading a balance you are about to reduce, so a concurrent sale or
 * adjustment can't spend the same units. Uses the same lock mode as the
 * balance trigger. Returns the ids that exist.
 */
export async function lockBatches(tx: Prisma.TransactionClient, batchIds: string[]) {
  if (batchIds.length === 0) return new Set<string>();
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Batch"
    WHERE "id" = ANY(${batchIds}::uuid[])
    ORDER BY "id"
    FOR NO KEY UPDATE`;
  return new Set(rows.map((r) => r.id));
}

/** Current quantity of each batch. Batches with no movements are 0. */
export async function batchQuantities(db: Db, batchIds: string[]): Promise<Map<string, number>> {
  const quantities = new Map(batchIds.map((id) => [id, 0]));
  if (batchIds.length === 0) return quantities;
  const sums = await db.stockMovement.groupBy({
    by: ['batchId'],
    where: { batchId: { in: batchIds } },
    _sum: { quantity: true },
  });
  for (const s of sums) quantities.set(s.batchId, s._sum.quantity ?? 0);
  return quantities;
}

/**
 * SQL for a batch's current quantity, for use inside raw queries where `b`
 * is the Batch alias. Served by the (batchId, createdAt) index.
 */
export const batchQuantitySql = Prisma.sql`(
  SELECT COALESCE(SUM(sm."quantity"), 0)::int FROM "StockMovement" sm WHERE sm."batchId" = b."id"
)`;

/**
 * Per-medicine stock totals for a lateral join on a Medicine row aliased `m`:
 * `sellable` (not expired on `today`), `expired` (still on the shelf) and
 * `nextExpiry` (earliest sellable batch with stock).
 */
export function medicineStockTotalsSql(today: string) {
  return Prisma.sql`
    SELECT
      COALESCE(SUM(bs."qty") FILTER (WHERE bs."expiryDate" > ${today}::date), 0)::int AS "sellable",
      COALESCE(SUM(bs."qty") FILTER (WHERE bs."expiryDate" <= ${today}::date), 0)::int AS "expired",
      MIN(bs."expiryDate") FILTER (WHERE bs."expiryDate" > ${today}::date AND bs."qty" > 0) AS "nextExpiry"
    FROM (
      SELECT b."expiryDate", ${batchQuantitySql} AS "qty"
      FROM "Batch" b WHERE b."medicineId" = m."id"
    ) bs`;
}
