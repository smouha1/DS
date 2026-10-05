/**
 * lanMaster.js — Master PC: pair, approve, kick, heartbeat, SKU locks.
 */
import {
  loadMasterState,
  saveMasterState,
  ensureMasterPin,
  rotateMasterPin,
  formatPin,
  genId,
  appendLanLog,
  getLanLog,
  clearLanLog,
  setLastLanError,
  packSignal,
} from './lanStore.js';
import { masterCreateOffer, masterAcceptAnswer, sendLan } from './lanTransport.js';

let state = loadMasterState();
const sessions = new Map(); // deviceId → { pc, channel, username, deviceLabel, role }
let activeOffer = null;
/** sku → deviceId currently adjusting */
const skuLocks = new Map();

function persist() {
  saveMasterState(state);
}

export function getMasterState() {
  state = ensureMasterPin(loadMasterState());
  return state;
}

export function setMasterEnabled(on) {
  state = getMasterState();
  state.enabled = !!on;
  if (state.enabled && !state.masterId) state.masterId = genId('m');
  persist();
  appendLanLog({ type: 'master', action: on ? 'enabled' : 'disabled' });
  return state;
}

export function setMasterName(name) {
  state = getMasterState();
  state.masterName = String(name || 'Master PC').slice(0, 40);
  persist();
  return state;
}

export function setMaxDevices(n) {
  state = getMasterState();
  const v = parseInt(n, 10);
  state.maxDevices = Number.isFinite(v) ? Math.min(15, Math.max(1, v)) : 4;
  persist();
  return state;
}

export function setSessionHours(h) {
  state = getMasterState();
  const v = parseInt(h, 10);
  state.sessionHours = Number.isFinite(v) ? Math.min(24 * 14, Math.max(0, v)) : 0;
  persist();
  return state;
}

export function getFullPin() {
  state = ensureMasterPin(getMasterState());
  persist();
  return formatPin(state.pinSuffix);
}

export function doRotatePin() {
  state = getMasterState();
  rotateMasterPin(state);
  persist();
  appendLanLog({ type: 'master', action: 'pin_rotated' });
  return getFullPin();
}

export function approvedCount() {
  state = getMasterState();
  const now = Date.now();
  return state.devices.filter(
    (d) => d.status === 'approved' && (!d.expiresAt || d.expiresAt > now)
  ).length;
}

export async function beginPairOffer() {
  state = getMasterState();
  if (!state.enabled) throw new Error('Master is off');
  if (approvedCount() >= state.maxDevices) throw new Error('Device limit reached');

  const pin = getFullPin();
  const onMessage = (msg) => handleIncoming(msg);
  const onState = (s) => {
    try {
      window.dispatchEvent(
        new CustomEvent('smouha:lan-conn', { detail: { role: 'master', state: s } })
      );
    } catch (e) {}
  };

  const { pc, channel, offerSignal } = await masterCreateOffer(onMessage, onState);
  const packed = await packSignal(offerSignal);
  activeOffer = { pc, channel, offerSignal, packed, createdAt: Date.now() };
  return {
    offerSignal: packed,
    offerSignalRaw: offerSignal,
    pin,
    masterId: state.masterId,
    masterName: state.masterName,
  };
}

export function getActiveOfferSignal() {
  return activeOffer && (activeOffer.packed || activeOffer.offerSignal);
}

export async function completePairWithAnswer({
  answerSignal,
  username,
  deviceId,
  deviceLabel,
  role,
}) {
  state = getMasterState();
  if (!activeOffer || !activeOffer.pc) throw new Error('No active offer — start pair again');
  if (approvedCount() >= state.maxDevices) throw new Error('Device limit reached');

  const uname = String(username || '').trim().slice(0, 32);
  if (!uname) throw new Error('Username required');

  // unpack if needed
  let answer = answerSignal;
  try {
    const { unpackSignal } = await import('./lanStore.js');
    const u = await unpackSignal(answerSignal);
    if (u) answer = u;
  } catch (e) {}

  await masterAcceptAnswer(activeOffer.pc, answer);

  const id = deviceId || genId('d');
  const expiresAt =
    state.sessionHours > 0 ? Date.now() + state.sessionHours * 3600 * 1000 : null;
  const label = String(deviceLabel || '').trim().slice(0, 40);
  const deviceRole = role === 'viewer' ? 'viewer' : 'operator';

  const device = {
    id,
    username: uname,
    deviceLabel: label,
    role: deviceRole,
    status: 'pending',
    pairedAt: Date.now(),
    expiresAt,
    lastSeen: Date.now(),
  };
  state.pending = state.pending.filter((d) => d.id !== id);
  state.pending.unshift(device);
  persist();

  sessions.set(id, {
    pc: activeOffer.pc,
    channel: activeOffer.channel,
    username: uname,
    deviceLabel: label,
    role: deviceRole,
  });
  sendLan(activeOffer.channel, {
    type: 'pair_pending',
    deviceId: id,
    masterName: state.masterName,
  });

  activeOffer = null;
  appendLanLog({
    type: 'pair',
    action: 'pending',
    username: uname,
    deviceId: id,
    deviceLabel: label,
    role: deviceRole,
  });
  return device;
}

export async function ingestMobileAnswerBlob(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch (e) {
      data = { answerSignal: raw };
    }
  }
  return completePairWithAnswer({
    answerSignal: data.answerSignal || data.answer || data,
    username: data.username,
    deviceId: data.deviceId,
    deviceLabel: data.deviceLabel,
    role: data.role,
  });
}

export function approveDevice(deviceId) {
  state = getMasterState();
  const idx = state.pending.findIndex((d) => d.id === deviceId);
  let device =
    idx >= 0 ? state.pending[idx] : state.devices.find((d) => d.id === deviceId);
  if (!device) return null;
  if (approvedCount() >= state.maxDevices && device.status !== 'approved') {
    throw new Error('Device limit reached');
  }
  device = { ...device, status: 'approved', lastSeen: Date.now() };
  state.pending = state.pending.filter((d) => d.id !== deviceId);
  state.devices = state.devices.filter((d) => d.id !== deviceId);
  state.devices.unshift(device);
  persist();

  const sess = sessions.get(deviceId);
  if (sess) {
    sess.role = device.role || 'operator';
    sendLan(sess.channel, {
      type: 'pair_approved',
      deviceId,
      sessionHours: state.sessionHours,
      expiresAt: device.expiresAt,
      role: device.role || 'operator',
    });
  }
  appendLanLog({
    type: 'pair',
    action: 'approved',
    username: device.username,
    deviceId,
    deviceLabel: device.deviceLabel,
  });
  return device;
}

export function rejectOrKickDevice(deviceId, reason = 'kicked') {
  state = getMasterState();
  const fromPending = state.pending.find((d) => d.id === deviceId);
  const fromDev = state.devices.find((d) => d.id === deviceId);
  const device = fromPending || fromDev;
  state.pending = state.pending.filter((d) => d.id !== deviceId);
  state.devices = state.devices.filter((d) => d.id !== deviceId);
  persist();

  const sess = sessions.get(deviceId);
  if (sess) {
    sendLan(sess.channel, { type: 'pair_kicked', reason });
    try {
      sess.channel.close();
      sess.pc.close();
    } catch (e) {}
    sessions.delete(deviceId);
  }
  // release locks held by this device
  for (const [sku, id] of skuLocks.entries()) {
    if (id === deviceId) skuLocks.delete(sku);
  }
  if (device) {
    appendLanLog({
      type: 'pair',
      action: reason,
      username: device.username,
      deviceId,
      deviceLabel: device.deviceLabel,
    });
  }
  return true;
}

export function tryLockSku(sku, deviceId) {
  const key = String(sku || '');
  if (!key) return true;
  const holder = skuLocks.get(key);
  if (holder && holder !== deviceId) return false;
  skuLocks.set(key, deviceId);
  return true;
}

export function unlockSku(sku, deviceId) {
  const key = String(sku || '');
  if (!key) return;
  if (skuLocks.get(key) === deviceId) skuLocks.delete(key);
}

function touchDevice(deviceId) {
  state = getMasterState();
  const d = state.devices.find((x) => x.id === deviceId);
  if (d) {
    d.lastSeen = Date.now();
    persist();
  }
}

function handleIncoming(msg) {
  if (!msg || !msg.type) return;
  const deviceId = msg.deviceId;
  const sess = deviceId ? sessions.get(deviceId) : null;
  const username = (sess && sess.username) || msg.username || '?';

  if (msg.type === 'hello') {
    if (msg.username && msg.deviceId && !sessions.has(msg.deviceId) && activeOffer) {
      sessions.set(msg.deviceId, {
        pc: activeOffer.pc,
        channel: activeOffer.channel,
        username: msg.username,
        deviceLabel: msg.deviceLabel || '',
        role: msg.role === 'viewer' ? 'viewer' : 'operator',
      });
    }
    return;
  }

  if (msg.type === 'heartbeat') {
    if (deviceId) touchDevice(deviceId);
    if (sess) {
      sendLan(sess.channel, { type: 'heartbeat_ack', t: Date.now() });
    }
    return;
  }

  if (msg.type === 'view') {
    appendLanLog({
      type: 'view',
      action: 'view',
      username,
      deviceId,
      deviceLabel: sess && sess.deviceLabel,
      sku: msg.sku,
      name: msg.name || '',
    });
    try {
      window.dispatchEvent(
        new CustomEvent('smouha:lan-remote-view', {
          detail: {
            sku: msg.sku,
            name: msg.name,
            username,
            deviceId,
            deviceLabel: sess && sess.deviceLabel,
            intent: true,
          },
        })
      );
    } catch (e) {}
    return;
  }

  if (msg.type === 'stock_req') {
    try {
      window.dispatchEvent(new CustomEvent('smouha:lan-stock-req', { detail: msg }));
    } catch (e) {}
    return;
  }

  if (msg.type === 'adjust_req') {
    // viewer cannot adjust
    const role = (sess && sess.role) || getDeviceRole(deviceId);
    if (role === 'viewer') {
      replyToDevice(deviceId, {
        type: 'adjust_res',
        reqId: msg.reqId,
        success: false,
        error: { code: 'VIEWER', message: 'Viewer mode — adjust disabled' },
      });
      setLastLanError({ code: 'VIEWER', message: 'Viewer tried adjust' });
      return;
    }
    if (!tryLockSku(msg.sku, deviceId)) {
      replyToDevice(deviceId, {
        type: 'adjust_res',
        reqId: msg.reqId,
        success: false,
        error: {
          code: 'SKU_BUSY',
          message: 'Another device is adjusting this SKU — try again',
        },
      });
      setLastLanError({ code: 'SKU_BUSY', message: 'SKU lock: ' + msg.sku });
      return;
    }
    try {
      window.dispatchEvent(new CustomEvent('smouha:lan-adjust-req', { detail: msg }));
    } catch (e) {}
    return;
  }
}

function getDeviceRole(deviceId) {
  state = getMasterState();
  const d =
    state.devices.find((x) => x.id === deviceId) ||
    state.pending.find((x) => x.id === deviceId);
  return (d && d.role) || 'operator';
}

export function replyToDevice(deviceId, msg) {
  const sess = sessions.get(deviceId);
  if (!sess) return false;
  // unlock after adjust response
  if (msg && msg.type === 'adjust_res' && msg.sku) {
    unlockSku(msg.sku, deviceId);
  }
  return sendLan(sess.channel, msg);
}

export function isDeviceApproved(deviceId) {
  state = getMasterState();
  const now = Date.now();
  return state.devices.some(
    (d) =>
      d.id === deviceId && d.status === 'approved' && (!d.expiresAt || d.expiresAt > now)
  );
}

export function getDeviceRolePublic(deviceId) {
  return getDeviceRole(deviceId);
}

export { getLanLog, clearLanLog, appendLanLog };
