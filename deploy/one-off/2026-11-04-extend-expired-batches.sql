-- One-off correction (2026-11-04): batches imported from the old MongoDB system
-- kept old expiry dates because new deliveries there were entered without one.
-- Moves every expired batch that still has stock (active medicines only) to
-- 2027-02-28, with one AuditLog row per batch (before/after), in one transaction.
--
-- Preview (shows the batches, saves nothing):
--   sudo -u postgres psql -d pharmacy_pos -v ON_ERROR_STOP=1 < ~/extend-expired-batches.sql
-- Apply:
--   sudo -u postgres psql -d pharmacy_pos -v ON_ERROR_STOP=1 -v confirm=1 < ~/extend-expired-batches.sql

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "User" WHERE username = 'ayeshahmad') THEN
    RAISE EXCEPTION 'User ayeshahmad not found: nothing changed';
  END IF;
END $$;

-- Expired = expiry on or before today in the pharmacy's timezone (isExpiredOn).
CREATE TEMP TABLE fix ON COMMIT DROP AS
SELECT b.id, m.name, b."batchNumber", b."expiryDate" AS old_expiry, SUM(sm.quantity) AS stock
FROM "Batch" b
JOIN "Medicine" m ON m.id = b."medicineId"
JOIN "StockMovement" sm ON sm."batchId" = b.id
WHERE m.status = 'ACTIVE'
  AND b."expiryDate" <= (now() AT TIME ZONE 'Asia/Karachi')::date
GROUP BY b.id, m.name, b."batchNumber", b."expiryDate"
HAVING SUM(sm.quantity) > 0;

SELECT name AS medicine, "batchNumber" AS batch, old_expiry, DATE '2027-02-28' AS new_expiry, stock
FROM fix ORDER BY old_expiry, name;

UPDATE "Batch" b
SET "expiryDate" = DATE '2027-02-28', "updatedAt" = now()
FROM fix
WHERE b.id = fix.id;

INSERT INTO "AuditLog" (id, "userId", action, "entityType", "entityId", before, after)
SELECT gen_random_uuid(),
       (SELECT id FROM "User" WHERE username = 'ayeshahmad'),
       'BATCH_EXPIRY_CORRECT',
       'Batch',
       fix.id::text,
       jsonb_build_object('expiryDate', fix.old_expiry::text, 'batchNumber', fix."batchNumber", 'medicine', fix.name),
       jsonb_build_object('expiryDate', '2027-02-28',
                          'reason', 'Imported from the old system without the new batch expiry date')
FROM fix;

SELECT count(*) AS batches_extended FROM fix;

\if :{?confirm}
COMMIT;
\echo 'SAVED: expiry dates changed.'
\else
ROLLBACK;
\echo 'PREVIEW ONLY: nothing was saved. Run again with -v confirm=1 to apply.'
\endif
