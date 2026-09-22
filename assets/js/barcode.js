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


/**
 * Talabat darkstores image URL from primary barcode (first token).
 * Spec: GTIN-14 starting with "0" → strip only the first zero for the path.
 * Does NOT mutate the stored barcode field.
 */
export function imageUrlFromBarcodes(barcodesOrRaw) {
  let list;
  if (Array.isArray(barcodesOrRaw)) {
    list = barcodesOrRaw.map((s) => String(s || '').trim()).filter(Boolean);
  } else {
    list = parse(barcodesOrRaw);
  }
  if (!list.length) return '';
  let primary = String(list[0]).trim();
  if (!primary) return '';
  if (primary.length === 14 && primary.charAt(0) === '0' && /^\d{14}$/.test(primary)) {
    primary = primary.slice(1);
  }
  return 'https://talabat.dhmedia.io/image/darkstores-eg/EGY_' + primary + '.JPG';
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
  if (!value || !svgEl) return false;
  const raw = String(value).trim();
  if (!raw) return false;

  // Prefer real JsBarcode when available
  const draw = () => {
    const large = typeof document !== 'undefined'
      && document.documentElement.classList.contains('large-barcode');
    const cacheKey = (large ? 'L:' : 'N:') + raw;
    const barW = large ? 2.5 : 1.8;
    const barH = large ? 110 : 64;
    const margin = large ? 6 : 4;

    // Always reset node so stale QR/noise markup cannot stick
    try {
      while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
      svgEl.removeAttribute('viewBox');
      svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      svgEl.setAttribute('role', 'img');
      svgEl.setAttribute('aria-label', 'Barcode ' + raw);
      svgEl.style.display = 'block';
      svgEl.style.width = '100%';
      svgEl.style.height = 'auto';
      svgEl.style.maxWidth = '100%';
      svgEl.style.background = '#ffffff';
    } catch (e) {}

    const cached = barcodeSvgCache.get(cacheKey);
    if (cached && cached.innerHTML && cached.viewBox) {
      svgEl.setAttribute('viewBox', cached.viewBox);
      if (cached.width) svgEl.setAttribute('width', cached.width);
      if (cached.height) svgEl.setAttribute('height', cached.height);
      svgEl.innerHTML = cached.innerHTML;
      return true;
    }

    if (typeof window !== 'undefined' && window.JsBarcode) {
      try {
        window.JsBarcode(svgEl, raw, {
          format: 'CODE128',
          lineColor: '#000000',
          width: barW,
          height: barH,
          displayValue: false,
          margin: margin,
          background: '#ffffff',
          xmlDocument: document,
        });
        // Guard against empty/noise render
        if (!svgEl.innerHTML || svgEl.innerHTML.length < 20) {
          throw new Error('empty-svg');
        }
        barcodeSvgCache.set(cacheKey, {
          viewBox: svgEl.getAttribute('viewBox') || '',
          width: svgEl.getAttribute('width') || '',
          height: svgEl.getAttribute('height') || '',
          innerHTML: svgEl.innerHTML,
        });
        return true;
      } catch (e1) {
        // Canvas fallback (some WebViews mishandle SVG targets)
        try {
          const canvas = document.createElement('canvas');
          window.JsBarcode(canvas, raw, {
            format: 'CODE128',
            lineColor: '#000000',
            width: barW,
            height: barH,
            displayValue: false,
            margin: margin,
            background: '#ffffff',
          });
          const dataUrl = canvas.toDataURL('image/png');
          const w = canvas.width || 200;
          const h = canvas.height || barH;
          svgEl.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
          svgEl.setAttribute('width', String(w));
          svgEl.setAttribute('height', String(h));
          svgEl.innerHTML =
            '<image href="' + dataUrl + '" xlink:href="' + dataUrl +
            '" x="0" y="0" width="' + w + '" height="' + h +
            '" preserveAspectRatio="xMidYMid meet"/>';
          barcodeSvgCache.set(cacheKey, {
            viewBox: svgEl.getAttribute('viewBox'),
            width: String(w),
            height: String(h),
            innerHTML: svgEl.innerHTML,
          });
          return true;
        } catch (e2) {
          return false;
        }
      }
    }
    return false;
  };

  return draw();
}

/** Wait briefly for JsBarcode global (defer race on slow devices). */
export function renderCode128WhenReady(svgEl, value, timeoutMs) {
  if (typeof window !== 'undefined' && window.JsBarcode) {
    return Promise.resolve(renderCode128(svgEl, value));
  }
  const ms = timeoutMs == null ? 2500 : timeoutMs;
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (window.JsBarcode) {
        resolve(renderCode128(svgEl, value));
        return;
      }
      if (Date.now() - t0 > ms) {
        resolve(false);
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
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
