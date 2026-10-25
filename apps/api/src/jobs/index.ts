import type { ScheduledTask } from 'node-cron';
import { startAlertsJob } from './alerts.job';

/**
 * Starts the background jobs. Called by server.ts only, never by createApp,
 * so tests drive the jobs' work directly instead of waiting on a schedule.
 */
export function startJobs() {
  const tasks = [startAlertsJob()].filter((t): t is ScheduledTask => t !== null);
  return {
    stop: () => Promise.all(tasks.map((t) => Promise.resolve(t.stop()))),
  };
}
