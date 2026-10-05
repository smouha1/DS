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

function scheduleIdle(fn) {
  try {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => { try { fn(); } catch (e) {} }, { timeout: 2500 });
      return;
    }
  } catch (e) {}
  setTimeout(() => { try { fn(); } catch (e) {} }, 1);
}

const PRODUCTS_URL = 'data/products.json';

let lastLoadSource = 'none'; // 'indexeddb' | 'network' | 'none' — for the Developer panel
let lastVersionInfo = null;  // parsed version.json, for the Developer panel / footer

export function getLastLoadSource() { return lastLoadSource; }
export function getLastVersionInfo() { return lastVersionInfo; }

/** Converts one raw [name, sku, barcodeRaw, image] row from products.json
 *  into the normalized shape stored in both IndexedDB and search.js. */
function normalizeRawRow(row) {
  // Tuple may be [name, sku, barcode] or [name, sku, barcode, image] — image column ignored
  const name = Array.isArray(row) ? row[0] : row.name;
  const sku = Array.isArray(row) ? row[1] : row.sku;
  const barcodeRaw = Array.isArray(row) ? row[2] : (row.barcode || row.barcodes);
  const barcodes = barcode.parse(barcodeRaw);
  const last6 = [...new Set(barcodes.filter(b => b.length >= 6).map(b => b.slice(-6)))];
  const image = barcode.imageUrlFromBarcodes(barcodes);
  return { sku: String(sku || ''), name: name || 'Unnamed product', barcodes, image, last6 };
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(url + ' HTTP ' + res.status);
  const text = await res.text();
  return { text, json: JSON.parse(text) };
}


/** Ensure every in-memory product has an image URL derived from its barcode. */
function fillImagesFromBarcodes() {
  try {
    if (typeof search.applyBarcodeImages === 'function') {
      return search.applyBarcodeImages();
    }
  } catch (e) {
    console.warn('[updater] barcode image fill failed:', e);
  }
  return 0;
}

async function fetchAndImportProducts() {
  // Single catalog: products.json only. Image URLs derived client-side from barcodes.
  const { text } = await fetchJson(PRODUCTS_URL);
  const raw = JSON.parse(text);
  const records = raw.map(normalizeRawRow);
  await search.buildAsync(records);
  try { fillImagesFromBarcodes(); } catch (e) {}
  return records;
}

/** First entry point, called once at startup. Resolves as soon as the app
 *  has *some* usable dataset in memory. Never rejects — on total failure it
 *  builds an empty index rather than leaving the app stuck. */
function emitCatalogStatus(state, message) {
  try {
    window.dispatchEvent(new CustomEvent('smouha:catalog-status', {
      detail: { state, message: message || '' }
    }));
  } catch (e) {}
}

async function backgroundRefresh(remoteVersion) {
  emitCatalogStatus('updating', 'Updating catalog…');
  try {
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const records = await fetchAndImportProducts();
    await db.replaceAllProducts(records);
    await db.setMeta('versionInfo', remoteVersion || lastVersionInfo);
    lastLoadSource = 'network-bg';
    lastVersionInfo = remoteVersion || lastVersionInfo;
    const ms = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
    try {
      window.dispatchEvent(new CustomEvent('smouha:db-updated', {
        detail: { count: records.length, ms: Math.round(ms), source: 'network-bg' }
      }));
    } catch (e) {}
    emitCatalogStatus('ok', 'Catalog updated');
    return records.length;
  } catch (e) {
    console.warn('[updater] background refresh failed:', e);
    try {
      window.dispatchEvent(new CustomEvent('smouha:db-update-failed', {
        detail: { message: (e && e.message) ? String(e.message) : 'Catalog background update failed' }
      }));
    } catch (err) {}
    emitCatalogStatus('stale', 'Catalog may be outdated');
    return 0;
  }
}

export async function loadInitial() {
  // 1) version.json (tiny) — optional on first paint
  let remoteVersion = null;
  try {
    const { json } = await fetchJson(VERSION_URL);
    remoteVersion = json;
    lastVersionInfo = json;
  } catch (e) {
    /* offline or missing */
  }

  // 2) IndexedDB-first: serve cache immediately, refresh in background if stale
  try {
    const cachedCount = await db.countProducts();
    if (cachedCount > 0) {
      const storedVersion = await db.getMeta('versionInfo');
      const records = await db.getAllProducts();
      const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      await search.buildAsync(records);
      const indexMs = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0);
      try { window.__smouhaIndexMs = indexMs; } catch (e) {}
      lastLoadSource = 'indexeddb';
      if (!lastVersionInfo) lastVersionInfo = storedVersion;

      const buildMatches = !remoteVersion || (storedVersion && storedVersion.build === remoteVersion.build);
      const countMatches = !remoteVersion || !remoteVersion.products || cachedCount === Number(remoteVersion.products);

      if (buildMatches && countMatches) {
        return { source: 'indexeddb', count: records.length, updated: false, indexMs };
      }

      // Stale or count mismatch: keep UI usable, refresh catalog in background
      console.info('[updater] serving IndexedDB now; background refresh (build/count mismatch)');
      emitCatalogStatus('updating', 'Updating catalog…');
      backgroundRefresh(remoteVersion).catch(() => {});
      return { source: 'indexeddb', count: records.length, updated: false, backgroundRefresh: true, indexMs };
    }
  } catch (e) {
    console.warn('[updater] IndexedDB unavailable, falling back to products.json:', e);
  }

  // 3) First launch / empty cache: full network import
  try {
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const records = await fetchAndImportProducts();
    const indexMs = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0);
    try { window.__smouhaIndexMs = indexMs; } catch (e) {}
    lastLoadSource = 'network';
    db.replaceAllProducts(records)
      .then(() => db.setMeta('versionInfo', remoteVersion || lastVersionInfo))
      .catch(e => console.warn('[updater] Could not persist products to IndexedDB:', e));
    return { source: 'network', count: records.length, updated: true, indexMs };
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
