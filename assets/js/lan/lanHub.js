/**
 * lanHub.js — client for local PC Hub (HTTP + SSE). No WebRTC.
 */
const LS_URL = 'smouha_lan_hub_url_v1';
const LS_USER = 'smouha_lan_hub_user_v1';
const LS_DEVICE = 'smouha_hub_device_id';

let hubUrl = '';
let masterEs = null;
let masterHandlers = null;
let healthTimer = null;
let lastHealth = { ok: false, at: 0, masterOnline: false };

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
    lastHealth = {
      ok: !!j.ok,
      at: Date.now(),
      masterOnline: !!j.masterOnline,
      masterName: j.masterName,
      ips: j.ips,
      devices: j.devices,
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
  if (!base) return { ok: false };
  const id = getHubIdentity();
  try {
    const r = await fetch(base + '/api/device/hello', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(id),
    });
    const j = await r.json();
    try {
      if (j && j.pending) localStorage.setItem('smouha_hub_pending', '1');
      else localStorage.removeItem('smouha_hub_pending');
      if (j && j.approved && j.role) {
        const cur = getHubIdentity();
        localStorage.setItem('smouha_lan_hub_user_v1', JSON.stringify({ username: cur.username, role: j.role }));
      }
    } catch (e) {}
    return j;
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export async function hubRequestStock(sku, warehouseId) {
  const base = getHubUrl();
  if (!base) return { ok: false, reason: 'no-hub', via: 'hub' };
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
      }),
      signal: ctrl.signal,
      cache: 'no-store',
    });
    clearTimeout(t);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      return {
        ok: false,
        reason: j.error || 'hub-http',
        message: j.message || null,
        via: 'hub',
      };
    }
    return {
      ok: !!j.ok,
      onHand: j.onHand ?? null,
      reserved: j.reserved ?? null,
      price: j.price ?? null,
      reason: j.reason || j.error || null,
      message: j.message || null,
      via: 'hub',
    };
  } catch (e) {
    return { ok: false, reason: 'hub-error', message: String(e.message || e), via: 'hub' };
  }
}

export async function hubRequestAdjust({ sku, quantity, direction, warehouseId }) {
  const base = getHubUrl();
  if (!base) {
    return { success: false, error: { code: 'NO_HUB', message: 'Hub URL not set' } };
  }
  const id = getHubIdentity();
  if (id.role === 'viewer') {
    return {
      success: false,
      error: { code: 'VIEWER', message: 'Viewer cannot adjust stock' },
    };
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 28000);
    const r = await fetch(base + '/api/adjust', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sku,
        quantity,
        direction,
        warehouseId: warehouseId || null,
        deviceId: id.deviceId,
        username: id.username,
        role: id.role,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return await r.json();
  } catch (e) {
    return {
      success: false,
      error: { code: 'HUB', message: String(e.message || e) },
    };
  }
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
    if (!r.ok) return { ok: false, reason: j.error || 'hub-http', message: j.message };
    return j;
  } catch (e) {
    return { ok: false, reason: 'hub-error', message: String(e.message || e) };
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
    return (j && j.rows) || [];
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
    };
    try {
      if (masterHandlers && masterHandlers.fetchLive) {
        const wid =
          data.warehouseId ||
          (masterHandlers.getWarehouseId && masterHandlers.getWarehouseId());
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
        };
      }
    } catch (e) {
      reply.reason = String(e.message || e);
    }
    try {
      await fetch(base + '/api/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reply),
      });
    } catch (e) {}
  });


  masterEs.addEventListener('lookup_req', async (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch (e) { return; }
    let reply = { reqId: data.reqId, ok: false, product: null, reason: 'no-handler' };
    try {
      if (masterHandlers && masterHandlers.lookupProduct) {
        const wid = data.warehouseId || (masterHandlers.getWarehouseId && masterHandlers.getWarehouseId());
        const look = await masterHandlers.lookupProduct(data.sku, wid, 14000);
        if (look && look.ok && look.product) {
          reply = { reqId: data.reqId, ok: true, product: look.product };
        } else {
          reply.reason = (look && look.reason) || 'not-found';
        }
      }
    } catch (e) {
      reply.reason = String(e.message || e);
    }
    try {
      await fetch(base + '/api/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reply),
      });
    } catch (e) {}
  });

  masterEs.addEventListener('adjust_req', async (ev) => {
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
      await fetch(base + '/api/adjust-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
  masterEs.addEventListener('hello', () => {
    try {
      probeHub().then((h) => {
        window.dispatchEvent(new CustomEvent('smouha:hub-health', { detail: h }));
      });
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
      probeHub().then((h) => {
        try { window.dispatchEvent(new CustomEvent('smouha:hub-health', { detail: h })); } catch (e) {}
      });
      hubDeviceHello().catch(() => {});
    }
  }, 10000);
  if (getHubUrl()) probeHub();
}
