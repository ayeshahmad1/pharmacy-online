import type { SellableMedicineDto } from '@pharmacy/shared';

// Billing search is local-first: this device's medicine list (refreshed every
// few minutes, less its own queued sales) answers at once, and the server's
// answer replaces it when it comes. The server still prices the sale and
// checks stock when it is saved, so a few-minutes-old list is only a preview.

/** Where the rows on screen came from. */
export type ResultsSource = 'server' | 'device' | 'previous';

type Answer = { items?: SellableMedicineDto[]; placeholder: boolean };

/**
 * The rows to show for what is typed: the server's answer once it is in for
 * this exact term, else this device's answer for it, else whatever was shown
 * before while both catch up.
 */
export function shownResults(input: {
  term: string;
  server: Answer & { term: string };
  device: Answer;
}): { items: SellableMedicineDto[]; source: ResultsSource | null } {
  const { term, server, device } = input;
  if (!term) return { items: [], source: null };
  if (server.term === term && server.items && !server.placeholder) {
    return { items: server.items, source: 'server' };
  }
  if (device.items && !device.placeholder) return { items: device.items, source: 'device' };
  return { items: server.items ?? device.items ?? [], source: 'previous' };
}

export type EnterAction =
  | { kind: 'add'; medicine: SellableMedicineDto }
  /** Nothing on screen answers it yet: ask the server now. */
  | { kind: 'lookup' }
  | { kind: 'not-found' };

/**
 * What Enter does with the list on screen. A scanner types the barcode and
 * Enter faster than the server answers, so the device's list is used straight
 * away: an exact barcode match is added, otherwise the highlighted row. A term
 * the device doesn't know goes to the server, which may know a medicine added
 * since the list was saved.
 */
export function enterAction(
  shown: { items: SellableMedicineDto[]; source: ResultsSource | null },
  highlighted: SellableMedicineDto | undefined,
): EnterAction {
  switch (shown.source) {
    case 'server':
      return highlighted ? { kind: 'add', medicine: highlighted } : { kind: 'not-found' };
    case 'device': {
      const pick = shown.items.find((m) => m.barcodeMatch) ?? highlighted;
      return pick ? { kind: 'add', medicine: pick } : { kind: 'lookup' };
    }
    default:
      return { kind: 'lookup' };
  }
}
