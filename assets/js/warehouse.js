/* ============================================================================
   warehouse.js — MODULE: warehouse
   ------------------------------------------------------------------------
   Isolated Multi-Warehouse manager for Smouha Pick.

   Responsibilities:
     - Load data/warehouses.json once
     - Persist selected warehouse (localStorage key: selectedWarehouse)
     - Default to EG_Alexandria Smouha_DS_60 on first launch
     - Premium searchable warehouse selector UI
     - Friendly / Original display names (display only; data never changes)
     - Dmart confirmation dialog after successful product searches
     - Live update of existing Dmart links when warehouse changes

   Future warehouses: edit data/warehouses.json only. No JS changes required.
   ============================================================================ */

import { escapeHtml, escapeAttr } from './utils.js';

const STORAGE_KEY = 'selectedWarehouse';
const DEFAULT_NAME = 'EG_Alexandria Smouha_DS_60';
const WAREHOUSES_URL = 'data/warehouses.json';

/** @type {{name:string, id:string}[]} */
let warehouses = [];
/** @type {{name:string, id:string}|null} */
let selected = null;
/** @type {'original'|'friendly'} */
let displayMode = 'original';

const changeListeners = new Set();

// ---------------------------------------------------------------------------
// Friendly name helper (display only — original data is never mutated)
// ---------------------------------------------------------------------------
function toFriendlyName(name) {
  if (!name) return '';
  if (name === 'EG_Alexandria Smouha_DS_60') return 'Smouha DS 60';
  // General cleanup: strip EG_ prefix, turn underscores into spaces
  let s = name.replace(/^EG_/, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  // Normalise "DS XX" spacing if present
  s = s.replace(/\s*DS\s*(\d+)/i, ' DS $1');
  return s;
}

export function getDisplayName(wh = selected) {
  if (!wh) return '';
  return displayMode === 'friendly' ? toFriendlyName(wh.name) : wh.name;
}

export function setDisplayMode(mode) {
  displayMode = mode === 'friendly' ? 'friendly' : 'original';
  refreshSelectorLabel();
  // Also refresh any open confirmation dialog warehouse text if present
  const nameEl = document.querySelector('#dmartConfirmWarehouse .dmart-confirm-wh-name')
    || document.querySelector('.dmart-confirm-wh-name');
  if (nameEl && selected) nameEl.textContent = getDisplayName();
}

export function getDisplayMode() {
  return displayMode;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
function loadSelectedFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.name && parsed.id) return parsed;
  } catch (e) { /* ignore */ }
  return null;
}

function saveSelected() {
  if (!selected) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ name: selected.name, id: selected.id }));
  } catch (e) { /* storage full / unavailable */ }
}

// ---------------------------------------------------------------------------
// Public getters / setters
// ---------------------------------------------------------------------------
export function getSelected() {
  return selected;
}

export function getSelectedId() {
  return selected ? selected.id : null;
}

export function getWarehouses() {
  return warehouses.slice();
}

export function setSelectedByName(name) {
  const found = warehouses.find(w => w.name === name);
  if (!found) return false;
  if (selected && selected.name === found.name) return true;
  selected = { name: found.name, id: found.id };
  saveSelected();
  refreshSelectorLabel();
  updateAllDmartLinks();
  changeListeners.forEach(cb => {
    try { cb(selected); } catch (e) { /* listener error must not break app */ }
  });
  return true;
}

export function onChange(cb) {
  if (typeof cb === 'function') changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}

// ---------------------------------------------------------------------------
// Dmart link live update
// ---------------------------------------------------------------------------
export function updateAllDmartLinks() {
  if (!selected) return;
  document.querySelectorAll('a.dmart-check-btn[data-sku]').forEach(a => {
    const sku = a.getAttribute('data-sku');
    if (sku) {
      a.href = buildInventoryUrl(sku);
    }
  });
}

/** Build the exact same URL pattern that dmart.js historically used,
 *  substituting only the warehouse ID. Kept here so dmart.js can call it
 *  without circular imports if needed; primary path goes through dmart.js. */
export function buildInventoryUrl(sku) {
  const id = getSelectedId() || '';
  return `https://portal.talabat.com/pv2/eg/p/inventory/w/${id}?search=${encodeURIComponent(sku)}&is_active=0&is_available=0&is_sample=0&sort=0&page=1`;
}

export function buildInventoryBrowseUrl() {
  const id = getSelectedId() || '';
  return `https://portal.talabat.com/pv2/eg/p/inventory/w/${id}?search=&is_active=0&is_available=0&is_sample=0&sort=0&page=1`;
}

// ---------------------------------------------------------------------------
// Selector UI
// ---------------------------------------------------------------------------
let selectorRoot = null;
let dropdownOpen = false;

function refreshSelectorLabel() {
  if (!selectorRoot || !selected) return;
  const label = selectorRoot.querySelector('.wh-selector-value');
  if (label) label.textContent = getDisplayName();
}

function closeDropdown() {
  if (!selectorRoot) return;
  dropdownOpen = false;
  selectorRoot.classList.remove('open');
  const panel = selectorRoot.querySelector('.wh-dropdown');
  if (panel) panel.setAttribute('hidden', '');
  const btn = selectorRoot.querySelector('.wh-selector-btn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function openDropdown() {
  if (!selectorRoot) return;
  dropdownOpen = true;
  selectorRoot.classList.add('open');
  const panel = selectorRoot.querySelector('.wh-dropdown');
  if (panel) panel.removeAttribute('hidden');
  const btn = selectorRoot.querySelector('.wh-selector-btn');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  const input = selectorRoot.querySelector('.wh-search-input');
  if (input) {
    input.value = '';
    renderWarehouseList('');
    // Focus after paint so mobile keyboards open reliably
    requestAnimationFrame(() => input.focus());
  }
}

function renderWarehouseList(filter) {
  const list = selectorRoot && selectorRoot.querySelector('.wh-list');
  if (!list) return;
  const q = (filter || '').trim().toLowerCase();
  const items = q
    ? warehouses.filter(w => {
        const original = w.name.toLowerCase();
        const friendly = toFriendlyName(w.name).toLowerCase();
        return original.includes(q) || friendly.includes(q);
      })
    : warehouses;

  if (!items.length) {
    list.innerHTML = `<div class="wh-empty">No warehouses match</div>`;
    return;
  }

  const selectedName = selected ? selected.name : '';
  list.innerHTML = items.map(w => {
    const active = w.name === selectedName ? ' active' : '';
    const display = displayMode === 'friendly' ? toFriendlyName(w.name) : w.name;
    return `<button type="button" class="wh-item${active}" data-name="${escapeAttr(w.name)}" role="option" aria-selected="${w.name === selectedName}">
      <span class="wh-item-name">${escapeHtml(display)}</span>
    </button>`;
  }).join('');
  // Selection is handled by event delegation on .wh-list (see wireSelector)
}

function buildSelectorHtml() {
  const display = selected ? getDisplayName() : 'Select warehouse';
  return `
    <div class="wh-selector" id="warehouseSelector">
      <span class="wh-selector-label">Warehouse</span>
      <button type="button" class="wh-selector-btn" aria-haspopup="listbox" aria-expanded="false" aria-label="Select warehouse">
        <span class="wh-selector-value">${escapeHtml(display)}</span>
        <span class="wh-selector-chevron" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </span>
      </button>
      <div class="wh-dropdown" hidden role="listbox" aria-label="Warehouse list">
        <div class="wh-search-wrap">
          <svg class="wh-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input type="search" class="wh-search-input" placeholder="Search warehouses…" autocomplete="off" spellcheck="false" aria-label="Filter warehouses">
        </div>
        <div class="wh-list"></div>
      </div>
    </div>
  `;
}

function wireSelector() {
  if (!selectorRoot) return;
  const btn = selectorRoot.querySelector('.wh-selector-btn');
  const input = selectorRoot.querySelector('.wh-search-input');
  const list = selectorRoot.querySelector('.wh-list');
  const dropdown = selectorRoot.querySelector('.wh-dropdown');

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (dropdownOpen) closeDropdown();
    else openDropdown();
  });

  // Select only on a real tap/click (not during scroll).
  // pointerdown was closing the list as soon as the user touched an item to scroll.
  list.addEventListener('click', (e) => {
    const item = e.target.closest('.wh-item');
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    const name = item.getAttribute('data-name');
    if (name) setSelectedByName(name);
    closeDropdown();
  });

  // Keep all pointer/touch activity inside the dropdown from bubbling
  // so the document "outside" handler never fires while scrolling.
  dropdown.addEventListener('pointerdown', (e) => e.stopPropagation());
  dropdown.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });

  input.addEventListener('input', () => renderWarehouseList(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeDropdown();
      btn.focus();
    }
  });
  input.addEventListener('click', (e) => e.stopPropagation());

  // Close only when the user taps truly outside the selector
  document.addEventListener('pointerdown', (e) => {
    if (dropdownOpen && selectorRoot && !selectorRoot.contains(e.target)) {
      closeDropdown();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dropdownOpen) closeDropdown();
  });
}

// ---------------------------------------------------------------------------
// Dmart confirmation dialog
// Compact, non-blocking panel (page stays usable). YES opens Dmart for the
// pending SKU; NO dismisses. Enter/Esc work while open without stealing focus.
// ---------------------------------------------------------------------------
let confirmBackdrop = null;
let confirmResolve = null;
let pendingDmartSku = null;
let confirmKeyHandler = null;

function ensureConfirmDialog() {
  if (confirmBackdrop) return;
  confirmBackdrop = document.createElement('div');
  confirmBackdrop.className = 'dmart-confirm-backdrop';
  confirmBackdrop.id = 'dmartConfirmBackdrop';
  confirmBackdrop.innerHTML = `
    <div class="dmart-confirm-box" role="dialog" aria-modal="false" aria-labelledby="dmartConfirmTitle">
      <div class="dmart-confirm-title" id="dmartConfirmTitle">Open Product in Dmart?</div>
      <div class="dmart-confirm-actions">
        <button type="button" class="dmart-confirm-btn dmart-confirm-no" id="dmartConfirmNo">NO</button>
        <button type="button" class="dmart-confirm-btn dmart-confirm-yes is-selected" id="dmartConfirmYes">YES</button>
      </div>
    </div>
  `;
  document.body.appendChild(confirmBackdrop);

  const yesBtn = confirmBackdrop.querySelector('#dmartConfirmYes');
  const noBtn = confirmBackdrop.querySelector('#dmartConfirmNo');

  yesBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeConfirm(true);
  });
  noBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeConfirm(false);
  });

  // Keep clicks inside the box from reaching the page only for the buttons;
  // the backdrop itself has pointer-events: none so the rest of the UI works.
  const box = confirmBackdrop.querySelector('.dmart-confirm-box');
  box.addEventListener('click', (e) => {
    e.stopPropagation();
  });
  enableConfirmDrag(box);
}

/** Drag the confirm panel by its title bar (desktop + touch).
 *  Critical: never leave top+bottom (or left+right) set together — that
 *  stretches the box. Always pin size with fixed width + height:auto. */
function enableConfirmDrag(box) {
  if (!box || box.dataset.dragReady === '1') return;
  box.dataset.dragReady = '1';
  const handle = box.querySelector('.dmart-confirm-title') || box;
  handle.classList.add('dmart-confirm-drag-handle');
  let dragging = false;
  let startX = 0, startY = 0, origLeft = 0, origTop = 0, boxW = 0;

  function pinBoxSize() {
    const rect = box.getBoundingClientRect();
    boxW = Math.round(rect.width);
    box.style.width = boxW + 'px';
    box.style.height = 'auto';
    box.style.maxHeight = 'none';
    box.style.bottom = 'auto';
    box.style.right = 'auto';
    box.style.transform = 'none';
  }

  const onMove = (clientX, clientY) => {
    if (!dragging) return;
    const dx = clientX - startX;
    const dy = clientY - startY;
    let left = origLeft + dx;
    let top = origTop + dy;
    const w = boxW || box.offsetWidth;
    const h = box.offsetHeight;
    const maxL = Math.max(8, window.innerWidth - w - 8);
    const maxT = Math.max(8, window.innerHeight - h - 8);
    left = Math.max(8, Math.min(left, maxL));
    top = Math.max(8, Math.min(top, maxT));
    box.style.left = left + 'px';
    box.style.top = top + 'px';
    box.style.right = 'auto';
    box.style.bottom = 'auto';
    box.style.width = w + 'px';
    box.style.height = 'auto';
    box.style.transform = 'none';
  };

  const onPointerDown = (e) => {
    if (e.target.closest('button')) return;
    dragging = true;
    pinBoxSize();
    const rect = box.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    origLeft = rect.left;
    origTop = rect.top;
    box.style.left = origLeft + 'px';
    box.style.top = origTop + 'px';
    box.style.right = 'auto';
    box.style.bottom = 'auto';
    box.style.transform = 'none';
    box.classList.add('is-dragging');
    try { handle.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  };
  const onPointerMove = (e) => { if (dragging) onMove(e.clientX, e.clientY); };
  const onPointerUp = (e) => {
    if (!dragging) return;
    dragging = false;
    box.classList.remove('is-dragging');
    try { handle.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  };
  handle.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('pointermove', onPointerMove);
  handle.addEventListener('pointerup', onPointerUp);
  handle.addEventListener('pointercancel', onPointerUp);
}

function toggleConfirmSelection() {
  if (!confirmBackdrop) return;
  const yesBtn = confirmBackdrop.querySelector('#dmartConfirmYes');
  const noBtn = confirmBackdrop.querySelector('#dmartConfirmNo');
  const yesSelected = yesBtn.classList.contains('is-selected');
  yesBtn.classList.toggle('is-selected', !yesSelected);
  noBtn.classList.toggle('is-selected', yesSelected);
}

function closeConfirm(accepted) {
  if (!confirmBackdrop) return;
  confirmBackdrop.classList.remove('open');
  const yesBtn = confirmBackdrop.querySelector('#dmartConfirmYes');
  const noBtn = confirmBackdrop.querySelector('#dmartConfirmNo');
  if (yesBtn) yesBtn.classList.add('is-selected');
  if (noBtn) noBtn.classList.remove('is-selected');
  if (confirmKeyHandler) {
    document.removeEventListener('keydown', confirmKeyHandler, true);
    confirmKeyHandler = null;
  }
  const resolve = confirmResolve;
  confirmResolve = null;
  if (resolve) resolve(!!accepted);
}

function bindConfirmKeys() {
  if (confirmKeyHandler) return;
  confirmKeyHandler = (e) => {
    if (!confirmBackdrop || !confirmBackdrop.classList.contains('open')) return;
    const tag = (e.target && e.target.tagName) || '';
    const inField = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable);
    // Enter always confirms the selected button (default YES) — even if search has focus
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const noBtn = confirmBackdrop.querySelector('#dmartConfirmNo');
      const preferYes = !noBtn || !noBtn.classList.contains('is-selected');
      closeConfirm(preferYes);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeConfirm(false);
      return;
    }
    // Arrow keys only when not typing freely in a field
    if (!inField && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      toggleConfirmSelection();
    }
  };
  document.addEventListener('keydown', confirmKeyHandler, true);
}

/**
 * Show compact Dmart confirmation for `sku`.
 * Non-blocking: page remains interactive. If already open, updates the SKU.
 * Resolves true (YES) / false (NO).
 */
export function showDmartConfirm(sku) {
  if (sku) pendingDmartSku = String(sku);
  ensureConfirmDialog();

  const yesBtn = confirmBackdrop.querySelector('#dmartConfirmYes');
  const noBtn = confirmBackdrop.querySelector('#dmartConfirmNo');
  if (yesBtn) yesBtn.classList.add('is-selected');
  if (noBtn) noBtn.classList.remove('is-selected');

  const alreadyOpen = confirmBackdrop.classList.contains('open');
  confirmBackdrop.classList.add('open');
  bindConfirmKeys();
  // Default dock position (top area) until user drags
  const box = confirmBackdrop.querySelector('.dmart-confirm-box');
  if (box && !box.dataset.docked) {
    box.dataset.docked = '1';
    requestAnimationFrame(() => {
      const team = document.getElementById('teamRotator');
      const tRect = team ? team.getBoundingClientRect() : null;
      const bw = Math.min(280, window.innerWidth - 24);
      box.style.width = bw + 'px';
      box.style.height = 'auto';
      box.style.right = 'auto';
      box.style.bottom = 'auto';
      box.style.transform = 'none';
      if (tRect) {
        // Default: to the RIGHT of Smouha Team rotator, vertically aligned
        const gap = 10;
        let left = tRect.right + gap;
        let top = tRect.top;
        // If overflows right edge, place just left of viewport edge still near team
        if (left + bw > window.innerWidth - 8) {
          left = Math.max(8, window.innerWidth - bw - 8);
        }
        // Keep on screen vertically
        top = Math.max(8, Math.min(top, window.innerHeight - 140));
        box.style.left = left + 'px';
        box.style.top = top + 'px';
      } else {
        box.style.left = Math.max(8, window.innerWidth - bw - 20) + 'px';
        box.style.top = '80px';
      }
    });
  }
  // Always put keyboard focus on YES so Enter opens Dmart immediately
  requestAnimationFrame(() => {
    try {
      const y = confirmBackdrop.querySelector('#dmartConfirmYes');
      if (y) y.focus({ preventScroll: true });
    } catch (e) { /* ignore */ }
  });

  // If already open, replace the pending resolver so only the latest waiter runs
  return new Promise((resolve) => {
    if (confirmResolve && alreadyOpen) {
      // Previous waiter: treat as dismissed without action
      try { confirmResolve(false); } catch (e) { /* ignore */ }
    }
    confirmResolve = resolve;
  });
}

export function getPendingDmartSku() {
  return pendingDmartSku;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
export async function init(container) {
  // Load warehouses once
  try {
    const res = await fetch(WAREHOUSES_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error('Failed to load warehouses.json');
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) throw new Error('warehouses.json empty or invalid');
    warehouses = data.map(w => ({ name: String(w.name), id: String(w.id) }));
  } catch (err) {
    console.error('[warehouse] load failed', err);
    // Minimal fallback so the app still runs
    warehouses = [{ name: DEFAULT_NAME, id: 'd24a9f96-f6bc-43b0-af78-b7067f0c901c' }];
  }

  // Restore selection
  const stored = loadSelectedFromStorage();
  if (stored) {
    const match = warehouses.find(w => w.name === stored.name || w.id === stored.id);
    selected = match || warehouses.find(w => w.name === DEFAULT_NAME) || warehouses[0];
  } else {
    selected = warehouses.find(w => w.name === DEFAULT_NAME) || warehouses[0];
  }
  saveSelected();

  // Sync display mode from settings if already available
  try {
    const raw = localStorage.getItem('smouhaPickSettings');
    if (raw) {
      const s = JSON.parse(raw);
      if (s.warehouseDisplay === 'friendly') displayMode = 'friendly';
    }
  } catch (e) { /* ignore */ }

  // Mount selector
  if (container) {
    container.innerHTML = buildSelectorHtml();
    selectorRoot = container.querySelector('#warehouseSelector') || container.firstElementChild;
    wireSelector();
    renderWarehouseList('');
  }

  return selected;
}
