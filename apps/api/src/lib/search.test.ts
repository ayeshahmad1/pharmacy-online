import { describe, expect, it } from 'vitest';
import { escapeLike } from './search';

describe('escapeLike', () => {
  it('escapes LIKE wildcards and the escape character itself', () => {
    expect(escapeLike('5%')).toBe('5\\%');
    expect(escapeLike('vit_d')).toBe('vit\\_d');
    expect(escapeLike('a\\b')).toBe('a\\\\b');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeLike('Panadol 500mg')).toBe('Panadol 500mg');
  });
});
