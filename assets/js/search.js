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

export function findBySku(sku) { return bySku.get(sku) || null; }
export function findByBarcode(barcode) { return byBarcode.get(barcode) || []; }
export function findBySuffix(suffix) { return bySuffix6.get(suffix) || []; }
export function getBySkuList(skus) { return skus.map(s => bySku.get(s)).filter(Boolean); }
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
