/* appStore.js — localStorage persistence for recent / favorites / theme / last Available */
const KEYS = {
  RECENT: 'tm_recent_searches',
  FAVS: 'tm_favorites',
  THEME: 'tm_theme',
  LAST_AVAIL: 'tm_recent_last_available',
};
const MAX_RECENT = 20;

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

/** Map sku -> last known Available (number). Survives refresh. */
export function getLastAvailableMap() {
  const m = safeGet(KEYS.LAST_AVAIL, {});
  return m && typeof m === 'object' ? m : {};
}

export function getLastAvailable(sku) {
  const m = getLastAvailableMap();
  const v = m[String(sku)];
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function setLastAvailable(sku, onHand) {
  if (sku == null || sku === '') return;
  if (onHand == null || !Number.isFinite(Number(onHand))) return;
  const m = getLastAvailableMap();
  m[String(sku)] = Number(onHand);
  // cap map size loosely
  const keys = Object.keys(m);
  if (keys.length > 80) {
    const recent = getRecent();
    const keep = new Set(recent.map(String));
    for (const k of keys) {
      if (!keep.has(k) && keys.length > 60) delete m[k];
    }
  }
  safeSet(KEYS.LAST_AVAIL, m);
  try {
    window.dispatchEvent(
      new CustomEvent('smouha:last-available', {
        detail: { sku: String(sku), available: Number(onHand) },
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
