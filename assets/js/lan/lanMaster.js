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
  packPayload,
  normalizePinInput,
  saveMobileSession,
} from './lanStore.js';
import {
  masterCreateOffer,
  masterAcceptAnswer,
  decodeAnySignal,
  sendLan,
  sendLanWhenOpen,
  waitChannelOpen,
} from './lanTransport.js';

let state = loadMasterState();
const sessions = new Map(); // deviceId → { pc, channel, username, deviceLabel, role }
// Every "Show pair QR" gets its own offer; the phone's answer names the offer it belongs to,
// so a newer QR can never steal an older QR's answer (and vice versa).
const offers = new Map(); // offerId → { pc, channel, ctx, createdAt }
const ackWaiters = new Map(); // deviceId → resolve()
const OFFER_TTL_MS = 10 * 60 * 1000;
/** sku → deviceId currently adjusting */
const skuLocks = new Map();

// Sessions/offers live only in this tab's memory — warn before it is closed or reloaded.
window.addEventListener('beforeunload', (e) => {
  if (!sessions.size && !offers.size) return;
  e.preventDefault();
  e.returnValue = '';
});

function emitConn(s, deviceId) {
  try {
    window.dispatchEvent(
      new CustomEvent('smouha:lan-conn', { detail: { role: 'master', state: s, deviceId: deviceId || null } })
    );
  } catch (e) {}
}

function pruneOffers() {
  const now = Date.now();
  for (const [id, o] of offers.entries()) {
    if (now - o.createdAt < OFFER_TTL_MS) continue;
    try {
      o.pc.close();
    } catch (e) {}
    offers.delete(id);
  }
}

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
  // Master PC must not keep a mobile pair session — that stole stock path into LAN loop
  if (state.enabled) {
    try { saveMobileSession(null); } catch (e) {}
  }
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

  pruneOffers();
  const pin = getFullPin();
  const ctx = { deviceId: null }; // filled once this offer's answer is accepted
  const { pc, channel, desc } = await masterCreateOffer(handleIncoming, (s) => {
    emitConn(s, ctx.deviceId);
    if (s === 'failed' && ctx.deviceId) {
      setLastLanError({
        code: 'ICE',
        message: 'Connection to phone failed — same Wi‑Fi? Guest Wi‑Fi / AP isolation blocks LAN',
      });
    }
  });
  const offerId = genId('o');
  offers.set(offerId, { pc, channel, ctx, createdAt: Date.now() });
  const offerSignal = await packPayload({ t: 'offer', id: offerId, s: desc.sdp });
  return {
    offerSignal,
    offerId,
    pin,
    masterId: state.masterId,
    masterName: state.masterName,
  };
}

export async function completePairWithAnswer({
  answerDesc,
  offerId,
  pin,
  username,
  deviceId,
  deviceLabel,
  role,
}) {
  state = getMasterState();
  if (!state.enabled) throw new Error('Master is off');

  const uname = String(username || '').trim().slice(0, 32);
  if (!uname) throw new Error('Username required');
  if (!pin) throw new Error('Phone app is outdated — reload it (close & reopen) and pair again');
  if (normalizePinInput(pin) !== normalizePinInput(getFullPin())) {
    throw new Error('Wrong PIN on the phone — compare with the PIN shown here (Rotate PIN changes it)');
  }

  const id = deviceId || genId('d');
  const now = Date.now();
  // Same phone pairing again (reconnect): keeps its approval, no second slot used.
  const known = state.devices.find(
    (d) => d.id === id && d.status === 'approved' && (!d.expiresAt || d.expiresAt > now)
  );
  if (!known && approvedCount() >= state.maxDevices) throw new Error('Device limit reached');

  // Legacy offers carry no id → newest offer
  const key = offerId || [...offers.keys()].pop();
  const offer = key ? offers.get(key) : null;
  if (!offer) {
    throw new Error('QR expired or created in another tab — press "Show pair QR" in THIS tab and scan it again');
  }

  await masterAcceptAnswer(offer.pc, answerDesc);
  offers.delete(key);
  offer.ctx.deviceId = id;

  const old = sessions.get(id);
  if (old && old.pc !== offer.pc) {
    try {
      old.pc.close();
    } catch (e) {}
  }

  const label = String(deviceLabel || '').trim().slice(0, 40);
  const deviceRole = role === 'viewer' ? 'viewer' : 'operator';
  const device = {
    id,
    username: uname,
    deviceLabel: label,
    role: deviceRole,
    status: known ? 'approved' : 'pending',
    pairedAt: now,
    expiresAt: known ? known.expiresAt : state.sessionHours > 0 ? now + state.sessionHours * 3600 * 1000 : null,
    lastSeen: now,
  };
  state.pending = state.pending.filter((d) => d.id !== id);
  if (known) state.devices = [device, ...state.devices.filter((d) => d.id !== id)];
  else state.pending.unshift(device);
  persist();

  sessions.set(id, {
    pc: offer.pc,
    channel: offer.channel,
    username: uname,
    deviceLabel: label,
    role: deviceRole,
  });

  // Answer accepted ≠ connected. If ICE cannot connect, say so instead of staying "Pending" forever.
  waitChannelOpen(offer.channel, 20000).then((ok) => {
    const cur = sessions.get(id);
    if (ok || !cur || cur.channel !== offer.channel) return;
    setLastLanError({
      code: 'ICE',
      message: 'Answer accepted but the channel did not open in 20s — same Wi‑Fi? (guest Wi‑Fi / AP isolation blocks LAN)',
    });
    emitConn('link-timeout', id);
  });

  if (known) deliverApproval(id, device);
  else sendLanWhenOpen(offer.channel, { type: 'pair_pending', deviceId: id, masterName: state.masterName }, 20000);

  appendLanLog({
    type: 'pair',
    action: known ? 'reconnected' : 'pending',
    username: uname,
    deviceId: id,
    deviceLabel: label,
    role: deviceRole,
  });
  return device;
}

async function parseAnswerBlob(raw) {
  const text = typeof raw === 'string' ? raw.trim() : raw;
  if (typeof text === 'string' && text.startsWith('2:')) {
    const p = await decodeAnySignal(text);
    if (p.t !== 'answer') throw new Error('That is the Master QR — scan the phone ANSWER instead');
    return {
      answerDesc: { sdp: p.s },
      offerId: p.id || null,
      pin: p.p,
      username: p.u,
      deviceId: p.d,
      deviceLabel: p.l,
      role: p.r,
    };
  }
  // Legacy JSON blob { answerSignal, username, deviceId, … } — has no PIN, so completePair rejects it
  let data = text;
  if (typeof text === 'string') {
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('Answer is cut off or invalid — paste the full text from the phone');
    }
  }
  if (!data || !data.answerSignal) throw new Error('Answer is cut off or invalid — paste the full text from the phone');
  const legacy = await decodeAnySignal(data.answerSignal);
  return {
    answerDesc: { sdp: legacy.s },
    offerId: null,
    pin: data.pin,
    username: data.username,
    deviceId: data.deviceId,
    deviceLabel: data.deviceLabel,
    role: data.role,
  };
}

export async function ingestMobileAnswerBlob(raw) {
  return completePairWithAnswer(await parseAnswerBlob(raw));
}

function waitAck(deviceId, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ackWaiters.delete(deviceId);
      resolve(false);
    }, ms);
    ackWaiters.set(deviceId, () => {
      clearTimeout(timer);
      ackWaiters.delete(deviceId);
      resolve(true);
    });
  });
}

/**
 * Deliver pair_approved over the live channel.
 * @returns {Promise<'acked'|'sent'|false>} acked = phone confirmed; sent = written to an open
 * channel but no ack (older phone build); false = channel never opened.
 */
async function deliverApproval(deviceId, device) {
  const sess = sessions.get(deviceId);
  if (!sess) return false;
  const payload = {
    type: 'pair_approved',
    deviceId,
    sessionHours: state.sessionHours,
    expiresAt: device.expiresAt,
    role: device.role || 'operator',
  };
  const deadline = Date.now() + 12000;
  let sent = false;
  while (Date.now() < deadline) {
    if (!(await waitChannelOpen(sess.channel, Math.max(500, deadline - Date.now())))) break;
    if (sendLan(sess.channel, payload)) {
      sent = true;
      if (await waitAck(deviceId, 1800)) return 'acked';
    }
  }
  return sent ? 'sent' : false;
}

/** Yes: only becomes "approved" once pair_approved actually went out on a live channel. */
export async function approveDevice(deviceId) {
  state = getMasterState();
  const device =
    state.pending.find((d) => d.id === deviceId) || state.devices.find((d) => d.id === deviceId);
  if (!device) return null;
  if (device.status !== 'approved' && approvedCount() >= state.maxDevices) {
    throw new Error('Device limit reached');
  }
  const fail = (code, message) => {
    const err = Object.assign(new Error(message), { code });
    setLastLanError(err);
    throw err;
  };
  if (!sessions.has(deviceId)) {
    fail('NO_SESSION', 'No live channel to this phone in THIS tab — use the tab that showed the QR, or pair again');
  }
  const result = await deliverApproval(deviceId, device);
  if (!result) {
    fail('CHANNEL', 'Phone did not get Yes — channel not open (same Wi‑Fi?). Still Pending, nothing saved');
  }

  state = getMasterState(); // re-read: other tabs may have written during the await
  const approved = { ...device, status: 'approved', lastSeen: Date.now() };
  state.pending = state.pending.filter((d) => d.id !== deviceId);
  state.devices = [approved, ...state.devices.filter((d) => d.id !== deviceId)];
  const sess = sessions.get(deviceId);
  if (sess) sess.role = approved.role || 'operator';
  persist();
  appendLanLog({
    type: 'pair',
    action: 'approved',
    username: approved.username,
    deviceId,
    deviceLabel: approved.deviceLabel,
  });
  if (result === 'sent') {
    setLastLanError({
      code: 'NO_ACK',
      message: 'Yes sent but the phone did not confirm — reload the phone app if it still shows Pending',
    });
  }
  return approved;
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

function handleIncoming(msg, channel) {
  if (!msg || !msg.type) return;
  const deviceId = msg.deviceId;
  const sess = deviceId ? sessions.get(deviceId) : null;
  // A device may only speak on the channel its own session owns (no spoofing, no stale-channel mixups)
  if (sess && channel && sess.channel !== channel) return;
  const username = (sess && sess.username) || msg.username || '?';

  if (msg.type === 'pair_approved_ack') {
    const w = ackWaiters.get(deviceId);
    if (w) w();
    return;
  }

  if (msg.type === 'hello') {
    // The session was bound to this exact channel when the answer was accepted.
    // Never rebind it to "the current offer" — a newer QR would replace a working channel with a dead one.
    if (!sess) return;
    if (msg.username) sess.username = msg.username;
    sess.deviceLabel = msg.deviceLabel || sess.deviceLabel || '';
    if (msg.role === 'viewer') sess.role = 'viewer';
    // Re-sync approval state (recovers a lost pair_approved)
    state = getMasterState();
    const now = Date.now();
    const approved = state.devices.find(
      (d) => d.id === deviceId && d.status === 'approved' && (!d.expiresAt || d.expiresAt > now)
    );
    if (approved) {
      sendLan(channel, {
        type: 'pair_approved',
        deviceId,
        sessionHours: state.sessionHours,
        expiresAt: approved.expiresAt,
        role: approved.role || sess.role || 'operator',
      });
    } else if (state.pending.some((d) => d.id === deviceId)) {
      sendLan(channel, { type: 'pair_pending', deviceId, masterName: state.masterName });
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
  if (!sess || !sess.channel) {
    try {
      setLastLanError({ code: 'NO_SESSION', message: 'No open channel for device ' + (deviceId || '?') });
    } catch (e) {}
    return false;
  }
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

/** Push pair_approved again to every approved device whose channel is open. */
export function resyncApprovedDevices() {
  state = getMasterState();
  const now = Date.now();
  let sent = 0;
  let offline = 0;
  for (const d of state.devices) {
    if (d.status !== 'approved') continue;
    if (d.expiresAt && d.expiresAt <= now) continue;
    const sess = sessions.get(d.id);
    const ok =
      sess &&
      sendLan(sess.channel, {
        type: 'pair_approved',
        deviceId: d.id,
        sessionHours: state.sessionHours,
        expiresAt: d.expiresAt,
        role: d.role || 'operator',
      });
    if (ok) sent += 1;
    else offline += 1;
  }
  return { sent, offline };
}

/** 'open' | 'connecting' | 'failed' | 'none' (no live session in THIS tab) */
export function getLinkState(deviceId) {
  const s = sessions.get(deviceId);
  if (!s) return 'none';
  if (s.channel && s.channel.readyState === 'open') return 'open';
  const cs = s.pc && s.pc.connectionState;
  if (cs === 'failed' || cs === 'closed' || (s.channel && s.channel.readyState === 'closed')) return 'failed';
  return 'connecting';
}

export function getDeviceRolePublic(deviceId) {
  return getDeviceRole(deviceId);
}

export { getLanLog, clearLanLog, appendLanLog };
