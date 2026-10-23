import { describe, expect, it } from 'vitest';
import { applyListChanges, readListParams } from './list-params';

const sp = (init: string) => new URLSearchParams(init);

describe('readListParams', () => {
  it('fills in defaults for a bare URL', () => {
    expect(readListParams(sp(''), ['status', 'categoryId'], { status: 'ACTIVE' })).toEqual({
      page: 1,
      pageSize: 20,
      q: '',
      filters: { status: 'ACTIVE', categoryId: '' },
    });
  });

  it('reads search, filters and paging from the URL', () => {
    const params = readListParams(sp('q=pana&page=3&pageSize=50&status=all'), ['status'], {
      status: 'ACTIVE',
    });
    expect(params).toEqual({ page: 3, pageSize: 50, q: 'pana', filters: { status: 'all' } });
  });

  it('ignores invalid paging values', () => {
    expect(readListParams(sp('page=-2&pageSize=7'), [])).toMatchObject({ page: 1, pageSize: 20 });
    expect(readListParams(sp('page=abc&pageSize=1000'), [])).toMatchObject({
      page: 1,
      pageSize: 20,
    });
  });
});

describe('applyListChanges', () => {
  it('goes back to page 1 when a filter or the search changes', () => {
    expect(applyListChanges(sp('page=4&q=a'), { q: 'ab' }).toString()).toBe('q=ab');
    expect(applyListChanges(sp('page=4'), { categoryId: 'c1' }).toString()).toBe('categoryId=c1');
  });

  it('keeps other params when changing the page', () => {
    expect(applyListChanges(sp('q=a'), { page: 2 }).toString()).toBe('q=a&page=2');
  });

  it('drops values that equal their default', () => {
    const defaults = { status: 'ACTIVE' };
    expect(applyListChanges(sp('status=all'), { status: 'ACTIVE' }, defaults).toString()).toBe('');
    expect(applyListChanges(sp(''), { status: 'all' }, defaults).toString()).toBe('status=all');
    expect(applyListChanges(sp('page=3'), { page: 1 }).toString()).toBe('');
    expect(applyListChanges(sp('pageSize=50'), { pageSize: 20 }).toString()).toBe('');
    expect(applyListChanges(sp('q=a'), { q: '' }).toString()).toBe('');
  });
});
