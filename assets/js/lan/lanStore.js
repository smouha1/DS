/**
 * lanStore.js — Master / mobile session persistence + LAN log + last error.
 */
const KEYS = {
  MASTER: 'smouha_lan_master_v1',
  MOBILE: 'smouha_lan_mobile_v1',
  LOG: 'smouha_lan_log_v1',
  LAST_ERR: 'smouha_lan_last_err_v1',
};

const DEFAULT_MASTER = {
  enabled: false,
  masterId: null,
  masterName: 'Master PC',
  maxDevices: 4,
  sessionHours: 0,
  pinSuffix: null,
  pinRotatedAt: null,
  devices: [],
  pending: [],
};

function safeGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function safeSet(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch (e) {}
}

export function loadMasterState() {
  const s = safeGet(KEYS.MASTER, null);
  if (!s || typeof s !== 'object') {
    return { ...DEFAULT_MASTER, masterId: genId('m') };
  }
  return {
    ...DEFAULT_MASTER,
    ...s,
    devices: Array.isArray(s.devices) ? s.devices : [],
    pending: Array.isArray(s.pending) ? s.pending : [],
    maxDevices: clampInt(s.maxDevices, 1, 15, 4),
    sessionHours: clampInt(s.sessionHours, 0, 24 * 14, 0),
  };
}

export function saveMasterState(state) {
  safeSet(KEYS.MASTER, state);
  try {
    window.dispatchEvent(new CustomEvent('smouha:lan-master-changed', { detail: state }));
  } catch (e) {}
}

export function loadMobileSession() {
  return safeGet(KEYS.MOBILE, null);
}

export function saveMobileSession(sess) {
  if (!sess) {
    try {
      localStorage.removeItem(KEYS.MOBILE);
    } catch (e) {}
    return;
  }
  safeSet(KEYS.MOBILE, sess);
}

export function appendLanLog(entry) {
  const list = safeGet(KEYS.LOG, []);
  const row = { t: Date.now(), ...entry };
  list.unshift(row);
  while (list.length > 500) list.pop();
  safeSet(KEYS.LOG, list);
  try {
    window.dispatchEvent(new CustomEvent('smouha:lan-log', { detail: row }));
  } catch (e) {}
  return row;
}

export function getLanLog(limit = 100) {
  return safeGet(KEYS.LOG, []).slice(0, limit);
}

export function clearLanLog() {
  safeSet(KEYS.LOG, []);
}

/** Shift summary from log (adds/removes by user). */
export function getShiftSummary(sinceMs) {
  const since = sinceMs || Date.now() - 12 * 3600 * 1000;
  const rows = getLanLog(500).filter((r) => r.t >= since);
  const byUser = {};
  let adds = 0;
  let removes = 0;
  let views = 0;
  rows.forEach((r) => {
    const u = r.username || '—';
    if (!byUser[u]) byUser[u] = { add: 0, remove: 0, view: 0, fail: 0 };
    if (r.action === 'add' || (r.type === 'adjust' && r.direction === 'increase' && r.action !== 'fail')) {
      byUser[u].add += r.quantity || 1;
      adds += r.quantity || 1;
    } else if (r.action === 'remove' || (r.type === 'adjust' && r.direction === 'decrease' && r.action !== 'fail')) {
      byUser[u].remove += r.quantity || 1;
      removes += r.quantity || 1;
    } else if (r.type === 'view' || r.action === 'view') {
      byUser[u].view += 1;
      views += 1;
    } else if (r.action === 'fail' || r.action === 'deny_offline') {
      byUser[u].fail += 1;
    }
  });
  return { since, adds, removes, views, byUser, totalEvents: rows.length };
}

export function setLastLanError(err) {
  const row = {
    at: Date.now(),
    message: String((err && (err.message || err.reason || err)) || 'error').slice(0, 200),
    code: (err && err.code) || null,
  };
  safeSet(KEYS.LAST_ERR, row);
  try {
    window.dispatchEvent(new CustomEvent('smouha:lan-last-error', { detail: row }));
  } catch (e) {}
  return row;
}

export function getLastLanError() {
  return safeGet(KEYS.LAST_ERR, null);
}

export function genId(prefix) {
  return (
    String(prefix || 'id') +
    '_' +
    Date.now().toString(36) +
    '_' +
    Math.random().toString(36).slice(2, 8)
  );
}

export function genPinSuffix() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

export function formatPin(suffix) {
  return 'Ds60' + String(suffix || '');
}

export function normalizePinInput(raw) {
  return String(raw || '').trim().replace(/\s+/g, '');
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function ensureMasterPin(state) {
  if (!state.pinSuffix) {
    state.pinSuffix = genPinSuffix();
    state.pinRotatedAt = Date.now();
  }
  return state;
}

export function rotateMasterPin(state) {
  state.pinSuffix = genPinSuffix();
  state.pinRotatedAt = Date.now();
  return state;
}

/**
 * Pair-code format v2:  2:<crc32 hex>:<z|r>:<base64url>
 *   z = gzip(JSON), r = raw JSON (no CompressionStream). The CRC lets the receiver
 *   reject a truncated / mangled QR or paste BEFORE touching WebRTC.
 */
function crc32(str) {
  const bytes = new TextEncoder().encode(str);
  let crc = ~0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (~crc >>> 0).toString(16).padStart(8, '0');
}

function bytesToB64Url(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64UrlToBytes(s) {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b + '='.repeat((4 - (b.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function pipeBytes(stream, bytes) {
  const writer = stream.writable.getWriter();
  // write/close reject too when the input is corrupt; the read below reports it
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

export async function packPayload(obj) {
  const json = JSON.stringify(obj);
  let bytes = new TextEncoder().encode(json);
  let mode = 'r';
  if (typeof CompressionStream !== 'undefined') {
    try {
      bytes = await pipeBytes(new CompressionStream('gzip'), bytes);
      mode = 'z';
    } catch (e) {}
  }
  return '2:' + crc32(json) + ':' + mode + ':' + bytesToB64Url(bytes);
}

/** @throws Error with a user-facing message when the code is cut off or damaged. */
export async function unpackPayload(packed) {
  const s = String(packed || '').replace(/\s+/g, '');
  const m = /^2:([0-9a-f]{8}):([zr]):([A-Za-z0-9_-]+)$/.exec(s);
  if (!m) throw new Error('Pair code is cut off or invalid — scan/copy it again in full');
  let bytes;
  try {
    bytes = b64UrlToBytes(m[3]);
    if (m[2] === 'z') {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('This browser cannot read the pair code — update Chrome');
      }
      bytes = await pipeBytes(new DecompressionStream('gzip'), bytes);
    }
  } catch (e) {
    if (/update Chrome/.test(e.message)) throw e;
    throw new Error('Pair code is damaged — scan/copy it again in full');
  }
  const json = new TextDecoder().decode(bytes);
  if (crc32(json) !== m[1]) throw new Error('Pair code is damaged (checksum) — scan/copy it again in full');
  return JSON.parse(json);
}

/** Legacy "0:" / "1:" / plain-base64 packing (read-only; kept for the transition). */
export async function unpackSignal(packed) {
  const s = String(packed || '');
  if (s.startsWith('1:')) {
    try {
      const b64 = s.slice(2);
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      if (typeof DecompressionStream === 'undefined') return null;
      const ds = new DecompressionStream('gzip');
      const writer = ds.writable.getWriter();
      writer.write(bytes);
      writer.close();
      const text = await new Response(ds.readable).text();
      return text;
    } catch (e) {
      return null;
    }
  }
  if (s.startsWith('0:')) return s.slice(2);
  return s; // legacy plain
}
