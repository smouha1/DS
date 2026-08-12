/* ============================================================================
   app.js — main orchestrator
   ------------------------------------------------------------------------
   Ties every module together: local persistence (store), the product card
   / search UI (ui), Pelican Mode camera+OCR scanning (smartScan), and the
   startup sequence (bootstrap at the bottom of this file).

   Settings and Maintenance are genuinely lazy — see ui.js's init() further
   down, which dynamically import()s settings.js/maintenance.js only the
   first time their respective UI is opened. The one exception is reading
   *values* of settings (quickGetSettings below): a few hot paths (image
   hover-preview, auto-copy, QR toggle, Performance/Compact mode at boot)
   need a settings value synchronously and can't wait on a dynamic import,
   so a tiny reader lives here, sourcing the exact same localStorage key
   settings.js's full panel writes to. This is the one deliberate, minimal,
   documented exception to "no duplicated code" in the whole codebase.
   ============================================================================ */

import * as search from './search.js';
import * as barcodeLib from './barcode.js';
import * as db from './indexeddb.js';
import * as updater from './updater.js';
import * as dmartLib from './dmart.js';
import * as dmartLive from './dmartLive.js';
import * as warehouse from './warehouse.js';
import * as image from './image.js';

const SETTINGS_KEY = 'smouhaPickSettings';
const SETTINGS_DEFAULTS = {
  autoCopyBarcode: false,
  autoCopySku: true,
  hoverPreview: true,
  compactMode: false,
  performanceMode: false,
  largeBarcode: false,
  largeProductImage: false,
  qrCode: true,
  scanSound: false,
  showProductCount: true,
  showVersion: true,
  warehouseDisplay: 'original',
  recentBesideBarcode: true,
  dmartPopupEnabled: true,
};

function quickGetSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...SETTINGS_DEFAULTS, ...JSON.parse(raw) } : { ...SETTINGS_DEFAULTS };
  } catch (e) {
    return { ...SETTINGS_DEFAULTS };
  }
}

function quickApplyGlobalModes() {
  const s = quickGetSettings();
  document.documentElement.classList.toggle('performance-mode', !!s.performanceMode);
  document.documentElement.classList.toggle('compact-mode', !!s.compactMode);
  document.documentElement.classList.toggle('large-barcode', !!s.largeBarcode);
  document.documentElement.classList.toggle('large-product-image', !!s.largeProductImage);
  document.documentElement.classList.toggle('recent-beside-barcode', !!s.recentBesideBarcode);
  document.documentElement.classList.toggle('hide-dmart-live', !s.showProductCount);
}

/* ============================================================================
   MODULE: store (localStorage persistence)
   ============================================================================ */
const store = (() => {
  const KEYS = { RECENT: 'tm_recent_searches', FAVS: 'tm_favorites', THEME: 'tm_theme' };
  const MAX_RECENT = 20;

  function safeGet(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) { return fallback; }
  }
  function safeSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage full/unavailable */ }
  }

  function getRecent() { return safeGet(KEYS.RECENT, []); }
  function addRecent(sku) {
    let list = getRecent().filter(s => s !== sku);
    list.unshift(sku);
    if (list.length > MAX_RECENT) list = list.slice(0, MAX_RECENT);
    safeSet(KEYS.RECENT, list);
    return list;
  }
  function clearRecent() { safeSet(KEYS.RECENT, []); }

  function getFavs() { return safeGet(KEYS.FAVS, []); }
  function isFav(sku) { return getFavs().includes(sku); }
  function toggleFav(sku) {
    let list = getFavs();
    if (list.includes(sku)) list = list.filter(s => s !== sku);
    else list.unshift(sku);
    safeSet(KEYS.FAVS, list);
    return list;
  }
  function clearFavs() { safeSet(KEYS.FAVS, []); }

  function getTheme() { return safeGet(KEYS.THEME, null); }
  function setTheme(t) { safeSet(KEYS.THEME, t); }

  return { getRecent, addRecent, clearRecent, getFavs, isFav, toggleFav, clearFavs, getTheme, setTheme };
})();

/* ============================================================================
   MODULE: productIndex
   ------------------------------------------------------------------------
   Builds Map-based indexes ONCE at startup for O(1) exact lookups:
     Map<SKU, Product>
     Map<Barcode, Product[]>        (any entry in a product's barcodes[] resolves)
     Map<Last6Digits, Product[]>
   No iteration over the product list happens during an exact-match search.
   Prefix search (SKU/barcode "starts with") and name search ("contains")
   are linear scans — fast enough at this catalog size and needed for the
   suggestions dropdown's lower-priority tiers.
   ============================================================================ */
const productIndex = (() => {
  let products = [];
  const bySku = new Map();
  const byBarcode = new Map();      // any barcode in barcodes[] -> [productRef]
  const bySuffix6 = new Map();      // last 6 digits of any barcode -> [productRef]
  const nameSearchCache = [];       // {product, lowerName} — used only for the suggestions dropdown
  const barcodeFlatCache = [];      // {product, barcode} — used for "barcode starts with"

  /** Normalizes raw rows into { id, sku, name, image, barcodes[] } and builds
   *  the O(1) lookup maps. barcodes[0] is treated as the primary barcode. */
  function build(raw) {
    products = raw.map((row, i) => {
      const [name, sku, barcodeRaw, image] = row;
      const barcodes = barcodeParser.parse(barcodeRaw);
      return { id: i, name: name || 'Unnamed product', sku: String(sku || ''), barcodes, image: image || '' };
    });

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

  function findBySku(sku) { return bySku.get(sku) || null; }
  function findByBarcode(barcode) { return byBarcode.get(barcode) || []; }
  function findBySuffix(suffix) { return bySuffix6.get(suffix) || []; }
  function getBySkuList(skus) { return skus.map(s => bySku.get(s)).filter(Boolean); }

  function searchNames(query, limit = 8) {
    const q = query.toLowerCase();
    const results = [];
    for (let i = 0; i < nameSearchCache.length && results.length < limit; i++) {
      if (nameSearchCache[i].lowerName.includes(q)) results.push(nameSearchCache[i].product);
    }
    return results;
  }

  /** Priority tier 4: SKU starts with the typed text (excludes exact match,
   *  which is already handled separately at higher priority). */
  function skusStartingWith(prefix, limit = 10) {
    const results = [];
    for (let i = 0; i < products.length && results.length < limit; i++) {
      const p = products[i];
      if (p.sku && p.sku !== prefix && p.sku.startsWith(prefix)) results.push(p);
    }
    return results;
  }

  /** Priority tier 5: any barcode starts with the typed text. */
  function barcodesStartingWith(prefix, limit = 10) {
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

  function count() { return products.length; }

  return {
    build, findBySku, findByBarcode, findBySuffix, getBySkuList,
    searchNames, skusStartingWith, barcodesStartingWith, count
  };
})();

/* ============================================================================
   MODULE: searchEngine
   ------------------------------------------------------------------------
   Two distinct strategies, each with its own explicit priority:

   query() — MANUAL typed search
     1) exact SKU
     2) last 6 digits of a barcode
     Full barcode is intentionally NOT supported for manual typing.

   queryPelican() — Pelican Mode (camera) search
     1) full barcode (exact match against any entry in barcodes[])
     2) exact SKU
     3) last 6 digits of a barcode

   Neither ever guesses — if multiple products match, caller must present
   a choice.
   ============================================================================ */
const searchEngine = (() => {
  function query(raw) {
    const q = raw.trim();
    if (!q) return { type: 'empty', results: [] };
    if (!/^[0-9A-Za-z]+$/.test(q)) return { type: 'invalid', results: [] };

    // 1. Exact SKU
    const skuMatch = productIndex.findBySku(q);
    if (skuMatch) return { type: 'sku', results: [skuMatch] };

    // 2. Last 6 digits
    if (q.length >= 4) {
      const suffix = q.length >= 6 ? q.slice(-6) : q;
      const suffixMatches = productIndex.findBySuffix(suffix);
      if (suffixMatches.length) return { type: 'suffix', results: dedupe(suffixMatches) };
    }

    return { type: 'none', results: [] };
  }

  function queryPelican(raw) {
    const q = raw.trim();
    if (!q) return { type: 'empty', results: [] };
    if (!/^[0-9A-Za-z]+$/.test(q)) return { type: 'invalid', results: [] };

    // 1. Full barcode (any entry in barcodes[])
    const barcodeMatches = productIndex.findByBarcode(q);
    if (barcodeMatches.length) return { type: 'barcode', results: dedupe(barcodeMatches) };

    // 2. Exact SKU
    const skuMatch = productIndex.findBySku(q);
    if (skuMatch) return { type: 'sku', results: [skuMatch] };

    // 3. Last 6 digits
    if (q.length >= 4) {
      const suffix = q.length >= 6 ? q.slice(-6) : q;
      const suffixMatches = productIndex.findBySuffix(suffix);
      if (suffixMatches.length) return { type: 'suffix', results: dedupe(suffixMatches) };
    }

    return { type: 'none', results: [] };
  }

  function dedupe(list) {
    const seen = new Set();
    return list.filter(p => (seen.has(p.id) ? false : (seen.add(p.id), true)));
  }

  return { query, queryPelican };
})();



/* ============================================================================
   MODULE: ui — rendering & DOM interaction
   ============================================================================ */
const ui = (() => {
  const els = {};
  let debounceTimer = null;
  let activeSuggestionIndex = -1;
  let currentSuggestions = [];

  function cacheEls() {
    els.searchInput = document.getElementById('searchInput');
    els.clearBtn = document.getElementById('clearBtn');
    els.suggestionsBox = document.getElementById('suggestionsBox');
    els.searchStats = document.getElementById('searchStats');
    els.resultArea = document.getElementById('resultArea');
    els.quickAccessGrid = document.getElementById('quickAccessGrid');
    els.recentList = document.getElementById('recentList');
    els.favList = document.getElementById('favList');
    els.clearRecent = document.getElementById('clearRecent');
    els.clearFavs = document.getElementById('clearFavs');
    els.toastContainer = document.getElementById('toastContainer');
    els.choiceModal = document.getElementById('choiceModal');
    els.choiceModalBody = document.getElementById('choiceModalBody');
    els.choiceModalClose = document.getElementById('choiceModalClose');
    els.teamModal = document.getElementById('teamModal');
    els.teamModalClose = document.getElementById('teamModalClose');
    els.teamLinkBtn = document.getElementById('teamLinkBtn');
    els.zoomBackdrop = document.getElementById('zoomBackdrop');
    els.zoomImg = document.getElementById('zoomImg');
    els.zoomClose = document.getElementById('zoomClose');
        els.stickyBar = document.getElementById('stickyBarcodeBar');
    els.stickyBarImg = document.getElementById('stickyBarcodeImg');
    els.stickyBarNumber = document.getElementById('stickyBarcodeNumber');
    els.settingsBtn = document.getElementById('settingsBtn');
    els.settingsBackdrop = document.getElementById('settingsBackdrop');
    els.settingsPanel = document.getElementById('settingsPanel');
    els.settingsClose = document.getElementById('settingsClose');
    els.maintenanceBackdrop = document.getElementById('maintenanceBackdrop');
    els.maintenanceBody = document.getElementById('maintenanceBody');
    els.maintenanceClose = document.getElementById('maintenanceClose');
    els.appVersionLine = document.getElementById('appVersionLine');
    els.searchSpinner = document.getElementById('searchSpinner');
    els.searchIcon = document.getElementById('searchIcon');
  }

  /* ---------- Zero-click workflow (search stays the home base) ----------
   *  After a discrete, explicit success — a completed scan, an explicit
   *  product pick, Enter, or closing a modal — focus returns to the search
   *  input with its text selected, so the next scan/type instantly replaces
   *  it. Deliberately NOT called from the plain debounced-typing path, so
   *  it never fights the user while they're still actively typing.
   *  Desktop/Pelican only — on touch-only devices this would pop the
   *  virtual keyboard open unexpectedly, so it's skipped entirely there. */
  function shouldAutoFocus() {
    return window.matchMedia && !window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  }
  function returnFocusToSearch() {
    if (!els.searchInput || els.searchInput.disabled) return;
    // Mobile: soft focus attempt without fighting the keyboard
    try {
      els.searchInput.focus({ preventScroll: true });
    } catch (e) {
      try { els.searchInput.focus(); } catch (e2) { /* ignore */ }
    }
    // Desktop only: select for quick overwrite after scan. On touch, select()
    // makes the next tap feel "dead" (needs extra tap to place caret).
    if (shouldAutoFocus()) {
      try { els.searchInput.select(); } catch (e) { /* ignore */ }
    }
  }

  /* ---------- Theme ---------- */
  function initTheme() {
    const saved = store.getTheme();
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = saved || (prefersDark ? 'dark' : 'light');
    applyTheme(theme);
    // Dark Mode lives in Settings (Appearance). Same storage API as before.
    window.addEventListener('smouha:toggle-theme', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      store.setTheme(next);
      window.dispatchEvent(new CustomEvent('smouha:theme-changed', { detail: { theme: next } }));
    });
  }

  function applyTheme(theme) {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }

  /* ---------- Toast ---------- */
  function toast(message, type = 'success') {
    const icons = {
      success: '<path d="M20 6 9 17l-5-5"/>',
      error: '<path d="M18 6 6 18M6 6l12 12"/>',
    };
    const div = document.createElement('div');
    div.className = 'toast';
    div.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${icons[type] || icons.success}</svg><span></span>`;
    div.querySelector('span').textContent = message;
    els.toastContainer.appendChild(div);
    setTimeout(() => div.remove(), 2600);
  }

  /* ---------- Automatic SKU copy (centralized single-toast state) ----------
   *  Only one "SKU Copied Successfully" toast may exist at a time. Starting
   *  any new search immediately dismisses a pending one, so the workflow
   *  never shows stacked or stale copy confirmations. */
  let autoCopyToastEl = null;
  let autoCopyTimer = null;

  function dismissAutoCopyToast() {
    if (autoCopyTimer) { clearTimeout(autoCopyTimer); autoCopyTimer = null; }
    if (autoCopyToastEl) { autoCopyToastEl.remove(); autoCopyToastEl = null; }
  }

  function showAutoCopyToast(label) {
    dismissAutoCopyToast();
    const div = document.createElement('div');
    div.className = 'toast toast-auto-copy';
    div.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg><span>' + (label || 'SKU') + ' Copied Successfully</span>';
    els.toastContainer.appendChild(div);
    autoCopyToastEl = div;
    autoCopyTimer = setTimeout(() => {
      div.remove();
      if (autoCopyToastEl === div) autoCopyToastEl = null;
      autoCopyTimer = null;
    }, 2000);
  }

  /** Copies the SKU (or, if Auto Copy SKU is off but Auto Copy Barcode is
   *  on, the primary barcode) of a just-rendered, successfully found
   *  product. Only called from genuine search-result paths (SKU/barcode/
   *  last-6/camera and their suggestion/choice-modal follow-ups) — never
   *  on failed searches, and never when merely reopening an item from
   *  Recent/Favorites. Only one value can be on the clipboard at a time,
   *  so if both toggles are on, SKU wins (matches the original always-on
   *  default behavior this feature shipped with). */
  function autoCopyAfterSearch(product) {
    const s = quickGetSettings();
    let value = null;
    if (s.autoCopySku) value = product.sku;
    else if (s.autoCopyBarcode) value = product.barcodes[0];
    if (!value) return;
    const done = () => showAutoCopyToast();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(done).catch(() => fallbackCopy(value, done));
    } else {
      fallbackCopy(value, done);
    }
  }

  /* ---------- Search input handling ---------- */
  function initSearch() {
    if (!els.searchInput) return;
    els.searchInput.addEventListener('input', onInput);
    els.searchInput.addEventListener('keydown', onKeydown);
    if (!els.suggestionsBox.dataset.pointerWired) {
      els.suggestionsBox.dataset.pointerWired = '1';
      // Select only on intentional tap/click — NOT while scrolling.
      // pointerdown alone would fire when the user starts a scroll gesture.
      let tapState = null;
      const TAP_SLOP = 10; // px movement allowed before treating as scroll

      els.suggestionsBox.addEventListener('pointerdown', (e) => {
        if (e.button != null && e.button !== 0) return;
        const item = e.target.closest('.suggestion-item');
        if (!item || !els.suggestionsBox.contains(item)) {
          tapState = null;
          return;
        }
        tapState = {
          id: e.pointerId,
          x: e.clientX,
          y: e.clientY,
          item,
          moved: false
        };
      });

      els.suggestionsBox.addEventListener('pointermove', (e) => {
        if (!tapState || e.pointerId !== tapState.id) return;
        const dx = Math.abs(e.clientX - tapState.x);
        const dy = Math.abs(e.clientY - tapState.y);
        if (dx > TAP_SLOP || dy > TAP_SLOP) tapState.moved = true;
      }, { passive: true });

      const endTap = (e) => {
        if (!tapState || e.pointerId !== tapState.id) return;
        const state = tapState;
        tapState = null;
        if (state.moved) return; // was a scroll/drag
        const item = state.item;
        if (!item || !els.suggestionsBox.contains(item)) return;
        const idx = Number(item.dataset.idx);
        const list = els.suggestionsBox._suggestionProducts || [];
        if (!list[idx]) return;
        e.preventDefault();
        e.stopPropagation();
        selectProduct(list[idx]);
        closeSuggestions();
      };

      els.suggestionsBox.addEventListener('pointerup', endTap);
      els.suggestionsBox.addEventListener('pointercancel', () => { tapState = null; });

      // Keyboard / accessibility: Enter/Space on focused option
      els.suggestionsBox.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const item = e.target.closest('.suggestion-item');
        if (!item) return;
        e.preventDefault();
        const idx = Number(item.dataset.idx);
        const list = els.suggestionsBox._suggestionProducts || [];
        if (list[idx]) {
          selectProduct(list[idx]);
          closeSuggestions();
        }
      });
    }

    // ABC keyboard toggle (mobile)
    const abcBtn = document.getElementById('abcToggleBtn');
    if (abcBtn) {
      abcBtn.hidden = false; // CSS hides on desktop
      abcBtn.addEventListener('click', () => {
        const letters = abcBtn.classList.toggle('is-letters');
        els.searchInput.setAttribute('inputmode', letters ? 'text' : 'numeric');
        abcBtn.textContent = letters ? '123' : 'ABC';
        try { els.searchInput.focus(); } catch (e) {}
      });
    }

    // Custom Barcode — generate barcode from typed value without product lookup
    const customBcBtn = document.getElementById('customBarcodeBtn');
    if (customBcBtn) {
      customBcBtn.addEventListener('click', () => {
        const raw = (els.searchInput.value || '').trim();
        if (!raw) {
          toast('Type a value first');
          return;
        }
        renderCustomBarcode(raw);
      });
    }

    window.addEventListener('smouha:hover-preview-off', () => {
      try { image.closeZoom({ silent: true }); } catch (e) { /* ignore */ }
    });

    // Ensure the field is always reachable (popup/overlays must not steal the first tap)
    els.searchInput.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      try { els.searchInput.focus({ preventScroll: true }); } catch (err) { els.searchInput.focus(); }
    });
    els.searchInput.addEventListener('focus', () => {
      // If confirm panel had focus, keep search usable for next SKU
      els.searchInput.classList.add('is-focused');
    });
    els.searchInput.addEventListener('blur', () => {
      els.searchInput.classList.remove('is-focused');
    });
    try { initTeamRotator(); } catch (e) { /* ignore */ }
    window.addEventListener('smouha:settings-changed', () => {
      if (lastRenderedProduct) {
        try { refreshPrimaryBarcode(lastRenderedProduct); } catch (e) { /* ignore */ }
      }
    });
    els.clearBtn.addEventListener('click', () => {
      els.searchInput.value = '';
      els.searchInput.focus();
      onInput();
    });
    document.addEventListener('click', (e) => {
      if (!els.suggestionsBox.contains(e.target) && e.target !== els.searchInput) {
        closeSuggestions();
      }
    });
  }

  function onInput() {
    const val = els.searchInput.value.trim();
    els.clearBtn.classList.toggle('visible', val.length > 0);
    if (val.length > 0) els.clearBtn.removeAttribute('hidden');
    else els.clearBtn.setAttribute('hidden', '');
    dismissAutoCopyToast(); // any new typing/clearing resets the copy state

    clearTimeout(debounceTimer);
    if (!val) {
      closeSuggestions();
      renderEmptyState();
      els.searchStats.textContent = '';
      return;
    }

    // Suggestions update instantly on every keystroke — never debounced, so
    // they can never lag behind or appear to "disappear" while typing.
    updateSuggestions(val);

    // The full product-card render (skeleton + barcode generation) stays
    // debounced — that's a heavier, separate operation from the dropdown.
    debounceTimer = setTimeout(() => {
      runSearch(val);
    }, 120);
  }

  function onKeydown(e) {
    if (!currentSuggestions.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeSuggestionIndex = Math.min(activeSuggestionIndex + 1, currentSuggestions.length - 1);
      highlightSuggestion();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeSuggestionIndex = Math.max(activeSuggestionIndex - 1, 0);
      highlightSuggestion();
    } else if (e.key === 'Enter') {
      // An explicitly arrow-selected suggestion always wins. Otherwise, if
      // the top suggestion is an exact SKU match, Enter opens it immediately
      // — no arrow-key navigation required.
      const pick = (activeSuggestionIndex >= 0 && currentSuggestions[activeSuggestionIndex])
        ? currentSuggestions[activeSuggestionIndex]
        : (currentSuggestions[0] && currentSuggestions[0].matchField === 'sku-exact' ? currentSuggestions[0] : null);
      if (pick) {
        selectProduct(pick.product);
        closeSuggestions();
      }
    } else if (e.key === 'Escape') {
      closeSuggestions();
    }
  }

  function updateSuggestions(query) {
    const matches = search.computeSuggestions(query, 10);
    currentSuggestions = matches;
    activeSuggestionIndex = -1;
    renderSuggestions(matches, query);
  }

  
  /** Show Dmart confirm for a SKU (non-blocking panel).
   *  Called after a successful product show, and when the user taps
   *  "Check in Dmart". Does not freeze the page. */
  function promptDmartConfirm(sku) {
    if (!sku) return;
    // Settings: optional confirm popup
    if (!quickGetSettings().dmartPopupEnabled) {
      returnFocusToSearch();
      return;
    }
    warehouse.showDmartConfirm(sku).then((accepted) => {
      if (accepted) {
        const finalSku = warehouse.getPendingDmartSku() || sku;
        const url = dmartLib.buildDmartInventoryUrl(finalSku);
        window.open(url, '_blank', 'noopener,noreferrer');
      }
      returnFocusToSearch();
    }).catch((e) => {
      console.error('[dmart confirm]', e);
      returnFocusToSearch();
    });
  }

function renderSuggestions(matches, query) {
    if (!matches.length) {
      els.suggestionsBox.innerHTML = `<div class="suggestion-empty">No matches for "${escapeHtml(query)}"</div>`;
      els.suggestionsBox.classList.add('open');
      els.suggestionsBox.hidden = false;
      els.searchInput.setAttribute('aria-expanded', 'true');
      return;
    }
    const suffixNeedle = query.length >= 6 ? query.slice(-6) : query;
    els.suggestionsBox.innerHTML = matches.map((m, i) => {
      const p = m.product;
      const isSkuTier = m.matchField === 'sku-exact' || m.matchField === 'sku-prefix';
      const isBarcodeTier = m.matchField === 'barcode-exact' || m.matchField === 'barcode-prefix' || m.matchField === 'barcode-suffix';
      const nameHtml = m.matchField === 'name' ? search.highlightMatch(p.name, query, escapeHtml) : escapeHtml(p.name);
      const skuHtml = isSkuTier ? search.highlightMatch(p.sku, query, escapeHtml) : escapeHtml(p.sku);
      const bcDisplay = p.barcodes[0] || '\u2014';
      const bcNeedle = m.matchField === 'barcode-suffix' ? suffixNeedle : query;
      const bcHtml = isBarcodeTier ? search.highlightMatch(bcDisplay, bcNeedle, escapeHtml) : escapeHtml(bcDisplay);
      return `
      <div class="suggestion-item" data-idx="${i}" role="option" tabindex="-1">
        <img class="suggestion-thumb" src="${escapeAttr(p.image)}" alt="" loading="lazy" decoding="async" onerror="this.style.visibility='hidden'">
        <div class="suggestion-text">
          <div class="suggestion-name">${nameHtml}</div>
          <div class="suggestion-sub">SKU ${skuHtml} &middot; ${bcHtml}</div>
        </div>
      </div>
    `;
    }).join('');
    els.suggestionsBox.classList.add('open');
    els.suggestionsBox.hidden = false;
    els.searchInput.setAttribute('aria-expanded', 'true');
    els.suggestionsBox._suggestionProducts = matches.map((m) => m.product);
  }

  function highlightSuggestion() {
    els.suggestionsBox.querySelectorAll('.suggestion-item').forEach((el, i) => {
      el.classList.toggle('active', i === activeSuggestionIndex);
      if (i === activeSuggestionIndex) el.scrollIntoView({ block: 'nearest' });
    });
  }

  function closeSuggestions() {
    els.suggestionsBox.classList.remove('open');
    els.searchInput.setAttribute('aria-expanded', 'false');
    currentSuggestions = [];
    activeSuggestionIndex = -1;
  }

  function selectProduct(product) {
    els.searchInput.value = product.sku;
    els.clearBtn.classList.add('visible'); els.clearBtn.removeAttribute('hidden');
    renderProduct(product);
    recordSearch(product);
    autoCopyAfterSearch(product);
    promptDmartConfirm(product.sku);
  }

  /* ---------- Main search execution ----------
     searchFn defaults to the manual search strategy (SKU -> last 6 digits).
     Pelican Mode passes search.queryPelican instead (full barcode ->
     SKU -> last 6 digits), reusing this exact same rendering pipeline. */
  function runSearch(query, searchFn) {
    const fn = searchFn || search.query;
    const isPelicanScan = fn === search.queryPelican;
    dismissAutoCopyToast(); // reset copy state before every new search
    showSkeleton();
    // Deliberate minimum skeleton duration (120-180ms) for a smoother perceived
    // transition, even though the underlying Map lookup itself is near-instant.
    setTimeout(() => {
      const result = fn(query);
      els.searchStats.textContent = statsLabel(result);

      if (result.type === 'invalid') {
        renderState('invalid');
      } else if (result.type === 'none') {
        renderState('none', query);
      } else if (result.results.length === 1) {
        renderProduct(result.results[0]);
        recordSearch(result.results[0]);
        autoCopyAfterSearch(result.results[0]);
        promptDmartConfirm(result.results[0].sku);
        // A completed camera scan is always a discrete, explicit event —
        // safe to return focus. Manual typing is deliberately excluded so
        // this never fights the user mid-keystroke.
        if (isPelicanScan) returnFocusToSearch();
      } else if (result.results.length > 1) {
        renderState('duplicate', query, result.results.length);
        openChoiceModal(result.results);
      }
    }, 150);
  }

  function statsLabel(result) {
    if (result.type === 'empty' || result.type === 'invalid') return '';
    const n = result.results.length;
    if (n === 0) return 'No results';
    if (n === 1) return '1 product found';
    return `${n} products found — please choose one`;
  }

  /* ---------- Choice modal ---------- */
  function openChoiceModal(products) {
    els.choiceModalBody.innerHTML = products.map((p, i) => `
      <div class="choice-item" data-idx="${i}">
        <img class="choice-thumb" src="${escapeAttr(p.image)}" alt="" loading="lazy" decoding="async" onerror="this.src='${placeholderImg()}'">
        <div class="choice-info">
          <div class="choice-name">${escapeHtml(p.name)}</div>
          <div class="choice-sub">SKU ${escapeHtml(p.sku)} · ${escapeHtml(p.barcodes.join(', '))}</div>
        </div>
      </div>
    `).join('');
    els.choiceModalBody.querySelectorAll('.choice-item').forEach((el, i) => {
      el.addEventListener('click', () => {
        renderProduct(products[i]);
        recordSearch(products[i]);
        autoCopyAfterSearch(products[i]);
        promptDmartConfirm(products[i].sku);
        closeChoiceModal();
      });
    });
    els.choiceModal.classList.add('open');
  }
  function closeChoiceModal() {
    const wasOpen = els.choiceModal.classList.contains('open');
    els.choiceModal.classList.remove('open');
    if (wasOpen) returnFocusToSearch();
  }

  /* ---------- Team Members modal (UI enhancement only) ---------- */
  function openTeamModal() { els.teamModal.classList.add('open'); }
  function closeTeamModal() {
    const wasOpen = els.teamModal.classList.contains('open');
    els.teamModal.classList.remove('open');
    if (wasOpen) returnFocusToSearch();
  }

  /* ---------- States ---------- */
  function renderEmptyState() {
    els.resultArea.innerHTML = `
      <div class="state-panel">
        <svg class="state-icon-talabat-mark" viewBox="0 0 100 100" aria-hidden="true"><path d="M 51.28,14.43 L 48.01,15.07 L 44.50,16.59 L 42.58,17.94 L 40.11,20.81 L 38.60,25.36 L 38.52,34.85 L 26.63,34.85 L 26.63,41.71 L 27.67,44.42 L 30.06,46.41 L 32.46,47.05 L 38.60,47.13 L 38.68,67.78 L 40.27,73.60 L 42.66,77.59 L 46.09,81.02 L 50.00,83.33 L 54.47,84.61 L 59.25,84.77 L 64.75,83.49 L 67.70,81.90 L 67.70,70.18 L 64.51,70.97 L 61.80,70.73 L 58.93,69.22 L 57.26,67.15 L 56.14,63.32 L 56.14,47.13 L 69.54,47.05 L 69.54,39.87 L 68.26,37.00 L 65.79,35.25 L 56.14,34.77 L 56.14,14.35 Z" fill="currentColor"/></svg>
        <div class="state-title">Start scanning or typing</div>
        <div class="state-sub">Search by SKU or last 6 digits of a barcode.</div>
      </div>`;
  }

  function showSkeleton() {
    els.resultArea.innerHTML = `
      <div class="skeleton-card">
        <div class="skel skel-img"></div>
        <div class="skel-lines">
          <div class="skel skel-line" style="width:60%"></div>
          <div class="skel skel-line" style="width:35%"></div>
          <div class="skel skel-line" style="width:80%"></div>
          <div class="skel skel-line" style="width:50%"></div>
        </div>
      </div>`;
  }

  function renderState(kind, query, count) {
    if (stickyObserver) { stickyObserver.disconnect(); stickyObserver = null; }
    if (els.stickyBar) els.stickyBar.hidden = true;
    const states = {
      invalid: {
        icon: '<path d="M12 9v4M12 17h.01"/><circle cx="12" cy="12" r="10"/>',
        title: 'Invalid characters',
        sub: 'Search only supports letters and numbers.',
      },
      none: {
        icon: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
        title: 'No product found',
        sub: query ? `Nothing matches "${escapeHtml(query)}". Check the digits and try again.` : 'No matches found.',
      },
      duplicate: {
        icon: '<rect x="3" y="3" width="13" height="13" rx="2"/><path d="M16 8h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-2"/>',
        title: `${count} products share this code`,
        sub: 'Choose the correct product from the popup.',
      },
    };
    const s = states[kind];
    els.resultArea.innerHTML = `
      <div class="state-panel">
        <svg class="state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${s.icon}</svg>
        <div class="state-title">${s.title}</div>
        <div class="state-sub">${s.sub}</div>
      </div>`;
  }

  /* ---------- Product card rendering ---------- */
  // QR Code library — loaded once from the local project file (no CDN).
  // File: assets/js/qrcode-generator.js  →  global function window.qrcode
  let qrLibraryPromise = null;
  function ensureQrLibraryLoaded() {
    if (typeof window.qrcode === 'function') {
      return Promise.resolve();
    }
    if (qrLibraryPromise) return qrLibraryPromise;

    qrLibraryPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'assets/js/qrcode-generator.js';
      script.async = true;
      script.onload = () => {
        if (typeof window.qrcode === 'function') resolve();
        else {
          qrLibraryPromise = null;
          reject(new Error('qrcode global missing after local load'));
        }
      };
      script.onerror = () => {
        qrLibraryPromise = null;
        reject(new Error('Failed to load local qrcode-generator.js'));
      };
      document.head.appendChild(script);
    });

    return qrLibraryPromise;
  }

  let lastRenderedProduct = null;

  /** Draw Code128 or QR into #c128-0 for the given product. Safe to call
   *  repeatedly (settings toggle / re-search). Never rebuilds the card.
   *  Uses a generation token so an older async QR result can never overwrite
   *  a newer render (fixes intermittent "static noise" QR). */
  let barcodeRenderGen = 0;

  function ensureBarcodeSvg(wrap) {
    let el = document.getElementById('c128-0');
    if (el) return el;
    if (!wrap) return null;
    wrap.classList.remove('is-qr');
    wrap.innerHTML = '<svg id="c128-0" data-barcode-value=""></svg>';
    return document.getElementById('c128-0');
  }

  function wireBarcodeZoom(wrap) {
    if (!wrap) return;
    wrap.style.cursor = 'pointer';
    wrap.onclick = () => {
      const e2 = document.getElementById('c128-0');
      if (e2) image.openZoom(barcodeLib.svgToDataUrl(e2));
    };
  }

  function refreshPrimaryBarcode(product) {
    if (!product) return;
    const bc = product.barcodes && product.barcodes[0];
    if (!bc) return;

    const gen = ++barcodeRenderGen;
    const s = quickGetSettings();
    const useQr = s.qrCode && !s.performanceMode;

    let wrap = document.getElementById('c128-0')?.parentElement
      || document.querySelector('.barcode-128-wrap');
    if (!wrap) return;

    if (useQr) {
      wrap.classList.add('is-qr');
      // Keep a placeholder svg so the slot doesn't collapse
      ensureBarcodeSvg(wrap);
      ensureQrLibraryLoaded()
        .then(() => new Promise((resolve) => {
          // Yield so UI stays smooth; then encode
          setTimeout(() => {
            if (gen !== barcodeRenderGen) { resolve(null); return; }
            const el = ensureBarcodeSvg(wrap);
            if (!el) { resolve(false); return; }
            barcodeLib.renderSkuQr(el, bc).then(resolve);
          }, 0);
        }))
        .then((ok) => {
          if (gen !== barcodeRenderGen) return; // stale
          if (ok === null) return;
          wrap = document.querySelector('.barcode-128-wrap') || wrap;
          if (ok === true) {
            try {
              wrap.classList.add('is-qr');
              const svg = wrap.querySelector('svg, #c128-0');
              if (svg) {
                svg.style.width = '100%';
                svg.style.height = '100%';
                svg.style.display = 'block';
              }
              syncBarcodeTrackWidth();
            } catch (e) {}
          }
          if (ok === false) {
            wrap.innerHTML = '<span style="color:#9aa0aa;font-size:11px;">Could not render QR code</span>';
            return;
          }
          wireBarcodeZoom(wrap);
        })
        .catch(() => {
          if (gen !== barcodeRenderGen) return;
          const w = document.querySelector('.barcode-128-wrap');
          if (w) w.innerHTML = '<span style="color:#9aa0aa;font-size:11px;">Could not load QR library</span>';
        });
      return;
    }

    // Code128 path (default)
    wrap.classList.remove('is-qr');
    const liveSvg = ensureBarcodeSvg(wrap);
    if (!liveSvg) return;
    const ok = barcodeLib.renderCode128(liveSvg, bc);
    if (ok) {
      wireBarcodeZoom(wrap);
      try {
        const block = wrap.closest('.barcode-block-128');
        if (block) {
          const w = Math.ceil(wrap.getBoundingClientRect().width);
          if (w > 0) block.style.setProperty('--bc-track-width', w + 'px');
        }
      } catch (e) { /* ignore */ }
    } else {
      wrap.innerHTML = '<span style="color:#9aa0aa;font-size:11px;">Invalid barcode for Code128</span>';
    }
  }



  function syncBarcodeTrackWidth() {
    try {
      const wrap = document.querySelector('.barcode-128-wrap');
      const block = wrap && wrap.closest('.barcode-block-128');
      if (!wrap || !block) return;
      const apply = () => {
        const isQr = wrap.classList.contains('is-qr');
        let w = Math.ceil(wrap.getBoundingClientRect().width);
        if (w < 8) return;
        // Lock block + numbers to exact wrap width (QR frame or C128 box)
        block.style.width = w + 'px';
        block.style.maxWidth = '100%';
        block.style.boxSizing = 'border-box';
        const list = block.querySelector('.barcode-numbers-list');
        if (list) {
          list.style.width = w + 'px';
          list.style.maxWidth = '100%';
          list.style.boxSizing = 'border-box';
        }
      };
      apply();
      requestAnimationFrame(() => {
        apply();
        setTimeout(apply, 30);
        setTimeout(apply, 120);
        setTimeout(apply, 300);
      });
    } catch (e) { /* ignore */ }
  }







  function renderCustomBarcode(value) {
    closeSuggestions();
    const useQr = quickGetSettings().qrCode && !quickGetSettings().performanceMode;
    els.resultArea.innerHTML = `
      <div class="custom-barcode-card">
        <h3>Custom Barcode</h3>
        <div class="custom-barcode-wrap is-clickable${useQr ? ' is-qr' : ''}" id="customBcWrap" role="button" tabindex="0" title="Tap to enlarge">
          <svg id="customBcSvg"></svg>
        </div>
        <div class="custom-barcode-value">${escapeHtml(value)}</div>
      </div>`;
    const wrap = document.getElementById('customBcWrap');
    if (!wrap) return;

    const wireZoom = () => {
      const open = () => {
        try {
          const live = wrap.querySelector('svg');
          if (live) image.openZoom(barcodeLib.svgToDataUrl(live));
        } catch (e) { /* ignore */ }
      };
      wrap.onclick = open;
      wrap.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
    };

    const showFallback = () => {
      wrap.innerHTML = `<div class="custom-barcode-fallback">${escapeHtml(value)}</div>`;
      wireZoom();
    };

    const tryCode128 = () => {
      // Ensure a fresh svg target after possible QR DOM replace
      let svg = wrap.querySelector('svg');
      if (!svg) {
        wrap.innerHTML = '<svg id="customBcSvg"></svg>';
        wrap.classList.remove('is-qr');
        svg = wrap.querySelector('svg');
      }
      if (!window.JsBarcode || !svg) { showFallback(); return false; }
      const ok = barcodeLib.renderCode128(svg, value);
      if (!ok) { showFallback(); return false; }
      svg.style.width = '100%';
      svg.style.height = 'auto';
      svg.style.display = 'block';
      wireZoom();
      return true;
    };

    if (useQr) {
      ensureQrLibraryLoaded()
        .then(() => {
          let svg = wrap.querySelector('svg');
          if (!svg) {
            wrap.innerHTML = '<svg id="customBcSvg"></svg>';
            svg = wrap.querySelector('svg');
          }
          wrap.classList.add('is-qr');
          return barcodeLib.renderSkuQr(svg, value);
        })
        .then((ok) => {
          if (ok) {
            wrap.classList.add('is-qr');
            const live = wrap.querySelector('svg');
            if (live) {
              live.style.width = '100%';
              live.style.height = '100%';
              live.style.display = 'block';
            }
            wireZoom();
          } else {
            tryCode128();
          }
        })
        .catch(() => { tryCode128(); });
    } else {
      tryCode128();
    }
  }

  function renderProduct(product) {
    lastRenderedProduct = product;
    const isFav = store.isFav(product.sku);
    const downloadIconPath = '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>';
    const favIconPath = '<path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>';

    // Only ONE Code128 image is generated (the first/primary barcode).
    // Every barcode number — including the first — is still listed below as
    // plain text, which keeps the card compact for products with many
    // barcodes while never hiding a number from the user.
    const barcodesHtml = `
      <div class="barcode-block barcode-block-128">
        <div class="barcode-128-wrap">
          <svg id="c128-0" data-barcode-value="${escapeAttr(product.barcodes[0] || '')}"></svg>
        </div>
        <div class="barcode-numbers-list">
          ${product.barcodes.map((bc, i) => `
            <div class="barcode-number-item" data-copy="${escapeAttr(bc)}" role="button" tabindex="0" aria-label="Copy Barcode ${i + 1}">
              <span class="barcode-number-label">Barcode ${i + 1}</span>
              <span class="barcode-number-value">${escapeHtml(bc)}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    els.resultArea.innerHTML = `
      <div class="product-card">
        <div class="product-top-row">
          <div class="product-live-col">
            ${dmartLive.liveCardHtml(product.sku)}
          </div>
          <div class="product-image-col">
            <div class="product-image-wrap loading" id="prodImgWrap">
              <img id="prodImg" alt="${escapeAttr(product.name)}" loading="lazy" decoding="async" src="${escapeAttr(product.image)}">
              <span class="image-zoom-hint"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg> Zoom</span>
            </div>
            <div class="product-name-under-img" title="${escapeAttr(product.name)}">${escapeHtml(product.name)}</div>
          </div>
          <div class="product-barcodes-col barcodes-section">
            ${barcodesHtml}
            <div class="sku-qr-slot" id="skuQrSlot" hidden>
              <svg id="skuQrSvg" class="sku-qr-svg"></svg>
              <span class="sku-qr-label">SKU QR</span>
            </div>
          </div>
          <div class="product-recent-col" id="productRecentCol" hidden>
            <div class="product-recent-head">
              <span>Recent</span>
              <button type="button" class="panel-clear" id="inlineClearRecent">Clear</button>
            </div>
            <div class="product-recent-list" id="productRecentList"></div>
          </div>
        </div>
        <div class="product-details-row">
          <div class="product-title-row">
            <span class="product-name">${escapeHtml(product.name)}</span>
          </div>
          <div class="sku-barcode-row">
            <button class="info-field" id="skuField" aria-label="Copy SKU">
              <span class="info-label">SKU</span>
              <span class="info-value">${escapeHtml(product.sku)}</span>
            </button>
            <div class="info-field info-field-barcode">
              <button class="info-field-copy" id="barcodeField" aria-label="Copy barcode">
                <span class="info-label">Barcode</span>
                <span class="info-value">${escapeHtml(product.barcodes[0] || '')}</span>
              </button>
              <button class="icon-btn-sm" id="barcodeFieldDownload" data-c128-idx="0" data-barcode="${escapeAttr(product.barcodes[0] || '')}" aria-label="Download barcode PNG">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${downloadIconPath}</svg>
              </button>
            </div>
            <button class="info-field info-field-fav ${isFav ? 'active' : ''}" id="favBtn" aria-pressed="${isFav}" aria-label="Toggle favorite">
              <span class="info-label">Favorite</span>
              <span class="info-value info-value-fav">
                <svg viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${favIconPath}</svg>
              </span>
            </button>
          </div>
        </div>
      </div>
    `;

    // Image load/error handling
    const img = document.getElementById('prodImg');
    const wrap = document.getElementById('prodImgWrap');
    img.addEventListener('load', () => wrap.classList.remove('loading'), { once: true });
    img.addEventListener('error', () => {
      wrap.classList.remove('loading');
      img.src = placeholderImg();
    }, { once: true });
    if (img.complete && img.naturalWidth > 0) wrap.classList.remove('loading');

    // Click-to-zoom (all devices) + desktop-only auto-close hover preview —
    // both handled by image.js, which also respects Performance Mode and
    // the Hover Preview setting.
    image.wireProductImageInteractions(wrap, img, quickGetSettings);

    // Primary barcode / QR — shared helper so settings toggles can refresh
    // without rebuilding the entire product card.
    refreshPrimaryBarcode(product);

    // Every barcode number in the plain-text list copies on click/tap.
    els.resultArea.querySelectorAll('.barcode-number-item').forEach(item => {
      const doCopy = () => copyText(item.dataset.copy, item, 'Barcode Copied');
      item.addEventListener('click', doCopy);
      item.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doCopy(); } });
    });

    // Wire buttons
    document.getElementById('favBtn').addEventListener('click', (e) => {
      store.toggleFav(product.sku);
      const btn = e.currentTarget;
      const nowFav = store.isFav(product.sku);
      btn.classList.toggle('active', nowFav);
      btn.setAttribute('aria-pressed', String(nowFav));
      btn.querySelector('svg').setAttribute('fill', nowFav ? 'currentColor' : 'none');
      btn.classList.add('pulse');
      setTimeout(() => btn.classList.remove('pulse'), 350);
      renderFavorites();
      toast(nowFav ? 'Added to favorites' : 'Removed from favorites');
    });

    // Intercept "Check in Dmart" → confirmation dialog, then open URL.
    // Prevents default navigation so warehouse selection is always confirmed.
    const dmartBtn = els.resultArea.querySelector('a.dmart-check-btn');
    if (dmartBtn) {
      dmartBtn.href = dmartLib.buildDmartInventoryUrl(product.sku);
      dmartBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const url = dmartLib.buildDmartInventoryUrl(product.sku);
        window.open(url, '_blank', 'noopener,noreferrer');
      });
    }

    // Live Dmart stock + price (async, non-blocking, race-safe)
    try { dmartLive.requestLiveForProduct(product.sku); } catch (e) { /* never break product card */ }

    // Optional: Recent list beside barcode (settings)
    try { fillInlineRecent(); } catch (e) { /* ignore */ }
    try { syncBarcodeTrackWidth(); } catch (e) { /* ignore */ }

    document.getElementById('skuField').addEventListener('click', (e) => {
      copyText(product.sku, e.currentTarget, 'SKU Copied');
    });

    document.getElementById('barcodeField').addEventListener('click', (e) => {
      copyText(product.barcodes[0] || '', e.currentTarget, 'Barcode Copied');
    });

    document.getElementById('barcodeFieldDownload').addEventListener('click', (e) => {
      downloadCode128(e.currentTarget.dataset.c128Idx, e.currentTarget.dataset.barcode, product.sku);
    });

    initStickyBarcode();
  }

  /** Sticky Barcode Bar (mobile only). Shows only the primary barcode + number
   *  while the user scrolls past its normal position in the product card, so
   *  it stays scannable without scrolling back up. Purely a UI convenience —
   *  does not touch search, OCR, Pelican Mode, or the database. */
  let stickyObserver = null;
  function initStickyBarcode() {
    if (stickyObserver) { stickyObserver.disconnect(); stickyObserver = null; }
    if (!els.stickyBar) return;
    els.stickyBar.hidden = true;

    const isMobile = window.matchMedia('(max-width:768px)').matches;
    const firstBlock = els.resultArea.querySelector('.barcode-block-128');
    if (!isMobile || !firstBlock) return;

    const svgEl = firstBlock.querySelector('svg');
    const barcodeFieldEl = document.getElementById('barcodeField');
    const downloadBtn = document.getElementById('barcodeFieldDownload');
    if (!svgEl || !barcodeFieldEl) return;
    const valueEl = barcodeFieldEl.querySelector('.info-value');

    stickyObserver = new IntersectionObserver((entries) => {
      const entry = entries[0];
      const scrolledPast = !entry.isIntersecting && entry.boundingClientRect.top < 0;
      els.stickyBar.hidden = !scrolledPast;
      if (scrolledPast) {
        els.stickyBarImg.innerHTML = svgEl.outerHTML;
        els.stickyBarNumber.textContent = valueEl ? valueEl.textContent : '';
      }
    }, { threshold: 0 });
    stickyObserver.observe(firstBlock);

    document.getElementById('stickyCopyBtn').onclick = () => {
      barcodeFieldEl.click();
    };
    document.getElementById('stickyDownloadBtn').onclick = () => {
      if (downloadBtn) downloadBtn.click();
    };
  }


  function downloadCode128(idx, barcode, sku) {
    const svgEl = document.getElementById(`c128-${idx}`);
    if (!svgEl) { toast('Barcode not ready yet', 'error'); return; }
    const xml = new XMLSerializer().serializeToString(svgEl);
    const img = new Image();
    const svgBlob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const scale = 3; // upscale for print-quality PNG
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      const link = document.createElement('a');
      link.download = `CODE128_${sku}_${barcode}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
      toast('Barcode Downloaded');
    };
    img.onerror = () => { URL.revokeObjectURL(url); toast('Download failed', 'error'); };
    img.src = url;
  }

  function copyText(text, btnEl, message) {
    const done = () => {
      toast(message);
      if (btnEl) {
        const original = btnEl.innerHTML;
        btnEl.classList.add('copied');
        setTimeout(() => { btnEl.classList.remove('copied'); }, 1000);
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }
  function fallbackCopy(text, cb) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); cb(); } catch (e) { toast('Copy failed', 'error'); }
    document.body.removeChild(ta);
  }

  /* ---------- Image zoom ---------- */
  function initZoom() {
    image.initZoom({ zoomBackdrop: els.zoomBackdrop, zoomImg: els.zoomImg, zoomClose: els.zoomClose }, returnFocusToSearch);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { image.closeZoom(); closeChoiceModal(); closeTeamModal(); } });
  }

  /* ---------- Recent / Favorites panels ---------- */
  function recordSearch(product) {
    store.addRecent(product.sku);
    renderRecent();
  }

    function renderRecent() {
    const skus = store.getRecent();
    const products = search.getBySkuList(skus);
    if (!els.recentList) return;
    if (!products.length) {
      els.recentList.innerHTML = '<div class="panel-empty">No recent searches yet.</div>';
    } else {
      els.recentList.innerHTML = products.map(p => panelItemHtml(p)).join('');
      wirePanelItems(els.recentList, products);
    }
    fillInlineRecent();
  }

  /** When setting is on, mirror Recent into the product card column beside barcodes. */
  function fillInlineRecent() {
    const col = document.getElementById('productRecentCol');
    const list = document.getElementById('productRecentList');
    if (!col || !list) return;
    const enabled = !!quickGetSettings().recentBesideBarcode;
    document.documentElement.classList.toggle('recent-beside-barcode', enabled);
    if (!enabled) {
      col.hidden = true;
      return;
    }
    col.hidden = false;
    col.removeAttribute('hidden');
    const skus = store.getRecent();
    const products = search.getBySkuList(skus);
    if (!products.length) {
      list.innerHTML = '<div class="panel-empty">No recent searches yet.</div>';
    } else {
      list.innerHTML = products.map(p => panelItemHtml(p)).join('');
      wirePanelItems(list, products);
    }
    const clearBtn = document.getElementById('inlineClearRecent');
    if (clearBtn && !clearBtn.dataset.wired) {
      clearBtn.dataset.wired = '1';
      clearBtn.addEventListener('click', () => {
        store.clearRecent();
        renderRecent();
        fillInlineRecent();
        toast('Recent searches cleared');
      });
    }
  }

  /** On startup: if Recent Beside is on and we have history, restore last product so Recent column is visible with data. */
  function restoreLastRecentProduct() {
    try {
      if (!quickGetSettings().recentBesideBarcode) return;
      if (lastRenderedProduct) return;
      const skus = store.getRecent();
      if (!skus || !skus.length) return;
      const products = search.getBySkuList(skus);
      if (products && products[0]) {
        renderProduct(products[0]);
      }
    } catch (e) { /* ignore */ }
  }

  function renderFavorites() {
    const skus = store.getFavs();
    const products = search.getBySkuList(skus);
    if (!products.length) {
      els.favList.innerHTML = '<div class="panel-empty">Star products to save them here.</div>';
      return;
    }
    els.favList.innerHTML = products.map(p => panelItemHtml(p)).join('');
    wirePanelItems(els.favList, products);
  }

  function panelItemHtml(p) {
    return `
      <div class="panel-item" data-sku="${escapeAttr(p.sku)}">
        <img class="panel-thumb" src="${escapeAttr(p.image)}" alt="" loading="lazy" decoding="async" onerror="this.src='${placeholderImg()}'">
        <div class="panel-text">
          <div class="panel-name">${escapeHtml(p.name)}</div>
          <div class="panel-sub">SKU ${escapeHtml(p.sku)}</div>
        </div>
      </div>`;
  }
  function wirePanelItems(container, products) {
    container.querySelectorAll('.panel-item').forEach((el, i) => {
      el.addEventListener('click', () => {
        els.searchInput.value = products[i].sku;
        els.clearBtn.classList.add('visible'); els.clearBtn.removeAttribute('hidden');
        renderProduct(products[i]);
        store.addRecent(products[i].sku);
        renderRecent();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        promptDmartConfirm(products[i].sku);
      });
    });
  }

  /* ---------- Quick Access ----------
   *  Configurable shortcut cards shown between the search bar and the
   *  product card. To add more shortcuts later (Reports, Inventory,
   *  Dashboard, Admin, etc.), just add another entry to this array —
   *  no markup or component changes needed.
   *  NOTE: Shopper and Dmart were removed from here per the "simplify
   *  Dmart action buttons" fix — the per-product "Check in Dmart" button
   *  (in the product card's action bar, unchanged) is now the only
   *  Dmart-related action in the app. */
  const TALABAT_MARK_PATH = 'M 51.28,14.43 L 48.01,15.07 L 44.50,16.59 L 42.58,17.94 L 40.11,20.81 L 38.60,25.36 L 38.52,34.85 L 26.63,34.85 L 26.63,41.71 L 27.67,44.42 L 30.06,46.41 L 32.46,47.05 L 38.60,47.13 L 38.68,67.78 L 40.27,73.60 L 42.66,77.59 L 46.09,81.02 L 50.00,83.33 L 54.47,84.61 L 59.25,84.77 L 64.75,83.49 L 67.70,81.90 L 67.70,70.18 L 64.51,70.97 L 61.80,70.73 L 58.93,69.22 L 57.26,67.15 L 56.14,63.32 L 56.14,47.13 L 69.54,47.05 L 69.54,39.87 L 68.26,37.00 L 65.79,35.25 L 56.14,34.77 L 56.14,14.35 Z';
  const QUICK_ACCESS_LINKS = [];

  function renderQuickAccess() {
    if (!els.quickAccessGrid) return;
    els.quickAccessGrid.innerHTML = QUICK_ACCESS_LINKS.map(item => `
      <a class="quick-access-card" href="${escapeAttr(item.url)}" target="_blank" rel="noopener noreferrer">
        <span class="quick-access-icon-badge">
          <svg viewBox="0 0 100 100" aria-hidden="true"><rect width="100" height="100" rx="22" fill="#fff"/><path d="${TALABAT_MARK_PATH}" fill="#FF6B00"/></svg>
        </span>
        <span class="quick-access-label">${escapeHtml(item.title)}</span>
        <svg class="quick-access-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M7 7h10v10"/></svg>
      </a>
    `).join('');
    const section = els.quickAccessGrid.closest('.quick-access-section');
    if (section) section.hidden = QUICK_ACCESS_LINKS.length === 0;
  }

  function initPanels() {
    renderRecent();
    renderFavorites();
    renderQuickAccess();
    preloadRecentImages();
    els.clearRecent.addEventListener('click', () => { store.clearRecent(); renderRecent(); toast('Recent searches cleared'); });
    els.clearFavs.addEventListener('click', () => { store.clearFavs(); renderFavorites(); toast('Favorites cleared'); });
  }

  /** Warms the browser's image cache for the first 20 recent products, so
   *  reopening a recently-scanned item feels instant. Purely additive —
   *  does not touch search, database, or rendering logic; the actual <img>
   *  tags still use loading="lazy" as before. */
  function preloadRecentImages() {
    const skus = store.getRecent().slice(0, 20);
    const products = search.getBySkuList(skus);
    image.preloadImages(products, 20);
  }

  /* ---------- Helpers ---------- */
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function escapeAttr(str) { return escapeHtml(str); }
  function placeholderImg() {
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#e9ebee"/><text x="50%" y="50%" font-family="sans-serif" font-size="14" fill="#9aa0aa" text-anchor="middle" dy=".3em">No Image</text></svg>`
    );
  }

  // Both panels are genuinely lazy: their modules are only fetched the
  // first time the user actually opens them, keeping their cost off the
  // critical startup path entirely.
  let settingsModulePromise = null;
  function loadSettingsModule() {
    if (!settingsModulePromise) settingsModulePromise = import('./settings.js');
    return settingsModulePromise;
  }
  let maintenanceModulePromise = null;
  function loadMaintenanceModule() {
    if (!maintenanceModulePromise) maintenanceModulePromise = import('./maintenance.js');
    return maintenanceModulePromise;
  }

  function initSettingsTrigger() {
    if (!els.settingsBtn) return;
    let initialized = false;
    els.settingsBtn.addEventListener('click', async () => {
      const mod = await loadSettingsModule();
      if (!initialized) {
        mod.initSettingsPanel(
          { panel: els.settingsPanel, openBtn: els.settingsBtn, closeBtn: els.settingsClose, backdrop: els.settingsBackdrop },
          { onForceUpdateResult: (r) => toast(r.ok ? 'Database Updated Successfully' : 'Update failed — check your connection') }
        );
        initialized = true;
      }
      mod.openPanel();
    });
    els.settingsBackdrop.addEventListener('click', (e) => {
      if (e.target === els.settingsBackdrop) returnFocusToSearch();
    });

    // When QR Code or Performance Mode is toggled, only swap the barcode
    // area — never rebuild the whole product card (that caused freezes).
    window.addEventListener('smouha:recent-layout', () => {
      try { fillInlineRecent(); } catch (e) { /* ignore */ }
    });
    window.addEventListener('smouha:settings-barcode', () => {
      if (!lastRenderedProduct) return;
      // Defer one frame so the settings switch animation finishes first.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => refreshPrimaryBarcode(lastRenderedProduct));
      });
    });
  }

  function initMaintenanceTrigger() {
    let initialized = false;
    let tapCount = 0;
    let tapTimer = null;
    async function openMaintenance() {
      const mod = await loadMaintenanceModule();
      if (!initialized) {
        mod.initMaintenancePanel({ backdrop: els.maintenanceBackdrop, body: els.maintenanceBody, closeBtn: els.maintenanceClose });
        initialized = true;
      }
      mod.open();
    }
    if (els.appVersionLine) {
      els.appVersionLine.addEventListener('click', () => {
        tapCount++;
        clearTimeout(tapTimer);
        tapTimer = setTimeout(() => { tapCount = 0; }, 1500);
        if (tapCount >= 5) { tapCount = 0; openMaintenance(); }
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'M' || e.key === 'm')) { e.preventDefault(); openMaintenance(); }
    });
    els.maintenanceBackdrop.addEventListener('click', (e) => {
      if (e.target === els.maintenanceBackdrop) returnFocusToSearch();
    });
  }

  function init() {
    cacheEls();
    quickApplyGlobalModes();
    initTheme();
    initSearch();
    initZoom();
    initPanels();
    initSettingsTrigger();
    initMaintenanceTrigger();
    els.choiceModalClose.addEventListener('click', closeChoiceModal);
    els.choiceModal.addEventListener('click', (e) => { if (e.target === els.choiceModal) closeChoiceModal(); });
    els.teamLinkBtn.addEventListener('click', openTeamModal);
    els.teamModalClose.addEventListener('click', closeTeamModal);
    els.teamModal.addEventListener('click', (e) => { if (e.target === els.teamModal) closeTeamModal(); });
    renderEmptyState();
  }

  /** Called by app.js once dataLoader.loadInitial() resolves: restores the
   *  search input from its "loading" state, flashes the ready-state focus
   *  ring, and (desktop/Pelican only) focuses it with the cursor ready. */
  function onDataReady() {
    // Warm QR library in the background if the setting is already on,
    // so the first product card never waits on a network/script load.
    try {
      if (quickGetSettings().qrCode && !quickGetSettings().performanceMode) {
        ensureQrLibraryLoaded().catch(() => {});
      }
    } catch (e) { /* ignore */ }

    els.searchInput.classList.remove('loading');
    els.searchInput.disabled = false;
    els.searchInput.placeholder = els.searchInput.dataset.originalPlaceholder || 'Search SKU or Last 6 digits...';
    if (els.searchSpinner) {
      els.searchSpinner.hidden = true;
      els.searchSpinner.setAttribute('hidden', '');
      els.searchSpinner.style.display = 'none';
    }
    if (els.searchIcon) {
      els.searchIcon.hidden = false;
      els.searchIcon.removeAttribute('hidden');
      els.searchIcon.style.display = '';
    }
    // Recent/Favorites were already rendered once during init(), but at
    // that point the product index was still empty (data hadn't loaded
    // yet), so both sections came up blank. Render them again now that
    // search.getBySkuList() can actually resolve the stored SKUs.
    renderRecent();
    renderFavorites();
    preloadRecentImages();
    restoreLastRecentProduct();
    if (shouldAutoFocus()) {
      els.searchInput.focus();
      els.searchInput.classList.add('ready-flash');
      setTimeout(() => els.searchInput.classList.remove('ready-flash'), 350);
    }
  }

  /** Called by app.js immediately at startup, before data has loaded. */
  function setLoadingState() {
    els.searchInput.dataset.originalPlaceholder = els.searchInput.placeholder;
    els.searchInput.classList.add('loading');
    els.searchInput.disabled = true;
    els.searchInput.placeholder = 'Loading products...';
    if (els.searchSpinner) {
      els.searchSpinner.hidden = false;
      els.searchSpinner.removeAttribute('hidden');
      els.searchSpinner.style.display = '';
    }
    if (els.searchIcon) {
      els.searchIcon.hidden = true;
      els.searchIcon.setAttribute('hidden', '');
      els.searchIcon.style.display = 'none';
    }
  }

  /** Short, synthesized beep (no external audio asset) for the "Play Scan
   *  Sound" setting. Uses WebAudio directly; silently no-ops if the
   *  browser blocks audio before any user gesture has occurred yet. */
  function playScanBeep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.12);
    } catch (e) { /* audio unavailable — silently skip */ }
  }

  /** Public entry point used by Pelican Mode (and any future input source)
   *  to feed a decoded value through the search pipeline. Uses the Pelican
   *  priority order (full barcode -> SKU -> last 6 digits) while reusing
   *  the exact same rendering/skeleton/choice-modal code as manual typing. */
  function searchFromExternalInput(code) {
    if (quickGetSettings().scanSound) playScanBeep();
    els.searchInput.value = code;
    els.clearBtn.classList.toggle('visible', code.length > 0);
    closeSuggestions();
    runSearch(code, search.queryPelican);
  }


  /* ---------- Team name rotator (medium typewriter) ---------- */
  function initTeamRotator() {
    const el = document.getElementById('teamRotatorText');
    const root = document.getElementById('teamRotator');
    const cursor = root ? root.querySelector('.team-rotator-cursor') : null;
    if (!el || !root) return;

    function toTitleCase(str) {
      return String(str).replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    }

    function readTeamPhrases() {
      const leaders = [];
      const members = [];
      const seen = new Set();
      document.querySelectorAll('.team-leader').forEach((node) => {
        const name = (node.querySelector('.team-leader-name')?.textContent || '').trim();
        const role = (node.querySelector('.team-leader-role')?.textContent || '').trim();
        if (!name) return;
        const phrase = role ? (toTitleCase(name) + ' — ' + toTitleCase(role)) : toTitleCase(name);
        const key = phrase.toLowerCase();
        if (!seen.has(key)) { seen.add(key); leaders.push(phrase); }
      });
      document.querySelectorAll('.team-members-list li').forEach((li) => {
        const name = (li.textContent || '').trim();
        if (!name) return;
        const phrase = toTitleCase(name);
        const key = phrase.toLowerCase();
        if (!seen.has(key)) { seen.add(key); members.push(phrase); }
      });
      // Sequence: 3 managers → special thanks → thanks tarek → rest of team
      const special1 = 'Special Thanks to Tarek Ali Abdallah 👌 for his invaluable support and creative contributions.';
      const special2 = 'Thanks Tarek ✋';
      const out = [];
      out.push(...leaders.slice(0, 3));
      out.push(special1);
      out.push(special2);
      // remaining leaders after first 3 + all members (skip Tarek if duplicated)
      leaders.slice(3).forEach((p) => {
        if (!/tarek ali abdallah/i.test(p)) out.push(p);
      });
      members.forEach((p) => {
        if (!/tarek ali abdallah/i.test(p)) out.push(p);
      });
      return out.length ? out : ['Talabat Mart Smouha Team'];
    }

    if (document.documentElement.classList.contains('performance-mode')) {
      el.textContent = 'Talabat Mart Smouha Team';
      if (cursor) cursor.hidden = true;
      return;
    }

    let phrases = readTeamPhrases();
    let idx = 0;
    let charIdx = 0;
    let deleting = false;
    let pause = 0;
    const TYPE_MS = 55;
    const TYPE_MS_ASHRAF = 95;
    const DELETE_MS = 32;
    const DELETE_MS_ASHRAF = 48;
    const HOLD_MS = 1600;
    const HOLD_MS_ASHRAF = 4000;
    const GAP_MS = 350;

    function isInstantClear(i) {
      // After special thanks line, clear at once then show Thanks Tarek
      const p = phrases[i];
      return p && p.startsWith('Special Thanks to Tarek');
    }

    setInterval(() => {
      const next = readTeamPhrases();
      if (next.join('\n') !== phrases.join('\n')) {
        phrases = next;
        if (idx >= phrases.length) idx = 0;
      }
    }, 5000);

    function tick() {
      if (document.documentElement.classList.contains('performance-mode')) {
        el.textContent = 'Talabat Mart Smouha Team';
        if (cursor) cursor.hidden = true;
        return;
      }
      if (!phrases.length) phrases = readTeamPhrases();
      const full = phrases[idx % phrases.length] || '';
      if (pause > 0) {
        pause -= 1;
        setTimeout(tick, TYPE_MS);
        return;
      }
      if (!deleting) {
        charIdx += 1;
        el.textContent = full.slice(0, charIdx);
        if (root) root.classList.toggle('is-ashraf', /ashraf\s+amin/i.test(full));
        if (charIdx >= full.length) {
          const ash = /ashraf\s+amin/i.test(full);
          const hold = ash ? HOLD_MS_ASHRAF : HOLD_MS;
          const tBase = ash ? TYPE_MS_ASHRAF : TYPE_MS;
          if (isInstantClear(idx % phrases.length)) {
            pause = Math.round(hold / tBase);
            deleting = true;
            el.dataset.instant = '1';
          } else {
            deleting = true;
            pause = Math.round(hold / tBase);
            el.dataset.instant = '0';
          }
        }
        const isAshraf = /ashraf\s+amin/i.test(full);
        setTimeout(tick, isAshraf ? TYPE_MS_ASHRAF : TYPE_MS);
      } else {
        if (el.dataset.instant === '1') {
          el.textContent = '';
          charIdx = 0;
          deleting = false;
          el.dataset.instant = '0';
          idx = (idx + 1) % Math.max(1, phrases.length);
          pause = Math.round(GAP_MS / TYPE_MS);
          setTimeout(tick, TYPE_MS);
          return;
        }
        charIdx -= 1;
        el.textContent = full.slice(0, Math.max(0, charIdx));
        if (charIdx <= 0) {
          deleting = false;
          idx = (idx + 1) % Math.max(1, phrases.length);
          pause = Math.round(GAP_MS / TYPE_MS);
        }
        const isAshrafDel = /ashraf\s+amin/i.test(full);
        setTimeout(tick, isAshrafDel ? DELETE_MS_ASHRAF : DELETE_MS);
      }
    }
    tick();
  }

  return { init, setLoadingState, onDataReady, toast, renderRecent, renderFavorites, searchFromExternalInput };
})();



/* ============================================================================
   MODULE: smartScan (internal module name unchanged — user-facing feature
   is now called "Pelican Mode")
   ------------------------------------------------------------------------
   Flow (speed-optimized):
     Open Camera → ZXing scans continuously (PRIMARY engine), analyzing
     only the center ROI of the frame → if a FULL BARCODE is detected →
     search using Pelican Mode priority (full barcode -> SKU -> last 6
     digits) → display product → generate Code128(s) → stop camera.

     If ZXing finds nothing after ~1000ms → OCR fallback, cropped to the
     white product card only:
       Step 2: extract SKU → search by SKU
       Step 3: if no SKU, extract full barcode → use its LAST 6 DIGITS →
               search via the existing last-6-digits engine

   BarcodeDetector is OPTIONAL: used only as a cheap opportunistic check
   run alongside ZXing (never gating it, never the primary loop). No
   search logic is duplicated — everything routes through
   ui.searchFromExternalInput(), which reuses search.queryPelican().
   ============================================================================ */
const smartScan = (() => {
  const OCR_FALLBACK_MS = 1000;      // ZXing detection window before OCR kicks in
  const DUPLICATE_IGNORE_MS = 2000;  // ignore repeat detections of the same code

  let els = {};
  let stream = null;
  let zxingReader = null;
  let zxingControls = null;
  let nativeDetector = null;
  let nativeCheckId = null;
  let ocrTimer = null;
  let running = false;
  let ocrBusy = false;
  let lastCode = null;
  let lastCodeAt = 0;

  function cacheEls() {
    els.scanBtn = document.getElementById('smartScanBtn');
    els.backdrop = document.getElementById('scanBackdrop');
    els.closeBtn = document.getElementById('scanCloseBtn');
    els.video = document.getElementById('scanVideo');
    els.ocrCanvas = document.getElementById('scanOcrCanvas');
    els.status = document.getElementById('scanStatus');
  }

  function setStatus(text, kind) {
    els.status.textContent = text;
    els.status.classList.remove('error', 'success');
    if (kind) els.status.classList.add(kind);
  }

  /* ---------- Lifecycle ---------- */
  async function open() {
    els.backdrop.classList.add('open');
    setStatus('Requesting camera…');

    if (!window.ZXingBrowser || !window.ZXing) {
      setStatus('Scanner engine failed to load', 'error');
      setTimeout(close, 1800);
      return;
    }

    running = true;
    lastCode = null;
    lastCodeAt = 0;
    initNativeDetector(); // optional, opportunistic only — never blocks ZXing

    const hints = new Map();
    const { BarcodeFormat, DecodeHintType } = window.ZXing;
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
      BarcodeFormat.CODE_128, BarcodeFormat.CODE_39
    ]);
    hints.set(DecodeHintType.TRY_HARDER, false); // favor speed over exhaustive retries per frame
    zxingReader = new window.ZXingBrowser.BrowserMultiFormatReader(hints);

    try {
      const devices = await window.ZXingBrowser.BrowserCodeReader.listVideoInputDevices();
      const rearDevice = pickRearCamera(devices);

      setStatus('Searching…');
      scheduleOcrFallback();

      // Continuous-autofocus + HD stream constraints for the rear camera.
      const constraints = {
        video: {
          deviceId: rearDevice ? { exact: rearDevice.deviceId } : undefined,
          facingMode: rearDevice ? undefined : { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          advanced: [{ focusMode: 'continuous' }]
        },
        audio: false
      };

      // ZXing owns the video element and decodes directly from the live
      // stream — this is the PRIMARY, continuous scanning engine. It
      // analyzes the center ROI only via the video's clip region.
      zxingControls = await zxingReader.decodeFromConstraints(constraints, els.video, (result) => {
        if (result && running) onCodeDetected(result.getText());
        // a null result fires on every frame with no barcode found — expected, ignored.
      });

      stream = els.video.srcObject;
    } catch (err) {
      handleCameraError(err);
    }
  }

  function close() {
    running = false;
    clearTimeout(ocrTimer);
    if (nativeCheckId) { clearInterval(nativeCheckId); nativeCheckId = null; }
    if (zxingControls) {
      try { zxingControls.stop(); } catch (e) { /* already stopped */ }
      zxingControls = null;
    }
    zxingReader = null;
    if (stream) {
      stream.getTracks().forEach(track => track.stop()); // release camera immediately
      stream = null;
    }
    els.video.srcObject = null;
    els.backdrop.classList.remove('open');
    nativeDetector = null;
    ocrBusy = false;
  }

  function handleCameraError(err) {
    if (err && err.name === 'NotAllowedError') {
      setStatus('Camera permission denied', 'error');
    } else if (err && err.name === 'NotFoundError') {
      setStatus('No camera found on this device', 'error');
    } else {
      setStatus('Unable to access camera', 'error');
    }
    setTimeout(close, 1800);
  }

  function pickRearCamera(devices) {
    if (!devices || !devices.length) return null;
    const rear = devices.find(d => /back|rear|environment/i.test(d.label));
    return rear || devices[devices.length - 1];
  }

  /* ---------- Optional secondary check: native BarcodeDetector ----------
     Purely opportunistic — on devices that support it, this can catch an
     obvious code a few frames earlier than ZXing. It never gates or
     replaces the ZXing loop above, and is skipped entirely if unsupported.
     It also only analyzes the center ROI, matching the ZXing crop. */
  function initNativeDetector() {
    if (!('BarcodeDetector' in window)) return;
    try {
      nativeDetector = new BarcodeDetector({
        formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39']
      });
    } catch (e) {
      nativeDetector = null;
      return;
    }
    nativeCheckId = setInterval(async () => {
      if (!running || !nativeDetector || !els.video.videoWidth) return;
      try {
        const roiBitmap = await centerRoiBitmap();
        const codes = await nativeDetector.detect(roiBitmap);
        if (codes && codes.length && running) onCodeDetected(codes[0].rawValue);
      } catch (e) { /* opportunistic only — ignore and keep relying on ZXing */ }
    }, 150);
  }

  /** Crops the live video down to the center ROI (matching the on-screen
   *  .scan-frame guide) and returns it as an ImageBitmap for detection.
   *  Keeps analysis focused on where the user is asked to hold the code,
   *  which is faster and more accurate than scanning the full frame. */
  async function centerRoiBitmap() {
    const rect = centerRoiRect();
    els.ocrCanvas.width = rect.w;
    els.ocrCanvas.height = rect.h;
    const ctx = els.ocrCanvas.getContext('2d');
    ctx.drawImage(els.video, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    return createImageBitmap(els.ocrCanvas);
  }

  function centerRoiRect() {
    const vw = els.video.videoWidth, vh = els.video.videoHeight;
    // Matches the .scan-frame overlay proportions (inset 12% vertical, 8% horizontal)
    return {
      x: Math.round(vw * 0.08),
      y: Math.round(vh * 0.12),
      w: Math.round(vw * 0.84),
      h: Math.round(vh * 0.76)
    };
  }

  function onCodeDetected(rawValue) {
    if (!running) return;
    const code = String(rawValue).trim();

    // Ignore duplicate detections of the same code within the debounce window
    const now = Date.now();
    if (code === lastCode && (now - lastCodeAt) < DUPLICATE_IGNORE_MS) return;
    lastCode = code;
    lastCodeAt = now;

    running = false; // stop every running process immediately
    clearTimeout(ocrTimer);
    if (nativeCheckId) { clearInterval(nativeCheckId); nativeCheckId = null; }
    setStatus('Product Found', 'success');
    close();
    ui.searchFromExternalInput(code);
  }

  /* ---------- Step 2 & 3: OCR fallback (cropped to the white info card) ---------- */
  function scheduleOcrFallback() {
    ocrTimer = setTimeout(() => {
      if (running && !ocrBusy) runOcrPass();
    }, OCR_FALLBACK_MS);
  }

  async function runOcrPass() {
    if (!running || !window.Tesseract || !els.video.videoWidth) {
      if (running) scheduleOcrFallback();
      return;
    }
    ocrBusy = true;
    setStatus('Detecting barcode…');
    try {
      const cropRect = locateInfoCard();
      const ocrCanvas = els.ocrCanvas;
      ocrCanvas.width = cropRect.w;
      ocrCanvas.height = cropRect.h;
      const ctx = ocrCanvas.getContext('2d');
      ctx.drawImage(els.video, cropRect.x, cropRect.y, cropRect.w, cropRect.h, 0, 0, cropRect.w, cropRect.h);

      setStatus('Reading SKU…');
      const { data } = await Tesseract.recognize(ocrCanvas, 'eng', { logger: () => {} });

      if (!running) return; // a barcode may have been found while OCR was running

      // Step 2: SKU first
      const sku = extractSku(data.text);
      if (sku) {
        setStatus('Product Found', 'success');
        close();
        ui.searchFromExternalInput(sku);
        return;
      }

      // Step 3: fall back to the full barcode's last 6 digits
      const last6 = extractLast6FromBarcode(data.text);
      if (last6) {
        setStatus('Product Found', 'success');
        close();
        ui.searchFromExternalInput(last6);
        return;
      }

      setStatus('No Barcode Detected — Reading Again…', 'error');
      ocrBusy = false;
      if (running) scheduleOcrFallback();
    } catch (e) {
      setStatus('OCR Failed — Retrying…', 'error');
      ocrBusy = false;
      if (running) scheduleOcrFallback();
    }
  }

  /** Locates the white product-info card region within the frame.
   *  Uses a fixed relative crop matching the on-screen scan-frame guide,
   *  which is where the app instructs the user to align the card. This
   *  avoids OCR-ing the full frame, keeping recognition fast and accurate. */
  function locateInfoCard() {
    return centerRoiRect();
  }

  /** Extracts ONLY the SKU value from OCR text, ignoring product name,
   *  price, location, buttons, icons, and everything else on the card. */
  function extractSku(text) {
    const skuMatch = text.match(/SKU[:\s]*([0-9]{4,10})/i);
    return skuMatch ? skuMatch[1] : null;
  }

  /** Extracts a full barcode from OCR text and returns only its last 6
   *  digits, to be routed through the existing last-6-digits search. */
  function extractLast6FromBarcode(text) {
    const barcodeMatch = text.match(/Barcode[:\s]*([0-9A-Za-z]{6,20})/i);
    const code = barcodeMatch ? barcodeMatch[1] : null;
    if (!code) return null;
    return code.length >= 6 ? code.slice(-6) : code;
  }

  function init() {
    cacheEls();
    els.scanBtn.addEventListener('click', open);
    els.closeBtn.addEventListener('click', close);
    els.backdrop.addEventListener('click', (e) => { if (e.target === els.backdrop) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && els.backdrop.classList.contains('open')) close(); });
  }

  return { init };
})();



/* ============================================================================
   BOOTSTRAP
   ------------------------------------------------------------------------
   window.__smouhaLoadStart is stamped as early as possible (inline in
   index.html, before this module even loads) so the Maintenance Panel's
   "Load Time" figure reflects true navigation-to-ready time, not just the
   time since this script started executing.
   ============================================================================ */
document.addEventListener('DOMContentLoaded', () => {
  ui.init();
  ui.setLoadingState();
  // Warehouse selector (must be ready before any Dmart links are built)
  const whMount = document.getElementById('warehouseSelectorMount');
  warehouse.init(whMount).then(() => {
    // Sync display mode from settings
    const s = quickGetSettings();
    warehouse.setDisplayMode(s.warehouseDisplay === 'friendly' ? 'friendly' : 'original');
    // When warehouse changes, refresh live Dmart info for the visible product
    warehouse.onChange((wh) => {
      try {
        dmartLive.invalidateCache(wh && wh.id);
        const card = document.getElementById('dmartLiveCard');
        if (card && card.dataset.sku) {
          dmartLive.requestLiveForProduct(card.dataset.sku);
        }
      } catch (e) { /* never break warehouse switch */ }
    });
  }).catch(err => console.error('[warehouse] init failed', err));

  smartScan.init();

  updater.loadInitial().then((result) => {
    ui.onDataReady();
    if (result.updated && result.source === 'network') {
      ui.toast('Database Updated Successfully');
    }
    const versionEl = document.getElementById('appVersionLine');
    if (versionEl && quickGetSettings().showVersion) {
      const v = updater.getLastVersionInfo() || {};
      const countText = quickGetSettings().showProductCount ? (' \u00b7 ' + search.count().toLocaleString() + ' Products') : '';
      versionEl.textContent = (v.version ? 'v' + v.version : '') + (v.build != null ? ' (build ' + v.build + ')' : '') + countText;
    }
  });
});
