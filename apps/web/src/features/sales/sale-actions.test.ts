import { describe, expect, it } from 'vitest';
import { returnBlocker, voidBlocker } from './sale-actions';

describe('voidBlocker', () => {
  it('allows voiding a completed sale with no live returns', () => {
    expect(voidBlocker({ status: 'COMPLETED' }, [])).toBeNull();
    // Rejected returns gave nothing back, so they don't stand in the way.
    expect(voidBlocker({ status: 'COMPLETED' }, [{ status: 'REJECTED' }])).toBeNull();
  });

  it('refuses a sale already voided or fully refunded', () => {
    expect(voidBlocker({ status: 'VOIDED' }, [])).toMatch(/already voided/);
    expect(voidBlocker({ status: 'REFUNDED' }, [{ status: 'COMPLETED' }])).toMatch(/returned/);
  });

  it('refuses while a return is pending, and after one has completed', () => {
    expect(
      voidBlocker({ status: 'COMPLETED' }, [{ status: 'REJECTED' }, { status: 'PENDING' }]),
    ).toMatch(/waiting for approval/);
    expect(voidBlocker({ status: 'COMPLETED' }, [{ status: 'COMPLETED' }])).toMatch(
      /already been returned/,
    );
  });
});

describe('returnBlocker', () => {
  it('allows returns only against a completed sale', () => {
    expect(returnBlocker({ status: 'COMPLETED' })).toBeNull();
    expect(returnBlocker({ status: 'VOIDED' })).toMatch(/voided/);
    expect(returnBlocker({ status: 'REFUNDED' })).toMatch(/already been returned/);
  });
});
