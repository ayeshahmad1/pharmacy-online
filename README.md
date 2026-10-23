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

| Endpoint                             | Who      | Notes                                                     |
| ------------------------------------ | -------- | --------------------------------------------------------- |
| `POST /api/auth/login`               | anyone   | `{ username, password }` → access token + user            |
| `POST /api/auth/refresh`             | cookie   | Rotates the refresh cookie, returns a new access token    |
| `POST /api/auth/logout`              | cookie   | Revokes the refresh token, clears the cookie              |
| `GET /api/auth/me`                   | any user | Current user                                              |
| `GET/POST /api/users`                | ADMIN    | List (`q`, `role`, `status`, `page`, `pageSize`) / create |
| `GET/PATCH /api/users/:id`           | ADMIN    | Get / update name, email, role                            |
| `POST /api/users/:id/deactivate`     | ADMIN    | Also revokes the user's sessions                          |
| `POST /api/users/:id/activate`       | ADMIN    |                                                           |
| `POST /api/users/:id/reset-password` | ADMIN    | `{ newPassword }`; revokes the user's sessions            |

Send the access token as `Authorization: Bearer <token>`. The refresh token is an httpOnly cookie
(`pharmacy_rt`, path `/api/auth`), so the browser sends it automatically to refresh/logout.

## Tests

API integration tests run against a separate database, `pharmacy_pos_test`, on the Docker Postgres
(override with `TEST_DATABASE_URL`). It is created and migrated automatically and **wiped before every
test**; the suite refuses to run against a database whose name does not end in `_test`.
