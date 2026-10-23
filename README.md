# Pharmacy POS

pnpm monorepo: `apps/api` (Express + Prisma), `apps/web` (React + Vite), `packages/shared` (shared types/constants).
Rules and stack: see [CLAUDE.md](CLAUDE.md). Build plan: [SESSIONS.md](SESSIONS.md).

## Local setup

Requires Node 22+, pnpm 10 (`corepack enable` picks up the version pinned in `package.json`) and Docker.

```bash
pnpm install
cp apps/api/.env.example apps/api/.env      # then set SEED_ADMIN_PASSWORD
docker compose up -d                        # Postgres 17 on localhost:5433
pnpm --filter api prisma migrate dev        # apply migrations
pnpm --filter api db:seed                   # roles, admin user, sample medicines/batches
```

Postgres is exposed on **5433** (not 5432) so it does not clash with a locally installed Postgres.
Override with `POSTGRES_PORT` and update `DATABASE_URL` to match.

## Scripts

| Command                             | What it does                                    |
| ----------------------------------- | ----------------------------------------------- |
| `pnpm dev`                          | Runs every app that has a `dev` script          |
| `pnpm typecheck`                    | `tsc` in every package                          |
| `pnpm lint`                         | ESLint (type-aware) over the repo               |
| `pnpm format` / `pnpm format:check` | Prettier                                        |
| `pnpm test`                         | Tests in every package (none yet)               |
| `pnpm --filter api db:studio`       | Prisma Studio to browse the database            |
| `pnpm --filter api db:reset`        | Drop, re-migrate and re-seed the local database |
