// The offline catalogue in IndexedDB, held in memory once read, and the
// billing lookups answered from it (search, one medicine, substitutes) with
// stock adjusted for this device's queued sales. See catalogue.ts for the
// rules, which are unit-tested there.

import type {
  OfflineCatalogueDto,
  OfflineMedicineDto,
  SellableMedicineDto,
  SubstitutesDto,
} from '@pharmacy/shared';
import { api } from '@/lib/api';
import {
  businessDate,
  findSubstitutes,
  projectBatches,
  searchCatalogue,
  toSellable,
  type CatalogueMeta,
} from './catalogue';
import { localDb, STORES } from './db';
import { saleQueue, stockClaims } from './sale-queue';

type Catalogue = {
  meta: CatalogueMeta;
  medicines: OfflineMedicineDto[];
  byId: Map<string, OfflineMedicineDto>;
};

type MetaRecord = { key: 'catalogue' } & CatalogueMeta;

const META_KEY = 'catalogue';

let cache: Promise<Catalogue | null> | null = null;
let currentMeta: CatalogueMeta | null = null;
const listeners = new Set<() => void>();

function index(meta: CatalogueMeta, medicines: OfflineMedicineDto[]): Catalogue {
  return { meta, medicines, byId: new Map(medicines.map((m) => [m.id, m])) };
}

function announce(meta: CatalogueMeta | null) {
  currentMeta = meta;
  listeners.forEach((l) => l());
}

async function read(): Promise<Catalogue | null> {
  const record = await localDb.get<MetaRecord>(STORES.meta, META_KEY);
  if (!record) return null;
  const { key: _key, ...meta } = record;
  const medicines = await localDb.getAll<OfflineMedicineDto>(STORES.catalogue);
  medicines.sort((a, b) => a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id));
  return index(meta, medicines);
}

export const catalogueStore = {
  /** The saved catalogue, or null if this device has never downloaded one. */
  load(): Promise<Catalogue | null> {
    cache ??= read()
      .then((c) => {
        if (c) announce(c.meta);
        return c;
      })
      .catch((err: unknown) => {
        cache = null;
        throw err;
      });
    return cache;
  },
  /** Replaces the saved catalogue in one transaction. */
  async save(dto: OfflineCatalogueDto) {
    const { medicines, ...meta } = dto;
    await localDb.replaceAll(STORES.catalogue, medicines, [
      [STORES.meta, { key: META_KEY, ...meta } satisfies MetaRecord],
    ]);
    cache = Promise.resolve(index(meta, medicines));
    announce(meta);
  },
  /** Details of the saved catalogue, once loaded, for status displays. */
  meta: () => currentMeta,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
};

/** A download that hasn't started by then is given up and tried again on the next round. */
const CATALOGUE_TIMEOUT_MS = 60_000;

/** Downloads the current catalogue and saves it on this device. */
export async function refreshCatalogue(): Promise<CatalogueMeta> {
  const dto = await api.get<OfflineCatalogueDto>(
    '/inventory/offline-catalogue',
    undefined,
    undefined,
    { timeoutMs: CATALOGUE_TIMEOUT_MS },
  );
  await catalogueStore.save(dto);
  const { medicines: _m, ...meta } = dto;
  return meta;
}

// ─── Lookups ────────────────────────────────────────────────────────────────

/** Medicines (and their batches) as this device counts them right now. */
async function localStock(catalogue: Catalogue, medicines: OfflineMedicineDto[]) {
  const sales = await saleQueue.list();
  const claims = stockClaims(sales, catalogue.meta.generatedAt);
  const batches = projectBatches(medicines, claims, catalogue.meta.timeZone);
  const today = businessDate(new Date(), catalogue.meta.timeZone);
  return { batches, today };
}

async function required(): Promise<Catalogue> {
  const catalogue = await catalogueStore.load();
  if (!catalogue) {
    throw new Error('No medicine list is saved on this device yet. Reconnect to download it.');
  }
  return catalogue;
}

export const offlineBilling = {
  async search(term: string, limit: number): Promise<SellableMedicineDto[]> {
    const catalogue = await required();
    const hits = searchCatalogue(catalogue.medicines, term, limit);
    const { batches, today } = await localStock(
      catalogue,
      hits.map((h) => h.medicine),
    );
    return hits.map((h) =>
      toSellable(h.medicine, batches.get(h.medicine.id) ?? [], today, h.barcodeMatch),
    );
  },

  async get(medicineId: string): Promise<SellableMedicineDto> {
    const catalogue = await required();
    const medicine = catalogue.byId.get(medicineId);
    if (!medicine) throw new Error('This medicine is not in the list saved on this device');
    const { batches, today } = await localStock(catalogue, [medicine]);
    return toSellable(medicine, batches.get(medicine.id) ?? [], today);
  },

  async substitutes(medicineId: string): Promise<SubstitutesDto> {
    const catalogue = await required();
    const medicine = catalogue.byId.get(medicineId);
    if (!medicine) throw new Error('This medicine is not in the list saved on this device');
    const generic = medicine.genericName?.toLowerCase();
    const related = generic
      ? catalogue.medicines.filter((m) => m.genericName?.toLowerCase() === generic)
      : [medicine];
    const { batches, today } = await localStock(catalogue, related);
    const views = related.map((m) => toSellable(m, batches.get(m.id) ?? [], today));
    return findSubstitutes(
      views.find((v) => v.id === medicineId)!,
      views,
    );
  },

  /**
   * What a sale offline needs: each medicine's current view and projected
   * batches, today's date, and the rules from the snapshot. Null catalogue
   * fields when nothing is saved.
   */
  async forSale(medicineIds: string[]) {
    const catalogue = await catalogueStore.load();
    if (!catalogue) return null;
    const medicines = medicineIds.flatMap((id) => catalogue.byId.get(id) ?? []);
    const { batches, today } = await localStock(catalogue, medicines);
    const stock = new Map<string, SellableMedicineDto>(
      medicines.map((m) => [m.id, toSellable(m, batches.get(m.id) ?? [], today)]),
    );
    return {
      meta: catalogue.meta,
      stock,
      batches,
      today,
    };
  },
};
