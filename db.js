// Thin IndexedDB wrapper. Only ever sees ciphertext plus the non-secret auth record.

const DB_NAME = 'expense-tracker';
const META = 'meta';       // 'auth' -> salt/iterations/verifier; 'seen' -> encrypted dedupe keys
const ENTRIES = 'entries'; // { id, iv, ct }

let connection;

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function open() {
  connection ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(META);
      req.result.createObjectStore(ENTRIES, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return connection;
}

// Runs synchronous store operations in one transaction and resolves when it commits.
async function write(work) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([META, ENTRIES], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
    work(tx.objectStore(META), tx.objectStore(ENTRIES));
  });
}

async function read(store, method, ...args) {
  const db = await open();
  return request(db.transaction(store).objectStore(store)[method](...args));
}

export const getMeta = (key) => read(META, 'get', key);
export const setMeta = (key, value) => write((meta) => meta.put(value, key));
export const allEntries = () => read(ENTRIES, 'getAll');
export const putEntry = (record) => write((_, entries) => entries.put(record));
export const deleteEntry = (id) => write((_, entries) => entries.delete(id));

/** Stores imported rows and their dedupe keys atomically, so a failed import can be retried. */
export function commitImport(records, seenRecord) {
  return write((meta, entries) => {
    records.forEach((record) => entries.put(record));
    meta.put(seenRecord, 'seen');
  });
}

export function wipe() {
  return write((meta, entries) => {
    meta.clear();
    entries.clear();
  });
}
