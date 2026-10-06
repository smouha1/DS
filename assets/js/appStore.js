/* appStore.js — localStorage persistence for recent / favorites / theme / last Available */
const KEYS = {
  RECENT: 'tm_recent_searches',
  FAVS: 'tm_favorites',
  THEME: 'tm_theme',
  LAST_AVAIL: 'tm_recent_last_available',
};
const MAX_RECENT = 15;

function safeGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch (e) {
    return fallback;
  }
}

function safeSet(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch (e) {
    /* storage full/unavailable */
  }
}

export function getRecent() {
  return safeGet(KEYS.RECENT, []);
}

export function addRecent(sku) {
  let list = getRecent().filter((s) => s !== sku);
  list.unshift(sku);
  if (list.length > MAX_RECENT) list = list.slice(0, MAX_RECENT);
  safeSet(KEYS.RECENT, list);
  return list;
}

export function clearRecent() {
  safeSet(KEYS.RECENT, []);
  // keep last-available history so re-adding SKU can still show old qty
}

/** Map sku -> number | { v, live, t }. Survives refresh. */
export function getLastAvailableMap() {
  const m = safeGet(KEYS.LAST_AVAIL, {});
  return m && typeof m === 'object' ? m : {};
}

function normalizeAvailMeta(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' || (typeof raw === 'string' && raw !== '')) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return { available: n, fromLive: false, t: 0 };
  }
  if (typeof raw === 'object') {
    const n = Number(raw.v != null ? raw.v : raw.available);
    if (!Number.isFinite(n)) return null;
    return { available: n, fromLive: !!(raw.live || raw.fromLive), t: Number(raw.t) || 0 };
  }
  return null;
}

export function getLastAvailable(sku) {
  const meta = getLastAvailableMeta(sku);
  return meta ? meta.available : null;
}

export function getLastAvailableMeta(sku) {
  const m = getLastAvailableMap();
  return normalizeAvailMeta(m[String(sku)]);
}

/** @param {{ fromLive?: boolean }} [opts] */
export function setLastAvailable(sku, onHand, opts) {
  if (sku == null || sku === '') return;
  if (onHand == null || !Number.isFinite(Number(onHand))) return;
  const fromLive = !!(opts && opts.fromLive);
  const m = getLastAvailableMap();
  m[String(sku)] = { v: Number(onHand), live: fromLive, t: Date.now() };
  const keys = Object.keys(m);
  if (keys.length > 80) {
    const recent = getRecent();
    const keep = new Set(recent.map(String));
    for (const k of keys) {
      if (!keep.has(k) && Object.keys(m).length > 60) delete m[k];
    }
  }
  safeSet(KEYS.LAST_AVAIL, m);
  try {
    window.dispatchEvent(
      new CustomEvent('smouha:last-available', {
        detail: { sku: String(sku), available: Number(onHand), fromLive },
      })
    );
  } catch (e) {}
}

export function getFavs() {
  return safeGet(KEYS.FAVS, []);
}

export function isFav(sku) {
  return getFavs().includes(sku);
}

export function toggleFav(sku) {
  let list = getFavs();
  if (list.includes(sku)) list = list.filter((s) => s !== sku);
  else list.unshift(sku);
  safeSet(KEYS.FAVS, list);
  return list;
}

export function clearFavs() {
  safeSet(KEYS.FAVS, []);
}

export function getTheme() {
  return safeGet(KEYS.THEME, null);
}

export function setTheme(t) {
  safeSet(KEYS.THEME, t);
}

export const store = {
  getRecent,
  addRecent,
  clearRecent,
  getLastAvailable,
  getLastAvailableMeta,
  getLastAvailableMap,
  setLastAvailable,
  getFavs,
  isFav,
  toggleFav,
  clearFavs,
  getTheme,
  setTheme,
};

export default store;
