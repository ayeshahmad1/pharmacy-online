// PM2 process file for production. deploy/scripts/deploy.sh starts or reloads
// it after switching the `current` symlink to a new release:
//
//   pm2 startOrReload /opt/pharmacy-pos/current/ecosystem.config.cjs --update-env
//
// One process in fork mode: the API's rate-limit counters live in memory, and
// a single pharmacy's traffic is far below what one Node process serves. The
// alerts job's advisory lock would still keep extra instances from clashing.

const fs = require('node:fs');
const path = require('node:path');

const APP_ROOT = process.env.APP_ROOT || '/opt/pharmacy-pos';
const LOG_DIR = process.env.LOG_DIR || '/var/log/pharmacy-pos';

// deploy.sh writes the deployed commit here; /api/health and Sentry report it.
const revisionFile = path.join(__dirname, 'REVISION');
const release = fs.existsSync(revisionFile)
  ? fs.readFileSync(revisionFile, 'utf8').trim()
  : undefined;

module.exports = {
  apps: [
    {
      name: 'pharmacy-pos-api',
      // Through the symlink, so a reload always runs the release `current` points at.
      cwd: path.join(APP_ROOT, 'current/apps/api'),
      script: 'dist/server.js',
      // Secrets come from the env file (mode 600), never from this file.
      node_args: ['--enable-source-maps', `--env-file=${path.join(APP_ROOT, 'shared/api.env')}`],
      exec_mode: 'fork',
      instances: 1,
      env: {
        NODE_ENV: 'production',
        ...(release && { APP_RELEASE: release }),
      },
      // The server calls process.send('ready') once it is listening.
      wait_ready: true,
      listen_timeout: 15000,
      // SIGINT, then this long for in-flight sales to finish (the server gives up at 8 s).
      kill_timeout: 10000,
      max_memory_restart: '512M',
      exp_backoff_restart_delay: 200,
      out_file: path.join(LOG_DIR, 'api.out.log'),
      error_file: path.join(LOG_DIR, 'api.err.log'),
      merge_logs: true,
    },
  ],
};
