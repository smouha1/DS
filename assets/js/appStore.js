/* appStore.js — localStorage persistence for recent / favorites / theme */
const KEYS = { RECENT: 'tm_recent_searches', FAVS: 'tm_favorites', THEME: 'tm_theme' };
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

/** Namespace object matching the legacy `store` IIFE API */
export const store = {
  getRecent,
  addRecent,
  clearRecent,
  getFavs,
  isFav,
  toggleFav,
  clearFavs,
  getTheme,
  setTheme,
};

export default store;
