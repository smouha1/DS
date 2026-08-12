/* ============================================================================
   updater.js — MODULE: updater
   ------------------------------------------------------------------------
   Implements the "IndexedDB 2.0" update workflow:

   FIRST RUN
     download data/products.json -> build IndexedDB -> build in-memory Maps

   EVERY NEXT RUN
     download ONLY data/version.json (a few bytes) -> compare "build" number
     against what's stored -> if identical, never download products.json,
     just load IndexedDB immediately (instant search)

   IF BUILD CHANGED
     download products.json -> rebuild IndexedDB -> refresh in-memory Maps
     -> notify the caller so it can show "Database Updated Successfully"

   OFFLINE / FETCH FAILURE
     use whatever is already in IndexedDB; the app keeps working

   INDEXEDDB FAILURE
     fall back to using products.json directly in memory (no persistence);
     the user never sees an error

   This module owns the update *decision*; it delegates actual persistence
   to indexeddb.js and actual indexing to search.js, so neither of those
   modules needs to know anything about version.json or fetch().
   ============================================================================ */

import * as db from './indexeddb.js';
import * as search from './search.js';
import * as barcode from './barcode.js';
import { quickHash } from './utils.js';

const VERSION_URL = 'data/version.json';
const PRODUCTS_URL = 'data/products.json';

let lastLoadSource = 'none'; // 'indexeddb' | 'network' | 'none' — for the Developer panel
let lastVersionInfo = null;  // parsed version.json, for the Developer panel / footer

export function getLastLoadSource() { return lastLoadSource; }
export function getLastVersionInfo() { return lastVersionInfo; }

/** Converts one raw [name, sku, barcodeRaw, image] row from products.json
 *  into the normalized shape stored in both IndexedDB and search.js. */
function normalizeRawRow(row) {
  const [name, sku, barcodeRaw, image] = row;
  const barcodes = barcode.parse(barcodeRaw);
  const last6 = [...new Set(barcodes.filter(b => b.length >= 6).map(b => b.slice(-6)))];
  return { sku: String(sku || ''), name: name || 'Unnamed product', barcodes, image: image || '', last6 };
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(url + ' HTTP ' + res.status);
  const text = await res.text();
  return { text, json: JSON.parse(text) };
}

async function fetchAndImportProducts() {
  const { text } = await fetchJson(PRODUCTS_URL);
  const raw = JSON.parse(text);
  const records = raw.map(normalizeRawRow);
  search.build(records);
  return records;
}

/** First entry point, called once at startup. Resolves as soon as the app
 *  has *some* usable dataset in memory. Never rejects — on total failure it
 *  builds an empty index rather than leaving the app stuck. */
export async function loadInitial() {
  // 1) Read version.json first — a few bytes, tells us if we even need to
  //    look at products.json at all.
  let remoteVersion = null;
  try {
    const { json } = await fetchJson(VERSION_URL);
    remoteVersion = json;
    lastVersionInfo = json;
  } catch (e) {
    // Offline on first paint, or version.json missing — fall through to
    // whatever IndexedDB already has, or products.json as a last resort.
  }

  // 2) If IndexedDB already has data AND its stored build matches the
  //    remote build (or we couldn't reach the network at all), use it
  //    immediately — instant search, no network wait.
  try {
    const cachedCount = await db.countProducts();
    if (cachedCount > 0) {
      const storedVersion = await db.getMeta('versionInfo');
      const buildMatches = !remoteVersion || (storedVersion && storedVersion.build === remoteVersion.build);
      if (buildMatches) {
        const records = await db.getAllProducts();
        search.build(records);
        lastLoadSource = 'indexeddb';
        if (!lastVersionInfo) lastVersionInfo = storedVersion;
        return { source: 'indexeddb', count: records.length, updated: false };
      }
      // Build changed: fall through to re-download products.json below.
    }
  } catch (e) {
    console.warn('[updater] IndexedDB unavailable, falling back to products.json:', e);
  }

  // 3) First launch, empty cache, or build changed: fetch products.json.
  try {
    const records = await fetchAndImportProducts();
    lastLoadSource = 'network';
    db.replaceAllProducts(records)
      .then(() => db.setMeta('versionInfo', remoteVersion || lastVersionInfo))
      .catch(e => console.warn('[updater] Could not persist products to IndexedDB:', e));
    return { source: 'network', count: records.length, updated: true };
  } catch (e) {
    console.error('[updater] Could not load product data from IndexedDB or products.json:', e);
    search.build([]);
    lastLoadSource = 'none';
    return { source: 'none', count: 0, error: e };
  }
}

/** Settings -> "Force Update Database": downloads products.json regardless
 *  of whether version.json's build number changed. */
export async function forceUpdate() {
  const records = await fetchAndImportProducts();
  try {
    const { json } = await fetchJson(VERSION_URL);
    lastVersionInfo = json;
    await db.replaceAllProducts(records);
    await db.setMeta('versionInfo', json);
  } catch (e) {
    // version.json unreachable but products.json worked — still persist,
    // just without an updated version stamp.
    await db.replaceAllProducts(records).catch(() => {});
  }
  lastLoadSource = 'network';
  return records.length;
}

/** Settings -> "Clear IndexedDB" / Maintenance Panel "Clear Database":
 *  wipes local storage and rebuilds straight from products.json. */
export async function clearAndRebuild() {
  await db.deleteDatabase().catch(() => {});
  return loadInitial();
}
