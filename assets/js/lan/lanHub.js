/**
 * lanHub.js — client for local PC Hub (HTTP + SSE). No WebRTC.
 */
import { normalizeHubError, friendlyHubMessage } from './hubErrors.js';

/** Bump when Hub client protocol changes (shown on Master device list). */
export const SMOUHA_HUB_CLIENT_REV = 'hub11-stable';
try {
  if (typeof window !== 'undefined') window.SMOUHA_HUB_CLIENT_REV = SMOUHA_HUB_CLIENT_REV;
} catch (e) {}

const LS_URL = 'smouha_lan_hub_url_v1';
const LS_USER = 'smouha_lan_hub_user_v1';
const LS_DEVICE = 'smouha_hub_device_id';

let hubUrl = '';
let masterEs = null;
let masterHandlers = null;
let masterToken = '';
let masterSuperseded = false;
let healthTimer = null;
let lastHealth = { ok: false, at: 0, masterOnline: false };
let lastHubStartedAt = null;

function normalizeUrl(u) {
  let s = String(u || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  return s;
}

export function getHubUrl() {
  if (hubUrl) return hubUrl;
  try {
    hubUrl = normalizeUrl(localStorage.getItem(LS_URL) || '');
  } catch (e) {
    hubUrl = '';
  }
  return hubUrl;
}

export function setHubUrl(u) {
  hubUrl = normalizeUrl(u);
  try {
    if (hubUrl) localStorage.setItem(LS_URL, hubUrl);
    else localStorage.removeItem(LS_URL);
  } catch (e) {}
  try {
    window.dispatchEvent(new CustomEvent('smouha:hub-url-changed', { detail: { url: hubUrl } }));
  } catch (e) {}
  return hubUrl;
}

export function getHubIdentity() {
  let username = 'phone';
  let role = 'operator';
  let deviceId = '';
  try {
    const raw = localStorage.getItem(LS_USER);
    if (raw) {
      const j = JSON.parse(raw);
      if (j.username) username = String(j.username).slice(0, 32);
      if (j.role === 'viewer' || j.role === 'supervisor') role = j.role;
    }
  } catch (e) {}
  try {
    deviceId = localStorage.getItem(LS_DEVICE) || '';
    if (!deviceId) {
      deviceId = 'h_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      localStorage.setItem(LS_DEVICE, deviceId);
    }
  } catch (e) {
    deviceId = 'h_anon';
  }
  return { username, role, deviceId };
}

export function setHubIdentity({ username, role }) {
  const u = String(username || '').trim().slice(0, 32) || 'phone';
  const r = role === 'viewer' ? 'viewer' : role === 'supervisor' ? 'supervisor' : 'operator';
  try {
    localStorage.setItem(LS_USER, JSON.stringify({ username: u, role: r }));
  } catch (e) {}
  return getHubIdentity();
}

export async function probeHub(url = getHubUrl()) {
  const base = normalizeUrl(url);
  if (!base) {
    lastHealth = { ok: false, at: Date.now(), masterOnline: false, error: 'no-url' };
    return lastHealth;
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(base + '/health', { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (j.startedAt && lastHubStartedAt && j.startedAt !== lastHubStartedAt) {
      try {
        window.dispatchEvent(
          new CustomEvent('smouha:hub-restarted', { detail: { startedAt: j.startedAt } })
        );
        hubDeviceHello().catch(() => {});
      } catch (e) {}
    }
    if (j.startedAt) lastHubStartedAt = j.startedAt;
    lastHealth = {
      ok: !!j.ok,
      at: Date.now(),
      masterOnline: !!j.masterOnline,
      startedAt: j.startedAt || null,
      lastError: j.lastError || null,
      masterName: j.masterName,
      ips: j.ips,
      devices: j.devices,
      approved: j.approved,
      maxDevices: j.maxDevices,
      error: null,
    };
    return lastHealth;
  } catch (e) {
    lastHealth = {
      ok: false,
      at: Date.now(),
      masterOnline: false,
      error: String(e.message || e),
    };
    return lastHealth;
  }
}

export function isHubReachable() {
  return !!(lastHealth.ok && Date.now() - lastHealth.at < 25000);
}

export function isHubMasterOnline() {
  return !!(isHubReachable() && lastHealth.masterOnline);
}

export function getLastHubHealth() {
  return lastHealth;
}

export async function hubDeviceHello() {
  const base = getHubUrl();
  if (!base) return { ok: false, reason: 'no-hub', message: 'Hub URL not set' };
  const id = getHubIdentity();
  try {
    const r = await fetch(base + '/api/device/hello', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...id, clientRev: SMOUHA_HUB_CLIENT_REV }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const norm = normalizeHubError(j, r);
      try {
        localStorage.setItem(
          'smouha_hub_blocked',
          JSON.stringify({ code: norm.code, message: norm.message, at: Date.now() })
        );
      } catch (e) {}
      return { ...norm, ok: false };
    }
    try {
      localStorage.removeItem('smouha_hub_blocked');
      if (j && j.pending) localStorage.setItem('smouha_hub_pending', '1');
      else localStorage.removeItem('smouha_hub_pending');
      if (j && j.approved && j.role && j.role !== 'viewer') {
        const cur = getHubIdentity();
        localStorage.setItem(
          'smouha_lan_hub_user_v1',
          JSON.stringify({ username: cur.username || j.username || 'phone', role: j.role })
        );
      }
    } catch (e) {}
    return j;
  } catch (e) {
    return { ok: false, reason: 'hub-error', message: String(e.message || e) };
  }
}

export function getHubBlocked() {
  try {
    const raw = localStorage.getItem('smouha_hub_blocked');
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}


/** Late image polls — extension lookup often 2–6s; cover up to ~19s under client abort. */
const HUB_IMAGE_POLL_DELAYS = [1000, 2000, 3000, 5000, 8000];

async function pollHubImage(base, sku, delays) {
  const waits = delays || HUB_IMAGE_POLL_DELAYS;
  for (const ms of waits) {
    await new Promise((r) => setTimeout(r, ms));
    try {
      const ir = await fetch(base + '/api/image?sku=' + encodeURIComponent(String(sku)), {
        cache: 'no-store',
      });
      if (!ir.ok) continue;
      const ij = await ir.json().catch(() => ({}));
      if (ij && ij.image) {
        try {
          window.dispatchEvent(
            new CustomEvent('smouha:hub-product-image', {
              detail: { sku: String(sku), image: String(ij.image), product: ij.product || null },
            })
          );
        } catch (e) {}
        return ij;
      }
    } catch (e) {}
  }
  return null;
}

export async function hubRequestStock(sku, warehouseId) {
  const base = getHubUrl();
  if (!base) return { ok: false, reason: 'no-hub', message: 'Hub URL not set', via: 'hub' };
  const id = getHubIdentity();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 22000);
    const r = await fetch(base + '/api/stock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sku: String(sku || '').trim(),
        warehouseId: warehouseId || null,
        deviceId: id.deviceId,
        username: id.username,
        role: id.role,
        clientRev: SMOUHA_HUB_CLIENT_REV,
      }),
      signal: ctrl.signal,
      cache: 'no-store',
    });
    clearTimeout(t);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      return normalizeHubError(j, r);
    }
    const img = j.image || (j.product && j.product.image) || null;
    if (img) {
      try {
        window.dispatchEvent(
          new CustomEvent('smouha:hub-product-image', {
            detail: { sku: String(sku), image: String(img), product: j.product || null },
          })
        );
      } catch (e) {}
    } else if (j.ok) {
      // Retry poll: late Master image lands in Hub cache (phones have no SSE)
      pollHubImage(base, sku, HUB_IMAGE_POLL_DELAYS).catch(() => {});
    }
    return {
      ok: !!j.ok,
      onHand: j.onHand ?? null,
      reserved: j.reserved ?? null,
      price: j.price ?? null,
      reason: typeof j.reason === 'string' ? j.reason : null,
      message: j.message || null,
      image: img,
      product: j.product || null,
      via: 'hub',
    };
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || e)));
    return {
      ok: false,
      reason: aborted ? 'TIMEOUT' : 'hub-error',
      message: aborted ? friendlyHubMessage('TIMEOUT') : String(e.message || e),
      via: 'hub',
    };
  }
}

async function doAdjustFetch(base, payload) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(base + '/api/adjust', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const j = await r.json().catch(() => ({}));
    if (j && j.success === true) return j;
    if (j && j.ok === true && j.success !== false) {
      return { success: true, data: j.data || j };
    }
    // Empty / malformed body after HTTP ok
    if (r.ok && (!j || (j.success !== true && j.ok !== true && !j.error))) {
      return {
        success: false,
        error: {
          code: 'HUB_MALFORMED',
          message: friendlyHubMessage('HUB_MALFORMED', 'Hub answered unexpectedly'),
        },
      };
    }
    if (!r.ok) {
      return normalizeHubError(j, r);
    }
    const errRaw = j.error;
    const code =
      typeof errRaw === 'string'
        ? errRaw
        : (errRaw && errRaw.code) || 'ADJUST_FAILED';
    const message =
      (typeof errRaw === 'object' && errRaw && errRaw.message) ||
      j.message ||
      (typeof errRaw === 'string' ? errRaw : friendlyHubMessage('ADJUST_FAILED', 'Adjust failed'));
    return { success: false, error: { code: String(code), message: String(message) } };
  } catch (e) {
    clearTimeout(t);
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || e)));
    return {
      success: false,
      error: {
        code: aborted ? 'TIMEOUT' : 'HUB',
        message: aborted ? friendlyHubMessage('TIMEOUT') : String(e.message || e),
      },
    };
  }
}

export async function hubRequestAdjust({ sku, quantity, direction, warehouseId }) {
  const base = getHubUrl();
  if (!base) {
    return { success: false, error: { code: 'NO_HUB', message: friendlyHubMessage('NO_HUB') } };
  }

  // Re-hello if health is stale or device was blocked (Hub restart / kick recovery)
  const healthAge = Date.now() - (lastHealth.at || 0);
  let blocked = null;
  try {
    blocked = JSON.parse(localStorage.getItem('smouha_hub_blocked') || 'null');
  } catch (e) {}
  if (blocked || healthAge > 30000 || !lastHealth.ok) {
    const hello = await hubDeviceHello();
    if (hello && hello.ok === false && (hello.code || hello.reason)) {
      const code = hello.code || hello.reason || 'NOT_APPROVED';
      return {
        success: false,
        error: {
          code: String(code),
          message: hello.message || friendlyHubMessage(code, code),
        },
      };
    }
    if (hello && hello.pending && !hello.approved) {
      return {
        success: false,
        error: {
          code: 'NOT_APPROVED',
          message: friendlyHubMessage('NOT_APPROVED'),
        },
      };
    }
  }

  const id = getHubIdentity();
  const payload = {
    sku,
    quantity,
    direction,
    warehouseId: warehouseId || null,
    deviceId: id.deviceId,
    username: id.username,
    role: id.role,
  };

  let result = await doAdjustFetch(base, payload);

  // One retry after re-hello when Master/Hub was temporarily offline
  const code = result && result.error && result.error.code;
  if (
    result &&
    !result.success &&
    (code === 'MASTER_OFFLINE' || code === 'HUB' || code === 'HTTP_503' || code === 'NOT_APPROVED')
  ) {
    await hubDeviceHello();
    result = await doAdjustFetch(base, { ...payload, ...getHubIdentity() });
  }
  return result;
}

export async function hubRequestLookup(sku, warehouseId, timeoutMs) {
  const base = getHubUrl();
  if (!base) return { ok: false, reason: 'no-hub' };
  const id = getHubIdentity();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), Number(timeoutMs) || 18000);
    const r = await fetch(base + '/api/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sku: String(sku || '').trim(),
        warehouseId: warehouseId || null,
        deviceId: id.deviceId,
        username: id.username,
        role: id.role,
      }),
      signal: ctrl.signal,
      cache: 'no-store',
    });
    clearTimeout(t);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return normalizeHubError(j, r);
    if (j && (j.ok || j.product || j.image)) {
      return {
        ok: true,
        product: j.product || { sku: String(sku), image: j.image || '', name: (j.product && j.product.name) || '' },
        image: j.image || (j.product && j.product.image) || null,
      };
    }
    return normalizeHubError(j || { error: { code: 'lookup-failed', message: 'Lookup failed' } }, r);
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || e)));
    return {
      ok: false,
      reason: aborted ? 'TIMEOUT' : 'hub-error',
      message: aborted ? friendlyHubMessage('TIMEOUT') : String(e.message || e),
    };
  }
}

export async function hubPushRecent({ sku, name }) {
  const base = getHubUrl();
  if (!base) return { ok: false };
  const id = getHubIdentity();
  try {
    const r = await fetch(base + '/api/recent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sku,
        name: name || null,
        deviceId: id.deviceId,
        username: id.username,
      }),
    });
    return await r.json();
  } catch (e) {
    return { ok: false };
  }
}

export async function hubApprove(deviceId) {
  return hubPost('/api/approve', { deviceId });
}
export async function hubSetMax(maxDevices) {
  return hubPost('/api/config', { maxDevices });
}
export async function hubShiftLock() {
  return hubPost('/api/shift-lock', {});
}
export async function hubShiftUnlock() {
  return hubPost('/api/shift-unlock', {});
}
async function hubPost(path, body) {
  const base = getHubUrl();
  if (!base) return { ok: false, error: 'no-hub' };
  try {
    const r = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}
export async function hubKick(deviceId) {

  const base = getHubUrl();
  if (!base) return { ok: false, error: 'no-hub' };
  try {
    return hubPost('/api/kick', { deviceId });
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export async function hubFetchLog(n = 80) {
  const base = getHubUrl();
  if (!base) return [];
  try {
    const r = await fetch(base + '/api/log?n=' + n, { cache: 'no-store' });
    const j = await r.json();
    return (j && (j.log || j.rows)) || [];
  } catch (e) {
    return [];
  }
}

function masterBaseUrl() {
  const base = getHubUrl();
  if (!base) return '';
  // Same PC: prefer loopback so HTTPS page can still reach local Hub more reliably
  try {
    const u = new URL(base);
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
      return 'http://127.0.0.1:' + (u.port || '8787');
    }
  } catch (e) {}
  return base;
}

export function startMasterHub(handlers) {
  masterHandlers = handlers || null;
  masterToken = '';
  masterSuperseded = false;
  stopMasterHub();
  const publicBase = getHubUrl();
  if (!publicBase) return false;
  const base = masterBaseUrl() || publicBase;

  fetch(base + '/api/master/hello', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: (handlers && handlers.getMasterName && handlers.getMasterName()) || 'Master',
      warehouseId: handlers && handlers.getWarehouseId ? handlers.getWarehouseId() : null,
    }),
  }).catch(() => {});

  try {
    masterEs = new EventSource(base + '/api/events?role=master');
  } catch (e) {
    console.warn('[lanHub] EventSource failed', e);
    return false;
  }

  masterEs.addEventListener('stock_req', async (ev) => {
    if (masterSuperseded) return;
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    let reply = {
      reqId: data.reqId,
      ok: false,
      onHand: null,
      reserved: null,
      price: null,
      reason: 'no-handler',
      sku: data.sku,
    };
    const wid =
      data.warehouseId ||
      (masterHandlers && masterHandlers.getWarehouseId && masterHandlers.getWarehouseId());
    // Parallel: stock first wins the reply; image may follow via /api/image
    let lookupPromise = null;
    if (masterHandlers && masterHandlers.lookupProduct) {
      lookupPromise = masterHandlers.lookupProduct(data.sku, wid, 8000).catch(() => null);
    }
    try {
      if (masterHandlers && masterHandlers.fetchLive) {
        const live = await masterHandlers.fetchLive(data.sku, wid, {
          force: true,
          skipHub: true,
        });
        reply = {
          reqId: data.reqId,
          ok: !!(live && live.ok),
          onHand: live && live.onHand != null ? live.onHand : null,
          reserved: live && live.reserved != null ? live.reserved : null,
          price: live && live.price != null ? live.price : null,
          reason: live && live.reason ? live.reason : null,
          sku: data.sku,
        };
      }
    } catch (e) {
      reply.reason = String(e.message || e);
    }
    // If lookup already done, attach image before reply
    if (lookupPromise) {
      try {
        // Wait a bit longer so cached/local product images ride with stock reply
        const raced = await Promise.race([
          lookupPromise.then((v) => ({ done: true, v })),
          new Promise((r) => setTimeout(() => r({ done: false }), 400)),
        ]);
        if (raced.done && raced.v && raced.v.ok && raced.v.product && raced.v.product.image) {
          reply.image = String(raced.v.product.image).trim();
          reply.product = raced.v.product;
        }
      } catch (e) {}
    }
    const headers = { 'Content-Type': 'application/json' };
    if (masterToken) headers['X-Master-Token'] = masterToken;
    try {
      await fetch(base + '/api/reply', {
        method: 'POST',
        headers,
        body: JSON.stringify(reply),
      });
    } catch (e) {}
    // Late image push (does not block stock)
    if (lookupPromise && !reply.image) {
      lookupPromise.then(async (look) => {
        if (!look || !look.ok || !look.product || !look.product.image) return;
        const img = String(look.product.image).trim();
        const h = { 'Content-Type': 'application/json' };
        if (masterToken) h['X-Master-Token'] = masterToken;
        try {
          await fetch(base + '/api/image', {
            method: 'POST',
            headers: h,
            body: JSON.stringify({ sku: data.sku, image: img, product: look.product }),
          });
        } catch (e) {}
        try {
          window.dispatchEvent(
            new CustomEvent('smouha:hub-product-image', {
              detail: { sku: String(data.sku), image: img, product: look.product },
            })
          );
        } catch (e) {}
      }).catch(() => {});
    }
  });


  masterEs.addEventListener('lookup_req', async (ev) => {
    if (masterSuperseded) return;
    let data;
    try { data = JSON.parse(ev.data); } catch (e) { return; }
    let reply = { reqId: data.reqId, ok: false, product: null, reason: 'no-handler', sku: data.sku };
    try {
      if (masterHandlers && masterHandlers.lookupProduct) {
        const wid = data.warehouseId || (masterHandlers.getWarehouseId && masterHandlers.getWarehouseId());
        const look = await masterHandlers.lookupProduct(data.sku, wid, 14000);
        if (look && look.ok && look.product) {
          reply = {
            reqId: data.reqId,
            ok: true,
            product: look.product,
            image: look.product.image || look.image || null,
            sku: data.sku,
          };
        } else {
          reply.reason = (look && look.reason) || 'not-found';
        }
      }
    } catch (e) {
      reply.reason = String(e.message || e);
    }
    try {
      const h = { 'Content-Type': 'application/json' };
      if (masterToken) h['X-Master-Token'] = masterToken;
      await fetch(base + '/api/reply', { method: 'POST', headers: h, body: JSON.stringify(reply) });
    } catch (e) {}
  });

  masterEs.addEventListener('adjust_req', async (ev) => {
    if (masterSuperseded) return;
    try {
      const peek = JSON.parse(ev.data);
      window.dispatchEvent(new CustomEvent('smouha:hub-adjust-req', { detail: peek }));
    } catch (e) {}

    let data;
    try {
      data = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    let result = {
      success: false,
      error: { code: 'NO_HANDLER', message: 'no handler' },
    };
    try {
      if (masterHandlers && masterHandlers.isBridgeOnline && !masterHandlers.isBridgeOnline()) {
        result = {
          success: false,
          error: {
            code: 'EXTENSION_OFFLINE',
            message: 'Chrome extension offline — open DMart portal on this PC',
          },
        };
      } else if (masterHandlers && masterHandlers.adjustStock) {
        result = await masterHandlers.adjustStock({
          sku: data.sku,
          quantity: data.quantity,
          direction: data.direction,
          warehouseId: data.warehouseId,
        });
      }
    } catch (e) {
      result = {
        success: false,
        error: { code: 'ERR', message: String(e.message || e) },
      };
    }
    try {
      const adjHeaders = { 'Content-Type': 'application/json' };
      if (masterToken) adjHeaders['X-Master-Token'] = masterToken;
      await fetch(base + '/api/adjust-reply', {
        method: 'POST',
        headers: adjHeaders,
        body: JSON.stringify({ reqId: data.reqId, result }),
      });
    } catch (e) {}
  });

  masterEs.addEventListener('recent_push', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      window.dispatchEvent(new CustomEvent('smouha:hub-recent', { detail: data }));
    } catch (e) {}
  });

  masterEs.onerror = () => {
    try {
      window.dispatchEvent(new CustomEvent('smouha:hub-master-sse-error', { detail: { at: Date.now() } }));
    } catch (e) {}
  };
  masterEs.addEventListener('hello', (ev) => {
    try {
      const data = JSON.parse(ev.data || '{}');
      if (data.token) masterToken = String(data.token);
      masterSuperseded = false;
    } catch (e) {}
    try {
      probeHub(base).then((h) => {
        h.sseOpen = true;
        window.dispatchEvent(new CustomEvent('smouha:hub-health', { detail: h }));
      });
    } catch (e) {}
  });
  masterEs.addEventListener('superseded', () => {
    masterSuperseded = true;
    try {
      window.dispatchEvent(
        new CustomEvent('smouha:hub-master-superseded', {
          detail: { message: 'Master moved to another tab' },
        })
      );
    } catch (e) {}
  });
  masterEs.addEventListener('stock_image', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.sku && data.image) {
        window.dispatchEvent(
          new CustomEvent('smouha:hub-product-image', {
            detail: { sku: String(data.sku), image: String(data.image), product: data.product || null },
          })
        );
      }
    } catch (e) {}
  });
  probeHub(base);
  return true;
}

export function stopMasterHub() {
  if (masterEs) {
    try {
      masterEs.close();
    } catch (e) {}
    masterEs = null;
  }
}

export function startHubHealthLoop() {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(() => {
    if (getHubUrl()) {
      let probeUrl = getHubUrl();
      try {
        if (localStorage.getItem('smouha_hub_is_master') === '1') probeUrl = masterBaseUrl() || probeUrl;
      } catch (e) {}
      probeHub(probeUrl).then((h) => {
        try {
          if (masterEs) h.sseOpen = masterEs.readyState === 1;
          window.dispatchEvent(new CustomEvent('smouha:hub-health', { detail: h }));
        } catch (e) {}
      });
      hubDeviceHello().catch(() => {});
    }
  }, 10000);
  if (getHubUrl()) probeHub();
}
