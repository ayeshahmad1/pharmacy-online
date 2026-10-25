import { createApp } from './app';
import { startJobs } from './jobs';
import { config } from './lib/config';
import { flushErrorReports, initErrorReporting, reportError } from './lib/error-reporting';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';

/** PM2 waits kill_timeout (10 s) after SIGINT; finish well inside that. */
const SHUTDOWN_GRACE_MS = 8000;

await initErrorReporting();

const server = createApp().listen(config.PORT, config.HOST, () => {
  logger.info(
    { host: config.HOST, port: config.PORT, env: config.NODE_ENV, release: config.APP_RELEASE },
    'API listening',
  );
  // Tells PM2 (wait_ready) the new process can take traffic.
  process.send?.('ready');
});
// Nginx keeps upstream connections open for up to 60 s; Node must not close
// them first, or a request racing the close gets a 502.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
// A slow or stuck client may not hold a connection forever.
server.requestTimeout = 30_000;

const jobs = startJobs();

let shuttingDown = false;
function shutdown(signal: string, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');

  // In-flight requests (a sale mid-transaction) get time to finish.
  setTimeout(() => {
    logger.error('Graceful shutdown timed out; exiting');
    process.exit(exitCode || 1);
  }, SHUTDOWN_GRACE_MS).unref();

  void jobs.stop();
  server.close(() => {
    void Promise.all([prisma.$disconnect(), flushErrorReports()]).finally(() =>
      process.exit(exitCode),
    );
  });
  server.closeIdleConnections();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// A bug that escaped every handler. The process may be in a bad state, so it
// reports, then exits and lets PM2 start a clean one.
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  reportError(err, { source: 'process' });
  shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  reportError(reason, { source: 'process' });
  shutdown('unhandledRejection', 1);
});
