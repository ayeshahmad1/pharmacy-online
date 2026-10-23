import { pino } from 'pino';
import { config } from './config';

export const logger = pino({
  level: config.NODE_ENV === 'test' ? 'silent' : config.LOG_LEVEL,
  // Never log credentials or tokens (CLAUDE.md). Bodies are not logged by
  // pino-http, but services may log objects that contain these fields.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.newPassword',
      '*.passwordHash',
      '*.accessToken',
      '*.refreshToken',
      '*.token',
    ],
    censor: '[REDACTED]',
  },
  ...(config.NODE_ENV === 'development' && {
    transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } },
  }),
});
