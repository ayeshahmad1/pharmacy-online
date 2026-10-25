import type { Request } from 'express';
import { config } from './config';
import { logger } from './logger';

/**
 * Where unexpected errors go besides the log: 5xx responses, failed jobs and
 * process-level crashes. Nothing is sent anywhere until a reporter is
 * installed; `initErrorReporting` installs Sentry when SENTRY_DSN is set.
 */
export type ErrorReporter = {
  capture(err: unknown, context: ErrorContext): void;
  /** Waits (at most timeoutMs) for queued reports to be sent, e.g. before exiting. */
  flush(timeoutMs: number): Promise<void>;
};

/** Never request bodies, headers or query strings: they can hold passwords and tokens. */
export type ErrorContext = {
  /** Where it happened: "http", "job:alerts", "process". */
  source: string;
  requestId?: string;
  userId?: string;
  role?: string;
  method?: string;
  /** The URL path without the query string (search terms stay out of reports). */
  path?: string;
};

let reporter: ErrorReporter | null = null;

export function setErrorReporter(next: ErrorReporter | null) {
  reporter = next;
}

export function reportError(err: unknown, context: ErrorContext): void {
  if (!reporter) return;
  try {
    reporter.capture(err, context);
  } catch (reportErr) {
    // Reporting must never turn one failure into two.
    logger.warn({ err: reportErr }, 'Error reporter failed');
  }
}

export async function flushErrorReports(timeoutMs = 2000): Promise<void> {
  await reporter?.flush(timeoutMs).catch(() => undefined);
}

/**
 * What an error report may say about the request it happened in. Called from
 * the error handler, so it must not throw even on a half-built request.
 */
export function requestContext(req: Request): Omit<ErrorContext, 'source'> {
  const url: unknown = req.originalUrl;
  return {
    requestId: typeof req.id === 'string' ? req.id : undefined,
    userId: req.user?.id,
    role: req.user?.role,
    method: req.method,
    path: typeof url === 'string' ? url.split('?')[0] : undefined,
  };
}

/**
 * Installs Sentry as the reporter when SENTRY_DSN is set. The SDK is loaded
 * only then, so it costs nothing otherwise. Only errors are sent (no tracing),
 * without IP addresses, headers, cookies, bodies or local variables.
 */
export async function initErrorReporting(): Promise<void> {
  if (!config.SENTRY_DSN) return;

  const Sentry = await import('@sentry/node');
  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.SENTRY_ENVIRONMENT ?? config.NODE_ENV,
    release: config.APP_RELEASE,
    // Nothing from the request or the stack's local variables: they can hold
    // passwords, tokens and customer data. The scope below adds what's safe.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
    },
    beforeSend(event) {
      if (event.request) {
        delete event.request.cookies;
        delete event.request.data;
        delete event.request.query_string;
        if (event.request.headers) {
          delete event.request.headers.authorization;
          delete event.request.headers.cookie;
        }
      }
      return event;
    },
  });

  setErrorReporter({
    capture(err, { source, requestId, userId, role, method, path }) {
      Sentry.withScope((scope) => {
        scope.setTag('source', source);
        if (requestId) scope.setTag('request_id', requestId);
        if (role) scope.setTag('role', role);
        if (userId) scope.setUser({ id: userId });
        if (method || path) scope.setContext('request', { method, path });
        Sentry.captureException(err);
      });
    },
    async flush(timeoutMs) {
      await Sentry.flush(timeoutMs);
    },
  });
  logger.info({ environment: config.SENTRY_ENVIRONMENT ?? config.NODE_ENV }, 'Sentry enabled');
}
