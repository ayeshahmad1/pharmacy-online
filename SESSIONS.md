# Session-by-Session Build Plan

How to use: start a fresh Claude Code session in the repo root, paste the prompt for the next session, review the result, test it manually, commit, then move on. Do not skip ahead. `CLAUDE.md` gives Claude the rules and stack in every session.

---

## Session 1: Foundation and schema

**Prompt:**
```
Read CLAUDE.md. Set up the pnpm monorepo (apps/api, apps/web, packages/shared) with TypeScript, ESLint, and Prettier. Create the Prisma schema for PostgreSQL covering: User, Role, Medicine, Category, Supplier, Batch, StockMovement, Sale, SaleItem, Payment, Return, ReturnItem, AuditLog. Follow the business rules in CLAUDE.md exactly (batches with expiry, stock via StockMovement, Decimal money, soft status fields). Add indexes for barcode, medicine name, batch expiry and sale date. Add a seed script with an admin user and sample medicines/batches. Add .env.example and a docker-compose for local Postgres. Do not build any endpoints or UI yet. Explain the schema decisions briefly when done.
```
**Done when:** migrations run, seed works, typecheck passes.

---

## Session 2: Auth and roles

**Prompt:**
```
Read CLAUDE.md. Build authentication in apps/api: login, JWT access + refresh tokens, logout, password hashing with bcrypt, and role-based middleware for ADMIN, PHARMACIST, CASHIER. Add user management endpoints (ADMIN only): create, list, update, deactivate users, reset password. Add the AuditLog writer helper and log auth events. Add Zod schemas in packages/shared, a global error handler, request validation middleware, and pino logging. Write Supertest tests for login, token refresh, and role enforcement.
```
**Done when:** a cashier cannot call admin endpoints, tests pass.

---

## Session 3: Medicines, suppliers, categories

**Prompt:**
```
Read CLAUDE.md. Build CRUD APIs for medicines, categories and suppliers with search (by name, generic/salt name, barcode), pagination and filters. Add a fast barcode lookup endpoint. Include reorder level and soft deactivation (no hard deletes). Enforce roles (cashier read-only). Audit-log every write. Add tests for search, barcode lookup, and permissions.
```
**Done when:** search returns results quickly with indexes in place.

---

## Session 4: Inventory, batches, stock movements

**Prompt:**
```
Read CLAUDE.md. Build the inventory module: receive stock (purchase) creating batches with batch number, expiry, cost price and quantity; stock adjustments with reason; expired-stock write-off. Every change must create a StockMovement inside a transaction. Add endpoints for current stock per medicine and per batch (computed from movements), low-stock list, and expiring-soon list (configurable days). Reject invalid input like past-expiry receipts or negative stock. Write thorough tests for stock calculation and rejection cases.
```
**Done when:** stock totals always match the sum of movements.

---

## Session 5: Sales engine (the core)

**Prompt:**
```
Read CLAUDE.md. Build the sales engine in apps/api: create a sale with multiple items, FEFO batch allocation (earliest expiry first, spanning multiple batches when needed), never selling expired stock, rejecting insufficient stock, discounts, tax if configured, multiple payment methods (cash, card, mobile wallet, split payments), change calculation, and receipt number generation. Everything in one transaction. Support an idempotency key so retried requests never create duplicate sales. Add endpoints to get a sale, list sales, and void a sale (ADMIN/PHARMACIST) that restores stock via movements. Write extensive tests: FEFO across batches, expired batches excluded, insufficient stock, concurrency (two sales racing for the last unit), idempotency, voiding.
```
**Done when:** the concurrency and FEFO tests pass.

---

## Session 6: Returns and refunds

**Prompt:**
```
Read CLAUDE.md. Build returns and refunds: return against an original sale (full or partial), validate quantities against what was sold and previous returns, restock to the original batch via StockMovement (with an option to mark returned items as damaged/not restockable), refund by payment method, require reason, and audit-log everything. Permission rules: cashier can request, pharmacist/admin approve (implement a simple approval status). Write tests for partial returns, double-return prevention, and stock effects.
```
**Done when:** a sale cannot be returned more than it was sold.

---

## Session 7: Web app shell and login

**Prompt:**
```
Read CLAUDE.md. Build the apps/web foundation: Vite + React + TypeScript, Tailwind, shadcn/ui, React Router, TanStack Query, an API client with token refresh, login page, protected routes with role-based navigation, app layout with sidebar, dark mode toggle, and toast notifications. Add the PWA setup (manifest, service worker via vite-plugin-pwa) but no offline sales logic yet. Keep it clean and fast.
```
**Done when:** login works end to end against the API, and menu items change by role.

---

## Session 8: Inventory and medicine screens

**Prompt:**
```
Read CLAUDE.md. Build the web screens for medicines (list, search, create/edit), suppliers, categories, receiving stock (purchase entry with batches), stock adjustments, and low-stock/expiring-soon lists with clear visual warnings. Tables need search, filters and pagination. Add form validation using the shared Zod schemas. Handle loading, empty and error states well.
```
**Done when:** you can add a medicine, receive a batch, and see stock update.

---

## Session 9: The billing (POS) screen

**Prompt:**
```
Read CLAUDE.md. Build the POS billing screen, the most important screen. Requirements: keyboard-first, autofocus on barcode/search input, barcode scanner input (scanner types like a keyboard + Enter), instant medicine search with substitutes (same generic/salt) shown when an item is out of stock, cart with quantity editing, line and bill discounts, hold/resume bills, multi-payment and split payment dialog, change calculation, shortcuts (e.g. F2 search, F8 pay, F9 hold, Esc clear), and a printable 80mm thermal receipt layout. Show clear errors for expired or insufficient stock returned from the API. Make it fast and usable on a tablet too.
```
**Done when:** a full sale can be completed with only the keyboard and a scanner.

---

## Session 10: Offline mode and sync

**Prompt:**
```
Read CLAUDE.md. Add offline-first billing: cache the medicine and current-stock data in IndexedDB, let the POS complete sales while offline by queueing them locally with an idempotency key, show a clear online/offline indicator and pending-sync count, and sync the queue automatically when connectivity returns with retry and error handling. Handle conflicts sensibly (e.g. stock no longer available at sync time) by flagging those sales for review instead of dropping them. Write tests for the queue and sync logic.
```
**Done when:** you can turn off the network, make sales, turn it back on, and see them sync once.

---

## Session 11: Reports, dashboard, alerts

**Prompt:**
```
Read CLAUDE.md. Build reports and the admin dashboard: daily/weekly/monthly sales, profit and margin per medicine, best sellers, dead stock, expiry report, low-stock report, supplier purchases, cashier-wise sales, and a daily cash-closing report. Add API endpoints with date filters and efficient queries, then dashboard cards and Recharts charts, with CSV export. Add node-cron jobs that generate low-stock and expiry alerts shown in the app (and a notification badge). Test the calculations.
```
**Done when:** report totals match the raw sales data.

---

## Session 12: Hardening, backups, deployment

**Prompt:**
```
Read CLAUDE.md. Prepare for production: add rate limiting, helmet, strict CORS, input size limits, and secure cookie/token settings; add health-check endpoint; add Sentry-ready error reporting hooks; write a daily pg_dump backup script with retention and upload to external storage (configurable); write deployment docs and config for Ubuntu VPS with Nginx (HTTPS via Let's Encrypt), PM2 ecosystem file, UFW rules, and an update/rollback procedure. Review the whole codebase for security issues (auth, role checks, SQL injection, secrets) and fix what you find. Produce a README with setup, env variables, and runbook.
```
**Done when:** a fresh VPS can be set up following only the README.

---

## Session 13 (optional): Data migration from MongoDB

**Prompt:**
```
Read CLAUDE.md. I have an existing MongoDB database. I will give you sample documents from each collection. Design the mapping to our Postgres schema and write a Node.js migration script that reads from Mongo and loads Postgres in batches inside transactions, parents first, keeps a legacy_id mapping, logs rejected records instead of skipping silently, and prints verification totals (row counts, total sales amount, stock per medicine) for comparison with the source. Run it as a dry run first.
```
**Done when:** verification totals match the old system.

---

## After every session

1. Run `pnpm typecheck && pnpm lint && pnpm test`
2. Test manually in the browser or with Postman
3. Commit with a clear message
4. Update CLAUDE.md if any decision changed
5. Start a fresh session for the next step
