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
- **Roles:** cashiers land on Billing and see only Billing, My sales and Returns. Pharmacists see
  everything except Users. The menu lives in `apps/web/src/lib/navigation.ts`, and route guards in
  `src/router.tsx` use the same role lists. The API enforces the real rules.
- **PWA:** `pnpm --filter web build` emits a manifest and a Workbox service worker that precaches
  the app shell (never API responses). New versions are offered with a "Reload" toast rather than
  applied silently, so a cart is never lost mid-sale. The service worker is not registered under
  `vite dev`; use `pnpm --filter web build && pnpm --filter web preview` to try it.
- **UI:** shadcn/ui components live in `src/components/ui` (add more with `pnpm dlx shadcn@latest add
<name>` from `apps/web`). Theme (light/dark/system) is stored in `localStorage`.

## Tests

API integration tests run against a separate database, `pharmacy_pos_test`, on the Docker Postgres
(override with `TEST_DATABASE_URL`). It is created and migrated automatically and **wiped before every
test**; the suite refuses to run against a database whose name does not end in `_test`.

Web tests (`pnpm --filter web test`) are plain Vitest unit tests with a mocked `fetch`; they need no
server.
