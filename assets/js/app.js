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
import { store } from './appStore.js';
import {
  SETTINGS_KEY,
  SETTINGS_DEFAULTS,
  quickGetSettings,
  isMobileViewport,
  suppressGhostImageTap,
  selectSearchAfterProduct,
  effectiveRecentBeside,
  effectiveWarehouseDisplay,
  effectiveDmartPopup,
  quickApplyGlobalModes,
} from './appSettingsQuick.js';
import { wireCatalogAndSessionUi } from './appCatalogUi.js';
import { createSmartScan } from './smartScan.js';

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
    const intensive = !!(quickGetSettings().intensiveAutoFocus);
    // Mobile + Intensive Auto Focus OFF: never steal focus / open keyboard
    // (e.g. after closing product image or barcode zoom).
    if (!shouldAutoFocus() && !intensive) {
      try { els.searchInput.blur(); } catch (e) { /* ignore */ }
      return;
    }
    // Desktop zero-click, or Intensive Auto Focus ON
    try {
      els.searchInput.focus({ preventScroll: true });
    } catch (e) {
      try { els.searchInput.focus(); } catch (e2) { /* ignore */ }
    }
    if (shouldAutoFocus()) {
      try { els.searchInput.select(); } catch (e) { /* ignore */ }
    }
  }

  /* ---------- Theme ---------- */
  function initTheme() {
    const saved = store.getTheme();
    // Dark mode default OFF on PC and mobile (ignore OS preference)
    const theme = saved || 'light';
    applyTheme(theme);
    // Dark Mode lives in Settings (Appearance). Same storage API as before.
        window.addEventListener('smouha:toggle-theme', () => {
      const root = document.documentElement;
      const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      let ov = document.getElementById('themeWipeOverlay');
      if (!ov) {
        ov = document.createElement('div');
        ov.id = 'themeWipeOverlay';
        ov.className = 'theme-wipe-overlay';
        document.body.appendChild(ov);
      }
      ov.className = 'theme-wipe-overlay theme-wipe-' + next;
      void ov.offsetWidth;
      ov.classList.add('run');
      // Apply immediately so Settings switch matches the real theme
      applyTheme(next);
      store.setTheme(next);
      try { window.dispatchEvent(new CustomEvent('smouha:theme-changed', { detail: { theme: next } })); } catch (e) {}
      setTimeout(() => { ov.classList.remove('run'); ov.className = 'theme-wipe-overlay'; }, 820);
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
      info: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
    };
    const div = document.createElement('div');
    const t = type === 'error' ? 'error' : type === 'info' ? 'info' : 'success';
    div.className = 'toast toast-' + t;
    div.innerHTML = `<span class="toast-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[t] || icons.success}</svg></span><span class="toast-msg"></span>`;
    div.querySelector('.toast-msg').textContent = message;
    els.toastContainer.appendChild(div);
    setTimeout(() => {
      div.classList.add('toast-leave');
      setTimeout(() => div.remove(), 220);
    }, 2400);
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
    div.className = 'toast toast-success toast-auto-copy';
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
      // Intentional tap only (not scroll). Children use pointer-events:none in CSS
      // so the event target is always the .suggestion-item row (fixes name-tap on mobile).
      let tapState = null;
      const TAP_SLOP = 14;

      const itemFromEvent = (e) => {
        const t = e.target;
        if (!t) return null;
        const item = (t.closest && t.closest('.suggestion-item')) || null;
        if (!item || !els.suggestionsBox.contains(item)) return null;
        return item;
      };

      const pickFromItem = (item) => {
        if (!item) return;
        const idx = Number(item.dataset.idx);
        const list = els.suggestionsBox._suggestionProducts || [];
        if (!list[idx]) return;
        suppressGhostImageTap(550);
        selectProduct(list[idx]);
        closeSuggestions();
      };

      els.suggestionsBox.addEventListener('pointerdown', (e) => {
        if (e.button != null && e.button !== 0) return;
        const item = itemFromEvent(e);
        if (!item) { tapState = null; return; }
        tapState = { id: e.pointerId, x: e.clientX, y: e.clientY, item, moved: false };
      }, { passive: true });

      els.suggestionsBox.addEventListener('pointermove', (e) => {
        if (!tapState || e.pointerId !== tapState.id) return;
        if (Math.abs(e.clientX - tapState.x) > TAP_SLOP || Math.abs(e.clientY - tapState.y) > TAP_SLOP) {
          tapState.moved = true;
        }
      }, { passive: true });

      els.suggestionsBox.addEventListener('pointerup', (e) => {
        if (!tapState || e.pointerId !== tapState.id) return;
        const state = tapState;
        tapState = null;
        if (state.moved) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        pickFromItem(state.item);
      }, true);

      els.suggestionsBox.addEventListener('pointercancel', () => { tapState = null; });

      // Fallback click for accessibility / desktop
      els.suggestionsBox.addEventListener('click', (e) => {
        const item = itemFromEvent(e);
        if (!item) return;
        e.preventDefault();
        e.stopPropagation();
        pickFromItem(item);
      });

      els.suggestionsBox.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const item = itemFromEvent(e);
        if (!item) return;
        e.preventDefault();
        pickFromItem(item);
      });
    }

    // ABC keyboard toggle (mobile)
    const abcBtn = document.getElementById('abcToggleBtn');
    if (abcBtn) {
      // Floating above keyboard on mobile only (Google Sheets style)
      abcBtn.hidden = true;
      abcBtn.classList.add('abc-keyboard-float');
      abcBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const letters = abcBtn.classList.toggle('is-letters');
        els.searchInput.setAttribute('inputmode', letters ? 'text' : 'numeric');
        abcBtn.textContent = letters ? '123' : 'ABC';
        try { els.searchInput.focus(); } catch (err) {}
      });

      const positionAbcFloat = () => {
        if (!abcBtn) return;
        const mobile = window.matchMedia('(max-width:720px)').matches;
        if (!mobile) {
          abcBtn.classList.remove('abc-float-visible');
          abcBtn.hidden = true;
          abcBtn.style.bottom = '';
          abcBtn.style.right = '';
          return;
        }
        const vv = window.visualViewport;
        const keyboardOpen = !!(vv && (window.innerHeight - vv.height > 100));
        const searchFocused = document.activeElement === els.searchInput;
        if (keyboardOpen && searchFocused) {
          abcBtn.hidden = false;
          abcBtn.classList.add('abc-float-visible');
          // Sit just above the keyboard, right side
          const gap = 10;
          const bottom = Math.max(gap, (window.innerHeight - vv.offsetTop - vv.height) + gap);
          abcBtn.style.bottom = bottom + 'px';
          abcBtn.style.right = '12px';
        } else {
          abcBtn.classList.remove('abc-float-visible');
          abcBtn.hidden = true;
        }
      };

      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', positionAbcFloat);
        window.visualViewport.addEventListener('scroll', positionAbcFloat);
      }
      window.addEventListener('resize', positionAbcFloat);
      els.searchInput.addEventListener('focus', () => setTimeout(positionAbcFloat, 50));
      els.searchInput.addEventListener('blur', () => setTimeout(positionAbcFloat, 80));
      positionAbcFloat();
    }

    // Intensive Auto Focus (settings) — default OFF; only when enabled
    let intensiveFocusTimer = null;
    const runIntensiveFocus = () => {
      try {
        if (!quickGetSettings().intensiveAutoFocus) return;
        if (!els.searchInput || els.searchInput.disabled) return;
        if (document.activeElement === els.searchInput) return;
        // Don't steal focus from camera / modals / inputs
        const ae = document.activeElement;
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
        if (document.getElementById('scanBackdrop')?.classList.contains('open')) return;
        if (document.getElementById('settingsPanel')?.classList.contains('open')) return;
        els.searchInput.focus({ preventScroll: true });
      } catch (e) { /* ignore */ }
    };
    const syncIntensiveFocus = () => {
      if (intensiveFocusTimer) { clearInterval(intensiveFocusTimer); intensiveFocusTimer = null; }
      if (quickGetSettings().intensiveAutoFocus) {
        intensiveFocusTimer = setInterval(runIntensiveFocus, 1200);
      }
    };
    syncIntensiveFocus();
    window.addEventListener('smouha:settings-changed', syncIntensiveFocus);

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
    // Auto-select so next typing replaces current value
    els.searchInput.addEventListener('focus', () => {
      try {
        requestAnimationFrame(() => { els.searchInput.select(); });
      } catch (e) { /* ignore */ }
    });
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
    if (!effectiveDmartPopup()) {
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
      try {
        const row = document.querySelector('.search-main-row');
        if (row) row.classList.add('suggestions-open');
      } catch (e) {}
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
    try {
      const row = document.querySelector('.search-main-row');
      if (row) row.classList.add('suggestions-open');
    } catch (e) {}
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
    try {
      const row = document.querySelector('.search-main-row');
      if (row) row.classList.remove('suggestions-open');
    } catch (e) {}
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
    suppressGhostImageTap(500);
    selectSearchAfterProduct();
  }

  /* ---------- Main search execution ----------
     searchFn defaults to the manual search strategy (SKU -> last 6 digits).
     Pelican Mode passes search.queryPelican instead (full barcode ->
     SKU -> last 6 digits), reusing this exact same rendering pipeline. */
  let searchGen = 0;
  function runSearch(query, searchFn) {
    const fn = searchFn || search.query;
    const isPelicanScan = fn === search.queryPelican;
    dismissAutoCopyToast(); // reset copy state before every new search
    showSkeleton();
    const myGen = ++searchGen;
    // Deliberate minimum skeleton duration for smoother perceived transition.
    setTimeout(async () => {
      if (myGen !== searchGen) return;
      let result = fn(query);
      // Local miss → DMart lookup only when query has at least 6 chars (SKU-like)
      if (result.type === 'none') {
        const q = String(query || '').trim();
        if (/^[0-9A-Za-z]+$/.test(q) && q.length >= 6) {
          try {
            const wid = warehouse.getSelectedId && warehouse.getSelectedId();
            if (wid && dmartLive.lookupProductViaBridge) {
              const look = await dmartLive.lookupProductViaBridge(q, wid, 15000);
              if (myGen !== searchGen) return;
              if (look && look.ok && look.product) {
                const bcs = Array.isArray(look.product.barcodes) ? look.product.barcodes.filter(Boolean) : [];
                const rec = {
                  sku: String(look.product.sku || q),
                  name: look.product.name || q,
                  barcodes: bcs.length ? bcs : [String(look.product.sku || q)],
                  image: look.product.image || '',
                  productId: look.product.productId || null,
                };
                const product = search.registerDmartProduct
                  ? search.registerDmartProduct(rec)
                  : {
                      id: 'dmart:' + rec.sku,
                      sku: rec.sku,
                      name: rec.name,
                      barcodes: rec.barcodes,
                      image: rec.image,
                      fromDmart: true,
                    };
                result = { type: 'dmart', results: [product] };
              }
            }
          } catch (e) {
            /* keep none */
          }
        }
      }

      if (myGen !== searchGen) return;
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
        suppressGhostImageTap(500);
        selectSearchAfterProduct();
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
    // Never show "No results" strip under search
    if (n === 0) return '';
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
      <div class="state-panel state-panel-premium">
        <div class="state-icon-wrap" aria-hidden="true">
          <svg class="state-icon-scan" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 16V12a4 4 0 0 1 4-4h4M32 8h4a4 4 0 0 1 4 4v4M40 32v4a4 4 0 0 1-4 4h-4M16 40h-4a4 4 0 0 1-4-4v-4"/>
            <rect x="14" y="18" width="20" height="12" rx="2"/>
            <path d="M18 24h12M18 28h8"/>
          </svg>
        </div>
        <div class="state-title">Start scanning or typing</div>
        <div class="state-sub">Search by SKU or the last 6 digits of a barcode.</div>
        <div class="state-tips">
          <button type="button" class="state-tip" data-tip="focus-search">Type SKU</button>
          <button type="button" class="state-tip" data-tip="focus-search">Last 6 digits</button>
          <button type="button" class="state-tip" data-tip="open-camera">Camera scan</button>
        </div>
      </div>`;
    const tips = els.resultArea.querySelectorAll('.state-tip[data-tip]');
    tips.forEach((btn) => {
      btn.addEventListener('click', () => {
        const tip = btn.getAttribute('data-tip');
        if (tip === 'open-camera') {
          const cam = document.getElementById('cameraBtn') || document.querySelector('[data-action="camera"], #btnCamera, .search-cam-btn');
          if (cam) cam.click();
          else if (els.searchInput) els.searchInput.focus();
          return;
        }
        if (els.searchInput) {
          els.searchInput.focus();
          try { els.searchInput.select(); } catch (e) {}
        }
      });
    });
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
  let imageLoadToken = 0;

  /** Draw Code128 or QR into #c128-0 for the given product. Safe to call
   *  repeatedly (settings toggle / re-search). Never rebuilds the card.
   *  Uses a generation token so an older async QR result can never overwrite
   *  a newer render (fixes intermittent "static noise" QR). */
  let barcodeRenderGen = 0;

  function ensureBarcodeSvg(wrap) {
    if (!wrap) return null;
    let el = wrap.querySelector('#c128-0') || document.getElementById('c128-0');
    if (el && wrap.contains(el)) return el;
    // Create SVG only — never replace wrap.innerHTML (would destroy siblings)
    el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.setAttribute('id', 'c128-0');
    el.setAttribute('data-barcode-value', '');
    // Remove only previous svg children, keep any non-svg nodes
    [...wrap.querySelectorAll('svg')].forEach((s) => s.remove());
    [...wrap.querySelectorAll('span')].forEach((s) => {
      if (/could not|invalid/i.test(s.textContent || '')) s.remove();
    });
    wrap.insertBefore(el, wrap.firstChild);
    return el;
  }

  function wireBarcodeZoom(wrap) {
    if (!wrap) return;
    wrap.style.cursor = 'pointer';
    wrap.onclick = () => {
      const e2 = document.getElementById('c128-0');
      if (e2) image.openZoom(barcodeLib.svgToDataUrl(e2));
    };
  }



  /** Floating QR/128 switch — fixed, draggable (pointer events), never in layout. */
  function formatSwitchLabel() {
    try {
      if (window.__smouhaFormatOverride === 'qr') return 'QR';
      if (window.__smouhaFormatOverride === '128') return '128';
    } catch (e) {}
    try { return quickGetSettings().qrCode ? 'QR' : '128'; } catch (e) { return 'QR'; }
  }

  function ensureFloatingFormatSwitch() {
    let btn = document.getElementById('barcodeFormatSwitch');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'barcodeFormatSwitch';
      btn.className = 'barcode-format-switch is-floating';
      btn.title = 'Toggle QR / Code128 — drag to move';
      btn.setAttribute('aria-label', 'Toggle barcode format');
      btn.innerHTML = '<span class="bfs-label">QR</span>';
      document.body.appendChild(btn);
      wireFloatingFormatSwitch(btn);
    }
    // Force visible on every call (mobile + PC)
    btn.hidden = false;
    btn.style.setProperty('display', 'inline-flex', 'important');
    btn.style.setProperty('visibility', 'visible', 'important');
    btn.style.setProperty('opacity', '1', 'important');
    btn.style.setProperty('pointer-events', 'auto', 'important');
    btn.style.setProperty('position', 'fixed', 'important');
    btn.style.setProperty('z-index', '2147483646', 'important');
    const lab = btn.querySelector('.bfs-label');
    if (lab) lab.textContent = formatSwitchLabel();
    return btn;
  }

  function wireFloatingFormatSwitch(btn) {
    if (btn.dataset.wired === '1') return;
    btn.dataset.wired = '1';

    // Default position if none saved
    const placeDefault = () => {
      btn.style.setProperty('left', 'auto', 'important');
      btn.style.setProperty('top', 'auto', 'important');
      btn.style.setProperty('right', '16px', 'important');
      btn.style.setProperty('bottom', '100px', 'important');
    };

    try {
      const raw = localStorage.getItem('smouha_fmt_switch_pos');
      if (raw) {
        const p = JSON.parse(raw);
        if (typeof p.x === 'number' && typeof p.y === 'number' && isFinite(p.x) && isFinite(p.y)) {
          const maxX = Math.max(4, window.innerWidth - 56);
          const maxY = Math.max(4, window.innerHeight - 48);
          const x = Math.max(4, Math.min(maxX, p.x));
          const y = Math.max(4, Math.min(maxY, p.y));
          btn.style.setProperty('left', x + 'px', 'important');
          btn.style.setProperty('top', y + 'px', 'important');
          btn.style.setProperty('right', 'auto', 'important');
          btn.style.setProperty('bottom', 'auto', 'important');
        } else {
          placeDefault();
        }
      } else {
        placeDefault();
      }
    } catch (e) {
      placeDefault();
    }

    let dragging = false;
    let moved = false;
    let pid = null;
    let startX = 0, startY = 0, origL = 0, origT = 0;

    const onPointerDown = (ev) => {
      // Only primary button / touch
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      dragging = true;
      moved = false;
      pid = ev.pointerId;
      try { btn.setPointerCapture(ev.pointerId); } catch (e) {}
      startX = ev.clientX;
      startY = ev.clientY;
      const r = btn.getBoundingClientRect();
      origL = r.left;
      origT = r.top;
      btn.classList.add('is-dragging');
      // Do NOT preventDefault here — would kill click on desktop
    };

    const onPointerMove = (ev) => {
      if (!dragging || (pid != null && ev.pointerId !== pid)) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) moved = true;
      if (!moved) return;
      // Only lock scroll once user actually drags
      if (ev.cancelable) ev.preventDefault();
      let nx = origL + dx;
      let ny = origT + dy;
      const maxX = window.innerWidth - btn.offsetWidth - 4;
      const maxY = window.innerHeight - btn.offsetHeight - 4;
      nx = Math.max(4, Math.min(maxX, nx));
      ny = Math.max(4, Math.min(maxY, ny));
      btn.style.setProperty('left', nx + 'px', 'important');
      btn.style.setProperty('top', ny + 'px', 'important');
      btn.style.setProperty('right', 'auto', 'important');
      btn.style.setProperty('bottom', 'auto', 'important');
    };

    const onPointerUp = (ev) => {
      if (!dragging || (pid != null && ev.pointerId !== pid)) return;
      dragging = false;
      pid = null;
      btn.classList.remove('is-dragging');
      try { btn.releasePointerCapture(ev.pointerId); } catch (e) {}
      try {
        const r = btn.getBoundingClientRect();
        localStorage.setItem('smouha_fmt_switch_pos', JSON.stringify({ x: r.left, y: r.top }));
      } catch (e) {}
      if (moved) {
        btn.dataset.skipClick = '1';
        setTimeout(() => { try { delete btn.dataset.skipClick; } catch (e) {} }, 80);
      }
    };

    btn.addEventListener('pointerdown', onPointerDown);
    btn.addEventListener('pointermove', onPointerMove);
    btn.addEventListener('pointerup', onPointerUp);
    btn.addEventListener('pointercancel', onPointerUp);

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.dataset.skipClick === '1') return;
      try {
        const currentlyQr = effectiveUseQr();
        window.__smouhaFormatOverride = currentlyQr ? '128' : 'qr';
      } catch (err) {
        window.__smouhaFormatOverride = '128';
      }
      const lab = btn.querySelector('.bfs-label');
      if (lab) lab.textContent = formatSwitchLabel();
      if (lastRenderedProduct) {
        try { refreshPrimaryBarcode(lastRenderedProduct); } catch (err) {}
      }
    });
  }

  try { window.__smouhaEnsureFmtSwitch = ensureFloatingFormatSwitch; } catch (e) {}

  function effectiveUseQr() {
    const s = quickGetSettings();
    if (s.performanceMode) return false;
    // Session toggle (switch next to barcode) — one-shot override; settings remain the default
    try {
      if (window.__smouhaFormatOverride === 'qr') return true;
      if (window.__smouhaFormatOverride === '128') return false;
    } catch (e) { /* ignore */ }
    return !!s.qrCode;
  }

  function refreshPrimaryBarcode(product) {
    if (!product) return;
    const bc = product.barcodes && product.barcodes[0];
    if (!bc) return;

    const gen = ++barcodeRenderGen;
    const s = quickGetSettings();
    const useQr = effectiveUseQr();

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
            try { const el = ensureBarcodeSvg(wrap); if (el) el.outerHTML = '<span style="color:#9aa0aa;font-size:11px;">Could not render QR code</span>'; } catch (e) {}
            return;
          }
          wireBarcodeZoom(wrap);
        })
        .catch(() => {
          if (gen !== barcodeRenderGen) return;
          const w = document.querySelector('.barcode-128-wrap');
          if (w) { try { const el = w.querySelector('#c128-0, svg'); if (el) el.outerHTML = '<span style="color:#9aa0aa;font-size:11px;">Could not load QR library</span>'; else w.insertAdjacentHTML('afterbegin', '<span style="color:#9aa0aa;font-size:11px;">Could not load QR library</span>'); } catch (e) {} }
        });
      return;
    }

    // Code128 path (default)
    wrap.classList.remove('is-qr');
    const liveSvg = ensureBarcodeSvg(wrap);
    if (!liveSvg) return;
    // Clear any previous QR/noise markup before drawing bars
    try {
      liveSvg.innerHTML = '';
      liveSvg.removeAttribute('viewBox');
    } catch (e) {}
    const applyOk = (ok) => {
      if (gen !== barcodeRenderGen) return;
      if (ok) {
        wireBarcodeZoom(wrap);
        try {
          const block = wrap.closest('.barcode-block-128');
          if (block) {
            const w = Math.ceil(wrap.getBoundingClientRect().width);
            if (w > 0) block.style.setProperty('--bc-track-width', w + 'px');
          }
          syncBarcodeTrackWidth();
        } catch (e) { /* ignore */ }
      } else {
        try {
          const el = ensureBarcodeSvg(wrap);
          if (el) el.outerHTML = '<span style="color:#9aa0aa;font-size:11px;">Invalid barcode for Code128</span>';
        } catch (e) {}
      }
    };
    if (typeof barcodeLib.renderCode128WhenReady === 'function') {
      barcodeLib.renderCode128WhenReady(liveSvg, bc, 3000).then(applyOk).catch(() => applyOk(false));
    } else {
      applyOk(barcodeLib.renderCode128(liveSvg, bc));
    }
  }



  function syncBarcodeTrackWidth() {
    try {
      const wrap = document.querySelector('.barcode-128-wrap');
      const block = wrap && wrap.closest('.barcode-block-128');
      if (!wrap || !block) return;
      const apply = () => {
        // Outer width of the white barcode frame (includes padding)
        const w = Math.round(wrap.getBoundingClientRect().width);
        if (w < 8) return;

        // Br list exactly same width → left & right edges match barcode
        const list = block.querySelector('.barcode-numbers-list');
        if (list) {
          list.style.boxSizing = 'border-box';
          list.style.width = w + 'px';
          list.style.minWidth = w + 'px';
          list.style.maxWidth = w + 'px';
          list.style.margin = '0';
          list.style.padding = '0';
          list.style.alignSelf = 'flex-start';
        }
        block.querySelectorAll('.barcode-number-item').forEach((item) => {
          item.style.boxSizing = 'border-box';
          item.style.width = '100%';
          item.style.maxWidth = '100%';
          item.style.margin = '0';
        });

        // Block shrink-wraps: switch row + barcode + Br (all same left edge)
        block.style.width = 'max-content';
        block.style.maxWidth = '100%';
        block.style.boxSizing = 'border-box';
        block.style.setProperty('--bc-track-width', w + 'px');
      };
      apply();
      requestAnimationFrame(() => {
        apply();
        setTimeout(apply, 40);
        setTimeout(apply, 150);
        setTimeout(apply, 350);
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

  function applyProductImageSrc(url) {
    const img = document.getElementById('prodImg');
    const wrap = document.getElementById('prodImgWrap');
    if (!img) return;
    const u = (url || '').trim();
    if (!u) {
      img.removeAttribute('src');
      img.alt = img.alt || '';
      if (wrap) wrap.classList.remove('loading');
      return;
    }
    if (wrap) wrap.classList.add('loading');
    img.onload = () => { if (wrap) wrap.classList.remove('loading'); };
    img.onerror = () => {
      img.removeAttribute('src');
      if (wrap) wrap.classList.remove('loading');
    };
    setProdImgSrc(img, u, { highPriority: true });
  }

  async function enrichProductImageFromDmart(product) {
    if (!product || !product.sku) return;
    const sku = String(product.sku);
    const token = ++imageLoadToken;

    const stillSame = () =>
      imageLoadToken === token &&
      lastRenderedProduct && String(lastRenderedProduct.sku) === sku;

    const showLoading = () => {
      const img = document.getElementById('prodImg');
      const wrap = document.getElementById('prodImgWrap');
      if (!img) return;
      img.alt = '';
      img.removeAttribute('src');
      img.src = loadingImagePlaceholder();
      if (wrap) {
        wrap.classList.add('loading');
        wrap.classList.add('img-fetching-dmart');
      }
    };
    const showFinal = (url) => {
      if (!stillSame()) return;
      const img = document.getElementById('prodImg');
      const wrap = document.getElementById('prodImgWrap');
      if (!img || !url) return;
      if (wrap) wrap.classList.add('loading');
      img.alt = '';
      img.onload = () => {
        if (!stillSame()) return;
        if (wrap) {
          wrap.classList.remove('loading');
          wrap.classList.remove('img-fetching-dmart');
        }
      };
      img.onerror = () => {
        if (!stillSame()) return;
        img.src = placeholderImg();
        if (wrap) {
          wrap.classList.remove('loading');
          wrap.classList.remove('img-fetching-dmart');
        }
      };
      img.src = url;
    };
    const onGotDmartUrl = (url) => {
      if (!url || !/^https?:\/\//i.test(url)) return;
      if (search.setDmartImage) search.setDmartImage(sku, url);
      try { product.image = url; } catch (e) {}
      refreshPanelThumbsForSku(sku, url);
      try { renderRecent(); } catch (e) {}
      try { renderFavorites(); } catch (e) {}
      showFinal(url);
    };

    const fileUrl = (product.image && /^https?:\/\//i.test(String(product.image).trim()))
      ? String(product.image).trim() : '';
    const cached = (search.getDmartImage && search.getDmartImage(sku)) || '';

    if (fileUrl) {
      const img = document.getElementById('prodImg');
      const wrap = document.getElementById('prodImgWrap');
      if (img) {
        if (wrap) wrap.classList.add('loading');
        img.alt = '';
        img.onload = () => {
          if (!stillSame()) return;
          if (wrap) {
            wrap.classList.remove('loading');
            wrap.classList.remove('img-fetching-dmart');
          }
        };
        img.onerror = () => {
          if (!stillSame()) return;
          showLoading();
          fetchDmart();
        };
        setProdImgSrc(img, fileUrl, { highPriority: true });
      }
      return;
    }
    if (cached) {
      onGotDmartUrl(cached);
      return;
    }
    showLoading();
    fetchDmart();

    async function fetchDmart() {
      if (!stillSame()) return;
      try {
        const wid = warehouse.getSelectedId && warehouse.getSelectedId();
        if (!wid || !dmartLive.lookupProductViaBridge) {
          if (stillSame()) {
            const img = document.getElementById('prodImg');
            if (img) img.src = placeholderImg();
            const wrap = document.getElementById('prodImgWrap');
            if (wrap) {
              wrap.classList.remove('loading');
              wrap.classList.remove('img-fetching-dmart');
            }
          }
          return;
        }
        const look = await dmartLive.lookupProductViaBridge(sku, wid, 15000);
        if (!stillSame()) return;
        if (look && look.ok && look.product && look.product.image) {
          const url = String(look.product.image).trim();
          onGotDmartUrl(url);
        } else {
          const img = document.getElementById('prodImg');
          if (img) img.src = placeholderImg();
          const wrap = document.getElementById('prodImgWrap');
          if (wrap) {
            wrap.classList.remove('loading');
            wrap.classList.remove('img-fetching-dmart');
          }
        }
      } catch (e) {
        if (!stillSame()) return;
        const img = document.getElementById('prodImg');
        if (img) img.src = placeholderImg();
        const wrap = document.getElementById('prodImgWrap');
        if (wrap) {
          wrap.classList.remove('loading');
          wrap.classList.remove('img-fetching-dmart');
        }
      }
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
          ${product.barcodes.map((bc, i) => {
            const brLabel = 'Br : ' + (i + 1);
            return `
            <div class="barcode-number-item" data-copy="${escapeAttr(bc)}" role="button" tabindex="0" aria-label="Copy ${brLabel}">
              <span class="barcode-number-label">${brLabel}</span>
              <span class="barcode-number-value">${escapeHtml(bc)}</span>
            </div>`;
          }).join('')}
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
              ${product.fromDmart ? '<span class="dmart-source-badge" title="Loaded from DMart">DMart</span>' : ''}
              <img id="prodImg" alt="" loading="eager" decoding="async" fetchpriority="high" src="">
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

    // Floating format switch (draggable, outside layout — never affects Br/barcode)
    ensureFloatingFormatSwitch();

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
      // Directional fill animation based on mouse approach
      dmartBtn.addEventListener('mousemove', (ev) => {
        try {
          const r = dmartBtn.getBoundingClientRect();
          const fromTop = (ev.clientY - r.top) < r.height / 2;
          dmartBtn.dataset.fillFrom = fromTop ? 'top' : 'bottom';
        } catch (e) { /* ignore */ }
      }, { passive: true });
      dmartBtn.href = dmartLib.buildDmartInventoryUrl(product.sku);
      dmartBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const url = dmartLib.buildDmartInventoryUrl(product.sku);
        window.open(url, '_blank', 'noopener,noreferrer');
      });
    }

    // Live Dmart stock + price (async, non-blocking, race-safe)
    try { dmartLive.requestLiveForProduct(product.sku); } catch (e) { /* never break product card */ }

    // Product image: DMart only (cached first, then live lookup) — never products.json
    try { enrichProductImageFromDmart(product); } catch (e) { /* ignore */ }

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

    // Mobile DOM order: image | barcode | live (CSS order can lose to older rules)
    try {
      if (window.matchMedia('(max-width:720px)').matches) {
        const row = els.resultArea.querySelector('.product-top-row');
        if (row) {
          const img = row.querySelector('.product-image-col');
          const bc = row.querySelector('.product-barcodes-col');
          const live = row.querySelector('.product-live-col');
          const recent = row.querySelector('.product-recent-col');
          if (img) row.appendChild(img);
          if (bc) row.appendChild(bc);
          if (live) row.appendChild(live);
          if (recent) row.appendChild(recent);
        }
      }
    } catch (e) { /* ignore */ }

    initStickyBarcode();
  }

  /** Sticky Barcode Bar (mobile only). Shows only the primary barcode + number
   *  while the user scrolls past its normal position in the product card, so
   *  it stays scannable without scrolling back up. Purely a UI convenience —
   *  does not touch search, OCR, Pelican Mode, or the database. */
  let stickyObserver = null;
  function initStickyBarcode() {
    if (stickyObserver) { stickyObserver.disconnect(); stickyObserver = null; }
    if (els.stickyBar) {
      els.stickyBar.hidden = true;
      els.stickyBar.style.display = 'none';
    }
    return; // disabled — user does not want sticky barcode strip on scroll
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
    image.initZoom({ zoomBackdrop: els.zoomBackdrop, zoomImg: els.zoomImg, zoomClose: els.zoomClose }, () => {
      // Closing image/barcode zoom must NOT open the keyboard when Intensive Auto Focus is OFF
      if (quickGetSettings().intensiveAutoFocus) {
        returnFocusToSearch();
      } else {
        try { els.searchInput && els.searchInput.blur(); } catch (e) { /* ignore */ }
      }
    });
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
      const MAX_RECENT_RENDER = 40;
      const shown = products.slice(0, MAX_RECENT_RENDER);
      let html = shown.map(p => panelItemHtml(p)).join('');
      if (products.length > MAX_RECENT_RENDER) {
        html += '<div class="panel-empty">Showing latest ' + MAX_RECENT_RENDER + ' of ' + products.length + '</div>';
      }
      els.recentList.innerHTML = html;
      wirePanelItems(els.recentList, shown);
    }
    fillInlineRecent();
    try { wirePanelAccordion(); } catch (e) {}
  }

  /** When setting is on, mirror Recent into the product card column beside barcodes. */
  function fillInlineRecent() {
    const col = document.getElementById('productRecentCol');
    const list = document.getElementById('productRecentList');
    if (!col || !list) return;
    const enabled = effectiveRecentBeside();
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
      list.innerHTML = products.map(p => panelItemHtml(p, { showAvailable: true })).join('');
      wirePanelItems(list, products);
    }
    const clearBtn = document.getElementById('inlineClearRecent');
    if (clearBtn && !clearBtn.dataset.wired) {
      clearBtn.dataset.wired = '1';
      clearBtn.addEventListener('click', () => {
        if (!confirm('Clear all Recent items? This cannot be undone.')) return;
        store.clearRecent();
        renderRecent();
        fillInlineRecent();
        toast('Recent searches cleared');
      });
    }
  }

  /** Persist last viewed product so it reopens after reload (mobile + PC). */
  function persistLastViewed(product) {
    if (!product || !product.sku) return;
    try { localStorage.setItem('smouha_last_sku', String(product.sku)); } catch (e) { /* ignore */ }
  }

  /** On startup: always restore last scanned/viewed product when data is ready. */
  function restoreLastRecentProduct() {
    try {
      if (lastRenderedProduct) return;
      let sku = null;
      try { sku = localStorage.getItem('smouha_last_sku'); } catch (e) { sku = null; }
      if (!sku) {
        const skus = store.getRecent();
        if (skus && skus.length) sku = skus[0];
      }
      if (!sku) return;
      const products = search.getBySkuList([sku]);
      if (products && products[0]) {
        renderProduct(products[0]);
        return;
      }
      // Fallback: first resolvable recent
      const skus = store.getRecent();
      if (skus && skus.length) {
        const list = search.getBySkuList(skus);
        if (list && list[0]) renderProduct(list[0]);
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

  function panelItemHtml(p, opts) {
    const thumb = resolveProductThumb(p);
    const showAvail = !!(opts && opts.showAvailable);
    let qtyHtml = '';
    if (showAvail) {
      let q = null;
      try {
        q = (typeof store.getLastAvailable === 'function') ? store.getLastAvailable(p.sku) : null;
      } catch (e) { q = null; }
      const has = q != null && Number.isFinite(Number(q));
      const n = has ? Number(q) : null;
      const cls = has ? (n > 0 ? 'is-positive' : 'is-zero') : 'is-unknown';
      const label = has ? String(n) : '—';
      qtyHtml = '<span class="panel-qty ' + cls + '" title="Last Available">' + label + '</span>';
    }
    return `
      <div class="panel-item${showAvail ? ' panel-item-with-qty' : ''}" data-sku="${escapeAttr(p.sku)}">
        <img class="panel-thumb" src="${escapeAttr(thumb)}" alt="" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='${placeholderImg()}'">
        <div class="panel-text">
          <div class="panel-name">${escapeHtml(p.name)}</div>
          <div class="panel-sub">SKU ${escapeHtml(p.sku)}</div>
        </div>
        ${qtyHtml}
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

  function wirePanelAccordion() {
    const row = document.querySelector('.panels-row');
    if (!row) return;
    const panels = [...row.querySelectorAll('.panel')];
    if (!panels.length) return;
    // Always ensure Recent is open on mobile so items are visible
    panels.forEach((p, i) => {
      if (i === 0) p.classList.add('is-open');
    });
    if (row.dataset.accordionWired) return;
    row.dataset.accordionWired = '1';
    panels.forEach((p, i) => {
      const head = p.querySelector('.panel-header');
      if (!head) return;
      head.style.cursor = 'pointer';
      head.addEventListener('click', (e) => {
        if (e.target.closest('.panel-clear')) return;
        if (!window.matchMedia('(max-width: 720px)').matches) return;
        const open = p.classList.contains('is-open');
        if (open) p.classList.remove('is-open');
        else p.classList.add('is-open');
      });
    });
  }

  function initPanels() {
    wirePanelAccordion();
    renderRecent();
    renderFavorites();
    renderQuickAccess();
    try {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(() => { try { preloadRecentImages(); } catch (e) {} }, { timeout: 3000 });
      } else {
        setTimeout(() => { try { preloadRecentImages(); } catch (e) {} }, 50);
      }
    } catch (e) {
      try { preloadRecentImages(); } catch (e2) {}
    }
    els.clearRecent.addEventListener('click', () => {
      if (!confirm('Clear all Recent items? This cannot be undone.')) return; store.clearRecent(); renderRecent(); toast('Recent searches cleared'); });
    els.clearFavs.addEventListener('click', () => {
      if (!confirm('Clear all Favorites? This cannot be undone.')) return; store.clearFavs(); renderFavorites(); toast('Favorites cleared'); });
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
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" rx="16" fill="#E8F3F8"/><rect x="70" y="58" width="60" height="48" rx="6" fill="none" stroke="#8AAEBC" stroke-width="3"/><circle cx="88" cy="76" r="5" fill="#8AAEBC"/><path d="M78 98l16-14 14 12 18-16 16 18" fill="none" stroke="#8AAEBC" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><text x="50%" y="168" font-family="system-ui,sans-serif" font-size="13" fill="#6A8694" text-anchor="middle">No image</text></svg>`
    );
  }
  
  function applyProdImgAttrs(img, { highPriority = true } = {}) {
    if (!img) return;
    try { img.decoding = 'async'; } catch (e) {}
    try {
      if (highPriority) img.setAttribute('fetchpriority', 'high');
      else img.setAttribute('fetchpriority', 'low');
    } catch (e) {}
    try { img.referrerPolicy = 'no-referrer'; } catch (e) {}
  }

  function setProdImgSrc(img, url, opts) {
    if (!img || !url) return;
    applyProdImgAttrs(img, opts);
    if (img.src === url) {
      // already showing — still ensure load handlers can complete
      if (img.complete && img.naturalWidth > 0) {
        try { img.dispatchEvent(new Event('load')); } catch (e) {}
      }
      return;
    }
    img.src = url;
  }

  function loadingImagePlaceholder() {
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" rx="16" fill="#EEF6FA"/><circle cx="100" cy="78" r="22" fill="none" stroke="#FF6B00" stroke-width="3" stroke-dasharray="28 40" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 100 78" to="360 100 78" dur="0.9s" repeatCount="indefinite"/></circle><text x="50%" y="130" font-family="system-ui,sans-serif" font-size="12" font-weight="600" fill="#FF6B00" text-anchor="middle">Fetching from DMart</text><text x="50%" y="150" font-family="system-ui,sans-serif" font-size="11" fill="#7A929E" text-anchor="middle">Loading image…</text></svg>`
    );
  }
  function resolveProductThumb(p) {
    if (!p) return placeholderImg();
    const file = String(p.image || '').trim();
    if (/^https?:\/\//i.test(file)) return file;
    const d = (search.getDmartImage && search.getDmartImage(p.sku)) || '';
    if (d) return d;
    return placeholderImg();
  }
  function refreshPanelThumbsForSku(sku, url) {
    if (!sku || !url) return;
    const safe = String(sku).replace(/"/g, '');
    document.querySelectorAll('.panel-item[data-sku="' + safe + '"] .panel-thumb').forEach((img) => {
      img.src = url;
    });
    document.querySelectorAll('#productRecentList .panel-item[data-sku="' + safe + '"] .panel-thumb').forEach((img) => {
      img.src = url;
    });
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
    const btn = els.settingsBtn || document.getElementById('settingsBtn');
    if (!btn) return;
    let initialized = false;
    let opening = false;
    btn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (opening) return;
      opening = true;
      try {
        const mod = await loadSettingsModule();
        const panel = els.settingsPanel || document.getElementById('settingsPanel');
        const closeBtn = els.settingsClose || document.getElementById('settingsClose');
        const backdrop = els.settingsBackdrop || document.getElementById('settingsBackdrop');
        if (!initialized) {
          mod.initSettingsPanel(
            { panel, openBtn: btn, closeBtn, backdrop },
            { onForceUpdateResult: (r) => toast(r.ok ? 'Database Updated Successfully' : 'Update failed — check your connection') }
          );
          initialized = true;
        }
        mod.openPanel();
      } catch (err) {
        console.error('[settings] open failed', err);
        try { toast('Settings failed to open', 'error'); } catch (e) {}
      } finally {
        opening = false;
      }
    });
    const bd = els.settingsBackdrop || document.getElementById('settingsBackdrop');
    if (bd) {
      bd.addEventListener('click', (e) => {
        if (e.target === bd) returnFocusToSearch();
      });
    }

    // When QR Code or Performance Mode is toggled, only swap the barcode
    // area — never rebuild the whole product card (that caused freezes).
    window.addEventListener('smouha:recent-layout', () => {
      try { fillInlineRecent(); } catch (e) { /* ignore */ }
    });
    window.addEventListener('smouha:last-available', () => {
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
    try { ensureFloatingFormatSwitch(); } catch (e) { console.warn("fmt switch", e); }

    // Unlock WebAudio after first gesture so scan sound works on mobile
    const unlockAudio = () => {
      try {
        if (!_scanAudioCtx) {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (AC) _scanAudioCtx = new AC();
        }
        if (_scanAudioCtx && _scanAudioCtx.state === 'suspended') _scanAudioCtx.resume();
      } catch (e) { /* ignore */ }
      document.removeEventListener('pointerdown', unlockAudio, true);
    };
    document.addEventListener('pointerdown', unlockAudio, true);

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

  // Smouha Team rotator → same team list modal as footer link
  (function wireTeamRotatorOpen() {
    const rot = document.querySelector('.team-rotator') || document.getElementById('teamRotator');
    if (!rot) return;
    rot.style.cursor = 'pointer';
    rot.setAttribute('role', 'button');
    rot.setAttribute('tabindex', '0');
    rot.setAttribute('title', 'Open team list');
    const open = (e) => {
      try {
        // Never steal taps meant for product suggestions.
        // NOTE: closeSuggestions() removes the 'open'/'suggestions-open' classes
        // *synchronously* the moment a suggestion is picked — before the browser
        // dispatches the trailing ghost click/tap at the same screen coordinates.
        // So on mobile, by the time that ghost click reaches here, both class
        // checks below have already gone stale (classes are already removed) and
        // fail to block it — that's exactly why tapping the first suggestion could
        // immediately re-open Team Rotator underneath it. The time-based guard
        // (same one used for the product image ghost-tap in image.js) is set
        // *before* the classes are removed, so it still catches this window.
        if (window.__smouhaIgnoreTapUntil && Date.now() < window.__smouhaIgnoreTapUntil) return;
        if (els.suggestionsBox && els.suggestionsBox.classList.contains('open')) return;
        if (document.querySelector('.search-main-row.suggestions-open')) return;
        if (e) { e.preventDefault(); e.stopPropagation(); }
        if (els.teamLinkBtn) els.teamLinkBtn.click();
        else if (els.teamModal) {
          els.teamModal.classList.add('open');
          els.teamModal.removeAttribute('hidden');
        }
      } catch (err) {}
    };
    rot.addEventListener('click', open, true);
    rot.addEventListener('pointerup', (e) => {
      if (els.suggestionsBox && els.suggestionsBox.classList.contains('open')) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
    rot.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  })();

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
  let _scanAudioCtx = null;
  function playScanBeep() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!_scanAudioCtx) _scanAudioCtx = new AC();
      const ctx = _scanAudioCtx;
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 980;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.14);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.15);
    } catch (e) { /* audio unavailable — silently skip */ }
  }

  function playScanFeedback() {
    try {
      if (quickGetSettings().scanSound) playScanBeep();
    } catch (e) { /* ignore */ }
    try {
      if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
    } catch (e) { /* ignore */ }
  }

  /** Public entry point used by Pelican Mode (and any future input source)
   *  to feed a decoded value through the search pipeline. Uses the Pelican
   *  priority order (full barcode -> SKU -> last 6 digits) while reusing
   *  the exact same rendering/skeleton/choice-modal code as manual typing. */
  function searchFromExternalInput(code) {
    playScanFeedback();
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
    const HOLD_MS_ASHRAF = 9000;
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

  window.addEventListener('resize', () => { try { quickApplyGlobalModes(); } catch (e) {} });

  return {
    init,
    setLoadingState,
    onDataReady,
    toast,
    renderRecent,
    renderFavorites,
    searchFromExternalInput,
  };
})();

/* Pelican Mode — extracted module */
const smartScan = createSmartScan({
  searchFromExternalInput: (code) => ui.searchFromExternalInput(code),
});


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
    warehouse.setDisplayMode(effectiveWarehouseDisplay() === 'friendly' ? 'friendly' : 'original');
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

  try {
    import('./dmartLive.js').then((m) => { if (m.startBridgeWatchdog) m.startBridgeWatchdog(); }).catch(() => {});
  } catch (e) {}
  updater.loadInitial().then((result) => {
    ui.onDataReady();
    if (result && result.updated && result.source === 'network') {
      ui.toast('Database Updated Successfully');
    }
    const versionEl = document.getElementById('appVersionLine');
    if (versionEl && quickGetSettings().showVersion) {
      const v = updater.getLastVersionInfo() || {};
      const countText = quickGetSettings().showProductCount ? (' \u00b7 ' + search.count().toLocaleString() + ' Products') : '';
      versionEl.textContent = (v.version ? 'v' + v.version : '') + (v.build != null ? ' (build ' + v.build + ')' : '') + countText;
    }
  }).catch((err) => {
    console.error('[updater] loadInitial failed', err);
    try { ui.onDataReady(); } catch (e) {}
    try { ui.toast('Could not load catalog — check connection', 'error'); } catch (e) {}
  });
});


window.addEventListener('smouha:clear-dmart-cache', () => {
  try {
    if (search.clearDmartCache) search.clearDmartCache();
    alert('DMart cache cleared.');
  } catch (e) {
    alert('Could not clear DMart cache.');
  }
});


window.addEventListener('smouha:db-updated', (ev) => {
  try {
    const n = ev && ev.detail && ev.detail.count;
    if (typeof ui !== 'undefined' && ui.toast) {
      ui.toast(n ? ('Catalog updated · ' + Number(n).toLocaleString() + ' products') : 'Catalog updated');
    }
  } catch (e) {}
});


window.addEventListener('smouha:db-update-failed', (ev) => {
  try {
    const msg = (ev && ev.detail && ev.detail.message) ? ev.detail.message : 'Background catalog update failed';
    if (typeof ui !== 'undefined' && ui.toast) ui.toast(msg + ' — data may be outdated', 'error');
    else alert(msg + ' — data may be outdated');
  } catch (e) {}
});

wireCatalogAndSessionUi();
