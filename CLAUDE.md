# Pharmacy POS System

Web-based Pharmacy POS for a single pharmacy (multi-branch ready). Handles billing, medicine inventory with batches and expiry, returns, reports, and an admin dashboard. Must keep working at the counter even when the internet drops.

## Stack (do not change without asking)

- Monorepo: pnpm workspaces
  - `apps/web`: React + Vite + TypeScript, Tailwind, shadcn/ui, TanStack Query, React Router, vite-plugin-pwa, Recharts
  - `apps/api`: Node.js + Express + TypeScript, Prisma, PostgreSQL, Zod, JWT (access + refresh), bcrypt, node-cron, pino logger
  - `packages/shared`: Zod schemas and shared types used by both apps
- Tests: Vitest (+ Supertest for the API)
- Deployment target: Ubuntu VPS, Nginx reverse proxy, Let's Encrypt HTTPS, PM2

## Folder structure

```
apps/
  api/
    prisma/schema.prisma
    src/
      modules/<name>/ (routes, controller, service, schema)
      middleware/ (auth, roles, error handler, validate)
      lib/ (prisma client, logger, config)
      jobs/ (cron: alerts, backups)
      server.ts
  web/
    src/
      pages/ components/ features/<name>/ lib/ offline/
packages/shared/src/ (zod schemas, types, constants)
```

## Hard business rules (never violate)

1. **FEFO**: sales deduct stock from the batch with the **earliest expiry first**. A sale spanning several batches creates one sale line per batch.
2. **No expired stock is ever sold.** Expired batches are excluded from sale and flagged in reports.
3. **No negative stock.** A sale that exceeds available non-expired stock is rejected.
4. **All stock-changing operations run inside a single database transaction** (sale, return, purchase receipt, adjustment). Either everything is saved or nothing.
5. **Stock is never edited directly.** Every change is a row in `StockMovement` (type: PURCHASE, SALE, RETURN, ADJUSTMENT, EXPIRED_WRITEOFF) with user and timestamp. Current stock = sum of movements per batch.
6. **Money** uses `Decimal(12,2)` in Postgres and string/decimal handling in code. Never use JS floats for money. Currency is PKR.
7. **Sales and returns are never hard-deleted.** Use status fields (COMPLETED, VOIDED, REFUNDED) and keep the audit trail.
8. **Every write action is recorded in `AuditLog`** (who, what, entity, before/after where relevant).
9. **Roles**: ADMIN (everything), PHARMACIST (inventory, sales, returns, reports), CASHIER (billing and own sales only). Enforce on the **server**, never only in the UI.
10. Medicines have: name, generic/salt name, barcode, category, unit, reorder level, selling price. Batches have: batch number, expiry date, cost price, quantity received, supplier.
11. **Sales** (decided in Session 5):
    - Prices always come from the catalogue (`Medicine.sellingPrice`); the client never sends a price. No tax is charged.
    - Discounts: per line and per bill, as a PKR amount or a percent. The bill discount is spread over the lines by value and each batch line stores its share, so refunds are exact. Cashiers may give at most `CASHIER_MAX_DISCOUNT_PERCENT` (default 10%) of the subtotal in total; pharmacist/admin are not capped.
    - Payments: CASH, CARD, MOBILE_WALLET, split allowed. Change is only given from cash (one cash entry per sale); card/wallet together may not exceed the total.
    - Receipt numbers: `S-YYYYMMDD-NNNN`, restarting each business day (pharmacy timezone), gap-free.
    - Every sale carries a client-generated idempotency key (UUID). A repeat returns the original sale (200, `replayed: true`); the same key with a different cart or user is rejected (409 `IDEMPOTENCY_KEY_REUSED`).
    - Void: ADMIN/PHARMACIST only, any time, reason required. Stock goes back to the original batches as RETURN movements linked to the sale item. Not allowed once anything has been returned against the sale, or while a return is pending.
12. **Returns** (decided in Session 6):
    - A return is against one sale and names sale lines (batches) and quantities; reason required. Any role may raise one against any sale. A CASHIER's return is `PENDING` until an ADMIN/PHARMACIST approves (`COMPLETED`) or rejects it (`REJECTED`, reason required); an ADMIN/PHARMACIST's return completes at once. Cashiers only read the returns they raised.
    - A line can never take back more than sold minus units on PENDING and COMPLETED returns (pending requests hold their units). Return numbers: `R-YYYYMMDD-NNNN`, gap-free per business day.
    - Refunds are computed by the server: the line's paid total pro rata, rounded down, and the return taking a line's last units gets the remainder, so a fully returned line refunds exactly what was paid.
    - Refunds go back only by methods the sale was paid with, each capped by what was paid that way minus earlier (pending or completed) refunds. Staff may give the split; otherwise cash first, then card, then wallet.
    - On completion, restockable units go back to the sale line's batch as RETURN movements linked to the return item. Damaged units (`restock: false`) and units whose batch has expired get no movement. A sale whose every unit is back becomes `REFUNDED`.

## Architecture rules

- The browser/client **only talks to the API over HTTPS**. Never connect a client directly to the database.
- Validate every request body, query, and param with Zod schemas from `packages/shared`.
- Controllers stay thin; business logic lives in services; services are unit-tested.
- Consistent API error shape: `{ error: { code, message, details? } }`.
- Never log passwords, tokens, or secrets. Secrets come from environment variables only; commit `.env.example`, never `.env`.
- Add database indexes for barcode, medicine name search, batch expiry, and sale date.
- Auth: short-lived JWT access token (Bearer header, kept in memory by the client) + opaque refresh token in an httpOnly `SameSite=Strict` cookie scoped to `/api/auth`, stored hashed in `RefreshToken` and rotated on every refresh (replaying a rotated token revokes the family). `authenticate` re-reads the user's status and role from the DB on each request. Protect routes with `authenticate` + `requireRole(...)`.
- Write audit entries with `writeAudit(tx, ...)` inside the same transaction as the change.
- API tests run against the `pharmacy_pos_test` database (wiped per test), never the dev database.

## Frontend rules

- The billing screen must be **keyboard-first**: autofocus on barcode/search, Enter to add, shortcuts for pay/hold/clear. Medicine search must feel instant.
- Billing must keep working offline: queue completed sales in IndexedDB and sync when back online, with idempotency keys so a sale is never saved twice.
- Large touch-friendly controls, clear empty/loading/error states, dark mode support.
- All API calls go through `apps/web/src/lib/api.ts` (relative `/api`, same origin; Vite proxies in dev). Never store the access token in `localStorage`/`sessionStorage`. A network failure must never log the user out; only a rejected refresh does.
- Role-based menu items live in `src/lib/navigation.ts`; route guards in `src/router.tsx` must use the same role lists.
- The service worker uses `registerType: 'prompt'`: updates are offered, never applied mid-sale. It precaches the app shell only; offline data belongs in IndexedDB (`src/offline/`).
- Forms validate with the shared Zod schemas via `parseForm` (`src/lib/form.ts`); map API errors back onto fields with `serverFieldErrors`. Money stays a string in forms and requests; display and arithmetic go through `src/lib/money.ts` (BigInt paisa).
- Billing (`src/features/billing/`): cart, pricing preview, payment settlement and API-error mapping are pure, unit-tested modules; the preview must mirror the API's `priceSale`/`settlePayments` exactly. The search box keeps focus between actions and typed characters are redirected to it. Each bill keeps one idempotency key for its whole life (edits, holds, retries); only a completed or cleared bill gets a new one. Held bills and the in-progress cart live in IndexedDB (`src/offline/`); the offline sale queue comes in Session 10.
- List screens keep search, filters and page in the URL (`useListParams`) and render through `ListView` (skeleton, error with retry, no-matches, empty). Expiry/stock warning levels come from `src/lib/stock-status.ts` so every screen agrees.

## Commands

- `pnpm install`
- `pnpm dev` (runs api + web)
- `pnpm --filter api prisma migrate dev`
- `pnpm test` (all tests), `pnpm lint`, `pnpm typecheck`

## Workflow rules for Claude

- Work on **one session goal at a time** (see SESSIONS.md). Do not build things from later sessions.
- Before coding a session: restate the plan briefly, then implement.
- After coding: run typecheck, lint, and tests, fix failures, then summarize what changed and what to test manually.
- Write tests for all stock, billing, and returns logic.
- If a business rule is unclear, **ask** instead of guessing.
- Small, focused commits with clear messages after each working step.
- Keep this file updated if a decision changes the stack or rules.

## Definition of done (every session)

- Typecheck, lint, and tests pass
- New logic has tests where it touches stock, money, or permissions
- No secrets committed, `.env.example` updated if new variables were added
- Short summary of what was built and how to verify it manually
