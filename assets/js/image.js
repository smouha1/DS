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
 *  Hover preview auto-closes the instant the cursor leaves the thumbnail's
 *  original area — tracked via document-level mousemove against a captured
 *  rect, NOT the thumbnail's own mouseleave: once the fullscreen overlay
 *  opens on top of it, plain mouseleave would fire immediately (the overlay
 *  "steals" hover), closing the preview the moment it opens.
 *
 *  Respects Performance Mode and the Hover Preview setting — both checked
 *  via the passed-in `settings` accessor so this module doesn't need to
 *  import settings.js directly (keeps the dependency graph one-directional). */
export function wireProductImageInteractions(wrap, img, getSettings) {
  wrap.addEventListener('click', () => openZoom(img.src));

  if (!isDesktopPointer()) return;

  let hoverCloseHandler = null;
  wrap.addEventListener('mouseenter', () => {
    // Re-read settings every time so toggles apply without re-render
    const settings = getSettings ? getSettings() : {};
    if (settings.performanceMode || settings.hoverPreview === false) {
      closeZoom({ silent: true });
      return;
    }
    openZoom(img.src);
    const rect = wrap.getBoundingClientRect();
    if (hoverCloseHandler) document.removeEventListener('mousemove', hoverCloseHandler);
    hoverCloseHandler = (e) => {
      const s2 = getSettings ? getSettings() : {};
      if (s2.hoverPreview === false || s2.performanceMode) {
        closeZoom({ silent: true });
        document.removeEventListener('mousemove', hoverCloseHandler);
        hoverCloseHandler = null;
        return;
      }
      const stillOpen = zoomBackdropEl && zoomBackdropEl.classList.contains('open');
      const outside = e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom;
      if (!stillOpen || outside) {
        if (outside && stillOpen) closeZoom({ silent: true });
        document.removeEventListener('mousemove', hoverCloseHandler);
        hoverCloseHandler = null;
      }
    };
    document.addEventListener('mousemove', hoverCloseHandler);
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
