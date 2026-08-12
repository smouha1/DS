/* ============================================================================
   barcode.js — MODULE: barcodeParser + Code128/QR generation
   ------------------------------------------------------------------------
   Isolated, format-agnostic barcode parsing and rendering. Never duplicate
   barcode-splitting or JsBarcode-calling logic anywhere else in the app —
   always go through this module.
   ============================================================================ */

const DELIMS = /[,;|/+\s]+/;

/** Splits a raw barcode field into a clean array of individual barcodes. */
export function parse(raw) {
  if (!raw) return [];
  return String(raw)
    .split(DELIMS)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => isValid(s));
}

/** Basic validity check: alphanumeric, reasonable length for retail barcodes. */
export function isValid(code) {
  if (!/^[0-9A-Za-z]+$/.test(code)) return false;
  if (code.length < 4 || code.length > 32) return false;
  return true;
}

/** Returns true if `code` matches the end (last N digits) of `full`. */
export function matchesSuffix(full, code, n = 6) {
  if (full.length < n) return full === code;
  return full.slice(-n) === code;
}

// Generated-SVG cache, keyed by barcode value — avoids re-running JsBarcode's
// encode+draw for a barcode we've already rendered this session (common when
// re-searching the same SKU repeatedly during a shift).
const barcodeSvgCache = new Map();

/** Renders a Code128 barcode into `svgEl` for the given value, using the
 *  cache when possible. Returns true on success, false if it could not be
 *  rendered (invalid barcode / library missing) — the caller decides what
 *  fallback UI to show. */
export function renderCode128(svgEl, value) {
  if (!value || !svgEl || !window.JsBarcode) return false;
  try {
    const large = typeof document !== 'undefined'
      && document.documentElement.classList.contains('large-barcode');
    const cacheKey = (large ? 'L:' : 'N:') + value;
    const cached = barcodeSvgCache.get(cacheKey);
    if (cached) {
      svgEl.setAttribute('viewBox', cached.viewBox);
      svgEl.setAttribute('width', cached.width);
      svgEl.setAttribute('height', cached.height);
      svgEl.innerHTML = cached.innerHTML;
    } else {
      window.JsBarcode(svgEl, value, {
        format: 'CODE128',
        width: large ? 3 : 2,
        height: large ? 120 : 70,
        displayValue: false,
        margin: large ? 8 : 6,
        background: '#ffffff'
      });
      barcodeSvgCache.set(cacheKey, {
        viewBox: svgEl.getAttribute('viewBox'),
        width: svgEl.getAttribute('width'),
        height: svgEl.getAttribute('height'),
        innerHTML: svgEl.innerHTML
      });
    }
    return true;
  } catch (e) {
    return false;
  }
}

/** Rasterizes an inline barcode/QR SVG to a PNG data URL, for zoom preview
 *  and PNG download. */
export function svgToDataUrl(svgEl) {
  const xml = new XMLSerializer().serializeToString(svgEl);
  const svg64 = btoa(unescape(encodeURIComponent(xml)));
  return 'data:image/svg+xml;base64,' + svg64;
}

// ---------------------------------------------------------------------------
// QR Code (Phase 12)
// Local lib: assets/js/qrcode-generator.js  →  window.qrcode
// Vector SVG via createSvgTag (single path). Injected with a safe DOM write.
// ---------------------------------------------------------------------------

const qrSvgCache = new Map(); // value -> { markup, viewBox }

function buildQrMarkup(value) {
  const cached = qrSvgCache.get(value);
  if (cached) return cached;

  const gen = window.qrcode;
  if (typeof gen !== 'function') return null;

  const qr = gen(0, 'M');
  qr.addData(String(value));
  qr.make();

  // cellSize 5 balances sharpness vs path length
  const raw = qr.createSvgTag(5, 2);
  if (!raw || typeof raw !== 'string') return null;

  // Parse once, normalize attributes for reliable mobile scaling
  const doc = new DOMParser().parseFromString(raw, 'image/svg+xml');
  const src = doc.documentElement;
  if (!src || src.tagName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) {
    return null;
  }

  const viewBox = src.getAttribute('viewBox') || '0 0 100 100';
  src.setAttribute('id', 'c128-0');
  src.setAttribute('role', 'img');
  src.setAttribute('aria-label', 'QR code');
  src.removeAttribute('width');
  src.removeAttribute('height');
  src.setAttribute('width', '100%');
  src.setAttribute('height', '100%');
  src.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  src.setAttribute('viewBox', viewBox);
  // Ensure modules are solid black on white
  const path = src.querySelector('path');
  if (path) {
    path.setAttribute('fill', '#000000');
    path.setAttribute('fill-rule', 'nonzero');
  }
  const bg = src.querySelector('rect');
  if (bg) bg.setAttribute('fill', '#ffffff');

  const markup = new XMLSerializer().serializeToString(src);
  const entry = { markup, viewBox };
  qrSvgCache.set(value, entry);
  return entry;
}

/**
 * Renders a QR for `value` into the barcode slot that currently holds `svgEl`.
 * Returns Promise<boolean>.
 */
export function renderSkuQr(svgEl, value) {
  if (!value || !svgEl) return Promise.resolve(false);
  if (typeof window.qrcode !== 'function') return Promise.resolve(false);

  try {
    const built = buildQrMarkup(value);
    if (!built) return Promise.resolve(false);
    if (!svgEl.isConnected) return Promise.resolve(true);

    const wrap = svgEl.parentElement;
    if (!wrap) return Promise.resolve(false);

    wrap.classList.add('is-qr');
    wrap.innerHTML = built.markup;
    return Promise.resolve(!!wrap.querySelector('#c128-0'));
  } catch (e) {
    return Promise.resolve(false);
  }
}
