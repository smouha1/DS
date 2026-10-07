/**
 * Smouha LAN Hub — zero-dependency Node HTTP relay
 * One PC only: Master browser tab + Chrome extension fulfill stock/adjust.
 * Phones talk HTTP to this process on the same Wi‑Fi.
 *
 *   node server.mjs
 *   node server.mjs 8787
 */
import http from 'http';
import os from 'os';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, 'state.json');
const LAST_ERR_FILE = path.join(__dirname, 'last-error.txt');
const HUB_STARTED_AT = Date.now();
let lastErrorLine = '';

const PORT = Number(process.env.SMOUHA_HUB_PORT || process.argv[2] || 8787);
const HOST = process.env.SMOUHA_HUB_HOST || '0.0.0.0';

const masterStreams = new Map(); // connId → { res, token }
const pending = new Map(); // reqId → { resolve, timer, kind? }
const devices = new Map(); // deviceId → { username, role, lastSeen, approved, requested }
const skuLocks = new Map(); // sku → { deviceId, until, username }
const auditLog = [];
const kicked = new Set();
const approved = new Set();
const lastImage = new Map(); // sku → { image, product, at }
let maxDevices = 4;
let shiftLocked = false;
const MAX_LOG = 500;
let masterMeta = { name: 'Master', warehouseId: null };

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (Array.isArray(j.approved)) j.approved.forEach((id) => approved.add(id));
    if (Array.isArray(j.kicked)) j.kicked.forEach((id) => kicked.add(id));
    if (j.devices && typeof j.devices === 'object') {
      for (const [id, d] of Object.entries(j.devices)) {
        devices.set(id, { ...d, lastSeen: d.lastSeen || Date.now() });
      }
    }
    if (Number.isFinite(j.maxDevices)) maxDevices = j.maxDevices;
  } catch (e) {
    console.warn('[hub] state load failed', e.message);
  }
}
let saveStateTimer = null;
function saveState() {
  clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(() => {
    try {
      const payload = {
        approved: [...approved],
        kicked: [...kicked],
        maxDevices,
        devices: Object.fromEntries(devices),
        at: Date.now(),
      };
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 0));
      fs.renameSync(tmp, STATE_FILE);
    } catch (e) {
      console.warn('[hub] state save failed', e.message);
    }
  }, 300);
}
function setLastError(line) {
  lastErrorLine = String(line || '').slice(0, 200);
  try {
    fs.writeFileSync(LAST_ERR_FILE, lastErrorLine + '\n' + new Date().toISOString());
  } catch (e) {}
}

loadState();

let activeMasterConnId = null;

function rid(p = 'r') {
  return p + '_' + randomBytes(5).toString('hex');
}
function now() {
  return Date.now();
}
function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const n of Object.keys(ifs || {})) {
    for (const a of ifs[n] || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}
function masterOnline() {
  return masterStreams.size > 0;
}
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Master-Token');
  res.setHeader('Cache-Control', 'no-store');
}
function sendJson(res, code, obj) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function errBody(code, message) {
  return { ok: false, success: false, error: { code: String(code), message: String(message || code) } };
}
function logEntry(row) {
  auditLog.unshift({ ...row, at: now() });
  if (auditLog.length > MAX_LOG) auditLog.length = MAX_LOG;
}
function pruneLocks() {
  const t = now();
  for (const [sku, L] of skuLocks) {
    if (!L || L.until <= t) skuLocks.delete(sku);
  }
}
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [id, entry] of masterStreams) {
    try {
      entry.res.write(payload);
    } catch (e) {
      masterStreams.delete(id);
      if (activeMasterConnId === id) activeMasterConnId = null;
    }
  }
}
function cleanupPending(reqId, result) {
  const p = pending.get(reqId);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(reqId);
  try {
    p.resolve(result);
  } catch (e) {}
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(raw));
      } catch (e) {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}
function getMasterToken(req) {
  return String(req.headers['x-master-token'] || '').trim();
}
function isValidMasterToken(token) {
  if (!token) return false;
  for (const [, entry] of masterStreams) {
    if (entry.token === token) return true;
  }
  return false;
}

/**
 * Register/update device presence only. Does NOT auto-approve.
 * Approval is only via /api/device/hello (under capacity) or explicit /api/approve.
 * Role is sticky after first request — body.role only used for NEW devices unless allowRoleChange.
 * Kicked devices are never registered.
 */
function touchDevice(body, { allowRoleChange = false } = {}) {
  const deviceId = String(body.deviceId || '').slice(0, 64);
  if (!deviceId) return null;
  if (kicked.has(deviceId)) return null;

  const username = String(body.username || 'phone').trim().slice(0, 32) || 'phone';
  const prev = devices.get(deviceId) || {};
  let requested;
  if (prev.requested && !allowRoleChange) {
    requested = prev.requested;
  } else {
    requested =
      body.role === 'viewer'
        ? 'viewer'
        : body.role === 'supervisor'
          ? 'supervisor'
          : prev.requested || 'operator';
  }

  // Never auto-approve from stock/lookup/recent — prevents DEVICE_LIMIT bypass
  const isApproved = approved.has(deviceId);
  const role = isApproved ? requested : 'viewer';
  devices.set(deviceId, {
    username,
    role,
    requested,
    lastSeen: now(),
    approved: isApproved,
    clientRev: body.clientRev || prev.clientRev || null,
  });
  saveState();
  return devices.get(deviceId);
}

function isLoopback(req) {
  const a = String((req.socket && req.socket.remoteAddress) || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/** Master-only write paths: require live Master SSE + token (loopback escape for local tools). */
function assertMasterWriteAuth(req, res) {
  if (masterStreams.size === 0) {
    if (isLoopback(req)) return true;
    sendJson(res, 503, errBody('MASTER_OFFLINE', 'Master PC not connected'));
    return false;
  }
  const token = getMasterToken(req);
  if (token && isValidMasterToken(token)) return true;
  if (!token && isLoopback(req)) return true;
  sendJson(res, 403, errBody('FORBIDDEN', 'Valid X-Master-Token required'));
  return false;
}

function assertNotKicked(deviceId) {
  if (deviceId && kicked.has(deviceId)) {
    return errBody('KICKED', 'This device was removed by Master — open Hub and Save again');
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      cors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // ---- health ----
    if (req.method === 'GET' && (path === '/health' || path === '/api/health')) {
      const devicesOut = [];
      for (const [id, d] of devices) {
        devicesOut.push({
          deviceId: id,
          username: d.username,
          role: d.role,
          approved: !!d.approved,
          lastSeen: d.lastSeen,
          agoSec: Math.round((now() - (d.lastSeen || now())) / 1000),
          clientRev: d.clientRev || null,
        });
      }
      sendJson(res, 200, {
        ok: true,
        masterOnline: masterOnline(),
        masterName: masterMeta.name,
        masterCount: masterStreams.size,
        approved: approved.size,
        maxDevices,
        shiftLocked,
        kicked: kicked.size,
        devices: devicesOut,
        ips: lanIPs(),
        port: PORT,
        startedAt: HUB_STARTED_AT,
        lastError: lastErrorLine || null,
      });
      return;
    }

    // ---- Master SSE (single active master) ----
    if (req.method === 'GET' && path === '/api/events') {
      const role = url.searchParams.get('role') || '';
      if (role !== 'master') {
        sendJson(res, 403, errBody('FORBIDDEN', 'Only master SSE supported'));
        return;
      }
      const connId = rid('m');
      const token = rid('tok');

      // Close previous masters — only newest wins
      for (const [oldId, entry] of [...masterStreams.entries()]) {
        try {
          entry.res.write(`event: superseded\ndata: ${JSON.stringify({ reason: 'another_master' })}\n\n`);
          entry.res.end();
        } catch (e) {}
        masterStreams.delete(oldId);
      }
      activeMasterConnId = connId;

      cors(res);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ connId, token, master: true })}\n\n`);
      masterStreams.set(connId, { res, token });

      const ping = setInterval(() => {
        try {
          res.write(`event: ping\ndata: ${JSON.stringify({ t: now() })}\n\n`);
        } catch (e) {
          clearInterval(ping);
        }
      }, 12000);
      req.on('close', () => {
        clearInterval(ping);
        masterStreams.delete(connId);
        if (activeMasterConnId === connId) activeMasterConnId = null;
      });
      return;
    }

    if (req.method === 'POST' && path === '/api/master/hello') {
      const body = await readJson(req);
      masterMeta = {
        name: String(body.name || 'Master').slice(0, 40),
        warehouseId: body.warehouseId || null,
      };
      sendJson(res, 200, {
        ok: true,
        masterOnline: masterOnline(),
        ips: lanIPs(),
        port: PORT,
      });
      return;
    }

    // ---- device hello (sole auto-approve path under capacity; over-limit → pending) ----
    if (req.method === 'POST' && path === '/api/device/hello') {
      const body = await readJson(req);
      const deviceId = String(body.deviceId || rid('d')).slice(0, 64);
      const username = String(body.username || 'phone').trim().slice(0, 32) || 'phone';
      const requested =
        body.role === 'viewer' ? 'viewer' : body.role === 'supervisor' ? 'supervisor' : 'operator';

      if (kicked.has(deviceId)) {
        sendJson(
          res,
          403,
          errBody('KICKED', 'This device was removed by Master — ask Master to unkick or use a new device id')
        );
        return;
      }
      if (shiftLocked && !approved.has(deviceId)) {
        sendJson(res, 403, errBody('SHIFT_LOCKED', 'Shift is locked — ask Master to unlock'));
        return;
      }

      // Only hello (or explicit /api/approve) may grant approval — never stock/lookup
      if (!approved.has(deviceId) && approved.size < maxDevices && requested !== 'viewer') {
        approved.add(deviceId);
      }
      const isApproved = approved.has(deviceId);
      const okRole = isApproved ? requested : 'viewer';
      devices.set(deviceId, {
        username,
        role: okRole,
        requested,
        lastSeen: now(),
        approved: isApproved,
        clientRev: body.clientRev || null,
      });
      saveState();
      logEntry({
        type: 'device',
        action: isApproved ? 'hello' : 'pending',
        username,
        deviceId,
        role: okRole,
      });
      if (!isApproved) broadcast('pair_pending', { deviceId, username, requested });
      else broadcast('device_hello', { deviceId, username, role: okRole });

      // Over-limit devices stay pending (HTTP 200) so Master can Approve — no silent drop
      sendJson(res, 200, {
        ok: true,
        deviceId,
        username,
        role: okRole,
        approved: isApproved,
        pending: !isApproved,
        limitReached: !isApproved && approved.size >= maxDevices,
        masterOnline: masterOnline(),
        masterName: masterMeta.name,
      });
      return;
    }

    // ---- stock ----
    if (req.method === 'POST' && path === '/api/stock') {
      const body = await readJson(req);
      const sku = String(body.sku || '').trim();
      if (!sku) {
        sendJson(res, 400, errBody('SKU_REQUIRED', 'SKU required'));
        return;
      }
      const deviceId = String(body.deviceId || 'anon').slice(0, 64);
      const kickedErr = assertNotKicked(deviceId);
      if (kickedErr) {
        sendJson(res, 403, kickedErr);
        return;
      }
      if (!masterOnline()) {
        sendJson(res, 503, errBody('MASTER_OFFLINE', 'Master PC not connected — open the site on the branch PC'));
        return;
      }
      touchDevice(body);
      const reqId = rid('s');
      const warehouseId = body.warehouseId || masterMeta.warehouseId || null;
      const username = String(body.username || '').slice(0, 32);
      logEntry({ type: 'stock', action: 'request', username, deviceId, sku });

      const waitMs = 20000;
      const result = await new Promise((resolve) => {
        const t = setTimeout(() => {
          pending.delete(reqId);
          resolve(null);
        }, waitMs);
        pending.set(reqId, { resolve, timer: t, kind: 'stock' });
        broadcast('stock_req', { reqId, sku, warehouseId, deviceId, username });
      });
      if (!result) {
        sendJson(res, 504, errBody('TIMEOUT', 'Stock request timed out — check extension on Master PC'));
        return;
      }
      // Attach cached image if master didn't include one
      if (!result.image && lastImage.has(sku)) {
        const cached = lastImage.get(sku);
        result.image = cached.image;
        if (!result.product && cached.product) result.product = cached.product;
      }
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    // ---- lookup ----
    if (req.method === 'POST' && path === '/api/lookup') {
      const body = await readJson(req);
      const sku = String(body.sku || '').trim();
      if (!sku) {
        sendJson(res, 400, errBody('SKU_REQUIRED', 'SKU required'));
        return;
      }
      const deviceId = String(body.deviceId || '').slice(0, 64);
      const kickedErr = assertNotKicked(deviceId);
      if (kickedErr) {
        sendJson(res, 403, kickedErr);
        return;
      }
      touchDevice(body);
      if (!masterOnline()) {
        sendJson(res, 503, errBody('MASTER_OFFLINE', 'Master tab not linked'));
        return;
      }
      if (lastImage.has(sku) && now() - lastImage.get(sku).at < 120000) {
        const c = lastImage.get(sku);
        sendJson(res, 200, { ok: true, product: c.product || { sku, image: c.image }, image: c.image });
        return;
      }
      const reqId = rid('lk');
      const waitMs = 18000;
      const result = await new Promise((resolve) => {
        const t = setTimeout(() => {
          pending.delete(reqId);
          resolve(null);
        }, waitMs);
        pending.set(reqId, { resolve, timer: t, kind: 'lookup' });
        broadcast('lookup_req', {
          reqId,
          sku,
          warehouseId: body.warehouseId || masterMeta.warehouseId || null,
          deviceId,
          username: body.username || null,
        });
      });
      if (!result) {
        sendJson(res, 504, errBody('TIMEOUT', 'Lookup timed out'));
        return;
      }
      if (result.image || (result.product && result.product.image)) {
        const img = result.image || result.product.image;
        lastImage.set(sku, { image: img, product: result.product || null, at: now() });
      }
      sendJson(res, 200, result);
      return;
    }

    // ---- image push from Master (late lookup) ----
    if (req.method === 'POST' && path === '/api/image') {
      if (!assertMasterWriteAuth(req, res)) return;
      const body = await readJson(req);
      const sku = String(body.sku || '').trim();
      const image = String(body.image || '').trim();
      if (!sku || !image) {
        sendJson(res, 400, errBody('BAD_REQUEST', 'sku and image required'));
        return;
      }
      lastImage.set(sku, { image, product: body.product || null, at: now() });
      broadcast('stock_image', { sku, image, product: body.product || null });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && path === '/api/image') {
      const sku = String(url.searchParams.get('sku') || '').trim();
      if (!sku || !lastImage.has(sku)) {
        sendJson(res, 404, errBody('NOT_FOUND', 'No image cached'));
        return;
      }
      const c = lastImage.get(sku);
      sendJson(res, 200, { ok: true, image: c.image, product: c.product });
      return;
    }

    // ---- adjust ----
    if (req.method === 'POST' && path === '/api/adjust') {
      const body = await readJson(req);
      const sku = String(body.sku || '').trim();
      const quantity = Number(body.quantity) || 0;
      const direction = body.direction === 'decrease' ? 'decrease' : 'increase';
      const deviceId = String(body.deviceId || '').slice(0, 64);
      const username = String(body.username || '').slice(0, 32);

      const kickedErr = assertNotKicked(deviceId);
      if (kickedErr) {
        sendJson(res, 403, kickedErr);
        return;
      }
      // Do NOT pass body.role for role escalation — use stored record
      const dev = touchDevice({ deviceId, username, role: undefined });
      if (!dev || !dev.approved) {
        sendJson(res, 403, errBody('NOT_APPROVED', 'Waiting for Master approval before adjust'));
        return;
      }
      const role = dev.role || 'viewer';
      if (role === 'viewer') {
        sendJson(res, 403, errBody('VIEWER', 'Viewer role cannot adjust stock'));
        return;
      }
      if (!sku || quantity < 1) {
        sendJson(res, 400, errBody('BAD_REQUEST', 'SKU and quantity (1+) required'));
        return;
      }
      if (!masterOnline()) {
        sendJson(res, 503, errBody('MASTER_OFFLINE', 'Master PC offline — cannot adjust'));
        return;
      }
      pruneLocks();
      const lock = skuLocks.get(sku);
      if (lock && lock.deviceId !== deviceId && lock.until > now()) {
        sendJson(
          res,
          409,
          errBody('SKU_LOCKED', 'Locked by ' + (lock.username || 'another device') + ' — wait a few seconds')
        );
        return;
      }
      skuLocks.set(sku, { deviceId, until: now() + 25000, username });
      const reqId = rid('a');
      logEntry({ type: 'adjust', action: 'request', username, deviceId, sku, quantity, direction });

      const result = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(reqId);
          skuLocks.delete(sku);
          setLastError('ADJUST_TIMEOUT sku=' + sku);
          resolve({ success: false, error: { code: 'TIMEOUT', message: 'Master timeout — check extension' } });
        }, 25000);
        pending.set(reqId, { resolve, timer, kind: 'adjust' });
        broadcast('adjust_req', {
          reqId,
          sku,
          quantity,
          direction,
          deviceId,
          username,
          warehouseId: body.warehouseId || masterMeta.warehouseId,
        });
      });
      skuLocks.delete(sku);
      logEntry({
        type: 'adjust',
        action: result && result.success ? 'ok' : 'fail',
        username,
        deviceId,
        sku,
        quantity,
        direction,
        code: result && result.error && result.error.code,
      });
      if (result && result.success) {
        sendJson(res, 200, result);
      } else {
        sendJson(res, 200, result || errBody('ADJUST_FAILED', 'Adjust failed'));
      }
      return;
    }

    // ---- replies from Master (require live Master + token; loopback escape) ----
    if (req.method === 'POST' && path === '/api/reply') {
      if (!assertMasterWriteAuth(req, res)) return;
      const body = await readJson(req);
      if (body.image && body.sku) {
        lastImage.set(String(body.sku), {
          image: String(body.image),
          product: body.product || null,
          at: now(),
        });
      }
      cleanupPending(body.reqId, {
        ok: !!body.ok,
        onHand: body.onHand ?? null,
        reserved: body.reserved ?? null,
        price: body.price ?? null,
        reason: body.reason || null,
        product: body.product || null,
        image: body.image || (body.product && body.product.image) || null,
        via: 'hub',
      });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && path === '/api/adjust-reply') {
      if (!assertMasterWriteAuth(req, res)) return;
      const body = await readJson(req);
      const result = body.result || body;
      cleanupPending(body.reqId, result);
      sendJson(res, 200, { ok: true });
      return;
    }

    // ---- recent ----
    if (req.method === 'POST' && path === '/api/recent') {
      const body = await readJson(req);
      const deviceId = String(body.deviceId || '').slice(0, 64);
      const kickedErr = assertNotKicked(deviceId);
      if (kickedErr) {
        sendJson(res, 403, kickedErr);
        return;
      }
      touchDevice(body);
      broadcast('recent_push', {
        sku: body.sku,
        name: body.name,
        image: body.image,
        username: body.username || body.deviceId,
        deviceId,
        at: now(),
      });
      sendJson(res, 200, { ok: true });
      return;
    }

    // ---- approve / unkick / kick / config ----
    if (req.method === 'POST' && path === '/api/approve') {
      const body = await readJson(req);
      const deviceId = String(body.deviceId || '').slice(0, 64);
      const d = devices.get(deviceId);
      if (!d) {
        sendJson(res, 404, errBody('UNKNOWN_DEVICE', 'Unknown device'));
        return;
      }
      if (approved.size >= maxDevices && !approved.has(deviceId)) {
        sendJson(res, 403, errBody('DEVICE_LIMIT', 'Device limit reached'));
        return;
      }
      kicked.delete(deviceId);
      approved.add(deviceId);
      d.approved = true;
      d.role = d.requested || 'operator';
      devices.set(deviceId, d);
      broadcast('approved', { deviceId, username: d.username, role: d.role });
      sendJson(res, 200, { ok: true, deviceId, role: d.role });
      return;
    }

    if (req.method === 'POST' && path === '/api/unkick') {
      const body = await readJson(req);
      const deviceId = String(body.deviceId || '').slice(0, 64);
      kicked.delete(deviceId);
      sendJson(res, 200, { ok: true, deviceId });
      return;
    }

    if (req.method === 'POST' && path === '/api/config') {
      const body = await readJson(req);
      const n = Number(body.maxDevices);
      if (Number.isFinite(n)) maxDevices = Math.max(1, Math.min(15, Math.round(n)));
      if (typeof body.shiftLocked === 'boolean') shiftLocked = body.shiftLocked;
      sendJson(res, 200, { ok: true, maxDevices, shiftLocked });
      return;
    }

    if (req.method === 'POST' && path === '/api/shift-lock') {
      shiftLocked = true;
      for (const [id, d] of [...devices.entries()]) {
        devices.delete(id);
        approved.delete(id);
        kicked.add(id);
        logEntry({ type: 'device', action: 'shift-lock', username: d.username, deviceId: id });
      }
      broadcast('shift_locked', { at: now() });
      sendJson(res, 200, { ok: true, shiftLocked: true });
      return;
    }

    if (req.method === 'POST' && path === '/api/shift-unlock') {
      shiftLocked = false;
      sendJson(res, 200, { ok: true, shiftLocked: false });
      return;
    }

    if (req.method === 'POST' && path === '/api/kick') {
      const body = await readJson(req);
      const deviceId = String(body.deviceId || '').slice(0, 64);
      if (!deviceId) {
        sendJson(res, 404, errBody('UNKNOWN_DEVICE', 'Device not connected'));
        return;
      }
      const d = devices.get(deviceId) || { username: '?', role: '?' };
      devices.delete(deviceId);
      approved.delete(deviceId);
      kicked.add(deviceId);
      saveState();
      logEntry({ type: 'device', action: 'kick', username: d.username, deviceId, role: d.role });
      broadcast('kicked', { deviceId, username: d.username });
      sendJson(res, 200, { ok: true, deviceId, approved: approved.size });
      return;
    }

    if (req.method === 'GET' && path === '/api/log') {
      sendJson(res, 200, { ok: true, log: auditLog.slice(0, 200) });
      return;
    }

    sendJson(res, 404, errBody('NOT_FOUND', 'Not found'));
  } catch (e) {
    sendJson(res, 500, errBody('SERVER', String(e && e.message ? e.message : e)));
  }
});

server.listen(PORT, HOST, () => {
  const ips = lanIPs();
  console.log('');
  console.log('══════════════════════════════════════════');
  console.log('  Smouha LAN Hub  ·  port ' + PORT);
  console.log('══════════════════════════════════════════');
  console.log('  Local:  http://127.0.0.1:' + PORT + '/health');
  for (const ip of ips) console.log('  Phone:  http://' + ip + ':' + PORT);
  if (!ips.length) console.log('  (no LAN IPv4 — check Wi-Fi)');
  console.log('  Keep this window open during the shift.');
  console.log('══════════════════════════════════════════');
  console.log('');
});
