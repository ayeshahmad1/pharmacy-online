// The app's IndexedDB database: data the counter keeps on this device so it
// survives a reload, a lost connection or an expired session. Never holds
// tokens or passwords. Bump DB_VERSION and extend `upgrade` to add stores.

const DB_NAME = 'pharmacy-pos';
const DB_VERSION = 1;

export const STORES = {
  /** Bills put on hold at the counter, by id. */
  heldBills: 'heldBills',
  /** The cart each user was building, by user id, so a reload doesn't lose it. */
  drafts: 'drafts',
} as const;
export type StoreName = (typeof STORES)[keyof typeof STORES];

function upgrade(db: IDBDatabase, oldVersion: number) {
  if (oldVersion < 1) {
    db.createObjectStore(STORES.heldBills, { keyPath: 'id' });
    db.createObjectStore(STORES.drafts, { keyPath: 'userId' });
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

async function run<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  action: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  const tx = db.transaction(store, mode);
  // Resolve only once the transaction has committed, so a write is on disk.
  const committed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Local storage request failed'));
    tx.onabort = () => reject(tx.error ?? new Error('Local storage request was aborted'));
  });
  const [result] = await Promise.all([done(action(tx.objectStore(store))), committed]);
  return result;
}

export const localDb = {
  getAll: <T>(store: StoreName) =>
    run<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>),
  get: <T>(store: StoreName, key: IDBValidKey) =>
    run<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>),
  put: (store: StoreName, value: unknown) => run(store, 'readwrite', (s) => s.put(value)),
  delete: (store: StoreName, key: IDBValidKey) => run(store, 'readwrite', (s) => s.delete(key)),
};
