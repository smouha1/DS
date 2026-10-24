/* ============================================================================
   cycleCount.js — Cycle Count Workspace Controller & Bridge/LAN Hub Client
   ----------------------------------------------------------------------------
   Features:
     • Fetches live Cycle Count KPIs (/v1/.../cycle-count/kpi) & Cycle/Batch
       lists (/v3/.../cycle-count/list) via DMart Bridge extension or LAN Hub
     • Caches last snapshot per warehouse in localStorage for instant floor
       reload & offline aisle resiliency + built-in DS60 sample preview mode
     • Displays each Cycle / Batch with status filters, SKU count, and total
       shelf locations count
     • Inside a Batch: displays every item with its 1 or 2+ shelf locations
       (`location_expiry_mapping[]`), expected qty & expiry per location,
       portal counted qty (`counts[]`), and interactive local floor check/count
     • Generates a live scannable barcode for EVERY item (and optional location
       barcode) using existing site libraries (JsBarcode + qrcode-generator)
       with instant switching between QR and Code 128 + multi-barcode Br:1/Br:2
     • Lazy-renders item barcodes via IntersectionObserver for 60fps scrolling
   ============================================================================ */

import * as barcodeLib from './barcode.js';
import * as warehouse from './warehouse.js';
import * as dmartLive from './dmartLive.js';
import * as dmartAdjust from './dmartAdjust.js';
import * as search from './search.js';
import * as image from './image.js';
import * as lanHub from './lan/lanHub.js';
import { isHubMasterFlag } from './lan/lanHubUi.js';
import { quickGetSettings } from './appSettingsQuick.js';
import {
  normalizeCycleKpi,
  normalizeCycleListPayload,
  formatShortTimestamp,
  productMatchesCycleQuery,
  findProductByScanCode,
  getSampleCycleData,
} from './cycleCountParse.js';

const SNAPSHOT_STORAGE_PREFIX = 'smouha_cycle_snapshot_v1_';
const DRAFTS_STORAGE_KEY = 'smouha_cycle_drafts_v1';

let mountEl = null;
let headerBtnEl = null;
let appCallbacks = {
  toast: () => {},
  playScanFeedback: () => {},
  openInPicker: () => {},
  openPelicanScanner: () => {},
};

const state = {
  isOpen: false,
  subView: 'batches', // 'batches' | 'detail'
  loading: false,
  error: null,
  isDemoMode: false,
  fromCache: false,
  fetchedAt: null,
  page: 1,
  perPage: 10,
  kpi: normalizeCycleKpi({}),
  cycles: [],
  batches: [],
  totalCycles: 0,
  batchFilter: 'all', // 'all' | 'open' | 'completed'
  batchSearchQuery: '',
  activeBatchId: null,
  itemFilter: 'all', // 'all' | 'multi' | 'unchecked' | 'discrepancy' | 'checked'
  itemSort: 'aisle', // 'aisle' | 'portal' | 'multi_first' | 'qty_desc'
  itemSearchQuery: '',
  selectedBarcodeIdxBySku: new Map(), // sku -> index in barcodes[]
  drafts: {}, // "${batchId}::${sku}::${locationName}" -> { checked: bool, countVal: string, at: number }
};

let barcodeObserver = null;

/* --------------------------------------------------------------------------
   Local Floor Drafts & Snapshot Cache Helpers
   -------------------------------------------------------------------------- */

function loadDrafts() {
  try {
    const raw = localStorage.getItem(DRAFTS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        state.drafts = parsed;
        return;
      }
    }
  } catch (e) {}
  state.drafts = {};
}

function saveDrafts() {
  try {
    const keys = Object.keys(state.drafts);
    if (keys.length > 2500) {
      // Prune oldest entries if storage grows large over months
      const sorted = keys.sort((a, b) => (state.drafts[a]?.at || 0) - (state.drafts[b]?.at || 0));
      for (let i = 0; i < sorted.length - 2000; i++) {
        delete state.drafts[sorted[i]];
      }
    }
    localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(state.drafts));
  } catch (e) {}
}

function draftKey(batchId, sku, locationName) {
  return `${String(batchId)}::${String(sku)}::${String(locationName || 'UNSPECIFIED-LOCATION').toUpperCase()}`;
}

function getLocationDraft(batchId, sku, locationName) {
  return state.drafts[draftKey(batchId, sku, locationName)] || { checked: false, countVal: '' };
}

function setLocationDraft(batchId, sku, locationName, patch) {
  const k = draftKey(batchId, sku, locationName);
  const prev = state.drafts[k] || { checked: false, countVal: '' };
  state.drafts[k] = {
    checked: patch.checked !== undefined ? !!patch.checked : !!prev.checked,
    countVal: patch.countVal !== undefined ? String(patch.countVal) : String(prev.countVal ?? ''),
    at: Date.now(),
  };
  saveDrafts();
}

function clearBatchDrafts(batchId) {
  const prefix = `${String(batchId)}::`;
  for (const k of Object.keys(state.drafts)) {
    if (k.startsWith(prefix)) delete state.drafts[k];
  }
  saveDrafts();
}

function saveWarehouseSnapshot(warehouseId, kpi, rawList, fetchedAt) {
  if (!warehouseId) return;
  try {
    const payload = {
      warehouseId,
      kpi,
      rawList,
      fetchedAt: fetchedAt || Date.now(),
    };
    localStorage.setItem(SNAPSHOT_STORAGE_PREFIX + warehouseId, JSON.stringify(payload));
  } catch (e) {}
}

function loadWarehouseSnapshot(warehouseId) {
  if (!warehouseId) return null;
  try {
    const raw = localStorage.getItem(SNAPSHOT_STORAGE_PREFIX + warehouseId);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/* --------------------------------------------------------------------------
   Effective Barcode Format (QR vs Code 128) — Synced with Global App Switch
   -------------------------------------------------------------------------- */

export function effectiveCycleUseQr() {
  const s = quickGetSettings();
  if (s.performanceMode) return false;
  try {
    if (window.__smouhaFormatOverride === 'qr') return true;
    if (window.__smouhaFormatOverride === '128') return false;
  } catch (e) {}
  return !!s.qrCode;
}

function toggleGlobalBarcodeFormat(targetFormat) {
  const nextQr = targetFormat ? targetFormat === 'qr' : !effectiveCycleUseQr();
  try {
    window.__smouhaFormatOverride = nextQr ? 'qr' : '128';
  } catch (e) {}
  // Sync floating #barcodeFormatSwitch label if present
  try {
    const floatBtn = document.getElementById('barcodeFormatSwitch');
    if (floatBtn) {
      const lab = floatBtn.querySelector('.bfs-label');
      if (lab) lab.textContent = nextQr ? 'QR' : '128';
    }
  } catch (e) {}
  // Notify main product card if rendered in background
  try {
    window.dispatchEvent(new CustomEvent('smouha:settings-barcode'));
  } catch (e) {}
  // Refresh all visible Cycle Count item barcodes + toolbar toggle state
  refreshVisibleCycleBarcodes();
}

/* --------------------------------------------------------------------------
   Extension Bridge & LAN Hub Transport
   -------------------------------------------------------------------------- */

function nextReqId(prefix = 'cyc') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Direct extension bridge call (used on Desktop/Master PC). */
export function requestCycleListBridgeOnly(warehouseId, page = 1, perPage = 10, force = false, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const requestId = nextReqId('cyclist');
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMsg);
      resolve({
        success: false,
        error: { code: 'TIMEOUT', message: 'Extension bridge timed out — make sure DMart Bridge v1.12.0+ is loaded and portal is open' },
      });
    }, timeoutMs);

    function onMsg(event) {
      if (event.source !== window) return;
      const d = event.data;
      if (!d || d.source !== 'smouha-dmart-bridge') return;
      if (d.type !== 'SMOUHA_PICK_CYCLE_LIST_RESPONSE' || d.requestId !== requestId) return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMsg);
      resolve(d);
    }

    window.addEventListener('message', onMsg);
    try {
      window.postMessage(
        {
          type: 'SMOUHA_PICK_CYCLE_LIST',
          requestId,
          warehouseId: String(warehouseId || ''),
          page: Number(page) || 1,
          perPage: Number(perPage) || 10,
          force: !!force,
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

export function requestCycleKpiBridgeOnly(warehouseId, force = false, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const requestId = nextReqId('cyckpi');
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMsg);
      resolve({
        success: false,
        error: { code: 'TIMEOUT', message: 'KPI request timed out' },
      });
    }, timeoutMs);

    function onMsg(event) {
      if (event.source !== window) return;
      const d = event.data;
      if (!d || d.source !== 'smouha-dmart-bridge') return;
      if (d.type !== 'SMOUHA_PICK_CYCLE_KPI_RESPONSE' || d.requestId !== requestId) return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMsg);
      resolve(d);
    }

    window.addEventListener('message', onMsg);
    try {
      window.postMessage(
        {
          type: 'SMOUHA_PICK_CYCLE_KPI',
          requestId,
          warehouseId: String(warehouseId || ''),
          force: !!force,
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

/** Smart transport: Extension Bridge first on desktop/Master; LAN Hub fallback on phones. */
async function fetchCycleDataSmart(warehouseId, { page = 1, perPage = 10, force = false } = {}) {
  const bridgeOnline = !!(dmartLive.isBridgeOnline && dmartLive.isBridgeOnline());
  const isMaster = !!(typeof isHubMasterFlag === 'function' && isHubMasterFlag());
  const hubUrl = lanHub.getHubUrl ? lanHub.getHubUrl() : '';

  // 1) Try Extension Bridge if online or if Master PC / no Hub configured
  if (bridgeOnline || isMaster || !hubUrl) {
    const [listRes, kpiRes] = await Promise.all([
      requestCycleListBridgeOnly(warehouseId, page, perPage, force, bridgeOnline ? 18000 : 4500),
      requestCycleKpiBridgeOnly(warehouseId, force, bridgeOnline ? 14000 : 4000),
    ]);
    if (listRes && listRes.success && listRes.data) {
      return {
        ok: true,
        via: 'bridge',
        listData: listRes.data,
        kpiData: (kpiRes && kpiRes.success && kpiRes.data) ? kpiRes.data.kpi : null,
      };
    }
    if (!hubUrl || isMaster) {
      return {
        ok: false,
        error: (listRes && listRes.error) || { code: 'BRIDGE_OFFLINE', message: 'DMart Bridge extension is offline or portal session expired.' },
      };
    }
  }

  // 2) Try LAN Hub for mobile devices connected to branch Wi-Fi
  if (hubUrl && lanHub.hubRequestCycle) {
    const [listHub, kpiHub] = await Promise.all([
      lanHub.hubRequestCycle({ kind: 'list', warehouseId, page, perPage, force }),
      lanHub.hubRequestCycle({ kind: 'kpi', warehouseId, force }),
    ]);
    if (listHub && listHub.success && listHub.data) {
      return {
        ok: true,
        via: 'hub',
        listData: listHub.data,
        kpiData: (kpiHub && kpiHub.success && kpiHub.data) ? kpiHub.data.kpi : null,
      };
    }
    return {
      ok: false,
      error: (listHub && listHub.error) || { code: 'HUB_ERROR', message: 'Could not load Cycle Count via LAN Hub.' },
    };
  }

  return {
    ok: false,
    error: { code: 'OFFLINE', message: 'Extension Bridge is offline.' },
  };
}

/* --------------------------------------------------------------------------
   Catalog & Image Cache Warming from Cycle Products
   -------------------------------------------------------------------------- */

function warmAppCachesFromBatches(batches) {
  try {
    const toPreload = [];
    for (const b of batches || []) {
      for (const p of b.products || []) {
        if (!p || !p.sku) continue;
        if (p.id && dmartAdjust && dmartAdjust.rememberProductId) {
          dmartAdjust.rememberProductId(p.sku, p.id);
        }
        if (p.imageUrl && search.setDmartImage) {
          search.setDmartImage(p.sku, p.imageUrl);
          toPreload.push({ sku: p.sku, image: p.imageUrl });
        }
        if (search.registerDmartProduct) {
          search.registerDmartProduct({
            sku: p.sku,
            name: p.name,
            barcodes: p.barcodes,
            image: p.imageUrl || '',
          });
        }
      }
    }
    if (toPreload.length && image.preloadImages) {
      image.preloadImages(toPreload, 24);
    }
  } catch (e) {}
}

/* --------------------------------------------------------------------------
   Data Load & Demo Mode Actions
   -------------------------------------------------------------------------- */

async function loadCycles({ force = false, keepSubView = true } = {}) {
  const whId = (warehouse.getSelectedId && warehouse.getSelectedId()) || 'd24a9f96-f6bc-43b0-af78-b7067f0c901c';
  state.loading = true;
  state.error = null;
  if (!keepSubView) {
    state.subView = 'batches';
    state.activeBatchId = null;
  }
  renderCycleWorkspace();

  const res = await fetchCycleDataSmart(whId, {
    page: state.page,
    perPage: state.perPage,
    force,
  });

  state.loading = false;

  if (res.ok && res.listData) {
    state.isDemoMode = false;
    state.fromCache = false;
    state.fetchedAt = res.listData.fetchedAt || Date.now();
    if (res.kpiData) {
      state.kpi = normalizeCycleKpi(res.kpiData);
    }
    const parsed = normalizeCycleListPayload(res.listData);
    state.cycles = parsed.cycles;
    state.batches = parsed.batches;
    state.totalCycles = parsed.totalCycles;
    saveWarehouseSnapshot(whId, state.kpi, res.listData.raw || res.listData, state.fetchedAt);
    warmAppCachesFromBatches(state.batches);
    updateHeaderBadge();
    renderCycleWorkspace();
    return;
  }

  // Fallback to cached snapshot for this warehouse if available
  const snap = loadWarehouseSnapshot(whId);
  if (snap && snap.rawList) {
    state.isDemoMode = false;
    state.fromCache = true;
    state.fetchedAt = snap.fetchedAt || null;
    if (snap.kpi) state.kpi = normalizeCycleKpi(snap.kpi);
    const parsed = normalizeCycleListPayload(snap.rawList);
    state.cycles = parsed.cycles;
    state.batches = parsed.batches;
    state.totalCycles = parsed.totalCycles;
    state.error = (res.error && res.error.message) || 'Showing last cached snapshot (Bridge offline)';
    warmAppCachesFromBatches(state.batches);
    updateHeaderBadge();
    renderCycleWorkspace();
    return;
  }

  state.error = (res.error && res.error.message) || 'Could not connect to DMart Bridge.';
  updateHeaderBadge();
  renderCycleWorkspace();
}

function loadDemoSampleData() {
  const sample = getSampleCycleData();
  state.loading = false;
  state.error = null;
  state.isDemoMode = true;
  state.fromCache = false;
  state.fetchedAt = Date.now();
  state.kpi = normalizeCycleKpi(sample.kpi);
  const parsed = normalizeCycleListPayload(sample.list);
  state.cycles = parsed.cycles;
  state.batches = parsed.batches;
  state.totalCycles = parsed.totalCycles;
  warmAppCachesFromBatches(state.batches);
  // Open the first open batch automatically or show batch list
  updateHeaderBadge();
  renderCycleWorkspace();
  appCallbacks.toast('Loaded DS60 HAR Sample Data (Preview Mode)');
}

/* --------------------------------------------------------------------------
   Calculations & Progress Helpers
   -------------------------------------------------------------------------- */

function getBatchProgress(batch) {
  if (!batch || !Array.isArray(batch.products)) {
    return { checkedLocations: 0, totalLocations: 0, pct: 0, localDiscrepancies: 0 };
  }
  let checkedLocations = 0;
  let totalLocations = 0;
  let localDiscrepancies = 0;

  for (const p of batch.products) {
    for (const loc of p.locations || []) {
      totalLocations += 1;
      const d = getLocationDraft(batch.id, p.sku, loc.locationName);
      const hasLocalCount = d.countVal !== '' && !Number.isNaN(Number(d.countVal));
      const isChecked = !!d.checked || hasLocalCount || loc.effectivePortalCount != null;
      if (isChecked) checkedLocations += 1;

      if (hasLocalCount) {
        const diff = Number(d.countVal) - loc.systemQty;
        if (Math.abs(diff) > 0.0001) localDiscrepancies += 1;
      } else if (loc.portalDiscrepancy != null && Math.abs(loc.portalDiscrepancy) > 0.0001) {
        localDiscrepancies += 1;
      }
    }
  }
  const pct = totalLocations > 0 ? Math.round((checkedLocations / totalLocations) * 100) : 0;
  return { checkedLocations, totalLocations, pct, localDiscrepancies };
}

function isProductFullyChecked(batchId, product) {
  if (!product || !Array.isArray(product.locations) || !product.locations.length) return false;
  return product.locations.every((loc) => {
    const d = getLocationDraft(batchId, product.sku, loc.locationName);
    return !!d.checked || (d.countVal !== '' && !Number.isNaN(Number(d.countVal))) || loc.effectivePortalCount != null;
  });
}

function doesProductHaveDiscrepancy(batchId, product) {
  if (!product || !Array.isArray(product.locations)) return false;
  return product.locations.some((loc) => {
    const d = getLocationDraft(batchId, product.sku, loc.locationName);
    if (d.countVal !== '' && !Number.isNaN(Number(d.countVal))) {
      return Math.abs(Number(d.countVal) - loc.systemQty) > 0.0001;
    }
    return loc.portalDiscrepancy != null && Math.abs(loc.portalDiscrepancy) > 0.0001;
  });
}

function updateHeaderBadge() {
  if (!headerBtnEl) return;
  const openBatches = (state.batches || []).filter((b) => !b.isCompleted).length;
  let badge = headerBtnEl.querySelector('.cycle-header-badge');
  if (openBatches > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'cycle-header-badge';
      headerBtnEl.appendChild(badge);
    }
    badge.textContent = String(openBatches);
    badge.hidden = false;
  } else if (badge) {
    badge.hidden = true;
  }
}

/* --------------------------------------------------------------------------
   HTML Escaping & Formatting Helpers
   -------------------------------------------------------------------------- */

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function placeholderSvgUrl() {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" rx="14" fill="#E8F3F8"/><rect x="52" y="44" width="56" height="44" rx="6" fill="none" stroke="#8AAEBC" stroke-width="2.5"/><circle cx="68" cy="60" r="4.5" fill="#8AAEBC"/><path d="M58 80l14-12 12 10 16-14 14 16" fill="none" stroke="#8AAEBC" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><text x="50%" y="128" font-family="system-ui,sans-serif" font-size="11" fill="#6A8694" text-anchor="middle">No Image</text></svg>`
  );
}

function copyToClipboard(text, label = 'Copied') {
  const s = String(text ?? '');
  if (!s) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(s).then(() => appCallbacks.toast(label)).catch(() => fallbackCopy(s, label));
  } else {
    fallbackCopy(s, label);
  }
}

function fallbackCopy(text, label) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    appCallbacks.toast(label);
  } catch (e) {}
  document.body.removeChild(ta);
}

/* --------------------------------------------------------------------------
   Location Barcode Modal / Zoom Helper (Scan Shelf Location Code)
   -------------------------------------------------------------------------- */

async function openLocationBarcodeZoom(locationName) {
  const code = String(locationName || '').trim();
  if (!code) return;
  const useQr = effectiveCycleUseQr();
  const tempWrap = document.createElement('div');
  tempWrap.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:260px;height:260px;background:#fff;';
  document.body.appendChild(tempWrap);
  try {
    const svg = await barcodeLib.renderBarcodeInSlot(tempWrap, code, {
      useQr,
      slotId: 'loc-zoom-svg',
    });
    if (svg) {
      const dataUrl = barcodeLib.svgToDataUrl(svg);
      image.openZoom(dataUrl);
      appCallbacks.toast(`Location ${useQr ? 'QR' : 'Code128'}: ${code}`);
    } else {
      appCallbacks.toast('Could not generate location barcode', 'error');
    }
  } catch (e) {
    appCallbacks.toast('Could not generate location barcode', 'error');
  } finally {
    tempWrap.remove();
  }
}

/* --------------------------------------------------------------------------
   Lazy & Instant Barcode Rendering for Batch Items
   -------------------------------------------------------------------------- */

function disconnectBarcodeObserver() {
  if (barcodeObserver) {
    barcodeObserver.disconnect();
    barcodeObserver = null;
  }
}

async function renderCardBarcodeSlot(cardEl) {
  if (!cardEl) return;
  const wrap = cardEl.querySelector('.cyc-bc-wrap');
  if (!wrap) return;
  const sku = cardEl.dataset.sku || '';
  const bcValue = wrap.dataset.bcValue || sku;
  if (!bcValue) return;

  const useQr = effectiveCycleUseQr();
  const slotId = `cyc-bc-svg-${sku.replace(/[^0-9A-Za-z_-]/g, '')}`;
  const currentRenderedVal = wrap.dataset.renderedVal || '';
  const currentRenderedFmt = wrap.dataset.renderedFmt || '';
  const targetFmt = useQr ? 'qr' : '128';

  if (currentRenderedVal === bcValue && currentRenderedFmt === targetFmt && wrap.querySelector('svg')) {
    return;
  }

  wrap.dataset.renderedVal = bcValue;
  wrap.dataset.renderedFmt = targetFmt;

  const svg = await barcodeLib.renderBarcodeInSlot(wrap, bcValue, {
    useQr,
    slotId,
  });

  if (svg && wrap.isConnected) {
    wrap.onclick = (e) => {
      e.stopPropagation();
      const liveSvg = wrap.querySelector('svg');
      if (liveSvg) {
        image.openZoom(barcodeLib.svgToDataUrl(liveSvg));
      }
    };
  }
}

function setupBarcodeLazyObserver() {
  disconnectBarcodeObserver();
  if (!mountEl) return;
  const cards = [...mountEl.querySelectorAll('.cyc-item-card')];
  if (!cards.length) return;

  if (!('IntersectionObserver' in window)) {
    cards.forEach((c) => renderCardBarcodeSlot(c));
    return;
  }

  barcodeObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          renderCardBarcodeSlot(entry.target);
        }
      }
    },
    { rootMargin: '360px 0px', threshold: 0.01 }
  );

  cards.forEach((card, idx) => {
    // Immediately render first 6 cards above the fold; observe the rest
    if (idx < 6) {
      renderCardBarcodeSlot(card);
    }
    barcodeObserver.observe(card);
  });
}

/** Called when user toggles QR <-> Code128 from either floating button or toolbar. */
export function refreshVisibleCycleBarcodes() {
  if (!state.isOpen || !mountEl) return;
  const useQr = effectiveCycleUseQr();

  // Update toolbar format switch buttons
  mountEl.querySelectorAll('[data-cyc-fmt]').forEach((btn) => {
    const isThisActive = (btn.dataset.cycFmt === 'qr') === useQr;
    btn.classList.toggle('is-active', isThisActive);
    btn.setAttribute('aria-pressed', String(isThisActive));
  });

  // Force re-render on all rendered barcode slots
  mountEl.querySelectorAll('.cyc-item-card').forEach((card) => {
    const wrap = card.querySelector('.cyc-bc-wrap');
    if (wrap) {
      wrap.dataset.renderedFmt = '';
    }
    renderCardBarcodeSlot(card);
  });
}

/* --------------------------------------------------------------------------
   Batch Summary Copy / Export
   -------------------------------------------------------------------------- */

function exportBatchSummaryText(batch) {
  if (!batch) return;
  const prog = getBatchProgress(batch);
  const whName = warehouse.getDisplayName ? warehouse.getDisplayName() : 'Smouha DS60';
  const lines = [
    `📋 Smouha Pick — Cycle Count Summary`,
    `Warehouse: ${whName}`,
    `Cycle #${batch.cycleReference} · Batch #${batch.reference} (${batch.status})`,
    `Progress: ${prog.checkedLocations}/${prog.totalLocations} Locations Checked (${prog.pct}%)`,
    `----------------------------------------`,
  ];

  const discrepancies = [];
  const checkedRows = [];

  for (const p of batch.products || []) {
    for (const loc of p.locations || []) {
      const d = getLocationDraft(batch.id, p.sku, loc.locationName);
      const localNum = d.countVal !== '' && !Number.isNaN(Number(d.countVal)) ? Number(d.countVal) : null;
      const effectiveCount = localNum != null ? localNum : loc.effectivePortalCount;
      if (effectiveCount != null) {
        const diff = Number((effectiveCount - loc.systemQty).toFixed(3));
        const rowStr = `• [${loc.locationName}] SKU ${p.sku} (${p.name.slice(0, 32)}): System=${loc.systemQty} | Counted=${effectiveCount} (${diff === 0 ? 'OK' : (diff > 0 ? '+' + diff : diff)})`;
        if (Math.abs(diff) > 0.0001) {
          discrepancies.push(rowStr);
        } else {
          checkedRows.push(rowStr);
        }
      } else if (d.checked) {
        checkedRows.push(`• [${loc.locationName}] SKU ${p.sku}: Verified (${loc.systemQty})`);
      }
    }
  }

  if (discrepancies.length) {
    lines.push(`⚠️ DISCREPANCIES (${discrepancies.length}):`);
    lines.push(...discrepancies);
    lines.push(`----------------------------------------`);
  } else {
    lines.push(`✅ Zero discrepancies recorded.`);
  }

  if (checkedRows.length) {
    lines.push(`✓ MATCHED / VERIFIED LOCATIONS (${checkedRows.length}):`);
    lines.push(...checkedRows.slice(0, 50));
    if (checkedRows.length > 50) lines.push(`...and ${checkedRows.length - 50} more matched locations.`);
  }

  copyToClipboard(lines.join('\n'), 'Batch Summary Copied to Clipboard');
}

/* --------------------------------------------------------------------------
   Render: Top Header & KPI Strip
   -------------------------------------------------------------------------- */

function renderTopHeaderHtml() {
  const whName = warehouse.getDisplayName ? warehouse.getDisplayName() : 'Smouha DS60';
  const useQr = effectiveCycleUseQr();
  const bridgeOnline = !!(dmartLive.isBridgeOnline && dmartLive.isBridgeOnline());
  const statusLabel = state.isDemoMode
    ? 'Sample Preview Mode'
    : state.fromCache
      ? 'Cached Snapshot'
      : bridgeOnline
        ? 'DMart Live Connected'
        : 'Bridge Standby';
  const statusCls = state.isDemoMode
    ? 'is-demo'
    : state.fromCache
      ? 'is-cached'
      : bridgeOnline
        ? 'is-online'
        : 'is-offline';

  const k = state.kpi || {};

  return `
    <div class="cyc-top-bar">
      <div class="cyc-top-left">
        <button type="button" class="cyc-back-picker-btn" id="cycBackToPickerBtn" title="Return to Main Barcode Picker">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          <span>Picker</span>
        </button>
        <div class="cyc-title-cluster">
          <div class="cyc-title-row">
            <h1 class="cyc-main-title">Cycle Count</h1>
            <span class="cyc-wh-pill" title="Active Warehouse">${esc(whName)}</span>
            <span class="cyc-conn-pill ${statusCls}">
              <span class="cyc-conn-dot"></span>
              ${esc(statusLabel)}
            </span>
          </div>
          <p class="cyc-subtitle">Multi-Location Shelf Verification &amp; Instant QR / Code128 Scanner</p>
        </div>
      </div>

      <div class="cyc-top-actions">
        <div class="cyc-fmt-segmented" role="group" aria-label="Barcode Format Switch">
          <button type="button" class="cyc-fmt-btn ${useQr ? 'is-active' : ''}" data-cyc-fmt="qr" aria-pressed="${useQr}" title="Render item barcodes as QR Code">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM18 18h3v3h-3zM14 19h2M19 14v2"/></svg>
            <span>QR Code</span>
          </button>
          <button type="button" class="cyc-fmt-btn ${!useQr ? 'is-active' : ''}" data-cyc-fmt="128" aria-pressed="${!useQr}" title="Render item barcodes as Code 128">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 5v14M6 5v14M10 5v14M13 5v14M17 5v14M21 5v14"/></svg>
            <span>Code 128</span>
          </button>
        </div>

        <button type="button" class="cyc-action-btn cyc-refresh-btn ${state.loading ? 'is-spinning' : ''}" id="cycRefreshBtn" ${state.loading ? 'disabled' : ''} title="Fetch fresh Cycle Count data from DMart">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
          <span>${state.loading ? 'Syncing…' : 'Refresh'}</span>
        </button>

        <a class="cyc-action-btn cyc-portal-link" href="https://portal.talabat.com/pv2/eg/p/inventory/cycle/w/${encodeURIComponent((warehouse.getSelectedId && warehouse.getSelectedId()) || 'd24a9f96-f6bc-43b0-af78-b7067f0c901c')}?search=&page=1" target="_blank" rel="noopener noreferrer" title="Open Cycle Count on Talabat Portal">
          <span>Portal</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M7 7h10v10"/></svg>
        </a>
      </div>
    </div>

    <div class="cyc-kpi-strip" aria-label="Cycle Count KPIs">
      <div class="cyc-kpi-card">
        <span class="cyc-kpi-label">Completed Cycles</span>
        <span class="cyc-kpi-value">${Number(k.completedCycles || 0).toLocaleString()}</span>
      </div>
      <div class="cyc-kpi-card">
        <span class="cyc-kpi-label">Distinct Counted SKUs</span>
        <span class="cyc-kpi-value">${Number(k.countedSkus || 0).toLocaleString()}</span>
      </div>
      <div class="cyc-kpi-card">
        <span class="cyc-kpi-label">Share of Assortment</span>
        <span class="cyc-kpi-value">${Number(k.assortmentPct || 0).toFixed(2)}%</span>
      </div>
      <div class="cyc-kpi-card">
        <span class="cyc-kpi-label">SKU Defect Rate</span>
        <span class="cyc-kpi-value ${k.skuDefectPct > 5 ? 'is-warn' : ''}">${Number(k.skuDefectPct || 0).toFixed(2)}%</span>
      </div>
      <div class="cyc-kpi-card">
        <span class="cyc-kpi-label">Unit Defect Rate</span>
        <span class="cyc-kpi-value">${Number(k.unitDefectPct || 0).toFixed(2)}%</span>
      </div>
    </div>
  `;
}

/* --------------------------------------------------------------------------
   Render Sub-View 1: Cycle & Batch Cards List
   -------------------------------------------------------------------------- */

function getFilteredBatches() {
  let list = state.batches || [];
  if (state.batchFilter === 'open') {
    list = list.filter((b) => !b.isCompleted);
  } else if (state.batchFilter === 'completed') {
    list = list.filter((b) => b.isCompleted);
  }

  const q = String(state.batchSearchQuery || '').trim().toLowerCase();
  if (q) {
    list = list.filter((b) => {
      if (String(b.reference).toLowerCase().includes(q)) return true;
      if (String(b.cycleReference).toLowerCase().includes(q)) return true;
      if (String(b.status).toLowerCase().includes(q)) return true;
      if (b.pickedBy && String(b.pickedBy).toLowerCase().includes(q)) return true;
      return (b.products || []).some((p) => productMatchesCycleQuery(p, q));
    });
  }
  return list;
}

function renderBatchListViewHtml() {
  const allBatches = state.batches || [];
  const openCount = allBatches.filter((b) => !b.isCompleted).length;
  const doneCount = allBatches.filter((b) => b.isCompleted).length;
  const filtered = getFilteredBatches();

  let statusBannerHtml = '';
  if (state.error) {
    statusBannerHtml = `
      <div class="cyc-notice-banner is-warning">
        <div class="cyc-notice-text">
          <strong>Connection Notice:</strong> ${esc(state.error)}
        </div>
        <div class="cyc-notice-actions">
          <button type="button" class="cyc-btn-sm cyc-btn-primary" id="cycTryDemoBtn">
            Preview DS60 HAR Sample Data
          </button>
          <button type="button" class="cyc-btn-sm" id="cycRetryLoadBtn">
            Retry Live Connection
          </button>
        </div>
      </div>
    `;
  } else if (state.isDemoMode) {
    statusBannerHtml = `
      <div class="cyc-notice-banner is-demo">
        <div class="cyc-notice-text">
          <strong>DS60 HAR Preview Mode:</strong> Viewing sample Cycle Count batches (#792013 / Batch #3358930 &amp; #3354112) with real multi-location &amp; barcode structure.
        </div>
        <div class="cyc-notice-actions">
          <button type="button" class="cyc-btn-sm cyc-btn-primary" id="cycRetryLoadBtn">
            Connect to Live DMart
          </button>
        </div>
      </div>
    `;
  }

  if (state.loading && !allBatches.length) {
    return `
      ${statusBannerHtml}
      <div class="cyc-empty-card">
        <div class="cyc-spinner-lg"></div>
        <h3>Loading Cycle Count Tasks from DMart…</h3>
        <p>Fetching active cycles, batches, and shelf location mappings for this warehouse.</p>
      </div>
    `;
  }

  if (!allBatches.length) {
    return `
      ${statusBannerHtml}
      <div class="cyc-empty-card">
        <svg class="cyc-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="m9 14 2 2 4-4"/></svg>
        <h3>No Cycle Count Batches Loaded</h3>
        <p>Open the Talabat Portal tab so DMart Bridge captures your session, or preview the built-in DS60 HAR sample batch to test multi-location cards and QR / Code128 scanning.</p>
        <div class="cyc-empty-actions">
          <button type="button" class="cyc-btn-primary" id="cycEmptyDemoBtn">
            Load DS60 HAR Sample Batch
          </button>
          <button type="button" class="cyc-btn-secondary" id="cycEmptyRetryBtn">
            Retry Live Fetch
          </button>
        </div>
      </div>
    `;
  }

  const cardsHtml = filtered.map((b) => {
    const prog = getBatchProgress(b);
    const statusClass = b.isCompleted ? 'is-completed' : 'is-open';
    const updatedStr = formatShortTimestamp(b.completedAt || b.updatedAt);

    return `
      <article class="cyc-batch-card ${statusClass}" data-open-batch="${esc(b.id)}" tabindex="0" role="button" aria-label="Open Batch ${esc(b.reference)}">
        <div class="cyc-batch-card-top">
          <div class="cyc-batch-ids">
            <span class="cyc-cycle-tag">Cycle #${esc(b.cycleReference)}</span>
            <h3 class="cyc-batch-title">Batch #${esc(b.reference)}</h3>
          </div>
          <span class="cyc-status-badge ${statusClass}">${esc(b.status)}</span>
        </div>

        <div class="cyc-batch-metrics">
          <div class="cyc-metric-pill">
            <span class="cyc-metric-num">${b.skuCount}</span>
            <span class="cyc-metric-lbl">SKUs</span>
          </div>
          <div class="cyc-metric-pill is-locations">
            <span class="cyc-metric-num">${b.totalLocationsCount}</span>
            <span class="cyc-metric-lbl">Shelf Locations</span>
          </div>
          <div class="cyc-metric-pill ${b.multiLocationSkusCount > 0 ? 'is-multi-highlight' : ''}">
            <span class="cyc-metric-num">${b.multiLocationSkusCount}</span>
            <span class="cyc-metric-lbl">Multi-Loc Items</span>
          </div>
          <div class="cyc-metric-pill">
            <span class="cyc-metric-num">${b.totalExpectedUnits}</span>
            <span class="cyc-metric-lbl">Total Units</span>
          </div>
        </div>

        <div class="cyc-batch-progress-block">
          <div class="cyc-progress-labels">
            <span>Floor Verification Progress</span>
            <strong>${prog.checkedLocations} / ${prog.totalLocations} Locations (${prog.pct}%)</strong>
          </div>
          <div class="cyc-progress-track">
            <div class="cyc-progress-fill" style="width:${prog.pct}%"></div>
          </div>
        </div>

        <div class="cyc-batch-card-foot">
          <div class="cyc-batch-meta">
            <span>Strategy: <strong>${esc(b.strategy)}</strong></span>
            <span>&middot;</span>
            <span>Picker: <strong>${esc(b.pickedBy || 'Unassigned')}</strong></span>
            <span>&middot;</span>
            <span>${esc(updatedStr)}</span>
          </div>
          <span class="cyc-open-batch-cta">
            Open Batch
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
          </span>
        </div>
      </article>
    `;
  }).join('');

  return `
    ${statusBannerHtml}

    <div class="cyc-list-toolbar">
      <div class="cyc-filter-tabs" role="tablist">
        <button type="button" class="cyc-tab-btn ${state.batchFilter === 'all' ? 'is-active' : ''}" data-batch-filter="all">
          All Batches <span class="cyc-tab-count">${allBatches.length}</span>
        </button>
        <button type="button" class="cyc-tab-btn ${state.batchFilter === 'open' ? 'is-active' : ''}" data-batch-filter="open">
          Open / Unassigned <span class="cyc-tab-count">${openCount}</span>
        </button>
        <button type="button" class="cyc-tab-btn ${state.batchFilter === 'completed' ? 'is-active' : ''}" data-batch-filter="completed">
          Completed <span class="cyc-tab-count">${doneCount}</span>
        </button>
      </div>

      <div class="cyc-list-search-wrap">
        <svg class="cyc-search-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <input type="text" class="cyc-list-search-input" id="cycBatchSearchInput" placeholder="Filter by Batch ID, Cycle ID, SKU, Barcode, or Location (e.g. A03)..." value="${esc(state.batchSearchQuery)}" autocomplete="off">
        ${state.batchSearchQuery ? '<button type="button" class="cyc-input-clear" id="cycBatchSearchClear" aria-label="Clear filter">&times;</button>' : ''}
      </div>
    </div>

    <div class="cyc-batches-grid">
      ${cardsHtml || '<div class="cyc-empty-inline">No batches match your current filter.</div>'}
    </div>

    <div class="cyc-pagination-bar">
      <div class="cyc-page-info">
        Page <strong>${state.page}</strong> &middot; Showing <strong>${allBatches.length}</strong> batches across <strong>${state.cycles.length}</strong> cycles
      </div>
      <div class="cyc-page-btns">
        <button type="button" class="cyc-btn-sm" id="cycPrevPageBtn" ${state.page <= 1 || state.loading ? 'disabled' : ''}>&larr; Previous Page</button>
        <button type="button" class="cyc-btn-sm" id="cycNextPageBtn" ${state.loading || state.cycles.length < state.perPage ? 'disabled' : ''}>Next Page &rarr;</button>
      </div>
    </div>
  `;
}

/* --------------------------------------------------------------------------
   Render Sub-View 2: Active Batch Detail — Multi-Location + Scannable Barcode Cards
   -------------------------------------------------------------------------- */

function getActiveBatch() {
  if (!state.activeBatchId) return null;
  return (state.batches || []).find((b) => String(b.id) === String(state.activeBatchId)) || null;
}

function getFilteredAndSortedBatchProducts(batch) {
  if (!batch || !Array.isArray(batch.products)) return [];
  let list = batch.products.slice();

  // Filter
  if (state.itemFilter === 'multi') {
    list = list.filter((p) => p.isMultiLocation);
  } else if (state.itemFilter === 'unchecked') {
    list = list.filter((p) => !isProductFullyChecked(batch.id, p));
  } else if (state.itemFilter === 'checked') {
    list = list.filter((p) => isProductFullyChecked(batch.id, p));
  } else if (state.itemFilter === 'discrepancy') {
    list = list.filter((p) => doesProductHaveDiscrepancy(batch.id, p));
  }

  // Search query
  if (state.itemSearchQuery) {
    list = list.filter((p) => productMatchesCycleQuery(p, state.itemSearchQuery));
  }

  // Sort
  if (state.itemSort === 'aisle') {
    list.sort((a, b) =>
      a.primaryAisleSortKey.localeCompare(b.primaryAisleSortKey, undefined, { numeric: true, sensitivity: 'base' })
    );
  } else if (state.itemSort === 'multi_first') {
    list.sort((a, b) => (b.locationCount - a.locationCount) || (a.portalIndex - b.portalIndex));
  } else if (state.itemSort === 'qty_desc') {
    list.sort((a, b) => (b.onHandQty - a.onHandQty) || (a.portalIndex - b.portalIndex));
  } else {
    list.sort((a, b) => a.portalIndex - b.portalIndex);
  }

  return list;
}

function renderLocationRowHtml(batch, product, loc, locIdx) {
  const d = getLocationDraft(batch.id, product.sku, loc.locationName);
  const hasLocalVal = d.countVal !== '' && !Number.isNaN(Number(d.countVal));
  const localNum = hasLocalVal ? Number(d.countVal) : null;
  const isVerified = !!d.checked || hasLocalVal || loc.effectivePortalCount != null;

  // Compute live discrepancy badge (prefer local floor input if entered, else portal count)
  let deltaBadgeHtml = '';
  const activeCount = localNum != null ? localNum : loc.effectivePortalCount;
  if (activeCount != null) {
    const diff = Number((activeCount - loc.systemQty).toFixed(3));
    if (Math.abs(diff) <= 0.0001) {
      deltaBadgeHtml = `<span class="cyc-loc-delta is-match" title="Count matches system stock">✓ Match (${activeCount})</span>`;
    } else if (diff > 0) {
      deltaBadgeHtml = `<span class="cyc-loc-delta is-over" title="Surplus vs system stock">+${diff} Over</span>`;
    } else {
      deltaBadgeHtml = `<span class="cyc-loc-delta is-short" title="Shortage vs system stock">${diff} Short</span>`;
    }
  }

  // Expiry pills
  let expiryHtml = '';
  if (loc.quantities && loc.quantities.length) {
    const withExp = loc.quantities.filter((q) => q.expiryFormatted);
    if (withExp.length === 1) {
      expiryHtml = `<span class="cyc-exp-pill" title="Registered Expiry Date">Exp: <strong>${esc(withExp[0].expiryFormatted)}</strong></span>`;
    } else if (withExp.length > 1) {
      expiryHtml = withExp
        .map(
          (q) =>
            `<span class="cyc-exp-pill is-split" title="Split batch expiry at this location">Exp: <strong>${esc(q.expiryFormatted)}</strong> (${q.quantity})</span>`
        )
        .join('');
    }
  }
  if (!expiryHtml) {
    expiryHtml = `<span class="cyc-exp-pill is-none">No Expiry</span>`;
  }

  // Portal recorded counts line (when present in HAR/BFF)
  let portalRecordedHtml = '';
  if (loc.portalCount != null || loc.portalRecount != null || loc.portalImRecount != null) {
    const parts = [];
    if (loc.portalCount != null) parts.push(`Count: <strong>${loc.portalCount}</strong>`);
    if (loc.portalRecount != null) parts.push(`Pelican Recount: <strong>${loc.portalRecount}</strong>`);
    if (loc.portalImRecount != null) parts.push(`IM Recount: <strong>${loc.portalImRecount}</strong>`);
    portalRecordedHtml = `<div class="cyc-loc-portal-history">Portal Recorded &rarr; ${parts.join(' &middot; ')}</div>`;
  }

  return `
    <div class="cyc-loc-row ${isVerified ? 'is-verified' : ''} ${loc.isUnspecified ? 'is-unspecified' : ''}" data-loc-name="${esc(loc.locationName)}">
      <div class="cyc-loc-main">
        <span class="cyc-loc-idx">${locIdx + 1}</span>
        <div class="cyc-loc-code-group">
          <div class="cyc-loc-code-line">
            <button type="button" class="cyc-loc-code-btn" data-copy-loc="${esc(loc.locationName)}" title="Tap to copy shelf location code">
              <span class="cyc-loc-pin">📍</span>
              <span class="cyc-loc-code">${esc(loc.locationName)}</span>
            </button>
            ${!loc.isUnspecified ? `
              <button type="button" class="cyc-loc-bc-btn" data-scan-loc="${esc(loc.locationName)}" title="Show scannable barcode for location ${esc(loc.locationName)}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 5v14M7 5v14M11 5v14M15 5v14M19 5v14"/></svg>
                <span>Loc Scan</span>
              </button>
            ` : ''}
            ${loc.locationType && loc.locationType !== 'NORMAL' && loc.locationType !== 'NONE'
              ? `<span class="cyc-loc-type-tag">${esc(loc.locationType)}</span>`
              : ''}
          </div>
          <div class="cyc-loc-exp-line">
            ${expiryHtml}
          </div>
          ${portalRecordedHtml}
        </div>
      </div>

      <div class="cyc-loc-controls">
        <div class="cyc-loc-sys-qty" title="Expected System Quantity at this Location">
          <span class="cyc-sys-lbl">System Qty</span>
          <strong class="cyc-sys-val">${loc.systemQty}</strong>
        </div>

        <div class="cyc-loc-floor-input-wrap">
          <label class="cyc-floor-lbl" for="cyc-cnt-${esc(product.sku)}-${locIdx}">Counted</label>
          <input
            type="number"
            id="cyc-cnt-${esc(product.sku)}-${locIdx}"
            class="cyc-floor-input"
            inputmode="${product.isWeighted ? 'decimal' : 'numeric'}"
            step="${product.isWeighted ? 'any' : '1'}"
            min="0"
            placeholder="${loc.effectivePortalCount != null ? esc(loc.effectivePortalCount) : esc(loc.systemQty)}"
            value="${esc(d.countVal)}"
            data-draft-sku="${esc(product.sku)}"
            data-draft-loc="${esc(loc.locationName)}"
            data-sys-qty="${loc.systemQty}"
          >
        </div>

        <button
          type="button"
          class="cyc-loc-check-btn ${isVerified ? 'is-checked' : ''}"
          data-check-sku="${esc(product.sku)}"
          data-check-loc="${esc(loc.locationName)}"
          data-sys-qty="${loc.systemQty}"
          aria-pressed="${isVerified}"
          title="${isVerified ? 'Location verified — tap to uncheck' : 'Mark this shelf location as verified'}"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          <span>${isVerified ? 'Done' : 'Verify'}</span>
        </button>
      </div>

      ${deltaBadgeHtml ? `<div class="cyc-loc-delta-row">${deltaBadgeHtml}</div>` : ''}
    </div>
  `;
}

function renderItemCardHtml(batch, product) {
  const selectedBcIdx = state.selectedBarcodeIdxBySku.get(product.sku) || 0;
  const barcodes = product.barcodes && product.barcodes.length ? product.barcodes : [product.sku];
  const safeIdx = selectedBcIdx < barcodes.length ? selectedBcIdx : 0;
  const activeBc = barcodes[safeIdx] || product.sku;

  const fullyChecked = isProductFullyChecked(batch.id, product);
  const hasDiscrepancy = doesProductHaveDiscrepancy(batch.id, product);

  const locBadgeClass = product.isMultiLocation ? 'is-multi-loc' : 'is-single-loc';
  const locBadgeText = product.isMultiLocation
    ? `⚠️ ${product.locationCount} Shelf Locations`
    : `1 Shelf Location`;

  const imgSrc = product.imageUrl || placeholderSvgUrl();

  const brPillsHtml = barcodes.map((bc, idx) => {
    const activeCls = idx === safeIdx ? 'is-active' : '';
    return `
      <button
        type="button"
        class="cyc-br-item ${activeCls}"
        data-select-bc-sku="${esc(product.sku)}"
        data-select-bc-idx="${idx}"
        data-select-bc-val="${esc(bc)}"
        title="Switch barcode to Br : ${idx + 1} (${esc(bc)}) &amp; copy"
      >
        <span class="cyc-br-lbl">Br : ${idx + 1}</span>
        <span class="cyc-br-val">${esc(bc)}</span>
      </button>
    `;
  }).join('');

  const locationsRowsHtml = (product.locations || [])
    .map((loc, lIdx) => renderLocationRowHtml(batch, product, loc, lIdx))
    .join('');

  return `
    <article
      class="cyc-item-card ${fullyChecked ? 'is-card-checked' : ''} ${hasDiscrepancy ? 'is-card-discrepancy' : ''} ${product.isMultiLocation ? 'is-card-multi' : ''}"
      id="cyc-item-${esc(product.sku)}"
      data-sku="${esc(product.sku)}"
    >
      <header class="cyc-item-card-head">
        <div class="cyc-item-head-left">
          <span class="cyc-item-seq">#${product.portalIndex}</span>
          <button type="button" class="cyc-sku-chip" data-copy-sku="${esc(product.sku)}" title="Tap to copy SKU">
            <span class="cyc-sku-prefix">SKU</span>
            <strong>${esc(product.sku)}</strong>
          </button>
          <span class="cyc-loc-count-badge ${locBadgeClass}">
            ${esc(locBadgeText)}
          </span>
          ${product.isWeighted ? '<span class="cyc-weighted-badge" title="Weighted product">⚖️ Weighted</span>' : ''}
        </div>

        <div class="cyc-item-head-right">
          <div class="cyc-total-onhand-pill" title="Total System On-Hand Quantity across all locations">
            <span>Total On-Hand:</span>
            <strong>${product.onHandQty}</strong>
          </div>
          <button type="button" class="cyc-open-picker-btn" data-open-picker-sku="${esc(product.sku)}" title="Open this SKU in Main Picker for Live Stock &amp; Stock Adjust (±)">
            <span>Picker / Adjust</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M7 7h10v10"/></svg>
          </button>
        </div>
      </header>

      <div class="cyc-item-card-body">
        <!-- Col 1: Product Image + Full Title -->
        <div class="cyc-item-col-product">
          <div class="cyc-item-img-wrap" data-zoom-src="${esc(imgSrc)}" title="Tap to zoom image">
            <img
              class="cyc-item-img"
              src="${esc(imgSrc)}"
              alt="${esc(product.name)}"
              loading="lazy"
              decoding="async"
              onerror="this.onerror=null;this.src='${placeholderSvgUrl()}'"
            >
            <span class="cyc-img-zoom-tag">🔍</span>
          </div>
          <div class="cyc-item-info">
            <h4 class="cyc-item-title">${esc(product.name)}</h4>
            <div class="cyc-item-QuickMeta">
              <span>Primary Aisle: <strong>${esc(product.locations[0]?.locationName || '—')}</strong></span>
            </div>
          </div>
        </div>

        <!-- Col 2: Shelf Locations List (1 or 2+ Locations) -->
        <div class="cyc-item-col-locations">
          <div class="cyc-locations-header">
            <span class="cyc-locations-heading">
              Shelf Locations Breakdown (${product.locationCount})
            </span>
            ${product.isMultiLocation
              ? '<span class="cyc-multi-hint">Check all listed locations before confirming</span>'
              : ''}
          </div>
          <div class="cyc-locations-list">
            ${locationsRowsHtml}
          </div>
        </div>

        <!-- Col 3: Scannable Barcode (QR / Code 128) + Multi-Barcode Switcher -->
        <div class="cyc-item-col-barcode">
          <div
            class="cyc-bc-wrap ${effectiveCycleUseQr() ? 'is-qr' : 'is-code128'}"
            data-bc-value="${esc(activeBc)}"
            title="Tap barcode to enlarge for long-range scanning"
            role="button"
            tabindex="0"
          >
            <svg id="cyc-bc-svg-${esc(product.sku.replace(/[^0-9A-Za-z_-]/g, ''))}"></svg>
          </div>
          <div class="cyc-bc-actions-row">
            <span class="cyc-bc-scan-hint">Tap barcode to Zoom &middot; Scan Ready</span>
            <button type="button" class="cyc-bc-fmt-mini" data-toggle-fmt="1" title="Switch between QR Code and Code 128">
              Switch QR / 128
            </button>
          </div>
          <div class="cyc-br-list">
            ${brPillsHtml}
          </div>
        </div>
      </div>
    </article>
  `;
}

function renderBatchDetailViewHtml(batch) {
  if (!batch) return '';
  const prog = getBatchProgress(batch);
  const allProducts = batch.products || [];
  const multiCount = allProducts.filter((p) => p.isMultiLocation).length;
  const uncheckedCount = allProducts.filter((p) => !isProductFullyChecked(batch.id, p)).length;
  const checkedCount = allProducts.length - uncheckedCount;
  const discCount = allProducts.filter((p) => doesProductHaveDiscrepancy(batch.id, p)).length;

  const visibleProducts = getFilteredAndSortedBatchProducts(batch);
  const statusClass = batch.isCompleted ? 'is-completed' : 'is-open';

  const itemsHtml = visibleProducts.map((p) => renderItemCardHtml(batch, p)).join('');

  return `
    <div class="cyc-detail-sticky-bar">
      <div class="cyc-detail-bar-top">
        <div class="cyc-detail-nav">
          <button type="button" class="cyc-back-batches-btn" id="cycBackToBatchesBtn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
            <span>All Batches</span>
          </button>
          <div class="cyc-detail-batch-ident">
            <span class="cyc-cycle-tag">Cycle #${esc(batch.cycleReference)}</span>
            <h2 class="cyc-detail-title">Batch #${esc(batch.reference)}</h2>
            <span class="cyc-status-badge ${statusClass}">${esc(batch.status)}</span>
          </div>
        </div>

        <div class="cyc-detail-progress-cluster">
          <div class="cyc-detail-prog-text">
            <span>Verified: <strong>${prog.checkedLocations} / ${prog.totalLocations}</strong> Locations (${prog.pct}%)</span>
            ${prog.localDiscrepancies > 0
              ? `<span class="cyc-disc-pill">⚠️ ${prog.localDiscrepancies} Discrepancies</span>`
              : '<span class="cyc-ok-pill">✓ 0 Discrepancies</span>'}
          </div>
          <div class="cyc-progress-track is-compact">
            <div class="cyc-progress-fill" style="width:${prog.pct}%"></div>
          </div>
        </div>

        <div class="cyc-detail-actions">
          <button type="button" class="cyc-btn-sm cyc-btn-primary" id="cycExportSummaryBtn" title="Copy summary of checked locations &amp; discrepancies">
            📋 Copy Summary
          </button>
          <button type="button" class="cyc-btn-sm" id="cycResetDraftsBtn" title="Clear local floor checkmarks for this batch">
            Reset Local Checks
          </button>
        </div>
      </div>

      <div class="cyc-detail-controls-row">
        <!-- Fast Scan / Jump Input -->
        <div class="cyc-scan-jump-wrap">
          <svg class="cyc-search-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 5v14M7 5v14M11 5v14M15 5v14M19 5v14"/></svg>
          <input
            type="text"
            id="cycItemScanInput"
            class="cyc-scan-jump-input"
            placeholder="Scan barcode or type SKU / Last 6 / Location (e.g. A03-09) to jump..."
            value="${esc(state.itemSearchQuery)}"
            autocomplete="off"
          >
          ${state.itemSearchQuery ? '<button type="button" class="cyc-input-clear" id="cycItemScanClear" aria-label="Clear search">&times;</button>' : ''}
          <button type="button" class="cyc-pelican-scan-btn" id="cycPelicanCamBtn" title="Scan item with Camera (Pelican Mode)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
          </button>
        </div>

        <!-- Filter Pills -->
        <div class="cyc-item-filter-pills" role="tablist">
          <button type="button" class="cyc-pill-btn ${state.itemFilter === 'all' ? 'is-active' : ''}" data-item-filter="all">
            All (${allProducts.length})
          </button>
          <button type="button" class="cyc-pill-btn is-multi-pill ${state.itemFilter === 'multi' ? 'is-active' : ''}" data-item-filter="multi">
            Multi-Location (${multiCount})
          </button>
          <button type="button" class="cyc-pill-btn ${state.itemFilter === 'unchecked' ? 'is-active' : ''}" data-item-filter="unchecked">
            Unchecked (${uncheckedCount})
          </button>
          <button type="button" class="cyc-pill-btn ${state.itemFilter === 'discrepancy' ? 'is-active' : ''}" data-item-filter="discrepancy">
            Discrepancies (${discCount})
          </button>
          <button type="button" class="cyc-pill-btn ${state.itemFilter === 'checked' ? 'is-active' : ''}" data-item-filter="checked">
            Done (${checkedCount})
          </button>
        </div>

        <!-- Walk-Path Sort -->
        <div class="cyc-sort-wrap">
          <label for="cycItemSortSelect" class="cyc-sort-lbl">Order:</label>
          <select id="cycItemSortSelect" class="cyc-sort-select">
            <option value="aisle" ${state.itemSort === 'aisle' ? 'selected' : ''}>Walk-Path (Aisle A01 &rarr; Z99)</option>
            <option value="multi_first" ${state.itemSort === 'multi_first' ? 'selected' : ''}>Multi-Location First</option>
            <option value="portal" ${state.itemSort === 'portal' ? 'selected' : ''}>Portal Sequence (#1 &rarr; #N)</option>
            <option value="qty_desc" ${state.itemSort === 'qty_desc' ? 'selected' : ''}>Highest On-Hand Qty</option>
          </select>
        </div>
      </div>
    </div>

    <div class="cyc-items-list" id="cycItemsList">
      ${itemsHtml || '<div class="cyc-empty-inline">No items in this batch match your current filter.</div>'}
    </div>
  `;
}

/* --------------------------------------------------------------------------
   Master Workspace Render & Event Delegation
   -------------------------------------------------------------------------- */

function renderCycleWorkspace() {
  if (!mountEl || !state.isOpen) return;
  disconnectBarcodeObserver();

  const activeBatch = state.subView === 'detail' ? getActiveBatch() : null;
  if (state.subView === 'detail' && !activeBatch) {
    state.subView = 'batches';
  }

  const bodyHtml =
    state.subView === 'detail' && activeBatch
      ? renderBatchDetailViewHtml(activeBatch)
      : renderBatchListViewHtml();

  mountEl.innerHTML = `
    <div class="cyc-container">
      ${renderTopHeaderHtml()}
      <div class="cyc-body-stage">
        ${bodyHtml}
      </div>
    </div>
  `;

  wireCycleWorkspaceEvents();
  if (state.subView === 'detail' && activeBatch) {
    setupBarcodeLazyObserver();
  }
}

function updateBatchProgressDomInPlace() {
  const batch = getActiveBatch();
  if (!batch || !mountEl) return;
  const prog = getBatchProgress(batch);
  const progCluster = mountEl.querySelector('.cyc-detail-progress-cluster');
  if (progCluster) {
    progCluster.innerHTML = `
      <div class="cyc-detail-prog-text">
        <span>Verified: <strong>${prog.checkedLocations} / ${prog.totalLocations}</strong> Locations (${prog.pct}%)</span>
        ${prog.localDiscrepancies > 0
          ? `<span class="cyc-disc-pill">⚠️ ${prog.localDiscrepancies} Discrepancies</span>`
          : '<span class="cyc-ok-pill">✓ 0 Discrepancies</span>'}
      </div>
      <div class="cyc-progress-track is-compact">
        <div class="cyc-progress-fill" style="width:${prog.pct}%"></div>
      </div>
    `;
  }
}

function wireCycleWorkspaceEvents() {
  if (!mountEl) return;

  // Back to Picker
  const backPickerBtn = document.getElementById('cycBackToPickerBtn');
  if (backPickerBtn) {
    backPickerBtn.onclick = () => closeCycleView();
  }

  // Refresh button
  const refreshBtn = document.getElementById('cycRefreshBtn');
  if (refreshBtn) {
    refreshBtn.onclick = () => loadCycles({ force: true, keepSubView: true });
  }

  // Global QR / Code 128 segmented buttons
  mountEl.querySelectorAll('[data-cyc-fmt]').forEach((btn) => {
    btn.onclick = () => {
      const fmt = btn.dataset.cycFmt;
      toggleGlobalBarcodeFormat(fmt);
    };
  });

  // Demo & Retry buttons
  const demoBtn = document.getElementById('cycTryDemoBtn') || document.getElementById('cycEmptyDemoBtn');
  if (demoBtn) demoBtn.onclick = () => loadDemoSampleData();

  const retryBtn = document.getElementById('cycRetryLoadBtn') || document.getElementById('cycEmptyRetryBtn');
  if (retryBtn) retryBtn.onclick = () => loadCycles({ force: true, keepSubView: true });

  // Sub-view: Batches list controls
  if (state.subView === 'batches') {
    mountEl.querySelectorAll('[data-batch-filter]').forEach((btn) => {
      btn.onclick = () => {
        state.batchFilter = btn.dataset.batchFilter || 'all';
        renderCycleWorkspace();
      };
    });

    const batchSearch = document.getElementById('cycBatchSearchInput');
    if (batchSearch) {
      batchSearch.oninput = (e) => {
        state.batchSearchQuery = e.target.value || '';
        const pos = batchSearch.selectionStart;
        renderCycleWorkspace();
        const nextInput = document.getElementById('cycBatchSearchInput');
        if (nextInput) {
          nextInput.focus();
          try { nextInput.setSelectionRange(pos, pos); } catch (err) {}
        }
      };
    }

    const batchClear = document.getElementById('cycBatchSearchClear');
    if (batchClear) {
      batchClear.onclick = () => {
        state.batchSearchQuery = '';
        renderCycleWorkspace();
      };
    }

    mountEl.querySelectorAll('[data-open-batch]').forEach((card) => {
      const openFn = () => {
        const bid = card.dataset.openBatch;
        if (!bid) return;
        state.activeBatchId = bid;
        state.subView = 'detail';
        state.itemFilter = 'all';
        state.itemSearchQuery = '';
        try {
          history.pushState({ smouhaView: 'cycle-batch', batchId: bid }, '', '#/cycle/batch/' + encodeURIComponent(bid));
        } catch (e) {}
        renderCycleWorkspace();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      };
      card.onclick = openFn;
      card.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openFn();
        }
      };
    });

    const prevBtn = document.getElementById('cycPrevPageBtn');
    if (prevBtn) {
      prevBtn.onclick = () => {
        if (state.page > 1) {
          state.page -= 1;
          loadCycles({ force: false, keepSubView: false });
        }
      };
    }
    const nextBtn = document.getElementById('cycNextPageBtn');
    if (nextBtn) {
      nextBtn.onclick = () => {
        state.page += 1;
        loadCycles({ force: false, keepSubView: false });
      };
    }
    return;
  }

  // Sub-view: Batch Detail controls
  const backBatchesBtn = document.getElementById('cycBackToBatchesBtn');
  if (backBatchesBtn) {
    backBatchesBtn.onclick = () => {
      state.subView = 'batches';
      state.activeBatchId = null;
      try {
        history.pushState({ smouhaView: 'cycle' }, '', '#/cycle');
      } catch (e) {}
      renderCycleWorkspace();
    };
  }

  const exportBtn = document.getElementById('cycExportSummaryBtn');
  if (exportBtn) {
    exportBtn.onclick = () => exportBatchSummaryText(getActiveBatch());
  }

  const resetBtn = document.getElementById('cycResetDraftsBtn');
  if (resetBtn) {
    resetBtn.onclick = () => {
      const b = getActiveBatch();
      if (!b) return;
      if (!confirm(`Clear all local floor checks & counted numbers for Batch #${b.reference}?`)) return;
      clearBatchDrafts(b.id);
      renderCycleWorkspace();
      appCallbacks.toast('Local batch checks cleared');
    };
  }

  // Item Filter pills
  mountEl.querySelectorAll('[data-item-filter]').forEach((btn) => {
    btn.onclick = () => {
      state.itemFilter = btn.dataset.itemFilter || 'all';
      renderCycleWorkspace();
    };
  });

  // Sort select
  const sortSelect = document.getElementById('cycItemSortSelect');
  if (sortSelect) {
    sortSelect.onchange = () => {
      state.itemSort = sortSelect.value || 'aisle';
      renderCycleWorkspace();
    };
  }

  // Scan / Search inside batch
  const scanInput = document.getElementById('cycItemScanInput');
  if (scanInput) {
    scanInput.oninput = () => {
      state.itemSearchQuery = scanInput.value || '';
      const pos = scanInput.selectionStart;
      renderCycleWorkspace();
      const restored = document.getElementById('cycItemScanInput');
      if (restored) {
        restored.focus();
        try { restored.setSelectionRange(pos, pos); } catch (e) {}
      }
    };
    scanInput.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const q = (scanInput.value || '').trim();
        if (q) handleExternalScanInCycle(q);
      }
    };
  }

  const scanClear = document.getElementById('cycItemScanClear');
  if (scanClear) {
    scanClear.onclick = () => {
      state.itemSearchQuery = '';
      renderCycleWorkspace();
    };
  }

  const pelicanCamBtn = document.getElementById('cycPelicanCamBtn');
  if (pelicanCamBtn) {
    pelicanCamBtn.onclick = () => {
      const mainSmartBtn = document.getElementById('smartScanBtn');
      if (mainSmartBtn) mainSmartBtn.click();
    };
  }

  // Delegated interactions inside #cycItemsList
  const itemsList = document.getElementById('cycItemsList');
  if (itemsList) {
    // Wire desktop hover preview + click zoom on item thumbnails
    itemsList.querySelectorAll('.cyc-item-img-wrap').forEach((wrap) => {
      const imgEl = wrap.querySelector('img');
      if (imgEl && image.wireProductImageInteractions) {
        image.wireProductImageInteractions(wrap, imgEl, quickGetSettings);
      }
    });

    itemsList.onclick = (e) => {
      const copySkuBtn = e.target.closest('[data-copy-sku]');
      if (copySkuBtn) {
        copyToClipboard(copySkuBtn.dataset.copySku, `SKU ${copySkuBtn.dataset.copySku} Copied`);
        return;
      }

      const copyLocBtn = e.target.closest('[data-copy-loc]');
      if (copyLocBtn) {
        copyToClipboard(copyLocBtn.dataset.copyLoc, `Location ${copyLocBtn.dataset.copyLoc} Copied`);
        return;
      }

      const scanLocBtn = e.target.closest('[data-scan-loc]');
      if (scanLocBtn) {
        openLocationBarcodeZoom(scanLocBtn.dataset.scanLoc);
        return;
      }

      const openPickerBtn = e.target.closest('[data-open-picker-sku]');
      if (openPickerBtn) {
        const sku = openPickerBtn.dataset.openPickerSku;
        const batch = getActiveBatch();
        const prod = batch && (batch.products || []).find((p) => String(p.sku) === String(sku));
        closeCycleView();
        if (appCallbacks.openInPicker) {
          appCallbacks.openInPicker(sku, prod || null);
        }
        return;
      }

      const toggleFmtBtn = e.target.closest('[data-toggle-fmt]');
      if (toggleFmtBtn) {
        toggleGlobalBarcodeFormat();
        return;
      }

      const selectBcBtn = e.target.closest('[data-select-bc-sku]');
      if (selectBcBtn) {
        const sku = selectBcBtn.dataset.selectBcSku;
        const idx = Number(selectBcBtn.dataset.selectBcIdx) || 0;
        const val = selectBcBtn.dataset.selectBcVal || '';
        state.selectedBarcodeIdxBySku.set(sku, idx);
        copyToClipboard(val, `Barcode Br:${idx + 1} Copied`);

        const card = selectBcBtn.closest('.cyc-item-card');
        if (card) {
          card.querySelectorAll('.cyc-br-item').forEach((b, i) => {
            b.classList.toggle('is-active', i === idx);
          });
          const wrap = card.querySelector('.cyc-bc-wrap');
          if (wrap) {
            wrap.dataset.bcValue = val;
            wrap.dataset.renderedVal = '';
            renderCardBarcodeSlot(card);
          }
        }
        return;
      }

      const checkBtn = e.target.closest('[data-check-sku]');
      if (checkBtn) {
        const batch = getActiveBatch();
        if (!batch) return;
        const sku = checkBtn.dataset.checkSku;
        const locName = checkBtn.dataset.checkLoc;
        const sysQty = checkBtn.dataset.sysQty;
        const cur = getLocationDraft(batch.id, sku, locName);
        const nextChecked = !cur.checked;
        const nextCountVal = nextChecked && cur.countVal === '' ? String(sysQty) : cur.countVal;
        setLocationDraft(batch.id, sku, locName, { checked: nextChecked, countVal: nextCountVal });
        renderCycleWorkspace();
        return;
      }
    };

    // Floor count numeric inputs
    itemsList.querySelectorAll('.cyc-floor-input').forEach((input) => {
      input.oninput = () => {
        const batch = getActiveBatch();
        if (!batch) return;
        const sku = input.dataset.draftSku;
        const locName = input.dataset.draftLoc;
        const val = input.value.trim();
        setLocationDraft(batch.id, sku, locName, {
          countVal: val,
          checked: val !== '',
        });
        updateBatchProgressDomInPlace();
      };
      input.onchange = () => {
        renderCycleWorkspace();
      };
    });
  }
}

/* --------------------------------------------------------------------------
   External Scanner / Pelican Camera Scan Integration
   -------------------------------------------------------------------------- */

export function handleExternalScanInCycle(codeRaw) {
  const code = String(codeRaw || '').trim();
  if (!code) return false;
  appCallbacks.playScanFeedback();

  // If currently on Batch List view, search across all batches to find matching SKU/barcode
  if (state.subView === 'batches') {
    for (const b of state.batches || []) {
      const hit = findProductByScanCode(b.products || [], code);
      if (hit) {
        state.activeBatchId = b.id;
        state.subView = 'detail';
        state.itemFilter = 'all';
        state.itemSearchQuery = '';
        renderCycleWorkspace();
        setTimeout(() => scrollToAndHighlightCycleSku(hit.sku), 60);
        return true;
      }
    }
    state.batchSearchQuery = code;
    renderCycleWorkspace();
    appCallbacks.toast(`Filtered batches for: ${code}`);
    return true;
  }

  // Inside Batch Detail view
  const batch = getActiveBatch();
  if (!batch) return false;
  const hit = findProductByScanCode(batch.products || [], code);
  if (hit) {
    if (state.itemFilter !== 'all' || state.itemSearchQuery) {
      state.itemFilter = 'all';
      state.itemSearchQuery = '';
      renderCycleWorkspace();
    }
    setTimeout(() => scrollToAndHighlightCycleSku(hit.sku), 40);
    return true;
  }

  appCallbacks.toast(`Code ${code} not found in Batch #${batch.reference}`, 'error');
  return true;
}

function scrollToAndHighlightCycleSku(sku) {
  const card = document.getElementById(`cyc-item-${sku}`);
  if (!card) return;
  renderCardBarcodeSlot(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.remove('is-scan-flash');
  void card.offsetWidth;
  card.classList.add('is-scan-flash');
  const firstInput = card.querySelector('.cyc-floor-input');
  if (firstInput) {
    try {
      firstInput.focus({ preventScroll: true });
      firstInput.select();
    } catch (e) {}
  }
  setTimeout(() => card.classList.remove('is-scan-flash'), 2200);
}

/* --------------------------------------------------------------------------
   View Open / Close & History Routing
   -------------------------------------------------------------------------- */

export function isCycleViewOpen() {
  return !!state.isOpen;
}

export function openCycleView({ pushHash = true } = {}) {
  if (!mountEl) mountEl = document.getElementById('cycleWorkspace');
  if (!mountEl) return;

  state.isOpen = true;
  document.documentElement.classList.add('cycle-view-active');
  mountEl.hidden = false;
  mountEl.removeAttribute('hidden');
  if (headerBtnEl) headerBtnEl.classList.add('is-active');

  if (pushHash && !window.location.hash.startsWith('#/cycle')) {
    try {
      history.pushState({ smouhaView: 'cycle' }, '', '#/cycle');
    } catch (e) {}
  }

  if (!state.batches.length && !state.loading) {
    loadCycles({ force: false, keepSubView: true });
  } else {
    renderCycleWorkspace();
  }
}

export function closeCycleView({ fromPopState = false } = {}) {
  if (!state.isOpen) return;
  state.isOpen = false;
  disconnectBarcodeObserver();
  document.documentElement.classList.remove('cycle-view-active');
  if (mountEl) {
    mountEl.hidden = true;
    mountEl.setAttribute('hidden', '');
  }
  if (headerBtnEl) headerBtnEl.classList.remove('is-active');

  if (!fromPopState && window.location.hash.startsWith('#/cycle')) {
    try {
      history.pushState({ smouhaView: 'picker' }, '', window.location.pathname + window.location.search);
    } catch (e) {}
  }
}

export function initCycleCount(callbacks = {}) {
  appCallbacks = { ...appCallbacks, ...callbacks };
  loadDrafts();

  mountEl = document.getElementById('cycleWorkspace');
  headerBtnEl = document.getElementById('cycleCountBtn');

  if (headerBtnEl) {
    headerBtnEl.addEventListener('click', (e) => {
      e.preventDefault();
      if (state.isOpen) {
        closeCycleView();
      } else {
        openCycleView({ pushHash: true });
      }
    });
  }

  // Listen for warehouse changes -> reload cycle snapshot or fetch fresh
  if (warehouse.onChange) {
    warehouse.onChange(() => {
      state.activeBatchId = null;
      state.subView = 'batches';
      if (state.isOpen) {
        loadCycles({ force: true, keepSubView: false });
      } else {
        const wid = warehouse.getSelectedId && warehouse.getSelectedId();
        const snap = loadWarehouseSnapshot(wid);
        if (snap && snap.rawList) {
          const parsed = normalizeCycleListPayload(snap.rawList);
          state.batches = parsed.batches;
          updateHeaderBadge();
        }
      }
    });
  }

  // Browser / Android APK Back Button handling
  window.addEventListener('popstate', () => {
    const h = window.location.hash || '';
    if (h.startsWith('#/cycle/batch/')) {
      const bid = decodeURIComponent(h.replace('#/cycle/batch/', ''));
      if (!state.isOpen) openCycleView({ pushHash: false });
      state.activeBatchId = bid;
      state.subView = 'detail';
      renderCycleWorkspace();
    } else if (h.startsWith('#/cycle')) {
      if (!state.isOpen) {
        openCycleView({ pushHash: false });
      } else if (state.subView === 'detail') {
        state.subView = 'batches';
        state.activeBatchId = null;
        renderCycleWorkspace();
      }
    } else if (state.isOpen) {
      closeCycleView({ fromPopState: true });
    }
  });

  // Restore badge count from cached snapshot if available on boot
  setTimeout(() => {
    try {
      const wid = (warehouse.getSelectedId && warehouse.getSelectedId()) || 'd24a9f96-f6bc-43b0-af78-b7067f0c901c';
      const snap = loadWarehouseSnapshot(wid);
      if (snap && snap.rawList && !state.batches.length) {
        const parsed = normalizeCycleListPayload(snap.rawList);
        state.cycles = parsed.cycles;
        state.batches = parsed.batches;
        if (snap.kpi) state.kpi = normalizeCycleKpi(snap.kpi);
        updateHeaderBadge();
      }
      if (window.location.hash.startsWith('#/cycle')) {
        openCycleView({ pushHash: false });
      }
    } catch (e) {}
  }, 250);
}
