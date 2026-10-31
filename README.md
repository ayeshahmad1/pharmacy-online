# Pharmacy POS

Point of sale and inventory for a pharmacy counter: billing (works offline), medicine batches with
FEFO and expiry, returns, reports and alerts. pnpm monorepo:

| Package           | What it is                                                         |
| ----------------- | ------------------------------------------------------------------ |
| `apps/api`        | Express + Prisma + PostgreSQL API                                  |
| `apps/web`        | React + Vite PWA, served as static files                           |
| `packages/shared` | Zod schemas and types used by both                                 |
| `deploy/`         | Nginx, cron and logrotate config; deploy, rollback, backup scripts |

Business rules and coding conventions: [CLAUDE.md](CLAUDE.md). What each screen and endpoint does:
[docs/REFERENCE.md](docs/REFERENCE.md). Build plan: [SESSIONS.md](SESSIONS.md).

**Contents:** [Local development](#local-development) · [Configuration](#configuration) ·
[Production deployment](#production-deployment-ubuntu-vps) · [Updates and rollback](#updates-and-rollback) ·
[Backups and restore](#backups-and-restore) · [Runbook](#runbook) · [Security](#security) · [Tests](#tests)

```
 Tills (browser/PWA)                       Ubuntu VPS
 ┌──────────────────┐  HTTPS   ┌───────────────────────────────────────────────┐
 │ web app          │ ───────► │ Nginx :443  ── static files (current release) │
 │ IndexedDB queue  │          │      │ /api                                   │
 │ (offline sales)  │          │      ▼                                        │
 └──────────────────┘          │ API (PM2) 127.0.0.1:4000 ──► PostgreSQL :5432 │
                               │                    cron ──► pg_dump ──► rclone ──► off-site storage
                               └───────────────────────────────────────────────┘
```

## Local development

Requires Node 22+, pnpm 10 (`corepack enable` picks up the version pinned in `package.json`) and
Docker.

```bash
pnpm install
cp apps/api/.env.example apps/api/.env      # then set SEED_ADMIN_PASSWORD and JWT_ACCESS_SECRET
cp apps/web/.env.example apps/web/.env      # receipt header/footer
docker compose up -d                        # Postgres 17 on localhost:5433
pnpm --filter api prisma migrate dev        # apply migrations
pnpm --filter api db:seed                   # roles, admin user, sample medicines/batches
pnpm dev                                    # API on :4000, web app on http://localhost:5173
```

Postgres is exposed on **5433** (not 5432) so it does not clash with a locally installed Postgres.
Override with `POSTGRES_PORT` and update `DATABASE_URL` to match. Vite proxies `/api` to the API, so
the browser stays on one origin exactly as behind Nginx in production.

| Command                             | What it does                                       |
| ----------------------------------- | -------------------------------------------------- |
| `pnpm dev`                          | API (`tsx watch`) and web app (Vite) together      |
| `pnpm typecheck`                    | `tsc` in every package                             |
| `pnpm lint`                         | ESLint (type-aware) over the repo                  |
| `pnpm format` / `pnpm format:check` | Prettier                                           |
| `pnpm test`                         | Tests in every package (API needs Docker Postgres) |
| `pnpm --filter api build`           | Bundles the API to `apps/api/dist/server.js`       |
| `pnpm --filter web build`           | Builds the PWA to `apps/web/dist`                  |
| `pnpm --filter api db:studio`       | Prisma Studio to browse the database               |
| `pnpm --filter api db:reset`        | Drop, re-migrate and re-seed the local database    |

## Configuration

Secrets live only in environment files that are never committed: `apps/api/.env` in development,
`/opt/pharmacy-pos/shared/*.env` (mode 600) in production. Templates: `apps/api/.env.example`,
`apps/web/.env.example`, `deploy/backup.env.example`. The API validates its environment at start-up
and refuses to run with a bad value, printing the variable names (never the values).

### API (`apps/api/.env`, production: `shared/api.env`)

| Variable                          | Default              | Notes                                                                                                                     |
| --------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                        | `development`        | `production` on the server: secure cookies, strict checks, no sample data in the seed                                     |
| `DATABASE_URL`                    | (required)           | `postgresql://user:password@localhost:5432/pharmacy_pos?schema=public`                                                    |
| `PORT` / `HOST`                   | `4000` / `127.0.0.1` | Keep loopback: only Nginx on the same machine talks to the API                                                            |
| `LOG_LEVEL`                       | `info`               | Pino JSON logs; authorization headers, cookies, passwords and tokens are redacted                                         |
| `JWT_ACCESS_SECRET`               | (required)           | ≥ 32 characters, random. Production refuses the example value                                                             |
| `JWT_ACCESS_TTL_SECONDS`          | `900`                | Access token lifetime, 60–3600                                                                                            |
| `REFRESH_TOKEN_TTL_DAYS`          | `7`                  | Sign-in lifetime, 1–30; renewed on every refresh                                                                          |
| `COOKIE_SECURE`                   | `true` in production | Refresh cookie HTTPS-only (`__Secure-pharmacy_rt`). `false` is refused in production                                      |
| `BCRYPT_ROUNDS`                   | `12`                 | Password hashing cost                                                                                                     |
| `TRUST_PROXY`                     | `loopback`           | Which proxies may set `X-Forwarded-*`; decides client IPs for rate limits and the audit log                               |
| `CORS_ORIGINS`                    | (empty)              | Extra browser origins allowed to call the API, comma-separated. Normally empty                                            |
| `RATE_LIMIT_ENABLED`              | `true`               | The API's own limits (Nginx has more in front)                                                                            |
| `RATE_LIMIT_API_PER_MINUTE`       | `600`                | Requests per client IP per minute. All tills share the pharmacy's public IP                                               |
| `RATE_LIMIT_LOGIN_ATTEMPTS`       | `10`                 | Failed sign-ins per username+IP per window (5× per IP across usernames). Successes don't count                            |
| `RATE_LIMIT_LOGIN_WINDOW_MINUTES` | `15`                 |                                                                                                                           |
| `SENTRY_DSN`                      | (unset)              | Send unexpected errors to Sentry. Unset: errors are only logged                                                           |
| `SENTRY_ENVIRONMENT`              | `NODE_ENV`           |                                                                                                                           |
| `APP_RELEASE`                     | (set by PM2)         | Deployed commit, from the release's `REVISION` file; shown by `/api/health`                                               |
| `BUSINESS_TIMEZONE`               | `Asia/Karachi`       | Decides "today" for expiry, receipt numbers and reports                                                                   |
| `EXPIRY_WARNING_DAYS`             | `90`                 | Default window of the expiring-soon list                                                                                  |
| `CASHIER_MAX_DISCOUNT_PERCENT`    | `10`                 | Largest bill discount a cashier may give                                                                                  |
| `OFFLINE_SALE_MAX_AGE_DAYS`       | `7`                  | Older offline sales are flagged for review instead of saved                                                               |
| `ALERTS_CRON`                     | `*/15 * * * *`       | Alerts job schedule (pharmacy timezone), also runs at start-up; `off` disables                                            |
| `ALERT_EXPIRY_DAYS`               | `30`                 | Batches expiring within this raise an alert                                                                               |
| `DEAD_STOCK_DAYS`                 | `60`                 | Dead-stock report window                                                                                                  |
| `SEED_ADMIN_USERNAME`             | (seed only)          | First admin account created by `db:seed`                                                                                  |
| `SEED_ADMIN_PASSWORD`             | (seed only)          | Give it only for the seed run (see below); production refuses the placeholder                                             |
| `TEST_DATABASE_URL`               | (dev only)           | Test database; its name must end in `_test`                                                                               |
| `MONGO_URL` / `MONGO_DB`          | (migration only)     | Old MongoDB system, read by `migrate:mongo` (see [Migrating from the old system](#migrating-from-the-old-mongodb-system)) |

### Web app (`apps/web/.env`, production: `shared/web.env`)

Built into the public JavaScript bundle at build time, so **nothing secret** goes here.

| Variable                                       | Notes                                  |
| ---------------------------------------------- | -------------------------------------- |
| `VITE_PHARMACY_NAME`                           | Printed at the top of the 80mm receipt |
| `VITE_PHARMACY_ADDRESS`, `VITE_PHARMACY_PHONE` | Receipt header lines                   |
| `VITE_RECEIPT_FOOTER`                          | Receipt footer                         |
| `API_PROXY_TARGET`                             | Dev only: where Vite proxies `/api`    |

### Backups (`shared/backup.env`)

| Variable                       | Default                     | Notes                                                                    |
| ------------------------------ | --------------------------- | ------------------------------------------------------------------------ |
| `BACKUP_DIR`                   | `/var/backups/pharmacy-pos` | Local dumps, in `daily/`, `pre-deploy/`, `manual/`                       |
| `BACKUP_RETENTION_DAYS`        | `14`                        | Local daily/manual dumps older than this are deleted                     |
| `BACKUP_PRE_DEPLOY_KEEP`       | `10`                        | Pre-deploy dumps kept (by count)                                         |
| `BACKUP_REMOTE`                | (empty = local only)        | rclone `remote:path` (S3, B2, Google Drive, SFTP, …)                     |
| `BACKUP_REMOTE_RETENTION_DAYS` | `90`                        | Off-site copies older than this are deleted                              |
| `BACKUP_GPG_PASSPHRASE_FILE`   | (empty = no encryption)     | Encrypt off-site copies (AES-256). Keep a copy of the key off the server |
| `BACKUP_HEALTHCHECK_URL`       | (empty)                     | Dead-man's switch pinged by the daily backup (e.g. healthchecks.io)      |

## Production deployment (Ubuntu VPS)

Tested layout: Ubuntu 24.04 LTS, 2 vCPU, **2 GB RAM or more** (the web build needs ~1 GB), 25 GB
disk. You need a domain name (below `pos.example.com`) whose DNS **A/AAAA record points at the VPS**
before step 8. Commands run as a sudo-capable admin user unless they start with `sudo -iu pharmacy`.

Layout on the server:

```
/opt/pharmacy-pos/
  repo/                     git clone, only used to fetch and export releases
  releases/<stamp>-<sha>/   one directory per deploy (last 5 kept)
  current -> releases/…     what Nginx serves and PM2 runs
  shared/api.env            API secrets and settings          (mode 600)
  shared/web.env            receipt header/footer             (mode 600)
  shared/backup.env         backup settings                   (mode 600)
/var/backups/pharmacy-pos/  database dumps
/var/log/pharmacy-pos/      API logs (PM2) and backup log
```

### 0. Order the server and secure the login (Contabo)

Any provider with a plain Ubuntu 24.04 VM works. These are the choices on Contabo, whose Cloud VPS
10 (4 vCPU, 8 GB RAM) is plenty for one pharmacy. Turn off any VPN while signing up and use the
card holder's real name and address; Contabo may ask for ID before it provisions the server.

| Order option   | Choose                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------- |
| Product        | Cloud VPS 10                                                                                      |
| Term           | 12 months (lower price, usually no setup fee) or monthly                                          |
| Region         | European Union (Germany), no surcharge; Singapore or India if their surcharge is fine             |
| Storage        | NVMe (75 GB), not the larger, slower SSD option                                                   |
| Image          | Ubuntu 24.04, plain OS: no cPanel, Plesk, Webmin or app images                                    |
| Login          | A long generated root password, kept in a password manager; your SSH key if offered               |
| Object Storage | No: off-site backups go to a different provider (step 7)                                          |
| Auto Backup    | Optional: restores the whole server in minutes. The data is safe in the off-site dumps either way |

The provisioning email gives the server's IP. Log in once as root with the password, create the
admin user that runs every later step, and leave:

```bash
ssh root@SERVER_IP
adduser yourname && usermod -aG sudo yourname
hostnamectl set-hostname pharmacy-pos
exit
```

On your computer, make an SSH key if you have none (`ssh-keygen -t ed25519`, with a passphrase)
and copy it to the new user. From Windows PowerShell (Linux/macOS: `ssh-copy-id yourname@SERVER_IP`):

```powershell
Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub | ssh yourname@SERVER_IP "mkdir -p -m 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

Check in a new terminal that `ssh yourname@SERVER_IP` gets in with the key and `sudo whoami` prints
`root`. Then turn off root and password logins. Provider images often switch password login on in
`/etc/ssh/sshd_config.d/`, and sshd keeps the first value it reads, so the setting goes in a file
that sorts first:

```bash
printf 'PermitRootLogin no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n' \
  | sudo tee /etc/ssh/sshd_config.d/00-hardening.conf
sudo sshd -t && sudo systemctl restart ssh
```

Keep that session open until a fresh `ssh yourname@SERVER_IP` works.

Point the domain at the server now, so DNS has spread by step 8: an A record for `pos.example.com`
to the server's IPv4, plus an AAAA record if `ip -6 addr show scope global` shows an address. On
Cloudflare set both to **DNS only** (grey cloud): through Cloudflare's proxy every request would
come from Cloudflare's addresses, and the per-IP rate limits would treat all users as one.

### 1. Base system and firewall

```bash
sudo apt update && sudo apt -y upgrade
sudo timedatectl set-timezone Asia/Karachi          # cron times (02:30 backup) are local
sudo apt install -y git curl gnupg nginx certbot rclone ufw unattended-upgrades
sudo dpkg-reconfigure -f noninteractive unattended-upgrades   # automatic security updates

# Firewall: only SSH (rate-limited) and HTTP/HTTPS. The API (4000) and Postgres (5432) listen on
# 127.0.0.1 only and are never opened.
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw limit OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status verbose
```

Root and password logins should already be off (step 0). If the provider has its own firewall in
its control panel, allow only TCP 22, 80 and 443 there too. With less than 4 GB of RAM add swap so
builds cannot run out of memory (not needed on the 8 GB Contabo plan):
`sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab`.

### 2. Node.js 22, pnpm and PM2

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
sudo bash /tmp/nodesource_setup.sh
sudo apt install -y nodejs
sudo corepack enable                # provides pnpm at the version pinned in package.json
sudo npm install -g pm2
node --version                      # v22.x
```

### 3. PostgreSQL 17

```bash
sudo apt install -y postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
sudo apt install -y postgresql-17
openssl rand -hex 24                 # copy this: the database password
sudo -u postgres createuser --pwprompt pharmacy      # paste the password twice
sudo -u postgres createdb --owner=pharmacy pharmacy_pos
```

Postgres listens on localhost only by default; keep it that way.

### 4. App user, directories and code

```bash
sudo adduser --system --group --shell /bin/bash --home /home/pharmacy pharmacy
sudo mkdir -p /opt/pharmacy-pos/releases /opt/pharmacy-pos/shared \
  /var/backups/pharmacy-pos /var/log/pharmacy-pos /var/www/letsencrypt
sudo chown -R pharmacy:pharmacy /opt/pharmacy-pos /var/backups/pharmacy-pos /var/log/pharmacy-pos
sudo chmod 700 /opt/pharmacy-pos/shared /var/backups/pharmacy-pos
```

Give the server read-only access to the repository with a deploy key:

```bash
sudo -iu pharmacy bash -c 'mkdir -p -m 700 ~/.ssh && ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 -C pharmacy-pos-deploy'
sudo cat /home/pharmacy/.ssh/id_ed25519.pub
# GitHub → repository → Settings → Deploy keys → Add (read-only), paste the key.
sudo -iu pharmacy git clone git@github.com:ayeshahmad1/pharmacy-online.git /opt/pharmacy-pos/repo
```

### 5. Configure

```bash
sudo -iu pharmacy
cd /opt/pharmacy-pos
cp repo/deploy/backup.env.example shared/backup.env
cp repo/apps/web/.env.example shared/web.env
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # JWT secret
nano shared/api.env
```

`shared/api.env` needs at least (see [Configuration](#configuration) for the rest):

```bash
NODE_ENV=production
DATABASE_URL="postgresql://pharmacy:<db password>@localhost:5432/pharmacy_pos?schema=public"
JWT_ACCESS_SECRET="<the random string from above>"
BUSINESS_TIMEZONE="Asia/Karachi"
SEED_ADMIN_USERNAME="admin"
SEED_ADMIN_FULL_NAME="Pharmacy Owner"
```

Then set the receipt lines in `shared/web.env`, lock the files down and leave the pharmacy shell:

```bash
chmod 600 shared/*.env
exit
```

### 6. First deploy

```bash
sudo -iu pharmacy /opt/pharmacy-pos/repo/deploy/scripts/deploy.sh main
```

This installs dependencies, builds the web app and the API, runs the database migrations, points
`current` at the release and starts the API under PM2, then waits for `/api/health/ready`. Then
create the first admin (the password is typed, so it stays out of files and shell history):

```bash
sudo -iu pharmacy
cd /opt/pharmacy-pos/current
read -rsp 'Password for the first admin: ' SEED_ADMIN_PASSWORD; echo; export SEED_ADMIN_PASSWORD
pnpm --filter api db:seed            # roles + admin; never sample data in production
unset SEED_ADMIN_PASSWORD
pm2 save
exit
```

**Migrating from the old MongoDB system?** Don't seed: the migration only loads into an empty
database and brings the old admins with their passwords. Run just `sudo -iu pharmacy pm2 save`,
finish the steps below, then load the data as in [Into production](#into-production).

Start PM2 at boot (it prints a command; it is the same as this):

```bash
sudo env PATH="$PATH:/usr/bin" pm2 startup systemd -u pharmacy --hp /home/pharmacy
```

### 7. Logs, rotation and backups

```bash
sudo cp /opt/pharmacy-pos/current/deploy/logrotate/pharmacy-pos /etc/logrotate.d/pharmacy-pos
sudo cp /opt/pharmacy-pos/current/deploy/cron/pharmacy-pos /etc/cron.d/pharmacy-pos
sudo chmod 644 /etc/cron.d/pharmacy-pos /etc/logrotate.d/pharmacy-pos
```

Off-site copies (strongly recommended; a backup on the same VPS dies with it):

```bash
sudo -iu pharmacy
rclone config                        # create a remote, e.g. "offsite" (S3/B2/Drive/SFTP)
openssl rand -base64 48 > /opt/pharmacy-pos/shared/backup.key && chmod 600 /opt/pharmacy-pos/shared/backup.key
cat /opt/pharmacy-pos/shared/backup.key   # store this in a password manager, NOT only on the VPS
nano /opt/pharmacy-pos/shared/backup.env  # BACKUP_REMOTE=offsite:pharmacy-pos-backups
                                          # BACKUP_GPG_PASSPHRASE_FILE=/opt/pharmacy-pos/shared/backup.key
/opt/pharmacy-pos/current/deploy/scripts/backup-db.sh manual   # must end with "Done"
exit
```

With **Backblaze B2**: create a private bucket (e.g. `pharmacy-pos-backups`) and an application key
limited to that bucket, and in the bucket's Lifecycle Settings choose **Keep only the last version**
(otherwise files the script deletes are only hidden, and still billed). In `rclone config` pick the
storage type **Backblaze B2**, name the remote `offsite`, and paste the keyID as `account` and the
application key as `key`. The manual backup above should then show up in the bucket.

### 8. Nginx and HTTPS (Let's Encrypt)

```bash
DOMAIN=pos.example.com
EMAIL=you@example.com
SRC=/opt/pharmacy-pos/current/deploy/nginx
sudo rm -f /etc/nginx/sites-enabled/default

# a) HTTP-only site to answer the certificate challenge
sudo cp $SRC/pharmacy-pos-bootstrap.conf /etc/nginx/sites-available/pharmacy-pos
sudo sed -i "s/pos\.example\.com/$DOMAIN/g" /etc/nginx/sites-available/pharmacy-pos
sudo ln -sfn /etc/nginx/sites-available/pharmacy-pos /etc/nginx/sites-enabled/pharmacy-pos
sudo nginx -t && sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/letsencrypt -d "$DOMAIN" \
  --email "$EMAIL" --agree-tos --no-eff-email

# b) the real site: HTTPS, security headers, /api proxy, rate limits
sudo cp $SRC/snippets/pharmacy-pos-*.conf /etc/nginx/snippets/
sudo cp $SRC/pharmacy-pos.conf /etc/nginx/sites-available/pharmacy-pos
sudo sed -i "s/pos\.example\.com/$DOMAIN/g" /etc/nginx/sites-available/pharmacy-pos
sudo nginx -t && sudo systemctl reload nginx

# c) reload Nginx whenever certbot's timer renews the certificate
printf '#!/bin/sh\nsystemctl reload nginx\n' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
sudo certbot renew --dry-run
```

### 9. Check it

```bash
curl -s https://$DOMAIN/api/health/ready      # {"status":"ok",...,"checks":{"database":"ok"}}
curl -sI https://$DOMAIN | grep -iE 'strict-transport|content-security'
curl -sI http://$DOMAIN | head -1              # 301 to https
sudo ss -tlnp | grep -E ':4000|:5432'          # both on 127.0.0.1 only
sudo -iu pharmacy pm2 status                   # pharmacy-pos-api online
```

Open `https://pos.example.com`, sign in as the admin, create staff accounts under **Users**, then
on each till install the app (browser menu → Install) and sign in once while online so it can cache
the catalogue for offline billing.

### 10. Monitoring and a safety net before go-live

- **Missed backups:** a [healthchecks.io](https://healthchecks.io) check (period 1 day, grace 2
  hours) with its ping URL as `BACKUP_HEALTHCHECK_URL` in `shared/backup.env`.
- **Downtime:** an uptime monitor (e.g. UptimeRobot) on `https://pos.example.com/api/health/ready`
  every 5 minutes. `/api/health*` is never rate-limited.
- **Errors (optional):** `SENTRY_DSN` in `shared/api.env`, then
  `sudo -iu pharmacy pm2 reload pharmacy-pos-api` so the API reads it.

Before the first real sale:

1. Restore one **off-site** backup into a scratch database (see [Backups and restore](#backups-and-restore)),
   to prove that the key and the procedure work.
2. Keep copies of `shared/api.env`, `shared/web.env`, `shared/backup.env` and `shared/backup.key` in
   a password manager. With them and the off-site dumps the system can be rebuilt on any server.
3. Take a snapshot of the finished server in the provider's control panel, and again before big
   changes.

## Updates and rollback

### Deploy an update

Push to `main` (or tag a release), then on the server:

```bash
sudo -iu pharmacy /opt/pharmacy-pos/current/deploy/scripts/deploy.sh main      # or a tag: v1.4.0
```

The script builds the new release beside the running one, takes a **pre-deploy database backup**,
applies migrations, switches `current`, restarts the API (2–3 seconds; tills carry on offline and
sync afterwards) and waits for `/api/health/ready`. If the new release is not healthy within 30
seconds it **switches back to the previous release automatically** and exits with an error. Tills
show an "Update available" prompt and reload only when the cashier chooses, never mid-sale.

Deploy when the counter is quiet. Prefer migrations that only add (new tables, nullable or
defaulted columns) and remove old things in a later release, so the previous code can still run on
the new schema; that keeps every rollback a code-only rollback.

### Roll back

```bash
sudo -iu pharmacy /opt/pharmacy-pos/current/deploy/scripts/rollback.sh             # previous release
sudo -iu pharmacy /opt/pharmacy-pos/current/deploy/scripts/rollback.sh 20261101093000-ab12cd3
ls /opt/pharmacy-pos/releases                                                      # what's available
```

Only code is rolled back. If the release being left applied migrations, the script lists them and
asks first. If the older code cannot work with the newer schema (a column it needs was dropped or
renamed), roll the database back too by restoring the pre-deploy backup **after** rolling back the
code. This loses everything written since that deploy, so first export or note the sales made since:

```bash
ls -t /var/backups/pharmacy-pos/pre-deploy/ | head -3
sudo /opt/pharmacy-pos/current/deploy/scripts/restore-db.sh \
  /var/backups/pharmacy-pos/pre-deploy/pharmacy_pos-pre-deploy-<stamp>.dump pharmacy_pos_restored --swap
```

## Backups and restore

- **Daily** at 02:30 (`/etc/cron.d/pharmacy-pos`), **before every deploy**, and on demand
  (`backup-db.sh manual`). Each is a `pg_dump` custom-format file, checked with `pg_restore --list`,
  with a `.sha256` beside it.
- Local copies in `/var/backups/pharmacy-pos/{daily,pre-deploy,manual}`; daily ones are kept 14 days.
- Off-site copies via rclone to `BACKUP_REMOTE`, encrypted with gpg when
  `BACKUP_GPG_PASSPHRASE_FILE` is set, pruned after 90 days.
- Log: `/var/log/pharmacy-pos/backup.log`. Set `BACKUP_HEALTHCHECK_URL` to be told when a nightly
  backup does not happen.

**Restore** always goes into a new database first; the live one is only replaced with `--swap`:

```bash
# from a local dump
sudo /opt/pharmacy-pos/current/deploy/scripts/restore-db.sh \
  /var/backups/pharmacy-pos/daily/pharmacy_pos-daily-<stamp>.dump pharmacy_pos_check
# from off-site: download the .gpg and its .sha256, then restore (decrypts with backup.env's key)
sudo -iu pharmacy rclone copy offsite:pharmacy-pos-backups/daily/<file>.dump.gpg /tmp/restore/
sudo -iu pharmacy rclone copy offsite:pharmacy-pos-backups/daily/<file>.dump.sha256 /tmp/restore/
sudo /opt/pharmacy-pos/current/deploy/scripts/restore-db.sh /tmp/restore/<file>.dump.gpg pharmacy_pos_check
```

It prints row counts and the last sale time to compare with what you expect. Then either drop the
copy (`sudo -u postgres dropdb pharmacy_pos_check`) or re-run with a new name and `--swap` to make
it live: the API is stopped, the live database is renamed `pharmacy_pos_before_restore_<stamp>` (kept
until you drop it) and the restored one takes its name.

**Rebuilding on a new VPS:** follow the deployment steps 1–8, but before seeding, restore the latest
off-site dump with `--swap` (skip `db:seed`), then deploy again so migrations newer than the dump
are applied.

**Test a restore every month** into a scratch database: a backup that was never restored is a hope,
not a backup.

## Migrating from the old MongoDB system

`pnpm --filter api migrate:mongo` copies the old system's users, medicines, stock and sales into
Postgres. It only reads from Mongo. It is a **dry run by default**: everything is written inside one
transaction, checked against the database's constraints, totalled, and rolled back.

**What is loaded and how** (decided in Session 13):

| Mongo                       | Postgres                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`                     | `User`. Passwords are kept (bcrypt); username = the part of the email before `@`. Roles admin/cashier                                                                           |
| `medicines` (one per batch) | `Medicine` (category "Uncategorised", unit = `type`) + one `Batch`; the Mongo quantity is an opening-stock `ADJUSTMENT`                                                         |
| `purchases`                 | Not rows: they give each batch its cost (latest priced delivery ÷ quantity; 0 when unknown, listed)                                                                             |
| `sales`                     | `Sale` + `SaleItem` + one `CASH` `Payment`, with no stock movements (the opening stock already reflects them). New `S-YYYYMMDD-NNNN` numbers; the old bill number is in `notes` |
| `sales` with `isReturn`     | Not loaded (they name no original sale); logged, and their total is shown in the comparison                                                                                     |
| `billsequences`             | Not copied; receipt counters are rebuilt from the sales                                                                                                                         |

Sales of medicines or by users deleted from Mongo get inactive placeholders ("Deleted item #abc123
(old system)", `legacy-user-abc123`), so no sale is lost. Each loaded row is recorded in `LegacyIdMap`
with its Mongo `_id`. Suppliers that are only numbers ("00") or "Return"/"Discount" become
"Unknown supplier".

**Run it:**

1. Put `MONGO_URL` in `apps/api/.env` (a read-only Atlas user is enough).
2. Point `DATABASE_URL` at an **empty** database with migrations applied and no seed; the script
   refuses a database that already has medicines, sales, suppliers or categories:
   ```bash
   docker exec pharmacy-pos-postgres createdb -U pharmacy pharmacy_pos_migration
   DATABASE_URL="postgresql://pharmacy:pharmacy_dev@localhost:5433/pharmacy_pos_migration?schema=public" pnpm --filter api db:deploy
   ```
3. Dry run, then read the output (also in `migration-output/<run>/`: `verification.txt`,
   `rejects.jsonl`, `warnings.jsonl`, `stock-per-medicine.csv`):
   ```bash
   DATABASE_URL="postgresql://pharmacy:pharmacy_dev@localhost:5433/pharmacy_pos_migration?schema=public" pnpm --filter api migrate:mongo
   ```
   It must show `loaded + rejected = Mongo sales` and every medicine's stock matching. Fix anything
   rejected in the old system and run again.
4. **Cut-over:** stop selling in the old system (receipt numbers and opening stock are taken from
   the data as it is at that moment), run the dry run once more, then the same command with
   `--commit`. Commit mode writes one transaction per batch of 500 (`--batch-size`); if it stops
   part-way, run it again and it skips what is already loaded. Then sign in as one of the old
   admins and set up the categories, barcodes, generic names, reorder levels and missing cost prices.

### Into production

On the server, in place of `db:seed` (deployment step 6). A release's `apps/api/.env` is the live
`shared/api.env`, so the script reads and writes the production database. Don't add medicines or
ring test sales before it: it refuses a database that already has any.

1. In MongoDB Atlas → Network Access, allow the server's IP.
2. Dry run (the URL is typed, so it stays out of files and shell history):
   ```bash
   sudo -iu pharmacy
   cd /opt/pharmacy-pos/current
   read -rsp 'Mongo URL: ' MONGO_URL; echo; export MONGO_URL
   pnpm --filter api migrate:mongo
   ```
3. At cut-over, after the final dry run, the same command with `--commit`. Then copy the output
   out of the release (old releases are deleted after five newer deploys), clear the URL and remove
   the server's IP from Atlas:
   ```bash
   cp -r /opt/pharmacy-pos/current/migration-output ~/
   unset MONGO_URL
   exit
   ```

## Runbook

Commands as the app user start with `sudo -iu pharmacy`. Logs are JSON lines; every API response
carries an `X-Request-Id` header, and the same id is in the log line for that request.

| Check                   | Command                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------- |
| API process             | `sudo -iu pharmacy pm2 status`                                                        |
| API logs (live)         | `sudo -iu pharmacy pm2 logs pharmacy-pos-api --lines 200`                             |
| API and database health | `curl -s localhost:4000/api/health/ready`                                             |
| Which release is live   | `readlink /opt/pharmacy-pos/current` or `curl -s localhost:4000/api/health`           |
| Find one request        | `grep <request-id> /var/log/pharmacy-pos/api.out.log`                                 |
| Nginx                   | `sudo systemctl status nginx`, `sudo tail -f /var/log/nginx/error.log`                |
| Postgres                | `sudo systemctl status postgresql`                                                    |
| Backups                 | `tail -50 /var/log/pharmacy-pos/backup.log`, `ls -lt /var/backups/pharmacy-pos/daily` |
| Disk                    | `df -h /`                                                                             |
| Certificate             | `sudo certbot certificates`                                                           |

**The site shows 502 Bad Gateway.** The API is not answering. `pm2 status`; if errored, read
`pm2 logs pharmacy-pos-api --err --lines 100`. "Invalid environment configuration" names the bad
variable in `shared/api.env`; fix it and `pm2 restart pharmacy-pos-api --update-env`. If it crashed
after a deploy, run `rollback.sh`. Tills keep billing offline meanwhile and sync when it is back.

**`/api/health/ready` says the database is unavailable (503).** `sudo systemctl status postgresql`,
`sudo journalctl -u postgresql@17-main -n 100`; a full disk is the usual cause (`df -h`). Start it
with `sudo systemctl start postgresql`. The API reconnects by itself.

**Disk is filling up.** Usual suspects: `/var/backups/pharmacy-pos` (lower the retention),
`/opt/pharmacy-pos/releases` (deploys keep 5), logs (`sudo journalctl --vacuum-size=200M`). Never
delete files under `/var/lib/postgresql`.

**A staff member is told "Too many failed sign-in attempts".** Ten wrong passwords for one username
from one IP within 15 minutes. Wait for the window, or clear the counters with
`sudo -iu pharmacy pm2 restart pharmacy-pos-api` (counters are in memory). If it happens without
anyone mistyping, someone may be guessing: check `AUTH_LOGIN_FAILED` rows in the audit log.

**Forgotten password.** An admin resets it under **Users** (that also signs the user out
everywhere). If the only admin is locked out, create a second admin with the seed, which only adds
accounts that don't exist yet:

```bash
sudo -iu pharmacy
cd /opt/pharmacy-pos/current
export SEED_ADMIN_USERNAME=rescue-admin
read -rsp 'Password: ' SEED_ADMIN_PASSWORD; echo; export SEED_ADMIN_PASSWORD
pnpm --filter api db:seed && unset SEED_ADMIN_PASSWORD
```

Sign in as `rescue-admin`, reset the original admin's password, then deactivate `rescue-admin`.

**A device is lost or a secret may have leaked.** Deactivate the affected users (revokes their
sessions at once). To sign everyone out: generate a new `JWT_ACCESS_SECRET` in `shared/api.env`,
`pm2 restart pharmacy-pos-api --update-env`, and revoke every refresh token:
`sudo -u postgres psql pharmacy_pos -c 'UPDATE "RefreshToken" SET "revokedAt" = now() WHERE "revokedAt" IS NULL'`.
If the database password leaked, change it (`sudo -u postgres psql -c '\password pharmacy'`) and in
`DATABASE_URL`, then restart.

**Offline sales did not sync.** The header on the till shows how many are waiting and lets you
"Sync now". Sales the server refused are never dropped: a pharmacist or admin saves or dismisses them
under **Offline sales**. A queued sale syncs only when its own cashier is signed in on that till.

**Alerts are not updating.** `pm2 logs pharmacy-pos-api | grep alerts`; "Skipped: another alerts
run holds the lock" is harmless. A pharmacist or admin can run **Check now** on the Alerts page.

**Backup failed.** Read `backup.log`. Common causes: disk full, the rclone remote's credentials
expired (`sudo -iu pharmacy rclone lsd offsite:`), a wrong key path. Run
`backup-db.sh manual` after fixing it.

**Certificate expiring.** certbot's systemd timer renews automatically (`systemctl list-timers |
grep certbot`). Test with `sudo certbot renew --dry-run`; port 80 must stay open for the challenge.

**Server rebooted.** PM2 brings the API back (`pm2 startup` from step 6). Check `pm2 status` and the
health URL. Reboot for kernel updates when the pharmacy is closed: `sudo reboot`.

**Error reporting.** Set `SENTRY_DSN` (and optionally `SENTRY_ENVIRONMENT`) in `shared/api.env`,
then `pm2 restart pharmacy-pos-api --update-env`. 5xx responses, failed alert jobs and crashes are
sent with the request id, route, user id and role, never bodies, headers, cookies or query strings.
The web app has the same hook (`apps/web/src/lib/error-reporting.ts`); wiring it to Sentry is
described there and needs the Sentry host in the CSP.

## Security

What the app does for you:

- **HTTPS only.** HTTP redirects to HTTPS; HSTS; TLS 1.2+; unknown hostnames are dropped.
- **Same origin.** The web app and API share one origin. The API refuses browser requests from any
  other origin (`CORS_ORIGINS` to allow more), and the refresh cookie is `httpOnly`, `Secure`,
  `SameSite=Strict`, `__Secure-` prefixed and limited to `/api/auth`.
- **Tokens.** Access tokens are short-lived JWTs (HS256, issuer and audience checked) held in memory
  only; refresh tokens are random, stored hashed, rotated on every use, and a replayed one revokes
  the whole family. Every request re-reads the user's status and role from the database.
- **Roles enforced by the API** on every route (`requireRole`), and per row in services (a cashier
  sees only their own sales, returns and offline conflicts, and never cost prices).
- **Brute force and abuse.** Failed logins are limited per username and IP and per IP; every API
  request is limited per IP; Nginx adds its own limits in front. Login timing does not reveal whether
  a username exists.
- **Input.** Every body, query and param is validated with Zod (strict objects, bounded lengths and
  list sizes); JSON bodies over 100 kB are refused (413), Nginx caps requests at 1 MB. All SQL goes
  through Prisma or `Prisma.sql` tagged templates, so values are always bound parameters; search
  text is escaped for `LIKE`; CSV exports neutralise spreadsheet formulas.
- **Headers.** API responses: helmet (CSP `default-src 'none'`, nosniff, no framing,
  `Cache-Control: no-store`). Web app: a CSP with no inline or eval'd script, `X-Frame-Options: DENY`,
  `Permissions-Policy`.
- **Secrets** only from env files (mode 600). Production refuses the example JWT secret and insecure
  cookies. Logs redact authorization headers, cookies, passwords and tokens; the audit log strips
  password/token/secret fields. Backups can be encrypted before leaving the server.
- **Network.** The API and Postgres listen on 127.0.0.1; UFW allows only SSH, 80 and 443.

What stays with you: strong, unique staff passwords; one account per person (never shared
logins); deactivating leavers the same day; SSH keys only; installing OS updates; keeping the backup
key somewhere safe off the server; and testing restores.

## Tests

API integration tests run against a separate database, `pharmacy_pos_test`, on the Docker Postgres
(override with `TEST_DATABASE_URL`). It is created and migrated automatically and **wiped before every
test**; the suite refuses to run against a database whose name does not end in `_test`. Rate limits
are off in the suite except in `test/security.test.ts`, which turns them on with small numbers.

Web tests (`pnpm --filter web test`) are plain Vitest unit tests with a mocked `fetch`; they need no
server.
