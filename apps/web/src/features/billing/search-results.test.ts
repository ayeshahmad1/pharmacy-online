import { describe, expect, it } from 'vitest';
import { enterAction, shownResults } from './search-results';
import { medicine } from './test-fixtures';

const panadol = medicine({ name: 'Panadol 500mg' });
const panadolExtra = medicine({ name: 'Panadol Extra' });
const scanned = medicine({ name: 'Brufen 400mg', barcode: '8964000123456', barcodeMatch: true });

describe('shownResults', () => {
  it('shows the device list at once while the server catches up', () => {
    expect(
      shownResults({
        term: 'pana',
        server: { term: 'pan', items: [panadol], placeholder: false },
        device: { items: [panadol, panadolExtra], placeholder: false },
      }),
    ).toEqual({ items: [panadol, panadolExtra], source: 'device' });
  });

  it("switches to the server's answer once it is in for what is typed", () => {
    expect(
      shownResults({
        term: 'pana',
        server: { term: 'pana', items: [panadolExtra], placeholder: false },
        device: { items: [panadol, panadolExtra], placeholder: false },
      }),
    ).toEqual({ items: [panadolExtra], source: 'server' });
  });

  it('keeps the previous rows while neither answer is in, and nothing for an empty box', () => {
    expect(
      shownResults({
        term: 'panad',
        server: { term: 'pana', items: [panadol], placeholder: true },
        device: { items: [panadolExtra], placeholder: true },
      }),
    ).toEqual({ items: [panadol], source: 'previous' });
    expect(
      shownResults({
        term: '',
        server: { term: '', items: [panadol], placeholder: false },
        device: { items: [panadol], placeholder: false },
      }),
    ).toEqual({ items: [], source: null });
  });

  it('falls back to the server when the device has no list yet', () => {
    expect(
      shownResults({
        term: 'pana',
        server: { term: 'pana', items: undefined, placeholder: false },
        device: { items: undefined, placeholder: false },
      }),
    ).toEqual({ items: [], source: 'previous' });
  });
});

describe('enterAction', () => {
  it('adds the barcode match from the device list without waiting for the server', () => {
    expect(enterAction({ items: [panadol, scanned], source: 'device' }, panadol)).toEqual({
      kind: 'add',
      medicine: scanned,
    });
  });

  it('adds the highlighted row of the device list for a typed name', () => {
    expect(enterAction({ items: [panadol, panadolExtra], source: 'device' }, panadolExtra)).toEqual(
      { kind: 'add', medicine: panadolExtra },
    );
  });

  it('asks the server for a term the device list does not know', () => {
    expect(enterAction({ items: [], source: 'device' }, undefined)).toEqual({ kind: 'lookup' });
    expect(enterAction({ items: [panadol], source: 'previous' }, panadol)).toEqual({
      kind: 'lookup',
    });
  });

  it("takes the highlighted row of the server's answer, or says nothing matches", () => {
    expect(enterAction({ items: [panadol], source: 'server' }, panadol)).toEqual({
      kind: 'add',
      medicine: panadol,
    });
    expect(enterAction({ items: [], source: 'server' }, undefined)).toEqual({ kind: 'not-found' });
  });
});
