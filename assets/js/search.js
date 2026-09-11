/* ============================================================================
   search.js — MODULE: productIndex + searchEngine + suggestions
   ------------------------------------------------------------------------
   productIndex builds Map-based indexes ONCE per data load for O(1) exact
   lookups (SKU, any barcode, last-6-digits). No iteration over the product
   list happens during an exact-match search. Prefix search ("starts with")
   and name search ("contains") are linear scans — fast enough at this
   catalog size and needed only by the suggestions dropdown's lower tiers.

   IMPORTANT: build() takes already-normalized records
   ({ sku, name, barcodes[], image }), not raw products.json tuples — the
   normalization step lives in updater.js, once, shared by both the
   first-load and background-update paths. build() is safe to call more
   than once: a silent background sync (see updater.js) rebuilds the live
   index in place when the database updates, so every Map is cleared first.

   searchEngine has two distinct strategies, each with its own explicit
   priority (unchanged from the original app — do not "unify" these):
     query()          — manual typed search: exact SKU -> last 6 digits
     queryPelican()    — camera search: full barcode -> exact SKU -> last 6
   Neither ever guesses — if multiple products match, the caller must
   present a choice.
   ============================================================================ */

let products = [];
const bySku = new Map();
const byBarcode = new Map();
const bySuffix6 = new Map();
let nameSearchCache = [];
let barcodeFlatCache = [];

/* DMart live-miss cache (browser only, until site data cleared) */
const DMART_CACHE_KEY = 'smouha_dmart_product_cache_v1';
const dmartBySku = new Map();
const dmartByBarcode = new Map();
const dmartBySuffix6 = new Map();
let dmartCacheLoaded = false;

function loadDmartCache() {
  if (dmartCacheLoaded) return;
  dmartCacheLoaded = true;
  try {
    const raw = localStorage.getItem(DMART_CACHE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return;
    Object.values(obj).forEach((rec) => {
      if (rec && rec.sku) indexDmartRecord(rec, false);
    });
  } catch (e) {}
}

function persistDmartCache() {
  try {
    const obj = {};
    dmartBySku.forEach((p, sku) => {
      obj[sku] = {
        sku: p.sku,
        name: p.name,
        barcodes: p.barcodes || [],
        image: p.image || '',
        productId: p.productId || null,
      };
    });
    localStorage.setItem(DMART_CACHE_KEY, JSON.stringify(obj));
  } catch (e) {}
}

function indexDmartRecord(rec, save) {
  if (!rec || !rec.sku) return null;
  const p = {
    id: 'dmart:' + rec.sku,
    sku: String(rec.sku),
    name: rec.name || String(rec.sku),
    barcodes: Array.isArray(rec.barcodes) ? rec.barcodes.map(String) : [],
    image: rec.image || '',
    productId: rec.productId || null,
    fromDmart: true,
  };
  dmartBySku.set(p.sku, p);
  p.barcodes.forEach((bc) => {
    if (!bc) return;
    dmartByBarcode.set(bc, p);
    if (bc.length >= 6) dmartBySuffix6.set(bc.slice(-6), p);
  });
  if (p.sku.length >= 6) dmartBySuffix6.set(p.sku.slice(-6), p);
  if (p.image && /^https?:\/\//i.test(p.image)) {
    try {
      const map = loadImageCache();
      map[p.sku] = p.image;
      imageCache = map;
      if (save !== false) persistImageCache();
    } catch (e) {}
  }
  if (save !== false) persistDmartCache();
  return p;
}

export function registerDmartProduct(rec) {
  loadDmartCache();
  return indexDmartRecord(rec, true);
}

/** Image-only cache (SKU → https URL from DMart). Survives until cleared. */
const DMART_IMAGE_KEY = 'smouha_dmart_image_cache_v1';
let imageCache = null;
function loadImageCache() {
  if (imageCache) return imageCache;
  imageCache = {};
  try {
    const raw = localStorage.getItem(DMART_IMAGE_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object') imageCache = o;
    }
  } catch (e) {}
  return imageCache;
}
function persistImageCache() {
  try {
    localStorage.setItem(DMART_IMAGE_KEY, JSON.stringify(imageCache || {}));
  } catch (e) {}
}
export function getDmartImage(sku) {
  if (!sku) return '';
  const map = loadImageCache();
  const u = map[String(sku)];
  return u && /^https?:\/\//i.test(u) ? u : '';
}
export function setDmartImage(sku, url) {
  if (!sku || !url || !/^https?:\/\//i.test(String(url))) return;
  const map = loadImageCache();
  map[String(sku)] = String(url).trim();
  imageCache = map;
  persistImageCache();
  // also refresh product cache image if present
  const p = findDmartBySku(String(sku));
  if (p) {
    p.image = String(url).trim();
    persistDmartCache();
  }
}
export function clearDmartCache() {
  try { localStorage.removeItem(DMART_CACHE_KEY); } catch (e) {}
  try { localStorage.removeItem(DMART_IMAGE_KEY); } catch (e) {}
  dmartBySku.clear();
  dmartByBarcode.clear();
  dmartBySuffix6.clear();
  dmartCacheLoaded = false;
  imageCache = {};
  return true;
}
export function dmartCacheStats() {
  loadDmartCache();
  const imgs = loadImageCache();
  return { products: dmartBySku.size, images: Object.keys(imgs).length };
}

function findDmartBySku(sku) {
  loadDmartCache();
  return dmartBySku.get(String(sku)) || null;
}
function findDmartByBarcode(bc) {
  loadDmartCache();
  return dmartByBarcode.get(String(bc)) || null;
}
function findDmartBySuffix(suf) {
  loadDmartCache();
  return dmartBySuffix6.get(String(suf)) || null;
}

export function build(records) {
  products = records.map((r, i) => ({
    id: i,
    sku: String(r.sku || ''),
    name: r.name || 'Unnamed product',
    barcodes: r.barcodes || [],
    image: r.image || ''
  }));

  bySku.clear();
  byBarcode.clear();
  bySuffix6.clear();
  nameSearchCache = [];
  barcodeFlatCache = [];

  for (const p of products) {
    if (p.sku) bySku.set(p.sku, p);
    for (const bc of p.barcodes) {
      if (!byBarcode.has(bc)) byBarcode.set(bc, []);
      byBarcode.get(bc).push(p);
      barcodeFlatCache.push({ product: p, barcode: bc });

      if (bc.length >= 6) {
        const suf = bc.slice(-6);
        if (!bySuffix6.has(suf)) bySuffix6.set(suf, []);
        bySuffix6.get(suf).push(p);
      }
    }
    nameSearchCache.push({ product: p, lowerName: p.name.toLowerCase() });
  }
}

export function findBySku(sku) {
  const local = bySku.get(sku);
  if (local) return local;
  return findDmartBySku(sku);
}
export function findByBarcode(code) {
  const local = byBarcode.get(code);
  if (local) return Array.isArray(local) ? local : [local];
  const d = findDmartByBarcode(code);
  return d ? [d] : [];
}
export function findBySuffix(suffix) {
  const local = bySuffix6.get(suffix) || [];
  const list = Array.isArray(local) ? local.slice() : (local ? [local] : []);
  const d = findDmartBySuffix(suffix);
  if (d && !list.some((x) => x.sku === d.sku)) list.push(d);
  return list;
}
export function getBySkuList(skus) { return skus.map(s => findBySku(String(s))).filter(Boolean); }
export function count() { return products.length; }
export function getMapsCount() { return { bySku: bySku.size, byBarcode: byBarcode.size, bySuffix6: bySuffix6.size }; }

export function searchNames(query, limit = 8) {
  const q = query.toLowerCase();
  const results = [];
  for (let i = 0; i < nameSearchCache.length && results.length < limit; i++) {
    if (nameSearchCache[i].lowerName.includes(q)) results.push(nameSearchCache[i].product);
  }
  return results;
}

/** Priority tier 4: SKU starts with the typed text (excludes exact match,
 *  which is already handled separately at higher priority). */
export function skusStartingWith(prefix, limit = 10) {
  const results = [];
  for (let i = 0; i < products.length && results.length < limit; i++) {
    const p = products[i];
    if (p.sku && p.sku !== prefix && p.sku.startsWith(prefix)) results.push(p);
  }
  return results;
}

/** Priority tier 5: any barcode starts with the typed text. */
export function barcodesStartingWith(prefix, limit = 10) {
  const results = [];
  const seen = new Set();
  for (let i = 0; i < barcodeFlatCache.length && results.length < limit; i++) {
    const entry = barcodeFlatCache[i];
    if (entry.barcode !== prefix && entry.barcode.startsWith(prefix) && !seen.has(entry.product.id)) {
      seen.add(entry.product.id);
      results.push(entry.product);
    }
  }
  return results;
}

function dedupe(list) {
  const seen = new Set();
  return list.filter(p => (seen.has(p.id) ? false : (seen.add(p.id), true)));
}

/** Manual typed search: exact SKU -> last 6 digits. Full barcode is
 *  intentionally NOT supported for manual typing (unchanged behavior). */
export function query(raw) {
  const q = raw.trim();
  if (!q) return { type: 'empty', results: [] };
  if (!/^[0-9A-Za-z]+$/.test(q)) return { type: 'invalid', results: [] };

  const skuMatch = findBySku(q);
  if (skuMatch) return { type: 'sku', results: [skuMatch] };

  if (q.length >= 4) {
    const suffix = q.length >= 6 ? q.slice(-6) : q;
    const suffixMatches = findBySuffix(suffix);
    if (suffixMatches.length) return { type: 'suffix', results: dedupe(suffixMatches) };
  }

  return { type: 'none', results: [] };
}

/** Pelican Mode (camera) search: full barcode -> exact SKU -> last 6 digits. */
export function queryPelican(raw) {
  const q = raw.trim();
  if (!q) return { type: 'empty', results: [] };
  if (!/^[0-9A-Za-z]+$/.test(q)) return { type: 'invalid', results: [] };

  const barcodeMatches = findByBarcode(q);
  if (barcodeMatches.length) return { type: 'barcode', results: dedupe(barcodeMatches) };

  const skuMatch = findBySku(q);
  if (skuMatch) return { type: 'sku', results: [skuMatch] };

  if (q.length >= 4) {
    const suffix = q.length >= 6 ? q.slice(-6) : q;
    const suffixMatches = findBySuffix(suffix);
    if (suffixMatches.length) return { type: 'suffix', results: dedupe(suffixMatches) };
  }

  return { type: 'none', results: [] };
}

/** Smart priority search for the suggestions dropdown:
 *    1) Exact SKU match
 *    2) Exact Barcode match (any entry in barcodes[])
 *    3) Last 6 digits of Barcode (exact)
 *    4) SKU starts with typed text
 *    5) Barcode starts with typed text
 *    6) Product Name (contains)
 *  Returns up to `limit` { product, matchField } entries, deduplicated. */
export function computeSuggestions(query, limit = 10) {
  const q = query;
  const results = [];
  const seen = new Set();
  function addAll(list, field) {
    for (const p of list) {
      if (results.length >= limit) return;
      if (!seen.has(p.id)) { seen.add(p.id); results.push({ product: p, matchField: field }); }
    }
  }

  const skuExact = findBySku(q);
  if (skuExact) addAll([skuExact], 'sku-exact');

  if (results.length < limit) addAll(findByBarcode(q), 'barcode-exact');

  if (results.length < limit && q.length >= 4) {
    const suffix = q.length >= 6 ? q.slice(-6) : q;
    addAll(findBySuffix(suffix), 'barcode-suffix');
  }

  if (results.length < limit) addAll(skusStartingWith(q, limit - results.length), 'sku-prefix');
  if (results.length < limit) addAll(barcodesStartingWith(q, limit - results.length), 'barcode-prefix');
  if (results.length < limit) addAll(searchNames(q, limit - results.length), 'name');

  return results.slice(0, limit);
}

/** Wraps the first occurrence of `needle` inside `text` in a highlight
 *  span. Falls back to plain escaped text if there's no match. Takes an
 *  `escapeHtml` function as a parameter to avoid a circular import with
 *  utils.js in bundling setups that don't dedupe (harmless either way). */
export function highlightMatch(text, needle, escapeHtml) {
  if (!needle) return escapeHtml(text);
  const idx = text.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return escapeHtml(text);
  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + needle.length);
  const after = text.slice(idx + needle.length);
  return escapeHtml(before) + '<mark class="suggestion-highlight">' + escapeHtml(match) + '</mark>' + escapeHtml(after);
}
