import { describe, expect, it } from 'vitest';
import { toAuditJson } from './audit';

describe('toAuditJson', () => {
  it('drops secret-looking keys at any depth', () => {
    const json = toAuditJson({
      username: 'ali',
      passwordHash: '$2b$...',
      nested: { refreshToken: 'abc', newPassword: 'x', keep: 1 },
      list: [{ apiSecret: 's', ok: true }],
    });
    expect(json).toEqual({ username: 'ali', nested: { keep: 1 }, list: [{ ok: true }] });
  });

  it('serialises dates to ISO strings', () => {
    const at = new Date('2026-10-23T10:00:00.000Z');
    expect(toAuditJson({ at })).toEqual({ at: '2026-10-23T10:00:00.000Z' });
  });

  it('returns undefined for null/undefined so the column stays NULL', () => {
    expect(toAuditJson(undefined)).toBeUndefined();
    expect(toAuditJson(null)).toBeUndefined();
  });
});
