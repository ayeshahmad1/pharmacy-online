import type { Prisma } from '@prisma/client';

/** Number prefixes: "S" sale receipts, "R" returns. */
export type DocumentSeries = 'S' | 'R';

/**
 * Next document number of the series for the business day, e.g.
 * S-20261023-0001. The upsert locks the day's counter row until commit, so
 * concurrent transactions get distinct numbers, and one that rolls back gives
 * its number back (gap-free).
 */
export async function nextDocumentNumber(
  tx: Prisma.TransactionClient,
  series: DocumentSeries,
  today: string,
): Promise<string> {
  const [row] = await tx.$queryRaw<[{ lastNumber: number }]>`
    INSERT INTO "ReceiptCounter" ("series", "day", "lastNumber", "updatedAt")
    VALUES (${series}, ${today}::date, 1, now())
    ON CONFLICT ("series", "day") DO UPDATE
      SET "lastNumber" = "ReceiptCounter"."lastNumber" + 1, "updatedAt" = now()
    RETURNING "lastNumber"`;
  return `${series}-${today.replace(/-/g, '')}-${String(row.lastNumber).padStart(4, '0')}`;
}
