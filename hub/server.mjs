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

const PORT = Number(process.env.SMOUHA_HUB_PORT || process.argv[2] || 8787);
const HOST = process.env.SMOUHA_HUB_HOST || '0.0.0.0';

const masterStreams = new Map(); // connId → ServerResponse (SSE)
const pending = new Map(); // reqId → { resolve, timer }
const devices = new Map(); // deviceId → { username, role, lastSeen, approved, requested }
function touchDevice(body) {
  const deviceId = String(body.deviceId || '').slice(0, 64);
  if (!deviceId) return null;
  const username = String(body.username || 'phone').trim().slice(0, 32) || 'phone';
  const prev = devices.get(deviceId) || {};
  const requested = body.role === 'viewer' ? 'viewer' : body.role === 'supervisor' ? 'supervisor' : (prev.requested || 'operator');
  // Auto-approve when under limit so phones appear and can adjust without manual Yes
  if (!approved.has(deviceId) && approved.size < maxDevices && requested !== 'viewer') {
    approved.add(deviceId);
  }
  const isApproved = approved.has(deviceId);
  const role = isApproved ? requested : 'viewer';
  devices.set(deviceId, {
    username,
    role,
    requested,
    lastSeen: now(),
    approved: isApproved,
  });
  return devices.get(deviceId);
}

const skuLocks = new Map(); // sku → { deviceId, until }
const auditLog = []; // ring buffer
const kicked = new Set();
const approved = new Set();
let maxDevices = 4;
let shiftLocked = false;
const MAX_LOG = 500;

let masterMeta = { name: 'Master', warehouseId: null };

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}
function sendJson(res, code, obj) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}
function logEntry(entry) {
  auditLog.unshift({ t: now(), ...entry });
  if (auditLog.length > MAX_LOG) auditLog.length = MAX_LOG;
}
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [id, res] of masterStreams) {
    try {
      res.write(payload);
    } catch (e) {
      masterStreams.delete(id);
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
function pruneLocks() {
  const t = now();
  for (const [sku, L] of skuLocks) {
    if (L.until < t) skuLocks.delete(sku);
  }
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  try {
    if (req.method === 'GET' && (path === '/' || path === '/health' || path === '/api/health')) {
      sendJson(res, 200, {
        ok: true,
        service: 'smouha-lan-hub',
        version: 1,
        masterOnline: masterOnline(),
        masterName: masterMeta.name,
        devices: [...devices.entries()].map(([id, d]) => ({
          id,
          username: d.username,
          role: d.role,
          requested: d.requested,
          approved: !!d.approved,
          lastSeen: d.lastSeen,
        })),
        maxDevices,
        shiftLocked,
        pending: pending.size,
        ips: lanIPs(),
        port: PORT,
      });
      return;
    }

    if (req.method === 'GET' && path === '/api/log') {
      const n = Math.min(200, Number(url.searchParams.get('n') || 100));
      sendJson(res, 200, { ok: true, rows: auditLog.slice(0, n) });
      return;
    }

    if (req.method === 'GET' && path === '/api/events') {
      if (url.searchParams.get('role') !== 'master') {
        sendJson(res, 400, { ok: false, error: 'role=master required' });
        return;
      }
      const connId = rid('m');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ connId, ok: true })}\n\n`);
      masterStreams.set(connId, res);
      const ping = setInterval(() => {
        try {
          res.write(`event: ping\ndata: ${JSON.stringify({ masterOnline: true })}\n\n`);
        } catch (e) {
          clearInterval(ping);
        }
      }, 12000);
      req.on('close', () => {
        clearInterval(ping);
        masterStreams.delete(connId);
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

    if (req.method === 'POST' && path === '/api/device/hello') {
      const body = await readJson(req);
      const deviceId = String(body.deviceId || rid('d')).slice(0, 64);
      const username = String(body.username || 'phone').trim().slice(0, 32) || 'phone';
      const requested = body.role === 'viewer' ? 'viewer' : body.role === 'supervisor' ? 'supervisor' : 'operator';
      if (shiftLocked && !approved.has(deviceId)) {
        sendJson(res, 403, { ok: false, error: 'SHIFT_LOCKED', message: 'Shift is locked — ask Master to unlock' });
        return;
      }
      const isNew = !devices.has(deviceId) && !approved.has(deviceId);
      if (isNew && approved.size >= maxDevices) {
        sendJson(res, 403, { ok: false, error: 'DEVICE_LIMIT', message: 'Device limit reached (' + maxDevices + ')' });
        return;
      }
      kicked.delete(deviceId);
      if (!approved.has(deviceId) && approved.size < maxDevices && requested !== 'viewer') {
        approved.add(deviceId);
      }
      const okRole = approved.has(deviceId) ? requested : 'viewer';
      devices.set(deviceId, { username, role: okRole, requested, lastSeen: now(), approved: approved.has(deviceId) });
      logEntry({ type: 'device', action: approved.has(deviceId) ? 'hello' : 'pending', username, deviceId, role: okRole });
      if (!approved.has(deviceId)) broadcast('pair_pending', { deviceId, username, requested });
      else broadcast('device_hello', { deviceId, username, role: okRole });
      sendJson(res, 200, {
        ok: true,
        deviceId,
        username,
        role: okRole,
        approved: approved.has(deviceId),
        pending: !approved.has(deviceId),
        masterOnline: masterOnline(),
        masterName: masterMeta.name,
      });
      return;
    }

    if (req.method === 'POST' && path === '/api/stock') {
      const body = await readJson(req);
      const sku = String(body.sku || '').trim();
      if (!sku) {
        sendJson(res, 400, { ok: false, error: 'SKU_REQUIRED', message: 'SKU required' });
        return;
      }
      const deviceId = String(body.deviceId || 'anon').slice(0, 64);
      if (kicked.has(deviceId)) {
        sendJson(res, 403, { ok: false, error: 'KICKED', message: 'This device was removed by Master — open Hub and Save again' });
        return;
      }
      if (!masterOnline()) {
        sendJson(res, 503, {
          ok: false,
          error: 'MASTER_OFFLINE',
          message: 'Master PC not connected — open the site on the branch PC with Hub running',
        });
        return;
      }
      const username = String(body.username || '').slice(0, 32);
      touchDevice(body);
      const reqId = rid('s');
      const warehouseId = body.warehouseId || masterMeta.warehouseId || null;
      logEntry({ type: 'stock', action: 'request', username, deviceId, sku });

      const result = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(reqId);
          resolve({
            ok: false,
            error: 'TIMEOUT',
            message: 'Master did not answer in time — check extension on PC',
          });
        }, 20000);
        pending.set(reqId, { resolve, timer });
        broadcast('stock_req', { reqId, sku, warehouseId, deviceId, username });
      });
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && path === '/api/reply') {
      const body = await readJson(req);
      if (!body.reqId || !pending.has(body.reqId)) {
        sendJson(res, 404, { ok: false, error: 'UNKNOWN_REQ' });
        return;
      }
      cleanupPending(body.reqId, {
        ok: !!body.ok,
        onHand: body.onHand ?? null,
        reserved: body.reserved ?? null,
        price: body.price ?? null,
        reason: body.reason || null,
        product: body.product || null,
        via: 'hub',
      });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && path === '/api/adjust') {
      const body = await readJson(req);
      const sku = String(body.sku || '').trim();
      const quantity = Number(body.quantity) || 0;
      const direction = body.direction === 'decrease' ? 'decrease' : 'increase';
      const deviceId = String(body.deviceId || '').slice(0, 64);
      const username = String(body.username || '').slice(0, 32);
      const dev = devices.get(deviceId) || {};
      const role = dev.role || 'viewer';
      if (!dev.approved) {
        sendJson(res, 403, { ok: false, error: 'NOT_APPROVED', message: 'Waiting for Master Yes before adjust' });
        return;
      }

      if (!sku || quantity < 1) {
        sendJson(res, 400, {
          ok: false,
          error: 'BAD_REQUEST',
          message: 'SKU and quantity (1+) required',
        });
        return;
      }
      if (role === 'viewer') {
        sendJson(res, 403, {
          ok: false,
          error: 'VIEWER',
          message: 'Viewer role cannot adjust stock',
        });
        return;
      }
      if (!masterOnline()) {
        sendJson(res, 503, {
          ok: false,
          error: 'MASTER_OFFLINE',
          message: 'Master PC offline — cannot adjust',
        });
        return;
      }
      pruneLocks();
      const lock = skuLocks.get(sku);
      if (lock && lock.deviceId !== deviceId && lock.until > now()) {
        sendJson(res, 409, {
          ok: false,
          error: 'SKU_LOCKED',
          message: 'Another device is adjusting this SKU — wait a few seconds',
        });
        return;
      }
      skuLocks.set(sku, { deviceId, until: now() + 25000 });
      const reqId = rid('a');
      logEntry({
        type: 'adjust',
        action: 'request',
        username,
        deviceId,
        sku,
        quantity,
        direction,
      });

      const result = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(reqId);
          skuLocks.delete(sku);
          resolve({
            success: false,
            error: { code: 'TIMEOUT', message: 'Master timeout — check extension' },
          });
        }, 25000);
        pending.set(reqId, { resolve, timer });
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
        error: result && result.error ? result.error.code || result.error.message : null,
      });
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && path === '/api/adjust-reply') {
      const body = await readJson(req);
      if (!body.reqId || !pending.has(body.reqId)) {
        sendJson(res, 404, { ok: false, error: 'UNKNOWN_REQ' });
        return;
      }
      cleanupPending(body.reqId, body.result || body);
      sendJson(res, 200, { ok: true });
      return;
    }

    // Mobile opened a product → push to Master recent
    if (req.method === 'POST' && path === '/api/recent') {
      const body = await readJson(req);
      const sku = String(body.sku || '').trim();
      if (!sku) {
        sendJson(res, 400, { ok: false, error: 'SKU_REQUIRED' });
        return;
      }
      const deviceId = String(body.deviceId || '').slice(0, 64);
      const username = String(body.username || '').slice(0, 32);
      touchDevice({ deviceId, username, role: body.role });
      logEntry({ type: 'recent', action: 'push', username, deviceId, sku });
      if (masterOnline()) {
        broadcast('recent_push', {
          sku,
          name: body.name || null,
          username,
          deviceId,
          at: now(),
        });
      }
      sendJson(res, 200, { ok: true, delivered: masterOnline() });
      return;
    }


    if (req.method === 'POST' && path === '/api/lookup') {
      const body = await readJson(req);
      const sku = String(body.sku || '').trim();
      if (!sku) {
        sendJson(res, 400, { ok: false, error: 'SKU_REQUIRED' });
        return;
      }
      touchDevice(body);
      if (!masterOnline()) {
        sendJson(res, 503, { ok: false, error: 'MASTER_OFFLINE', message: 'Master tab not linked' });
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
          deviceId: body.deviceId || null,
          username: body.username || null,
        });
      });
      if (!result) {
        sendJson(res, 504, { ok: false, error: 'TIMEOUT', message: 'Lookup timed out' });
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && path === '/api/approve') {
      const body = await readJson(req);
      const deviceId = String(body.deviceId || '').slice(0, 64);
      const d = devices.get(deviceId);
      if (!d) { sendJson(res, 404, { ok: false, error: 'UNKNOWN_DEVICE' }); return; }
      if (approved.size >= maxDevices && !approved.has(deviceId)) {
        sendJson(res, 403, { ok: false, error: 'DEVICE_LIMIT', message: 'Device limit reached' });
        return;
      }
      approved.add(deviceId);
      d.approved = true;
      d.role = d.requested || 'operator';
      logEntry({ type: 'device', action: 'approve', username: d.username, deviceId, role: d.role });
      broadcast('approved', { deviceId, username: d.username, role: d.role });
      sendJson(res, 200, { ok: true, deviceId, role: d.role });
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
      if (!deviceId || !devices.has(deviceId)) {
        sendJson(res, 404, { ok: false, error: 'UNKNOWN_DEVICE', message: 'Device not connected' });
        return;
      }
      const d = devices.get(deviceId);
      devices.delete(deviceId);
      kicked.add(deviceId);
      logEntry({ type: 'device', action: 'kick', username: d.username, deviceId, role: d.role });
      broadcast('kicked', { deviceId, username: d.username });
      sendJson(res, 200, { ok: true, deviceId });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'NOT_FOUND' });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String(e && e.message ? e.message : e) });
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
