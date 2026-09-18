/* ============================================================================
   utils.js — shared, dependency-free helpers.
   No other module in this app should duplicate any of these.
   ============================================================================ */

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function escapeAttr(str) {
  return escapeHtml(str);
}

export function placeholderImg() {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#e9ebee"/><text x="50%" y="50%" font-family="sans-serif" font-size="14" fill="#9aa0aa" text-anchor="middle" dy=".3em">No Image</text></svg>`
  );
}

/** Small, fast, non-cryptographic hash — used only to detect whether a
 *  fetched file's content changed since the last check, never for security. */
export function quickHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h.toString(36) + ':' + str.length;
}

/** Formats a byte count into a human-readable string (KB/MB), used by the
 *  Maintenance Panel's Developer section for IndexedDB size, etc. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

/** Standard debounce — used for the heavier product-card render, never for
 *  the suggestions dropdown (which must update on every keystroke). */
export function debounce(fn, delay) {
  let timer = null;
  return function debounced(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

/** True on devices with a real hover-capable pointer (desktop mouse/trackpad).
 *  Used to gate desktop-only features (hover preview, hover states) so
 *  touch devices never receive dead hover-only interactions. */
export function isDesktopPointer() {
  return window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}


/** Lightweight leveled logger — one place for site diagnostics. */
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
let logLevel = 2;
export function setLogLevel(level) {
  if (level in LOG_LEVELS) logLevel = LOG_LEVELS[level];
  else if (typeof level === 'number') logLevel = level;
}
const logRing = [];
const LOG_RING_MAX = 20;
export function getRecentLogs() {
  return logRing.slice();
}
export function log(level, scope, message, detail) {
  try {
    logRing.push({
      t: Date.now(),
      level: level || 'info',
      scope: scope || '',
      message: String(message || ''),
      detail: detail != null ? String(detail).slice(0, 180) : ''
    });
    while (logRing.length > LOG_RING_MAX) logRing.shift();
  } catch (e) {}

  const lv = LOG_LEVELS[level] != null ? LOG_LEVELS[level] : 2;
  if (lv > logLevel) return;
  const prefix = '[smouha' + (scope ? ':' + scope : '') + ']';
  const args = detail !== undefined ? [prefix, message, detail] : [prefix, message];
  if (level === 'error') console.error.apply(console, args);
  else if (level === 'warn') console.warn.apply(console, args);
  else console.info.apply(console, args);
}
