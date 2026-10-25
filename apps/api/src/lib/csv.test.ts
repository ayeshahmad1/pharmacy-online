import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from './csv';

describe('csvCell', () => {
  it('leaves plain values alone and blanks out missing ones', () => {
    expect(csvCell('Panadol')).toBe('Panadol');
    expect(csvCell(12)).toBe('12');
    expect(csvCell('120.50')).toBe('120.50');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes commas, quotes, newlines and edge spaces', () => {
    expect(csvCell('Panadol, Extra')).toBe('"Panadol, Extra"');
    expect(csvCell('5" bandage')).toBe('"5"" bandage"');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell(' padded')).toBe('" padded"');
  });

  it('defuses formulas in free text but keeps negative numbers', () => {
    expect(csvCell('=HYPERLINK("x")', true)).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+92 300', true)).toBe("'+92 300");
    expect(csvCell('@sum', true)).toBe("'@sum");
    expect(csvCell('-25.00')).toBe('-25.00');
  });
});

describe('toCsv', () => {
  it('writes a header row and CRLF-terminated lines', () => {
    const csv = toCsv(
      [
        { header: 'Medicine', value: (r: { name: string; total: string }) => r.name, text: true },
        { header: 'Total', value: (r) => r.total },
      ],
      [
        { name: 'Panadol', total: '100.00' },
        { name: 'Brufen, 400', total: '-5.00' },
      ],
    );
    expect(csv).toBe('Medicine,Total\r\nPanadol,100.00\r\n"Brufen, 400",-5.00\r\n');
  });
});
