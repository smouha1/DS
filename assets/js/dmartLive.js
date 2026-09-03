/* ============================================================================
   dmartLive.js — MODULE: live Dmart inventory + price
   ------------------------------------------------------------------------
   Preferred path: Chrome "DMart Bridge" extension (session-based, no token
   shared with this page).

   Fallback: direct BFF fetch (often blocked by CORS) using optional local
   token in localStorage "smouha_dmart_token" for advanced/dev use only.

   Authoritative fields:
     on_hand_quantity  → Available
     reserved_quantity → Reserved
     selling price field → Price EGP

   Race protection: sku + warehouseId + monotonic token.
   Failures show "—" and never break search / barcode / QR / popup.
   ============================================================================ */

import { getSelectedId } from './warehouse.js';

const ENTITY = 'HF_EG';
const BFF_BASE = 'https://im-bff-live-me.deliveryhero.io/v2/entity';
const CACHE_TTL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
const BRIDGE_TIMEOUT_MS = 12_000;
const LIVE_MAX_WAIT_MS = 60_000;
const LIVE_RETRY_DELAYS_MS = [0, 900, 1500, 2500, 4000, 6000, 9000, 12000];
const TOKEN_KEY = 'smouha_dmart_token';

/* Supabase read-only mirror (anon). Written by the PC extension — never holds DMart token. */
const SB_URL = 'https://kryrvfyzmrydbqkmfubt.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtyeXJ2Znl6bXJ5ZGJxa21mdWJ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcxNDY5MDksImV4cCI6MjEwMjcyMjkwOX0.Zg9mXQ-1f2eRGsx92dy8kYfduDVm-eOpX1wheuhCpcs';
const SB_MAX_AGE_MS = 15 * 60 * 1000; // ignore rows older than 15 minutes

/** @type {Map<string, { at:number, data:object }>} */
const cache = new Map();

let activeToken = 0;
let activeSku = null;
let activeWarehouseId = null;
let bridgeReady = false;
let bridgeReadyKnown = false;
let lastBridgeAt = 0;
const BRIDGE_OFFLINE_MS = 45_000;

export function getStoredBearer() {
  try {
    let t = localStorage.getItem(TOKEN_KEY) || '';
    t = t.trim();
    if (/^bearer\s+/i.test(t)) t = t.replace(/^bearer\s+/i, '').trim();
    return t;
  } catch (e) {
    return '';
  }
}

export function setStoredBearer(token) {
  try {
    if (token && String(token).trim()) {
      localStorage.setItem(TOKEN_KEY, String(token).trim());
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch (e) { /* storage unavailable */ }
}

function buildSearchUrl(sku, warehouseId) {
  const q = encodeURIComponent(sku);
  const w = encodeURIComponent(warehouseId);
  return `${BFF_BASE}/${ENTITY}/warehouse/${w}/products?per_page=20&page=1&sort=PRODUCT_NAME_ASC&query=${q}`;
}

function buildDetailUrl(productId, warehouseId) {
  const p = encodeURIComponent(productId);
  const w = encodeURIComponent(warehouseId);
  return `${BFF_BASE}/${ENTITY}/warehouse/${w}/product/${p}`;
}

function findNumericField(root, keys) {
  if (!root || typeof root !== 'object') return null;
  const queue = [root];
  const seen = new Set();
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(node, k)) {
        const v = node[k];
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
      }
    }
    if (Array.isArray(node)) {
      for (const item of node) queue.push(item);
    } else {
      for (const v of Object.values(node)) {
        if (v && typeof v === 'object') queue.push(v);
      }
    }
  }
  return null;
}

function findStringField(root, keys) {
  if (!root || typeof root !== 'object') return null;
  const queue = [root];
  const seen = new Set();
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(node, k) && node[k] != null && String(node[k]).trim()) {
        return String(node[k]);
      }
    }
    if (Array.isArray(node)) {
      for (const item of node) queue.push(item);
    } else {
      for (const v of Object.values(node)) {
        if (v && typeof v === 'object') queue.push(v);
      }
    }
  }
  return null;
}

function asList(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  for (const key of ['results', 'data', 'items', 'products', 'records', 'content']) {
    if (Array.isArray(data[key])) return data[key];
    if (data[key] && Array.isArray(data[key].results)) return data[key].results;
    if (data[key] && Array.isArray(data[key].data)) return data[key].data;
  }
  return [data];
}

function pickMatchingProduct(data, sku) {
  const list = asList(data);
  const skuStr = String(sku).trim();
  if (!skuStr) return null;
  // Exact SKU match only — never use list[0] (search often returns many unrelated products)
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

function extractLiveFields(raw, sku) {
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

async function fetchJson(url, bearer) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers = {
      Accept: 'application/json, text/plain, */*',
    };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;

    const res = await fetch(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      signal: ctrl.signal,
      headers,
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } catch (e) {
    const msg = (e && e.message) ? String(e.message) : '';
    if (!e.status && /failed to fetch|networkerror|cors|load failed/i.test(msg)) {
      const err = new Error('CORS blocked');
      err.status = 0;
      err.cors = true;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function newRequestId() {
  return 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

/** Talk to the DMart Bridge extension via window.postMessage. */
function requestViaExtension(sku, warehouseId) {
  return new Promise((resolve) => {
    const requestId = newRequestId();
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMsg);
      resolve({ ok: false, reason: 'bridge-timeout', onHand: null, reserved: null, price: null });
    }, BRIDGE_TIMEOUT_MS);

    function onMsg(event) {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== 'smouha-dmart-bridge') return;
      if (data.type === 'SMOUHA_PICK_DMART_BRIDGE_READY') {
        markBridgeReady();
        return;
      }
      if (data.type !== 'SMOUHA_PICK_DMART_RESPONSE') return;
      if (data.requestId !== requestId) return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMsg);
      markBridgeReady();

      if (data.success && data.data) {
        resolve({
          ok: true,
          onHand: data.data.available != null ? data.data.available : null,
          reserved: data.data.reserved != null ? data.data.reserved : null,
          price: data.data.price != null ? data.data.price : null,
          via: 'extension',
        });
        return;
      }

      const code = (data.error && data.error.code) || 'UNKNOWN_ERROR';
      let reason = 'fetch-failed';
      if (code === 'AUTH_REQUIRED') reason = 'auth-required';
      else if (code === 'PRODUCT_NOT_FOUND') reason = 'not-found';
      else if (code === 'TIMEOUT') reason = 'fetch-failed';
      resolve({ ok: false, reason, onHand: null, reserved: null, price: null, via: 'extension' });
    }

    window.addEventListener('message', onMsg);
    try {
      window.postMessage(
        {
          type: 'SMOUHA_PICK_DMART_REQUEST',
          requestId,
          warehouseId: String(warehouseId),
          sku: String(sku),
        },
        window.location.origin
      );
    } catch (e) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve({ ok: false, reason: 'no-bridge', onHand: null, reserved: null, price: null });
      }
    }
  });
}

async function fetchViaDirect(sku, warehouseId) {
  const bearer = getStoredBearer();
  if (!bearer) {
    return { onHand: null, reserved: null, price: null, ok: false, reason: 'no-token' };
  }

  try {
    const searchRaw = await fetchJson(buildSearchUrl(sku, warehouseId), bearer);
    let fields = extractLiveFields(searchRaw, sku);

    if (fields.productId && (fields.onHand === null || fields.reserved === null || fields.price === null)) {
      try {
        const detailRaw = await fetchJson(buildDetailUrl(fields.productId, warehouseId), bearer);
        const detail = extractLiveFields(detailRaw, sku);
        fields = {
          onHand: fields.onHand !== null ? fields.onHand : detail.onHand,
          reserved: fields.reserved !== null ? fields.reserved : detail.reserved,
          price: fields.price !== null ? fields.price : detail.price,
          productId: fields.productId,
        };
      } catch (e) {
        console.info('[dmartLive] detail fetch failed:', e && e.message ? e.message : 'error');
      }
    }

    if (fields.onHand === null && fields.reserved === null && fields.price === null) {
      return { onHand: null, reserved: null, price: null, ok: false, reason: 'no-fields' };
    }

    return {
      onHand: fields.onHand,
      reserved: fields.reserved,
      price: fields.price,
      ok: true,
      via: 'direct',
    };
  } catch (e) {
    const status = e && e.status;
    let reason = 'fetch-failed';
    if (e && e.cors) reason = 'cors';
    else if (status === 401 || status === 403) reason = 'unauthorized';
    return { onHand: null, reserved: null, price: null, ok: false, reason };
  }
}

function hasCompleteLiveData(data) {
  return !!data && data.onHand != null && data.reserved != null && data.price != null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}



async function fetchViaLiveRelay(sku, warehouseId) {
  if (!SB_URL || !SB_ANON || !sku || !warehouseId) {
    return { ok: false, reason: 'supabase-config', onHand: null, reserved: null, price: null };
  }
  try {
    // 1) Create pending request
    const createRes = await fetch(SB_URL + '/rest/v1/dmart_live_requests', {
      method: 'POST',
      headers: {
        apikey: SB_ANON,
        Authorization: 'Bearer ' + SB_ANON,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        warehouse_id: String(warehouseId),
        sku: String(sku),
        status: 'pending',
      }),
    });
    if (!createRes.ok) {
      return { ok: false, reason: 'relay-create-failed', onHand: null, reserved: null, price: null };
    }
    const created = await createRes.json();
    const row = Array.isArray(created) ? created[0] : created;
    if (!row || !row.id) {
      return { ok: false, reason: 'relay-create-failed', onHand: null, reserved: null, price: null };
    }
    const id = row.id;

    // 2) Poll for done/error (max ~9s, target <3s when PC extension is awake)
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      await sleep(200);
      const q =
        SB_URL +
        '/rest/v1/dmart_live_requests?id=eq.' + encodeURIComponent(id) +
        '&select=status,available,reserved,price,error_code';
      const res = await fetch(q, {
        headers: {
          apikey: SB_ANON,
          Authorization: 'Bearer ' + SB_ANON,
          Accept: 'application/json',
        },
      });
      if (!res.ok) continue;
      const rows = await res.json();
      if (!rows || !rows.length) continue;
      const r = rows[0];
      if (r.status === 'done') {
        const onHand = r.available != null ? Number(r.available) : null;
        const reserved = r.reserved != null ? Number(r.reserved) : null;
        const price = r.price != null ? Number(r.price) : null;
        return {
          ok: true,
          onHand: Number.isFinite(onHand) ? onHand : null,
          reserved: Number.isFinite(reserved) ? reserved : null,
          price: Number.isFinite(price) ? price : null,
          via: 'live-relay',
        };
      }
      if (r.status === 'error') {
        return {
          ok: false,
          reason: r.error_code === 'AUTH_REQUIRED' ? 'auth-required' : 'relay-error',
          onHand: null,
          reserved: null,
          price: null,
          via: 'live-relay',
        };
      }
    }
    return { ok: false, reason: 'relay-timeout', onHand: null, reserved: null, price: null };
  } catch (e) {
    return { ok: false, reason: 'relay-error', onHand: null, reserved: null, price: null };
  }
}


/* ---- Bridge online indicator + stock adjust (desktop, extension executor) ---- */

export function isBridgeOnline() {
  return !!bridgeReady;
}

function isDesktopViewport() {
  try {
    return window.matchMedia('(min-width: 900px)').matches;
  } catch (e) {
    return window.innerWidth >= 900;
  }
}

export function updateBridgeStatusUi() {
  const el = document.getElementById('bridgeStatusBadge');
  if (!el) return;
  const online = !!bridgeReady;
  el.classList.toggle('is-online', online);
  el.classList.toggle('is-offline', !online);
  el.setAttribute('data-state', online ? 'online' : 'offline');
  el.title = online
    ? 'Connected to DMart Bridge extension'
    : 'DMart Bridge offline — install/enable extension on this PC';
  const label = el.querySelector('.bridge-status-label');
  if (label) label.textContent = online ? 'Bridge Online' : 'Bridge Offline';
  // Show/hide adjust panels on live cards
  document.querySelectorAll('.dmart-adjust-panel').forEach((panel) => {
    const show = online && isDesktopViewport();
    panel.hidden = !show;
  });
}

function markBridgeReady() {
  markBridgeReady();
  lastBridgeAt = Date.now();
  updateBridgeStatusUi();
}

function markBridgeOffline() {
  bridgeReady = false;
  bridgeReadyKnown = true;
  updateBridgeStatusUi();
}

function requestStockAdjust({ sku, warehouseId, quantity, direction }) {
  return new Promise((resolve) => {
    const requestId = 'adj_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      window.removeEventListener('message', onMsg);
      resolve({ success: false, error: { code: 'TIMEOUT', message: 'Bridge timed out' } });
    }, 20000);

    function onMsg(event) {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== 'smouha-dmart-bridge') return;
      if (data.type !== 'SMOUHA_PICK_DMART_STOCK_ADJUST_RESPONSE') return;
      if (data.requestId !== requestId) return;
      if (done) return;
      done = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMsg);
      resolve(data);
    }
    window.addEventListener('message', onMsg);
    try {
      window.postMessage(
        {
          type: 'SMOUHA_PICK_DMART_STOCK_ADJUST',
          requestId,
          sku: String(sku),
          warehouseId: String(warehouseId),
          quantity: Number(quantity) || 1,
          direction: direction === 'decrease' ? 'decrease' : 'increase',
        },
        window.location.origin
      );
    } catch (e) {
      clearTimeout(timer);
      window.removeEventListener('message', onMsg);
      resolve({ success: false, error: { code: 'POST_FAILED', message: String(e && e.message || e) } });
    }
  });
}

function buildAdjustPanelHtml(sku) {
  const safe = String(sku || '').replace(/"/g, '');
  return `
    <div class="dmart-adjust-panel" data-adjust-sku="${safe}" hidden>
      <div class="dmart-adjust-title">Adjust stock <span class="dmart-adjust-hint">PC · Bridge</span></div>
      <div class="dmart-adjust-row">
        <button type="button" class="dmart-adjust-btn dmart-adjust-minus" data-adj="minus" aria-label="Decrease">−</button>
        <input type="number" class="dmart-adjust-qty" min="1" max="15" value="1" inputmode="numeric" aria-label="Quantity" />
        <button type="button" class="dmart-adjust-btn dmart-adjust-plus" data-adj="plus" aria-label="Increase">+</button>
      </div>
      <div class="dmart-adjust-msg" data-adj-msg hidden></div>
    </div>`;
}

function bindAdjustPanel(root, sku) {
  if (!root || !sku) return;
  const panel = root.querySelector('.dmart-adjust-panel');
  if (!panel || panel.dataset.bound === '1') return;
  panel.dataset.bound = '1';
  const qtyInput = panel.querySelector('.dmart-adjust-qty');
  const msg = panel.querySelector('[data-adj-msg]');

  function clampQty() {
    let n = parseInt(qtyInput.value, 10);
    if (!Number.isFinite(n)) n = 1;
    n = Math.min(15, Math.max(1, n));
    qtyInput.value = String(n);
    return n;
  }

  async function run(direction) {
    if (!isBridgeOnline()) {
      if (msg) {
        msg.hidden = false;
        msg.textContent = 'Bridge offline';
        msg.className = 'dmart-adjust-msg is-err';
      }
      return;
    }
    if (!isDesktopViewport()) return;
    const quantity = clampQty();
    const warehouseId = getSelectedId();
    if (!warehouseId) {
      if (msg) {
        msg.hidden = false;
        msg.textContent = 'Select a warehouse first';
        msg.className = 'dmart-adjust-msg is-err';
      }
      return;
    }
    const sign = direction === 'increase' ? '+' : '−';
    const ok = window.confirm(
      'Confirm stock adjust?\n\nSKU: ' + sku + '\n' + sign + quantity + ' (' + direction + ')\n\nUses first Location + Expiry from DMart.'
    );
    if (!ok) return;

    panel.classList.add('is-busy');
    panel.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    if (msg) {
      msg.hidden = false;
      msg.className = 'dmart-adjust-msg';
      msg.textContent = 'Working…';
    }

    const res = await requestStockAdjust({ sku, warehouseId, quantity, direction });
    panel.classList.remove('is-busy');
    panel.querySelectorAll('button').forEach((b) => { b.disabled = false; });

    if (!res || !res.success) {
      const err = (res && res.error) || {};
      if (msg) {
        msg.hidden = false;
        msg.className = 'dmart-adjust-msg is-err';
        msg.textContent = (err.code || 'ERROR') + (err.message ? ': ' + err.message : '');
      }
      return;
    }
    const d = res.data || {};
    if (msg) {
      msg.hidden = false;
      msg.className = 'dmart-adjust-msg is-ok';
      msg.textContent =
        'OK ' +
        (d.stock_delta > 0 ? '+' : '') +
        d.stock_delta +
        (d.location ? ' · ' + d.location : '') +
        (d.available != null ? ' · on hand ' + d.available : '');
    }
    // Update live numbers on card
    if (d.available != null || d.reserved != null || d.price != null) {
      setLiveValues(root, {
        onHand: d.available != null ? d.available : null,
        reserved: d.reserved != null ? d.reserved : null,
        price: d.price != null ? d.price : null,
        ok: true,
      });
      root.classList.add('dmart-adjust-flash');
      setTimeout(() => root.classList.remove('dmart-adjust-flash'), 700);
      // bust cache for this sku
      try {
        const key = String(warehouseId) + '::' + String(sku);
        cache.delete(key);
      } catch (e) {}
    }
  }

  panel.querySelector('[data-adj="minus"]')?.addEventListener('click', () => run('decrease'));
  panel.querySelector('[data-adj="plus"]')?.addEventListener('click', () => run('increase'));
  qtyInput?.addEventListener('change', clampQty);
}


export async function fetchLiveProductInfo(sku, warehouseId) {
  if (!sku || !warehouseId) {
    return { onHand: null, reserved: null, price: null, ok: false, reason: 'missing-ids' };
  }

  const cacheKey = `${warehouseId}::${sku}`;
  const cached = cache.get(cacheKey);
  if (cached && hasCompleteLiveData(cached.data) && Date.now() - cached.at < CACHE_TTL_MS) {
    return { ...cached.data, ok: true, cached: true };
  }

  // 1) Prefer extension bridge (PC — solves CORS, uses portal session)
  const bridge = await requestViaExtension(sku, warehouseId);
  if (bridge.ok) {
    const data = {
      onHand: bridge.onHand,
      reserved: bridge.reserved,
      price: bridge.price,
    };
    if (hasCompleteLiveData(data)) {
      cache.set(cacheKey, { at: Date.now(), data });
      return { ...data, ok: true, via: 'extension' };
    }
    return { ...data, ok: false, reason: 'partial-data', via: 'extension' };
  }

  // 2) Live relay via Supabase → PC extension → DMart (fresh numbers)
  const relay = await fetchViaLiveRelay(sku, warehouseId);
  if (relay.ok) {
    const data = {
      onHand: relay.onHand,
      reserved: relay.reserved,
      price: relay.price,
    };
    cache.set(cacheKey, { at: Date.now(), data });
    return { ...data, ok: true, via: 'live-relay' };
  }

  // Bridge present but auth missing
  if (bridge.reason === 'auth-required') {
    return { onHand: null, reserved: null, price: null, ok: false, reason: 'auth-required' };
  }

  // 2) Fallback: direct (may CORS-fail without backend)
  const direct = await fetchViaDirect(sku, warehouseId);
  if (direct.ok) {
    const data = {
      onHand: direct.onHand,
      reserved: direct.reserved,
      price: direct.price,
    };
    if (hasCompleteLiveData(data)) {
      cache.set(cacheKey, { at: Date.now(), data });
      return { ...data, ok: true, via: 'direct' };
    }
    return { ...data, ok: false, reason: 'partial-data', via: 'direct' };
  }

  // Prefer clearer reason
  if (bridge.reason === 'bridge-timeout' || bridge.reason === 'no-bridge') {
    // If direct also failed with no-token/cors, show no-bridge when extension missing
    if (direct.reason === 'no-token' || direct.reason === 'cors') {
      return { onHand: null, reserved: null, price: null, ok: false, reason: 'no-bridge' };
    }
  }
  return {
    onHand: null,
    reserved: null,
    price: null,
    ok: false,
    reason: direct.reason || bridge.reason || 'fetch-failed',
  };
}

function formatUnits(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `${n} Units`;
}

function formatPrice(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const text = Number.isInteger(n) ? String(n) : n.toFixed(2);
  return `${text} EGP`;
}

export function setLiveLoading(root) {
  if (!root) return;
  root.querySelector('[data-live="available"]').textContent = '…';
  root.querySelector('[data-live="reserved"]').textContent = '…';
  root.querySelector('[data-live="price"]').textContent = '…';
  root.classList.add('is-loading');
  root.classList.remove('is-error', 'is-ready');
  const status = root.querySelector('[data-live="status"]');
  if (status) {
    status.textContent = '';
    status.hidden = true;
  }
}

export function setLiveValues(root, data) {
  if (!root) return;
  const avail = root.querySelector('[data-live="available"]');
  const res = root.querySelector('[data-live="reserved"]');
  const price = root.querySelector('[data-live="price"]');
  if (avail) avail.textContent = formatUnits(data.onHand);
  if (res) res.textContent = formatUnits(data.reserved);
  if (price) price.textContent = formatPrice(data.price);
  root.classList.remove('is-loading');
  root.classList.toggle('is-error', !data.ok);
  root.classList.toggle('is-ready', !!data.ok);
  const status = root.querySelector('[data-live="status"]');
  if (status) {
    if (data.ok) {
      status.textContent = '';
      status.hidden = true;
    } else {
      const map = {
        'no-token': 'Add Dmart token in Settings → Developer (or install DMart Bridge extension)',
        'no-bridge': 'DMart Bridge Extension not detected. Install it and keep portal.talabat.com signed in.',
        'auth-required': 'Talabat session required — open portal.talabat.com and sign in.',
        'unauthorized': 'Token/session expired — sign in again on portal.talabat.com',
        'cors': 'Browser blocked the API (CORS). Install DMart Bridge extension.',
        'fetch-failed': 'Could not reach Dmart API',
        'no-fields': 'API returned no stock/price fields',
        'not-found': 'Product not found in DMart for this warehouse',
        'partial-data': 'Waiting for complete DMart data…',
        'missing-ids': 'Select a warehouse first',
        'bridge-timeout': 'DMart Bridge timed out — check portal login',
      };
      status.textContent = map[data.reason] || 'Live data unavailable';
      status.hidden = false;
    }
  }
}

export function setLiveFailed(root) {
  setLiveValues(root, { onHand: null, reserved: null, price: null, ok: false });
}

export function requestLiveForProduct(sku) {
  const warehouseId = getSelectedId();
  const root = document.getElementById('dmartLiveCard');
  if (!root || !sku) return;

  try { bindAdjustPanel(root, sku); updateBridgeStatusUi(); } catch (e) {}

  activeToken += 1;
  const token = activeToken;
  activeSku = String(sku);
  activeWarehouseId = warehouseId ? String(warehouseId) : null;

  setLiveLoading(root);

  if (!warehouseId) {
    setLiveFailed(root);
    return;
  }

  const startedAt = Date.now();
  let attempt = 0;
  let lastData = null;

  const stillCurrent = () => {
    const current = document.getElementById('dmartLiveCard');
    return token === activeToken &&
      String(sku) === activeSku &&
      String(warehouseId) === String(activeWarehouseId) &&
      !!current &&
      current === root &&
      current.dataset.sku === String(sku);
  };

  const poll = async () => {
    while (stillCurrent() && Date.now() - startedAt < LIVE_MAX_WAIT_MS) {
      const delay = LIVE_RETRY_DELAYS_MS[Math.min(attempt, LIVE_RETRY_DELAYS_MS.length - 1)];
      if (delay > 0) await sleep(delay);
      if (!stillCurrent()) return;

      attempt += 1;
      try {
        const data = await fetchLiveProductInfo(sku, warehouseId);
        if (!stillCurrent()) return;

        lastData = data;

        // Do not replace the loading state with dashes just because the bridge
        // is waking up or returning a partial response. Keep polling instead.
        if (hasCompleteLiveData(data)) {
          setLiveValues(root, { ...data, ok: true });
          return;
        }

        // Definitive failures — stop spinner (do not wait full LIVE_MAX_WAIT)
        const stopReasons = new Set([
          'not-found', 'no-fields', 'auth-required', 'unauthorized',
          'no-token', 'missing-ids',
        ]);
        if (data && stopReasons.has(data.reason)) {
          setLiveValues(root, { ...data, ok: false });
          return;
        }

        const status = root.querySelector('[data-live="status"]');
        if (status) {
          status.textContent = 'Waiting for DMart data…';
          status.hidden = false;
        }
        root.classList.add('is-loading');
        root.classList.remove('is-error', 'is-ready');
      } catch (e) {
        if (!stillCurrent()) return;
        lastData = { ok: false, reason: 'fetch-failed' };
      }
    }

    if (!stillCurrent()) return;

    // One final state after the bounded wait. Keep the UI honest instead of
    // showing stale/ambiguous values forever.
    setLiveValues(root, lastData || {
      ok: false,
      reason: 'bridge-timeout',
      onHand: null,
      reserved: null,
      price: null,
    });
  };

  poll().catch((e) => {
    if (!stillCurrent()) return;
    console.info('[dmartLive] polling error:', e && e.message ? e.message : 'error');
    setLiveFailed(root);
  });
}

export function liveCardHtml(sku) {
  const safe = String(sku).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `
    <div class="dmart-live-card" id="dmartLiveCard" data-sku="${safe}" aria-live="polite">
      <div class="dmart-live-title">DMart</div>
      <div class="dmart-live-row dmart-live-available-row"><span class="dmart-live-label">Available</span><span class="dmart-live-value dmart-live-available" data-live="available">…</span></div>
      <div class="dmart-live-row dmart-live-reserved-row"><span class="dmart-live-label">Reserved</span><span class="dmart-live-value dmart-live-reserved" data-live="reserved">…</span></div>
      <div class="dmart-live-row dmart-live-price-row"><span class="dmart-live-label">Price</span><span class="dmart-live-value dmart-live-price" data-live="price">…</span></div>
      ${buildAdjustPanelHtml(sku)}
      <a class="dmart-check-btn dmart-check-btn-inline" href="#" data-sku="${safe}" target="_blank" rel="noopener noreferrer">
        <span class="dmart-check-icon" aria-hidden="true">
          <svg viewBox="0 0 100 100"><path d="M 51.28,14.43 L 48.01,15.07 L 44.50,16.59 L 42.58,17.94 L 40.11,20.81 L 38.60,25.36 L 38.52,34.85 L 26.63,34.85 L 26.63,41.71 L 27.67,44.42 L 30.06,46.41 L 32.46,47.05 L 38.60,47.13 L 38.68,67.78 L 40.27,73.60 L 42.66,77.59 L 46.09,81.02 L 50.00,83.33 L 54.47,84.61 L 59.25,84.77 L 64.75,83.49 L 67.70,81.90 L 67.70,70.18 L 64.51,70.97 L 61.80,70.73 L 58.93,69.22 L 57.26,67.15 L 56.14,63.32 L 56.14,47.13 L 69.54,47.05 L 69.54,39.87 L 68.26,37.00 L 65.79,35.25 L 56.14,34.77 L 56.14,14.35 Z" fill="currentColor"/></svg>
        </span>
        <span>Check in Dmart</span>
      </a>
      <div class="dmart-live-status" data-live="status" hidden></div>
    </div>
  `;
}

export function invalidateCache(warehouseId) {
  if (!warehouseId) {
    cache.clear();
    return;
  }
  const prefix = `${warehouseId}::`;
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

// Listen for bridge ready signal
try {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.type === 'SMOUHA_PICK_DMART_BRIDGE_READY' && event.data.source === 'smouha-dmart-bridge') {
      markBridgeReady();
    }
  });
} catch (e) { /* ignore */ }


/** Directional orange fill for Check in Dmart (mouse approach top/bottom). */
export function wireDmartFillDirection(root) {
  try {
    const scope = root || document;
    scope.querySelectorAll('a.dmart-check-btn, a.dmart-check-btn-inline').forEach((btn) => {
      if (btn.dataset.fillWired) return;
      btn.dataset.fillWired = '1';
      btn.addEventListener('mousemove', (ev) => {
        const r = btn.getBoundingClientRect();
        btn.dataset.fillFrom = (ev.clientY - r.top) < r.height / 2 ? 'top' : 'bottom';
      }, { passive: true });
    });
  } catch (e) { /* ignore */ }
}


window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.source !== 'smouha-dmart-bridge') return;
  if (event.data.type === 'SMOUHA_PICK_DMART_BRIDGE_READY') markBridgeReady();
  if (event.data.type === 'SMOUHA_PICK_DMART_BRIDGE_OFFLINE') markBridgeOffline();
});

function watchBridgeHeartbeat() {
  updateBridgeStatusUi();
  setInterval(() => {
    if (bridgeReady && lastBridgeAt && Date.now() - lastBridgeAt > BRIDGE_OFFLINE_MS) {
      // soft offline if no READY refresh for a while; content script re-announces on load only
      // keep online if we got READY once in this page life — only offline on explicit OFFLINE
    }
    updateBridgeStatusUi();
  }, 5000);
  try {
    window.matchMedia('(min-width: 900px)').addEventListener('change', updateBridgeStatusUi);
  } catch (e) {}
  // Assume offline until READY
  setTimeout(() => {
    if (!bridgeReadyKnown) {
      bridgeReadyKnown = true;
      updateBridgeStatusUi();
    }
  }, 2500);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', watchBridgeHeartbeat);
} else {
  watchBridgeHeartbeat();
}
