import { createApp } from './app';
import { startJobs } from './jobs';
import { config } from './lib/config';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';

const server = createApp().listen(config.PORT, () => {
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'API listening');
});
const jobs = startJobs();

function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down');
  void jobs.stop();
  server.close(() => {
    void prisma.$disconnect().finally(() => process.exit(0));
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
