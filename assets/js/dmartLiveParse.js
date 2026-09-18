/* dmartLiveParse.js — pure helpers for DMart live field extraction (no UI state) */
export function findNumericField(root, keys) {
  if (!root || typeof root !== 'object') return null;
  for (const key of keys) {
    if (root[key] == null || root[key] === '') continue;
    const n = Number(root[key]);
    if (Number.isFinite(n)) return n;
  }
  // nested common bags
  for (const bag of ['inventory', 'stock', 'quantities', 'pricing', 'price_info']) {
    const node = root[bag];
    if (!node || typeof node !== 'object') continue;
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
  const list = asList(data);
  const skuStr = String(sku).trim();
  if (!skuStr) return null;
  const match = list.find((row) => {
    if (!row || typeof row !== 'object') return false;
    const candidates = [
      row.sku, row.SKU, row.product_sku, row.productSku, row.sku_code, row.skuCode,
      row.external_id, row.externalId, row.barcode, row.product_barcode,
      row.merchant_sku, row.merchantSku, row.item_sku, row.itemSku,
    ].filter((x) => x != null).map((x) => String(x).trim());
    return candidates.includes(skuStr);
  });
  return match || null;
}

export function extractLiveFields(raw, sku) {
  const node = pickMatchingProduct(raw, sku);
  if (!node) {
    return { onHand: null, reserved: null, price: null, productId: null, matched: false };
  }
  const onHand = findNumericField(node, [
    'on_hand_quantity', 'onHandQuantity', 'on_hand', 'onHand',
  ]);
  const reserved = findNumericField(node, [
    'reserved_quantity', 'reservedQuantity', 'reserved',
  ]);
  const priceKeys = [
    'selling_price', 'sellingPrice',
    'unit_selling_price', 'unitSellingPrice',
    'final_price', 'finalPrice',
    'retail_price', 'retailPrice',
    'platform_price', 'platformPrice',
    'vat_price', 'vatPrice',
    'price',
    'unit_price', 'unitPrice',
  ];
  const price = findNumericField(node, priceKeys);
  const productId = findStringField(node, [
    'id', 'product_id', 'productId', 'uuid', 'product_uuid', 'productUuid',
  ]);
  return {
    onHand: onHand === null ? null : onHand,
    reserved: reserved === null ? null : reserved,
    price: price === null ? null : price,
    productId,
    matched: true,
  };
}

export function hasCompleteLiveData(data) {
  if (!data) return false;
  return data.onHand != null || data.reserved != null || data.price != null;
}

export function buildSearchUrl(base, entity, sku, warehouseId) {
  const q = encodeURIComponent(sku);
  const w = encodeURIComponent(warehouseId);
  return `${base}/${entity}/warehouse/${w}/products?per_page=20&page=1&sort=PRODUCT_NAME_ASC&query=${q}`;
}

export function buildDetailUrl(base, entity, productId, warehouseId) {
  const w = encodeURIComponent(warehouseId);
  const id = encodeURIComponent(productId);
  return `${base}/${entity}/warehouse/${w}/products/${id}`;
}
