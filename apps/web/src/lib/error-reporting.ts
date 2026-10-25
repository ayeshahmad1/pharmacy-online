import { ApiError } from './api';

/**
 * The browser's error-reporting hook. Unexpected errors (React render errors,
 * uncaught exceptions, unhandled promise rejections) are passed to the
 * installed reporter; with none installed they are only logged to the console
 * (React and the browser already do that).
 *
 * To send them to Sentry: add @sentry/react, call Sentry.init in main.tsx,
 * then `setErrorReporter((error, context) => Sentry.captureException(error,
 * { tags: context }))`, and allow the Sentry ingest host in the CSP's
 * connect-src (deploy/nginx/snippets/pharmacy-pos-headers.conf).
 */
export type ErrorReporter = (error: unknown, context: { source: string }) => void;

let reporter: ErrorReporter | null = null;

export function setErrorReporter(next: ErrorReporter | null) {
  reporter = next;
}

/**
 * Errors the app expects and already shows to the user: the API refusing a
 * request, the network being down (billing carries on offline), cancellations.
 * Reporting those would bury real bugs.
 */
export function isExpectedError(error: unknown): boolean {
  if (error instanceof ApiError) return error.code === 'NETWORK_ERROR' || error.status < 500;
  return error instanceof DOMException && error.name === 'AbortError';
}

export function reportError(error: unknown, source: string) {
  if (!reporter || isExpectedError(error)) return;
  try {
    reporter(error, { source });
  } catch (reportErr) {
    console.error('Error reporter failed', reportErr);
  }
}

/** Forwards uncaught exceptions and unhandled rejections to the reporter. */
export function installGlobalErrorHandlers() {
  window.addEventListener('error', (event) => {
    reportError(event.error ?? event.message, 'window.error');
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportError(event.reason, 'unhandledrejection');
  });
}
