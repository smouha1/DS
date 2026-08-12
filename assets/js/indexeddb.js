/* ============================================================================
   indexeddb.js — MODULE: db
   ------------------------------------------------------------------------
   IndexedDB 2.0. Persistent local storage for the product catalog.

   Design decision (unchanged from the original single-file build, still
   correct here): IndexedDB is the persistence layer, not the live search
   engine. Every launch reads the full catalog out of IndexedDB (or, on
   first run / cache miss, out of a freshly-fetched data/products.json)
   and hands it to search.js, which builds the actual in-memory Maps that
   every search hits. Search NEVER queries IndexedDB directly at keystroke
   time — that would be async and slower than a Map.get(), not faster.

   Database: SmouhaPickDB (version 2 — "2.0" per the update workflow)
   Object store: products   (keyPath: sku)
     indexes: barcode (multiEntry), name, last6 (multiEntry)
   Object store: meta       (keyPath: key) — stores the last-applied
     version.json { version, build } so updater.js can compare cheaply.
   ============================================================================ */

const DB_NAME = 'SmouhaPickDB';
const DB_VERSION = 2;
const STORE_PRODUCTS = 'products';
const STORE_META = 'meta';

let dbPromise = null;

export function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('IndexedDB not supported in this browser')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const idb = e.target.result;
      if (!idb.objectStoreNames.contains(STORE_PRODUCTS)) {
        const store = idb.createObjectStore(STORE_PRODUCTS, { keyPath: 'sku' });
        store.createIndex('barcode', 'barcodes', { multiEntry: true });
        store.createIndex('name', 'name', { unique: false });
        store.createIndex('last6', 'last6', { multiEntry: true });
      }
      if (!idb.objectStoreNames.contains(STORE_META)) {
        idb.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another open tab'));
  });
  return dbPromise;
}

export async function countProducts() {
  const idb = await open();
  return new Promise((resolve, reject) => {
    const req = idb.transaction(STORE_PRODUCTS, 'readonly').objectStore(STORE_PRODUCTS).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllProducts() {
  const idb = await open();
  return new Promise((resolve, reject) => {
    const req = idb.transaction(STORE_PRODUCTS, 'readonly').objectStore(STORE_PRODUCTS).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Clears the store and bulk-inserts fresh records in one transaction. */
export async function replaceAllProducts(records) {
  const idb = await open();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(STORE_PRODUCTS, 'readwrite');
    const store = tx.objectStore(STORE_PRODUCTS);
    store.clear();
    for (const rec of records) store.put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function getMeta(key) {
  const idb = await open();
  return new Promise((resolve, reject) => {
    const req = idb.transaction(STORE_META, 'readonly').objectStore(STORE_META).get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
    req.onerror = () => reject(req.error);
  });
}

export async function setMeta(key, value) {
  const idb = await open();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(STORE_META, 'readwrite');
    tx.objectStore(STORE_META).put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Deletes the entire database (Settings -> "Clear IndexedDB" / Maintenance
 *  Panel "Clear Database"). The next call to open() re-creates it fresh. */
export async function deleteDatabase() {
  if (dbPromise) {
    const idb = await dbPromise;
    idb.close();
  }
  dbPromise = null;
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve(); // another tab has it open; it'll clear once closed
  });
}

/** Best-effort storage size estimate for the Developer/Maintenance section.
 *  navigator.storage.estimate() is supported in all modern Chromium/Firefox
 *  browsers but is a whole-origin estimate (not IndexedDB-store-specific) —
 *  labelled accordingly in the UI rather than presented as exact. */
export async function estimateStorageUsage() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  } catch (e) {
    return null;
  }
}

export function isSupported() {
  return !!window.indexedDB;
}
