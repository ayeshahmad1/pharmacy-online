import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { isExpectedError, reportError, setErrorReporter } from './error-reporting';

describe('error reporting', () => {
  afterEach(() => setErrorReporter(null));

  it('treats API refusals, network failures and cancellations as expected', () => {
    expect(isExpectedError(new ApiError(409, 'INSUFFICIENT_STOCK', 'Short'))).toBe(true);
    expect(isExpectedError(new ApiError(0, 'NETWORK_ERROR', 'Offline'))).toBe(true);
    expect(isExpectedError(new DOMException('Aborted', 'AbortError'))).toBe(true);
  });

  it('reports server errors and bugs to the installed reporter', () => {
    const reporter = vi.fn();
    setErrorReporter(reporter);
    const bug = new TypeError('x is undefined');

    reportError(new ApiError(500, 'INTERNAL_ERROR', 'Boom'), 'react');
    reportError(bug, 'window.error');
    reportError(new ApiError(403, 'FORBIDDEN', 'No'), 'unhandledrejection');

    expect(reporter).toHaveBeenCalledTimes(2);
    expect(reporter).toHaveBeenLastCalledWith(bug, { source: 'window.error' });
  });

  it('survives a reporter that throws', () => {
    setErrorReporter(() => {
      throw new Error('reporter down');
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => reportError(new Error('bug'), 'react')).not.toThrow();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
