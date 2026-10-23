-- Hand-written guards on the stock ledger (Prisma can't express triggers).
-- Services check and lock first and give friendly errors; these are the last
-- line of defence for CLAUDE.md rules 3 and 5.

-- Rule 3: a batch's stock (sum of its movements) may never go below zero.
-- Only stock-removing rows need checking. The batch row lock serialises
-- concurrent removals from the same batch, and since each statement in a
-- READ COMMITTED function takes a fresh snapshot, the SUM after the lock sees
-- everything committed by whoever held it before. FOR NO KEY UPDATE (not FOR
-- UPDATE) so it doesn't conflict with the FK's KEY SHARE lock taken by other
-- inserts on the same batch, which would deadlock.
CREATE FUNCTION "stock_movement_check_balance"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  balance integer;
BEGIN
  IF NEW."quantity" >= 0 THEN
    RETURN NULL;
  END IF;

  PERFORM 1 FROM "Batch" WHERE "id" = NEW."batchId" FOR NO KEY UPDATE;
  SELECT COALESCE(SUM("quantity"), 0) INTO balance
    FROM "StockMovement" WHERE "batchId" = NEW."batchId";

  IF balance < 0 THEN
    RAISE EXCEPTION 'Stock of batch % would become negative (%)', NEW."batchId", balance
      USING ERRCODE = 'check_violation', CONSTRAINT = 'StockMovement_non_negative_balance';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "StockMovement_non_negative_balance"
  AFTER INSERT ON "StockMovement"
  FOR EACH ROW EXECUTE FUNCTION "stock_movement_check_balance"();

-- Rule 5: the ledger is append-only. Mistakes are corrected with a new
-- ADJUSTMENT row, never by editing or deleting history. (TRUNCATE, used only
-- by the test suite's reset, does not fire row triggers.)
CREATE FUNCTION "stock_movement_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'StockMovement rows cannot be updated or deleted'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "StockMovement_append_only"
  BEFORE UPDATE OR DELETE ON "StockMovement"
  FOR EACH ROW EXECUTE FUNCTION "stock_movement_append_only"();
