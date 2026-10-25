import { type ScheduledTask, schedule } from 'node-cron';
import { config } from '../lib/config';
import { reportError } from '../lib/error-reporting';
import { logger } from '../lib/logger';
import { refreshAlerts } from '../modules/alerts/alerts.service';

const log = logger.child({ job: 'alerts' });

/** One run of the alerts job. Never throws: a failed run is logged and the next one tries again. */
export async function runAlertsJob() {
  const started = Date.now();
  try {
    const result = await refreshAlerts();
    if (!result) {
      log.info('Skipped: another alerts run holds the lock');
      return;
    }
    log.info({ ...result, ms: Date.now() - started }, 'Alerts refreshed');
  } catch (err) {
    log.error({ err }, 'Alerts refresh failed');
    reportError(err, { source: 'job:alerts' });
  }
}

/**
 * Re-checks low stock and expiry on ALERTS_CRON (in the pharmacy's
 * timezone, so a daily schedule fires at local times), and once at startup
 * so alerts are current after a deploy. Returns null when disabled.
 */
export function startAlertsJob(): ScheduledTask | null {
  if (config.ALERTS_CRON === 'off') {
    log.info('Alerts job disabled (ALERTS_CRON=off)');
    return null;
  }
  const task = schedule(config.ALERTS_CRON, runAlertsJob, {
    name: 'alerts',
    timezone: config.BUSINESS_TIMEZONE,
    noOverlap: true,
  });
  void runAlertsJob();
  log.info(
    { cron: config.ALERTS_CRON, timezone: config.BUSINESS_TIMEZONE },
    'Alerts job scheduled',
  );
  return task;
}
