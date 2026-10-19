/* ============================================================================
   image.js — MODULE: image (zoom modal, desktop hover preview, preloading)
   ------------------------------------------------------------------------
   Lazy-loaded (see app.js): image preview isn't needed until the first
   product renders, so this module is dynamically imported rather than
   bundled into the critical startup path.
   ============================================================================ */

import { isDesktopPointer } from './utils.js';

let zoomBackdropEl = null;
let zoomImgEl = null;
let zoomCloseEl = null;
let onZoomClose = null;

/** Wires the zoom modal's own controls (X button, click-outside, ESC is
 *  handled centrally by app.js alongside the other modals). Call once.
 *  `onClose`, if provided, fires every time the preview closes for any
 *  reason (X button, click-outside, hover-out, ESC) — used by app.js to
 *  implement the zero-click "return focus to search" workflow without
 *  this module needing to know anything about the search input. */
export function initZoom(elements, onClose) {
  zoomBackdropEl = elements.zoomBackdrop;
  zoomImgEl = elements.zoomImg;
  zoomCloseEl = elements.zoomClose;
  onZoomClose = onClose || null;

  zoomCloseEl.addEventListener('click', closeZoom);
  zoomBackdropEl.addEventListener('click', (e) => { if (e.target === zoomBackdropEl) closeZoom(); });
}

export function openZoom(src) {
  try {
    if (window.__smouhaIgnoreTapUntil && Date.now() < window.__smouhaIgnoreTapUntil) return;
  } catch (e) { /* ignore */ }

  if (!zoomImgEl) return;
  zoomImgEl.src = src;
  zoomBackdropEl.classList.add('open');
}

export function closeZoom(opts = {}) {
  if (!zoomBackdropEl) return;
  const wasOpen = zoomBackdropEl.classList.contains('open');
  zoomBackdropEl.classList.remove('open');
  const silent = opts.silent === true;
  if (wasOpen && onZoomClose && !silent) onZoomClose();
}

/** Wires the product image's click-to-zoom and (desktop only) hover-to-zoom
 *  behavior for one rendered product card. `wrap`/`img` are the specific
 *  DOM nodes for the currently-shown product (re-called on every render).
 *
 *  Desktop hover uses a compact floating preview (~260×320) always to the
 *  RIGHT of the cursor (never covers the full screen). Click still opens
 *  the full zoom modal. Preview closes when the cursor leaves the thumbnail.
 *
 *  Respects Performance Mode and the Hover Preview setting — both checked
 *  via the passed-in `settings` accessor so this module doesn't need to
 *  import settings.js directly (keeps the dependency graph one-directional). */
/* ---- Desktop hover preview (small float to the RIGHT of the cursor) ---- */
const HOVER_W = 260;
const HOVER_H = 320;
const HOVER_GAP = 14;
const HOVER_DELAY_MS = 100;

let hoverPreviewEl = null;
let hoverShowTimer = null;
let hoverMoveHandler = null;
let hoverThumbRect = null;
let hoverActiveWrap = null;

function ensureHoverPreviewEl() {
  if (hoverPreviewEl && hoverPreviewEl.isConnected) return hoverPreviewEl;
  const el = document.createElement('div');
  el.id = 'productHoverPreview';
  el.className = 'product-hover-preview';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<img alt="" draggable="false" />';
  document.body.appendChild(el);
  hoverPreviewEl = el;
  return el;
}

function positionHoverPreview(clientX, clientY) {
  const el = hoverPreviewEl;
  if (!el) return;
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  // Always to the RIGHT of the cursor (user requirement).
  let left = clientX + HOVER_GAP;
  // Keep fully on-screen if near the right edge (still rooted to the right of the pointer).
  if (left + HOVER_W > vw - 8) {
    left = Math.max(8, vw - HOVER_W - 8);
  }
  // Vertical: slightly above cursor center, clamped to viewport.
  let top = clientY - Math.round(HOVER_H * 0.35);
  if (top < 8) top = 8;
  if (top + HOVER_H > vh - 8) top = Math.max(8, vh - HOVER_H - 8);

  // Nudge vertically if overlapping the DMart live card (keep horizontal "right of mouse").
  try {
    const card = document.getElementById('dmartLiveCard');
    if (card && !card.hidden) {
      const cr = card.getBoundingClientRect();
      const overlaps =
        left < cr.right && left + HOVER_W > cr.left &&
        top < cr.bottom && top + HOVER_H > cr.top;
      if (overlaps) {
        // Prefer above the card; else below.
        if (cr.top - HOVER_H - 8 >= 8) {
          top = cr.top - HOVER_H - 8;
        } else if (cr.bottom + 8 + HOVER_H <= vh - 8) {
          top = cr.bottom + 8;
        }
      }
    }
  } catch (e) { /* ignore */ }

  el.style.left = left + 'px';
  el.style.top = top + 'px';
}

export function hideProductHoverPreview() {
  if (hoverShowTimer) {
    clearTimeout(hoverShowTimer);
    hoverShowTimer = null;
  }
  if (hoverMoveHandler) {
    document.removeEventListener('mousemove', hoverMoveHandler);
    hoverMoveHandler = null;
  }
  hoverThumbRect = null;
  hoverActiveWrap = null;
  if (hoverPreviewEl) {
    hoverPreviewEl.classList.remove('is-visible');
    hoverPreviewEl.setAttribute('aria-hidden', 'true');
    const im = hoverPreviewEl.querySelector('img');
    if (im) im.removeAttribute('src');
  }
}

function showProductHoverPreview(src, clientX, clientY) {
  const el = ensureHoverPreviewEl();
  const im = el.querySelector('img');
  if (im && im.getAttribute('src') !== src) im.src = src;
  positionHoverPreview(clientX, clientY);
  el.classList.add('is-visible');
  el.setAttribute('aria-hidden', 'false');
}

// Hide when user turns the setting off from Settings
try {
  window.addEventListener('smouha:hover-preview-off', () => {
    hideProductHoverPreview();
  });
} catch (e) { /* ignore */ }

export function wireProductImageInteractions(wrap, img, getSettings) {
  // Click → full-screen zoom modal (unchanged)
  wrap.addEventListener('click', () => {
    hideProductHoverPreview();
    openZoom(img.src);
  });

  if (!isDesktopPointer()) return;

  wrap.addEventListener('mouseenter', (ev) => {
    const settings = getSettings ? getSettings() : {};
    if (settings.performanceMode || settings.hoverPreview === false) {
      hideProductHoverPreview();
      return;
    }

    hoverActiveWrap = wrap;
    hoverThumbRect = wrap.getBoundingClientRect();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const src = img && img.src ? img.src : '';

    if (hoverShowTimer) clearTimeout(hoverShowTimer);
    hoverShowTimer = setTimeout(() => {
      hoverShowTimer = null;
      if (hoverActiveWrap !== wrap) return;
      const s = getSettings ? getSettings() : {};
      if (s.performanceMode || s.hoverPreview === false) return;
      if (!src) return;
      showProductHoverPreview(src, startX, startY);
    }, HOVER_DELAY_MS);

    if (hoverMoveHandler) document.removeEventListener('mousemove', hoverMoveHandler);
    hoverMoveHandler = (e) => {
      const s2 = getSettings ? getSettings() : {};
      if (s2.hoverPreview === false || s2.performanceMode) {
        hideProductHoverPreview();
        return;
      }
      const rect = hoverThumbRect || wrap.getBoundingClientRect();
      const outside =
        e.clientX < rect.left || e.clientX > rect.right ||
        e.clientY < rect.top || e.clientY > rect.bottom;
      if (outside) {
        hideProductHoverPreview();
        return;
      }
      // Follow cursor; always position to the right
      if (hoverPreviewEl && hoverPreviewEl.classList.contains('is-visible')) {
        positionHoverPreview(e.clientX, e.clientY);
      }
    };
    document.addEventListener('mousemove', hoverMoveHandler);
  });

  wrap.addEventListener('mouseleave', () => {
    if (hoverActiveWrap === wrap) hideProductHoverPreview();
  });
}

/** Warms the browser's image cache for up to `limit` products, so
 *  reopening a recently-scanned item feels instant. Purely additive —
 *  does not touch search, database, or rendering logic. */
/** In-flight + warmed URL set — avoids duplicate network work. */
const warmedUrls = new Set();
const inflight = new Map(); // url -> Promise

function connectionAwareLimit(requested) {
  try {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (c) {
      if (c.saveData) return Math.min(requested, 4);
      const t = String(c.effectiveType || '');
      if (t.includes('2g')) return Math.min(requested, 3);
      if (t === '3g') return Math.min(requested, 8);
    }
  } catch (e) {}
  return requested;
}

/**
 * Load one URL into the HTTP cache (deduped). Resolves when decoded or loaded.
 */
export function warmImageUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) return Promise.resolve(false);
  if (warmedUrls.has(url)) return Promise.resolve(true);
  if (inflight.has(url)) return inflight.get(url);

  const p = new Promise((resolve) => {
    try {
      const img = new Image();
      img.decoding = 'async';
      try { img.referrerPolicy = 'no-referrer'; } catch (e) {}
      img.onload = async () => {
        try {
          if (img.decode) await img.decode();
        } catch (e) { /* decode optional */ }
        warmedUrls.add(url);
        inflight.delete(url);
        resolve(true);
      };
      img.onerror = () => {
        inflight.delete(url);
        resolve(false);
      };
      img.src = url;
    } catch (e) {
      inflight.delete(url);
      resolve(false);
    }
  });
  inflight.set(url, p);
  return p;
}

/**
 * Warms the browser image cache with limited concurrency so mobile radios
 * are not flooded. Safe / additive — does not change search or UI logic.
 */
export function preloadImages(products, limit = 20) {
  const max = connectionAwareLimit(limit);
  const urls = [];
  const seen = new Set();
  for (const p of products || []) {
    if (!p || !p.image) continue;
    const u = String(p.image).trim();
    if (!/^https?:\/\//i.test(u) || seen.has(u) || warmedUrls.has(u)) continue;
    seen.add(u);
    urls.push(u);
    if (urls.length >= max) break;
  }
  const concurrency = connectionAwareLimit(4);
  let i = 0;
  function pump() {
    while (i < urls.length && inflight.size < concurrency) {
      const u = urls[i++];
      warmImageUrl(u).then(() => pump());
    }
  }
  pump();
}

/** True if URL was already successfully warmed this session. */
export function isImageWarmed(url) {
  return !!(url && warmedUrls.has(url));
}
