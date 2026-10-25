# Pharmacy POS

pnpm monorepo: `apps/api` (Express + Prisma), `apps/web` (React + Vite), `packages/shared` (shared types/constants).
Rules and stack: see [CLAUDE.md](CLAUDE.md). Build plan: [SESSIONS.md](SESSIONS.md).

## Local setup

Requires Node 22+, pnpm 10 (`corepack enable` picks up the version pinned in `package.json`) and Docker.

```bash
pnpm install
cp apps/api/.env.example apps/api/.env      # then set SEED_ADMIN_PASSWORD and JWT_ACCESS_SECRET
docker compose up -d                        # Postgres 17 on localhost:5433
pnpm --filter api prisma migrate dev        # apply migrations
pnpm --filter api db:seed                   # roles, admin user, sample medicines/batches
```

Postgres is exposed on **5433** (not 5432) so it does not clash with a locally installed Postgres.
Override with `POSTGRES_PORT` and update `DATABASE_URL` to match.

## Scripts

| Command                             | What it does                                       |
| ----------------------------------- | -------------------------------------------------- |
| `pnpm dev`                          | Runs every app that has a `dev` script             |
| `pnpm typecheck`                    | `tsc` in every package                             |
| `pnpm lint`                         | ESLint (type-aware) over the repo                  |
| `pnpm format` / `pnpm format:check` | Prettier                                           |
| `pnpm test`                         | Tests in every package (API needs Docker Postgres) |
| `pnpm --filter api db:studio`       | Prisma Studio to browse the database               |
| `pnpm --filter api db:reset`        | Drop, re-migrate and re-seed the local database    |

## API

`pnpm --filter api dev` starts the API on http://localhost:4000.

| Endpoint                                                    | Who               | Notes                                                                                      |
| ----------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------ |
| `POST /api/auth/login`                                      | anyone            | `{ username, password }` → access token + user                                             |
| `POST /api/auth/refresh`                                    | cookie            | Rotates the refresh cookie, returns a new access token                                     |
| `POST /api/auth/logout`                                     | cookie            | Revokes the refresh token, clears the cookie                                               |
| `GET /api/auth/me`                                          | any user          | Current user                                                                               |
| `GET/POST /api/users`                                       | ADMIN             | List (`q`, `role`, `status`, `page`, `pageSize`) / create                                  |
| `GET/PATCH /api/users/:id`                                  | ADMIN             | Get / update name, email, role                                                             |
| `POST /api/users/:id/deactivate`                            | ADMIN             | Also revokes the user's sessions                                                           |
| `POST /api/users/:id/activate`                              | ADMIN             |                                                                                            |
| `POST /api/users/:id/reset-password`                        | ADMIN             | `{ newPassword }`; revokes the user's sessions                                             |
| `GET /api/medicines`                                        | any user          | Search `q` (name or generic/salt name, ranked), `categoryId`, `status`, `page`, `pageSize` |
| `GET /api/medicines/:id`                                    | any user          |                                                                                            |
| `POST /api/medicines`                                       | ADMIN, PHARMACIST | `sellingPrice` is a decimal string, e.g. `"120.50"`                                        |
| `PATCH /api/medicines/:id`                                  | ADMIN, PHARMACIST | Partial update; send `null`/`""` to clear an optional field                                |
| `GET /api/categories`, `GET /api/suppliers`                 | any user          | `q`, `status`, `page`, `pageSize`                                                          |
| `GET /api/categories/:id`, `GET /api/suppliers/:id`         | any user          |                                                                                            |
| `POST /api/categories`, `POST /api/suppliers`               | ADMIN, PHARMACIST | Names are unique, ignoring case                                                            |
| `PATCH /api/categories/:id`, `PATCH /api/suppliers/:id`     | ADMIN, PHARMACIST |                                                                                            |
| `POST /api/{medicines,categories,suppliers}/:id/deactivate` | ADMIN, PHARMACIST | Soft: the row is kept; there is no DELETE                                                  |
| `POST /api/{medicines,categories,suppliers}/:id/activate`   | ADMIN, PHARMACIST |                                                                                            |

Send the access token as `Authorization: Bearer <token>`. The refresh token is an httpOnly cookie
(`pharmacy_rt`, path `/api/auth`), so the browser sends it automatically to refresh/logout.

## Web app

`pnpm --filter web dev` starts the app on http://localhost:5173. Vite proxies `/api` to the API
(`API_PROXY_TARGET`, default `http://localhost:4000`), so the browser stays same-origin, exactly as
behind Nginx in production. Start the API first.

- **Auth:** the access token is kept in memory only; a reload restores the session from the refresh
  cookie. A 401 triggers one shared refresh and a retry. Refreshes are serialised across tabs with a
  Web Lock, because the server treats a reused refresh token as theft. Logging out in one tab logs out
  the others.
- **Roles:** cashiers land on Billing and see only Billing, My sales, Returns, My offline sales and Alerts. Pharmacists see
  everything except Users. The menu lives in `apps/web/src/lib/navigation.ts`, and route guards in
  `src/router.tsx` use the same role lists. The API enforces the real rules.
- **PWA:** `pnpm --filter web build` emits a manifest and a Workbox service worker that precaches
  the app shell (never API responses). New versions are offered with a "Reload" toast rather than
  applied silently, so a cart is never lost mid-sale. The service worker is not registered under
  `vite dev`; use `pnpm --filter web build && pnpm --filter web preview` to try it.
- **UI:** shadcn/ui components live in `src/components/ui` (add more with `pnpm dlx shadcn@latest add
<name>` from `apps/web`). Theme (light/dark/system) is stored in `localStorage`.
- **Stock screens (admin, pharmacist):** Medicines (list, create/edit, a detail page with batches in
  FEFO order and stock history), Categories, Suppliers, Inventory (all stock, low stock, expiring
  soon, expired with write-off) and Inventory → Receive stock (one delivery, one line per batch).
  Batches are adjusted from the medicine page or the expiring list. Search, filters and page live in
  the URL, so Back and reload keep them.
- **Forms** validate with the shared Zod schemas through `parseForm` (`src/lib/form.ts`), and API
  field errors are mapped back onto the same fields. Money is typed and sent as strings and only
  formatted or multiplied in exact paisa (`src/lib/money.ts`).
- **Billing (every role):** keyboard first. The search box has focus between actions and matches
  brand name, generic/salt name or an exact barcode (a scanner types the code and Enter, which adds
  it at once; `3*` before a scan adds three). Out-of-stock or expired-only medicines open a list of
  in-stock substitutes with the same salt. Shortcuts: F2 search, ↑/↓ select line, +/− quantity, F4
  type quantity, F6 line discount, F7 bill discount, F8 pay, F9 hold, F10 held bills, Del remove
  line, Esc clear. The pay dialog takes cash, card, mobile wallet or a split; change comes only from
  cash. Totals mirror the API's pricing, but the API re-prices every sale and is the authority;
  rejections (short or expired stock, the cashier discount cap) are shown on the line they concern.
  The bill being built and held bills are kept in IndexedDB on the device (`src/offline/`), so a
  reload never loses a cart; prices and stock are re-read on resume. The search uses
  `GET /api/inventory/sellable?q=`, `GET /api/inventory/sellable/:id` and
  `GET /api/inventory/medicines/:id/substitutes`.
- **Offline billing:** the header shows Online/Offline (whether the API answers, probed at
  `GET /api/ping`), how many sales wait to sync and how many were flagged; click it for details and
  "Sync now". While online the device keeps a copy of every active medicine with its batch stock
  (`GET /api/inventory/offline-catalogue`, refreshed every 5 minutes, in IndexedDB). Offline, search
  and substitutes use that copy, with stock reduced by the sales this device has queued (FEFO, expiry
  by the pharmacy's day). Paying offline, or when the server stops answering mid-sale, checks the
  device's stock count and the cashier discount cap, queues the sale under the bill's idempotency key
  and prints a provisional receipt (`OFF-XXXXXXXX`). The queue syncs oldest first on reconnect, after
  each new sale and every 15 s while anything waits, backing off from 5 s to 5 min. The server
  records the counter time as `soldAt` (and that day's receipt number) and refuses a sale whose total
  no longer matches what was charged (`PRICE_CHANGED`). A refused sale is never dropped: it is
  reported to `/api/offline-sales/conflicts` and listed under **Offline sales**, where a pharmacist or
  admin saves it for the original cashier (after fixing stock, approving a discount, or accepting
  today's prices) or dismisses it with a reason. After a reload while offline, the last signed-in
  user (profile only, no token) carries on; the session is confirmed as soon as the server answers.
  Offline sales must reach the server within `OFFLINE_SALE_MAX_AGE_DAYS` (default 7).
- **Receipts:** an 80mm thermal layout printed from the browser (`P` on the sale-complete screen, or
  automatically after each sale if ticked on that device). Set the printer's paper to the 80mm roll.
  Header and footer come from `VITE_PHARMACY_NAME`, `VITE_PHARMACY_ADDRESS`, `VITE_PHARMACY_PHONE`
  and `VITE_RECEIPT_FOOTER` in `apps/web/.env`.
- **Dashboard and reports (admin, pharmacist):** the dashboard shows today against yesterday, the
  month so far, the last 30 days (revenue and gross profit), best sellers, today's payment mix and
  what needs attention. **Reports** has tabs for sales by day/week/month, profit and margin per
  medicine, best sellers, cashiers, the daily cash closing, low stock (with the 30-day sales pace),
  expiry (bucketed and valued), dead stock and supplier purchases. Date ranges and filters live in
  the URL; **Export CSV** downloads every row (`?format=csv` on the same endpoint). Rules: sales count
  on the day they were rung up (offline sales on their counter time), voided sales are left out, a
  refund comes off the day of the original sale, and cost is the batch cost of what sold less units
  returned to the shelf. Cash closing follows the drawer instead: every sale rung up that day, less
  voids and refunds paid back that day. Charts and report pages are code-split, so billing devices
  never download them.
- **Alerts (every role sees them):** the API's alerts job (`ALERTS_CRON`, every 15 minutes and at
  startup) opens an alert per out-of-stock or low-stock medicine and per batch expiring within
  `ALERT_EXPIRY_DAYS` (default 30) or expired with stock on the shelf, and resolves it by itself once
  dealt with. The bell in the header counts unread alerts; a pharmacist or admin marks them seen
  (for everyone) or runs **Check now** on the Alerts page.
- **Warnings:** expiring within 30 days is red, within 90 days amber (`src/lib/stock-status.ts`);
  out of stock is red, at or below the reorder level amber. Expiring soon uses the API's
  `EXPIRY_WARNING_DAYS` window unless another is picked.

## Tests

API integration tests run against a separate database, `pharmacy_pos_test`, on the Docker Postgres
(override with `TEST_DATABASE_URL`). It is created and migrated automatically and **wiped before every
test**; the suite refuses to run against a database whose name does not end in `_test`.

Web tests (`pnpm --filter web test`) are plain Vitest unit tests with a mocked `fetch`; they need no
server.
