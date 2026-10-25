// The app's IndexedDB database: data the counter keeps on this device so it
// survives a reload, a lost connection or an expired session. Never holds
// tokens or passwords. Bump DB_VERSION and extend `upgrade` to add stores.

const DB_NAME = 'pharmacy-pos';
const DB_VERSION = 2;

export const STORES = {
  /** Bills put on hold at the counter, by id. */
  heldBills: 'heldBills',
  /** The cart each user was building, by user id, so a reload doesn't lose it. */
  drafts: 'drafts',
  /** Active medicines with batch stock, by id, for selling offline. */
  catalogue: 'catalogue',
  /** Small records by key: the catalogue's details, the remembered user. */
  meta: 'meta',
  /** Sales made offline (or whose reply was lost), by idempotency key, until synced. */
  saleQueue: 'saleQueue',
} as const;
export type StoreName = (typeof STORES)[keyof typeof STORES];

function upgrade(db: IDBDatabase, oldVersion: number) {
  if (oldVersion < 1) {
    db.createObjectStore(STORES.heldBills, { keyPath: 'id' });
    db.createObjectStore(STORES.drafts, { keyPath: 'userId' });
  }
  if (oldVersion < 2) {
    db.createObjectStore(STORES.catalogue, { keyPath: 'id' });
    db.createObjectStore(STORES.meta, { keyPath: 'key' });
    db.createObjectStore(STORES.saleQueue, { keyPath: 'idempotencyKey' });
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser cannot store data offline'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => upgrade(request.result, event.oldVersion);
    request.onsuccess = () => {
      const db = request.result;
      // Another tab is upgrading the schema: step aside so it can.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open local storage'));
  }).catch((err: unknown) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Local storage request failed'));
  });
}

function committed(tx: IDBTransaction): Promise<void> {
  // Resolve only once the transaction has committed, so a write is on disk.
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Local storage request failed'));
    tx.onabort = () => reject(tx.error ?? new Error('Local storage request was aborted'));
  });
}

async function run<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  action: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  const tx = db.transaction(store, mode);
  const [result] = await Promise.all([done(action(tx.objectStore(store))), committed(tx)]);
  return result;
}

export const localDb = {
  getAll: <T>(store: StoreName) =>
    run<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>),
  get: <T>(store: StoreName, key: IDBValidKey) =>
    run<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>),
  put: (store: StoreName, value: unknown) => run(store, 'readwrite', (s) => s.put(value)),
  delete: (store: StoreName, key: IDBValidKey) => run(store, 'readwrite', (s) => s.delete(key)),
  /**
   * Replaces everything in `store` with `values` and writes `extra` records
   * to other stores, in one transaction: readers see the old set or the new
   * one, never a mix.
   */
  async replaceAll(store: StoreName, values: unknown[], extra: [StoreName, unknown][] = []) {
    const db = await openDb();
    const tx = db.transaction([store, ...extra.map(([s]) => s)], 'readwrite');
    const target = tx.objectStore(store);
    target.clear();
    for (const value of values) target.put(value);
    for (const [s, value] of extra) tx.objectStore(s).put(value);
    await committed(tx);
  },
};
