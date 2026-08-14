// The on-device cache, and the one connection everything in it shares.
//
// localStorage held the first version of the message cache and cannot hold this
// one: it is capped somewhere around five megabytes, it is synchronous — every
// read and write blocks the frame it happens on — and it stores strings, so a
// hundred messages have to be parsed in full to look at one. IndexedDB has none
// of those limits.
//
// ── Privacy ──────────────────────────────────────────────────────────────────
// The contents are plain: anyone with the device and the browser profile can
// read them. That is the price of painting a conversation before the network
// answers, so everything here is wiped on sign-out, and `clearDeviceCache()` is
// the single place that has to be called when a session ends.

/** Bump when the set of stores changes; see `STORES`. */
const DB_VERSION = 1;
const DB_NAME = 'sfera-cache';

/** Every object store in the database, each keyed by an `id` property. */
const STORES = ['messages'] as const;

export type StoreName = (typeof STORES)[number];

let connection: Promise<IDBDatabase | null> | null = null;

/**
 * The shared connection, opened on first use.
 *
 * A browser that refuses — private mode in some versions, a blocked upgrade, no
 * IndexedDB at all — resolves to null rather than throwing. Every caller treats
 * that as an empty cache, which is what it is: this is only ever an
 * optimisation, and the network answer is on its way regardless.
 */
function open(): Promise<IDBDatabase | null> {
  if (connection) return connection;

  connection = new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      return resolve(null);
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    // Another tab is holding the old version open. Rather than wait for it,
    // give up for this session — the cache is optional.
    request.onblocked = () => resolve(null);
  });

  return connection;
}

function run<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return open().then((db) => {
    if (!db) return null;
    return new Promise<T | null>((resolve) => {
      try {
        const transaction = db.transaction(store, mode);
        const request = body(transaction.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        transaction.onerror = () => resolve(null);
        // Quota exceeded, most often. Nothing to do but carry on without it.
        transaction.onabort = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  });
}

/** One record, or null when it is absent or unreadable. */
export function readRecord<T>(store: StoreName, id: string): Promise<T | null> {
  if (!id) return Promise.resolve(null);
  return run<T>(store, 'readonly', (s) => s.get(id) as IDBRequest<T>);
}

/** Every record in a store. Used for pruning, which needs to see them all. */
export function readAll<T>(store: StoreName): Promise<T[]> {
  return run<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>)
    .then((all) => all ?? []);
}

/** Write one record, keyed by its own `id`. */
export function writeRecord<T extends { id: string }>(store: StoreName, record: T): Promise<void> {
  return run(store, 'readwrite', (s) => s.put(record) as IDBRequest<IDBValidKey>).then(() => {});
}

/** Drop records by key. */
export function deleteRecords(store: StoreName, ids: string[]): Promise<void> {
  if (!ids.length) return Promise.resolve();
  return open().then((db) => {
    if (!db) return;
    try {
      const transaction = db.transaction(store, 'readwrite');
      const objectStore = transaction.objectStore(store);
      for (const id of ids) objectStore.delete(id);
    } catch { /* ignore */ }
  });
}

/** Empty one store. */
export function clearStore(store: StoreName): Promise<void> {
  return run(store, 'readwrite', (s) => s.clear() as IDBRequest<undefined>).then(() => {});
}

/** Empty every store. Call on sign-out — see the privacy note at the top. */
export function clearDeviceCache(): Promise<void> {
  return open().then((db) => {
    if (!db) return;
    try {
      const transaction = db.transaction(STORES as unknown as string[], 'readwrite');
      for (const store of STORES) transaction.objectStore(store).clear();
    } catch { /* ignore */ }
  });
}
