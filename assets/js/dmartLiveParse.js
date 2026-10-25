/* dmartLiveParse.js — pure helpers for DMart live field extraction (no UI state) */
export function findNumericField(root, keys) {
  if (!root || typeof root !== 'object') return null;
  for (const key of keys) {
    if (root[key] == null || root[key] === '') continue;
    const n = Number(root[key]);
    if (Number.isFinite(n)) return n;
  }
  // nested common bags
  for (const bag of ['inventory', 'stock', 'quantities', 'pricing', 'price_info', 'warehouse_stock']) {
    const node = root[bag];
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    for (const key of keys) {
      if (node[key] == null || node[key] === '') continue;
      const n = Number(node[key]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

export function findStringField(root, keys) {
  if (!root || typeof root !== 'object') return null;
  for (const key of keys) {
    if (root[key] == null || root[key] === '') continue;
    return String(root[key]);
  }
  return null;
}

export function isSearchListPayload(raw) {
  if (!raw || typeof raw !== 'object') return false;
  if (Array.isArray(raw)) return true;
  for (const key of ['results', 'products', 'items', 'records', 'content']) {
    if (Array.isArray(raw[key])) return true;
    if (raw[key] && typeof raw[key] === 'object' && Array.isArray(raw[key].results)) return true;
  }
  if (Array.isArray(raw.data)) return true;
  if (raw.data && typeof raw.data === 'object' && Array.isArray(raw.data.results)) return true;
  return false;
}

export function asList(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (typeof data !== 'object') return [];
  for (const key of ['results', 'data', 'products', 'items', 'records']) {
    if (Array.isArray(data[key])) return data[key];
    if (data[key] && Array.isArray(data[key].results)) return data[key].results;
    if (data[key] && Array.isArray(data[key].data)) return data[key].data;
  }
  return [data];
}

export function pickMatchingProduct(data, sku) {
  if (!data || typeof data !== 'object') return null;
  // Single-product detail unwrap ({ product: {...} } or direct detail object)
  if (!Array.isArray(data) && !isSearchListPayload(data)) {
    if (data.product && typeof data.product === 'object' && !Array.isArray(data.product)) {
      return data.product;
    }
    if (data.data && typeof data.data === 'object' && !Array.isArray(data.data)) {
      return data.data;
    }
    if (
      data.id != null ||
      data.sku != null ||
      data.on_hand_quantity != null ||
      data.onHandQuantity != null ||
      Array.isArray(data.locations_with_expiry_date)
    ) {
      return data;
    }
  }
  const list = asList(data);
  const skuStr = String(sku).trim();
  if (!skuStr) return null;
  // Pass 1: exact primary SKU match
  const exactSku = list.find((row) => {
    if (!row || typeof row !== 'object') return false;
    const primary = [
      row.sku, row.SKU, row.product_sku, row.productSku, row.sku_code, row.skuCode,
    ].filter((x) => x != null).map((x) => String(x).trim());
    return primary.includes(skuStr);
  });
  if (exactSku) return exactSku;
  // Pass 2: secondary / barcode candidates
  const match = list.find((row) => {
    if (!row || typeof row !== 'object') return false;
    const candidates = [
      row.external_id, row.externalId, row.barcode, row.product_barcode,
      row.merchant_sku, row.merchantSku, row.item_sku, row.itemSku,
    ].filter((x) => x != null).map((x) => String(x).trim());
    return candidates.includes(skuStr);
  });
  return match || null;
}

const PRICE_KEYS = [
  'selling_price', 'sellingPrice',
  'unit_selling_price', 'unitSellingPrice',
  'final_price', 'finalPrice',
  'retail_price', 'retailPrice',
  'platform_price', 'platformPrice',
  'vat_price', 'vatPrice',
  'price',
  'unit_price', 'unitPrice',
];

/**
 * Search-list extractor: NEVER trusts `reserved_quantity` from `/products?query=...`
 * because the BFF search index holds stale/cached reservation counts.
 */
export function extractSearchLiveFields(raw, sku) {
  const node = pickMatchingProduct(raw, sku);
  if (!node) {
    return { onHand: null, reserved: null, price: null, productId: null, matched: false };
  }
  const onHand = findNumericField(node, [
    'on_hand_quantity', 'onHandQuantity', 'on_hand', 'onHand',
  ]);
  const price = findNumericField(node, PRICE_KEYS);
  const productId = findStringField(node, [
    'id', 'product_id', 'productId', 'uuid', 'product_uuid', 'productUuid',
  ]);
  return {
    onHand: onHand === null ? null : onHand,
    reserved: null,
    price: price === null ? null : price,
    productId,
    matched: true,
  };
}

/**
 * Authoritative single-product detail extractor (`/product/{productId}`).
 * On a valid detail payload, omitted/null `reserved_quantity` means 0 active reservations.
 */
export function extractDetailLiveFields(raw, sku) {
  if (!raw || typeof raw !== 'object' || isSearchListPayload(raw)) {
    return { onHand: null, reserved: null, price: null, productId: null, matched: false };
  }
  const node = pickMatchingProduct(raw, sku);
  if (!node || typeof node !== 'object') {
    return { onHand: null, reserved: null, price: null, productId: null, matched: false };
  }
  let onHand = findNumericField(node, [
    'on_hand_quantity', 'onHandQuantity', 'on_hand', 'onHand',
  ]);
  if (onHand === null && Array.isArray(node.locations_with_expiry_date)) {
    onHand = 0;
    for (const r of node.locations_with_expiry_date) {
      if (r && typeof r === 'object') {
        const q = Number(r.qty ?? r.quantity ?? r.on_hand_quantity ?? 0);
        if (Number.isFinite(q) && q > 0) onHand += q;
      }
    }
  }
  const rawReserved = findNumericField(node, [
    'reserved_quantity', 'reservedQuantity', 'reserved_qty', 'reservedQty',
  ]);
  const hasDetailIdentity =
    onHand !== null ||
    node.id != null ||
    node.sku != null ||
    Array.isArray(node.locations_with_expiry_date);
  const reserved =
    rawReserved !== null && rawReserved >= 0
      ? rawReserved
      : hasDetailIdentity
        ? 0
        : null;
  const price = findNumericField(node, PRICE_KEYS);
  const productId = findStringField(node, [
    'id', 'product_id', 'productId', 'uuid', 'product_uuid', 'productUuid',
  ]);
  return {
    onHand: onHand === null ? null : onHand,
    reserved,
    price: price === null ? null : price,
    productId,
    matched: !!hasDetailIdentity,
  };
}

export function extractLiveFields(raw, sku) {
  if (isSearchListPayload(raw)) {
    return extractSearchLiveFields(raw, sku);
  }
  return extractDetailLiveFields(raw, sku);
}

export function hasCompleteLiveData(data) {
  if (!data) return false;
  // Stock truth needs BOTH on-hand and reserved confirmed from detail.
  return data.onHand != null && data.reserved != null;
}

export function buildSearchUrl(base, entity, sku, warehouseId) {
  const q = encodeURIComponent(sku);
  const w = encodeURIComponent(warehouseId);
  return `${base}/${entity}/warehouse/${w}/products?per_page=20&page=1&sort=PRODUCT_NAME_ASC&query=${q}`;
}

export function buildDetailUrl(base, entity, productId, warehouseId) {
  const w = encodeURIComponent(warehouseId);
  const id = encodeURIComponent(productId);
  return `${base}/${entity}/warehouse/${w}/product/${id}`;
}
