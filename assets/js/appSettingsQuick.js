/* appSettingsQuick.js — synchronous settings reads for hot paths */
export const SETTINGS_KEY = 'smouhaPickSettings';
export const SETTINGS_DEFAULTS = {
  autoCopyBarcode: false,
  autoCopySku: false,
  hoverPreview: true,
  compactMode: false,
  performanceMode: false,
  largeBarcode: false,
  largeProductImage: false,
  qrCode: true,
  scanSound: true,
  showProductCount: true,
  showVersion: true,
  warehouseDisplay: 'friendly',
  recentBesideBarcode: true,
  dmartPopupEnabled: true,
  intensiveAutoFocus: false,
};

export function quickGetSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...SETTINGS_DEFAULTS, ...JSON.parse(raw) } : { ...SETTINGS_DEFAULTS };
  } catch (e) {
    return { ...SETTINGS_DEFAULTS };
  }
}

export function isMobileViewport() {
  try { return window.matchMedia('(max-width:720px)').matches; } catch (e) { return false; }
}

/** PC default ON, mobile default OFF.
 *  On mobile, only ON if user explicitly enabled AFTER this version (flag). */
export function suppressGhostImageTap(ms) {
  try { window.__smouhaIgnoreTapUntil = Date.now() + (ms || 450); } catch (e) { /* ignore */ }
}

export function selectSearchAfterProduct() {
  const input = document.getElementById('searchInput');
  if (!input) return;
  // Mobile: do NOT open keyboard after product appears
  if (isMobileViewport()) {
    try { input.blur(); } catch (e) { /* ignore */ }
    return;
  }
  try {
    requestAnimationFrame(() => {
      input.focus({ preventScroll: true });
      input.select();
    });
  } catch (e) { /* ignore */ }
}

export function effectiveRecentBeside() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    let explicit = null;
    if (raw) {
      const p = JSON.parse(raw);
      if (p && Object.prototype.hasOwnProperty.call(p, 'recentBesideBarcode')) {
        explicit = !!p.recentBesideBarcode;
      }
    }
    if (isMobileViewport()) {
      // Mobile default OFF — ignore old saved true unless user re-enabled
      try {
        if (localStorage.getItem('smouha_rb_mobile_on') === '1') {
          return explicit !== false; // user opted in on mobile
        }
      } catch (e2) { /* ignore */ }
      return false;
    }
    // PC: ON unless user explicitly disabled
    return explicit === null ? true : explicit;
  } catch (e) {
    return !isMobileViewport();
  }
}

export function effectiveWarehouseDisplay() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    let explicit = null;
    if (raw) {
      const p = JSON.parse(raw);
      if (p && Object.prototype.hasOwnProperty.call(p, 'warehouseDisplay')) {
        explicit = p.warehouseDisplay;
      }
    }
    // Default Friendly on mobile + desktop; Settings can still force Original names
    return explicit == null ? 'friendly' : explicit;
  } catch (e) {
    return 'friendly';
  }
}

export function effectiveDmartPopup() {
  try {
    const s = quickGetSettings();
    if (!isMobileViewport()) return s.dmartPopupEnabled !== false;
    // Mobile default OFF
    try {
      if (localStorage.getItem('smouha_dmart_popup_mobile_on') === '1') {
        return s.dmartPopupEnabled !== false;
      }
    } catch (e2) { /* ignore */ }
    return false;
  } catch (e) {
    return !isMobileViewport();
  }
}

export function quickApplyGlobalModes() {
  const s = quickGetSettings();
  document.documentElement.classList.toggle('performance-mode', !!s.performanceMode);
  document.documentElement.classList.toggle('compact-mode', !!s.compactMode);
  document.documentElement.classList.toggle('large-barcode', !!s.largeBarcode);
  document.documentElement.classList.toggle('large-product-image', !!s.largeProductImage);
  document.documentElement.classList.toggle('recent-beside-barcode', effectiveRecentBeside());
  document.documentElement.classList.toggle('hide-dmart-live', !s.showProductCount);
}