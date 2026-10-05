/**
 * lanClient.js — Mobile client: pair, reconnect, heartbeat, stock/adjust, roles.
 */
import {
  loadMobileSession,
  saveMobileSession,
  genId,
  normalizePinInput,
  packPayload,
  setLastLanError,
} from './lanStore.js';
import { decodeAnySignal, mobileAnswerOffer, sendLan } from './lanTransport.js';
import { playLanSuccess, playLanFail, playLanSoft } from './lanFeedback.js';

let session = loadMobileSession();
let pc = null;
let channel = null;
let connState = 'idle';
let heartbeatTimer = null;
let linkTimer = null;
const pending = new Map();

export function getClientSession() {
  session = loadMobileSession();
  return session;
}

export function isPairedApproved() {
  session = loadMobileSession();
  if (!session || session.status !== 'approved' || !session.deviceId) return false;
  if (session.expiresAt && Date.now() > session.expiresAt) {
    clearClientSession();
    return false;
  }
  return true;
}

export function isViewerRole() {
  session = loadMobileSession();
  return !!(session && session.role === 'viewer');
}

/** Data channel is open, regardless of approval state. */
export function isChannelOpen() {
  return !!(channel && channel.readyState === 'open');
}

export function isLanChannelOpen() {
  return !!(channel && channel.readyState === 'open' && isPairedApproved());
}

export function getConnState() {
  return connState;
}

function closeLink() {
  stopHeartbeat();
  if (linkTimer) clearTimeout(linkTimer);
  linkTimer = null;
  try {
    if (channel) channel.close();
    if (pc) pc.close();
  } catch (e) {}
  channel = null;
  pc = null;
}

export async function clientStartPairFixed({
  offerSignal,
  pin,
  username,
  deviceLabel,
  role,
  deviceId: reuseDeviceId,
}) {
  const uname = String(username || '').trim().slice(0, 32);
  if (!uname) throw new Error('Username required');
  const cleanPin = normalizePinInput(pin);
  if (!/^Ds60\d{4}$/i.test(cleanPin)) throw new Error('PIN must look like Ds60 + 4 digits');

  // Throws a readable message if the QR/paste was cut off or damaged (checksum)
  const offer = await decodeAnySignal(offerSignal);
  if (offer.t !== 'offer') throw new Error('That is the phone Answer — scan the MASTER QR instead');

  closeLink(); // a previous half-open attempt must not linger
  const deviceId = reuseDeviceId || genId('d');
  const deviceRole = role === 'viewer' ? 'viewer' : 'operator';
  const label = String(deviceLabel || '').trim().slice(0, 40);

  const { pc: peer, desc } = await mobileAnswerOffer(
    offer.s,
    (ch) => {
      channel = ch;
      wireClientChannel(ch);
    },
    (st) => {
      connState = st;
      if (st === 'failed') {
        emitStatus('link_failed', {
          hint: 'Connection failed — phone and Master must be on the SAME Wi‑Fi (not guest / mobile data)',
        });
        setLastLanError({ code: 'ICE', message: 'ICE failed — same Wi‑Fi as Master?' });
        stopHeartbeat();
      } else if (st === 'disconnected') {
        emitStatus('master_offline');
        stopHeartbeat();
      }
    }
  );
  pc = peer;

  session = {
    deviceId,
    username: uname,
    deviceLabel: label,
    role: deviceRole,
    status: 'pending',
    pairedAt: Date.now(),
  };
  saveMobileSession(session);
  emitStatus('pending', { channelOpen: false, hint: 'Show this Answer to the Master and wait for Yes' });

  // Nothing opened → tell the user what to check instead of sitting on "Pending"
  linkTimer = setTimeout(() => {
    if (isChannelOpen() || pc !== peer) return;
    emitStatus('link_failed', {
      hint: 'Channel not open yet — Master must scan/paste this Answer (not only press Yes), and both on the same Wi‑Fi',
    });
  }, 45000);

  const answerSignal = await packPayload({
    t: 'answer',
    id: offer.id || null,
    s: desc.sdp,
    u: uname,
    d: deviceId,
    l: label,
    r: deviceRole,
    p: cleanPin,
  });
  // answerBlob kept as an alias: the compact code already carries username/device/PIN
  return { deviceId, username: uname, answerSignal, answerBlob: answerSignal };
}

/**
 * Reconnect: reuse saved username/label/role; user must scan new Offer from Master.
 */
export async function clientReconnectWithOffer({ offerSignal, pin }) {
  session = loadMobileSession();
  if (!session || !session.username) {
    throw new Error('No previous session — pair from scratch');
  }
  return clientStartPairFixed({
    offerSignal,
    pin,
    username: session.username,
    deviceLabel: session.deviceLabel || '',
    role: session.role || 'operator',
    deviceId: session.deviceId, // same identity → Master keeps the approval, no extra slot used
  });
}

function wireClientChannel(ch) {
  let helloTimer = null;
  const hello = () => {
    session = loadMobileSession() || session;
    if (!session || !session.deviceId) return;
    sendLan(ch, {
      type: 'hello',
      deviceId: session.deviceId,
      username: session.username,
      deviceLabel: session.deviceLabel || '',
      role: session.role || 'operator',
    });
  };
  const onOpen = () => {
    connState = 'channel-open';
    if (linkTimer) clearTimeout(linkTimer);
    linkTimer = null;
    // Announce; keep announcing while pending so the Master can re-send a lost Yes
    hello();
    let n = 0;
    helloTimer = setInterval(() => {
      session = loadMobileSession();
      n += 1;
      if (!session || session.status === 'approved' || n > 20 || ch.readyState !== 'open') {
        clearInterval(helloTimer);
        return;
      }
      hello();
    }, 2500);
    startHeartbeat();
    session = loadMobileSession();
    if (session && session.status === 'pending') {
      emitStatus('pending', { channelOpen: true, hint: 'Connected to Master — waiting for Yes' });
    }
  };
  ch.onmessage = (e) => {
    try {
      handleMasterMessage(JSON.parse(e.data));
    } catch (err) {}
  };
  ch.onclose = () => {
    connState = 'channel-closed';
    if (helloTimer) clearInterval(helloTimer);
    stopHeartbeat();
    emitStatus('master_offline');
  };
  ch.onerror = () => {
    connState = 'channel-error';
  };
  ch.onopen = onOpen;
  if (ch.readyState === 'open') onOpen();
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!channel || channel.readyState !== 'open') return;
    session = loadMobileSession();
    if (!session) return;
    sendLan(channel, {
      type: 'heartbeat',
      deviceId: session.deviceId,
      username: session.username,
    });
  }, 18000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function emitStatus(status, extra) {
  try {
    window.dispatchEvent(
      new CustomEvent('smouha:lan-pair-status', { detail: { status, ...(extra || {}) } })
    );
  } catch (e) {}
  updateStatusBadge(status);
}

function handleMasterMessage(msg) {
  if (!msg || !msg.type) return;
  if (msg.type === 'heartbeat_ack') return;

  if (msg.type === 'pair_pending') {
    session = loadMobileSession() || session;
    if (session) {
      session.status = 'pending';
      saveMobileSession(session);
    }
    emitStatus('pending');
    return;
  }
  if (msg.type === 'pair_approved') {
    session = loadMobileSession() || session;
    if (session) {
      session.status = 'approved';
      session.expiresAt = msg.expiresAt || null;
      if (msg.role) session.role = msg.role;
      saveMobileSession(session);
    }
    emitStatus('approved');
    playLanSoft();
    startHeartbeat();
    // Tell the Master the Yes really arrived (it marks the pairing complete on this)
    sendLan(channel, { type: 'pair_approved_ack', deviceId: msg.deviceId });
    try {
      document.documentElement.setAttribute(
        'data-lan-role',
        (session && session.role) || 'operator'
      );
    } catch (e) {}
    try {
      window.dispatchEvent(
        new CustomEvent('smouha:lan-pair-confirmed', {
          detail: { username: session && session.username, role: session && session.role },
        })
      );
    } catch (e) {}
    return;
  }
  if (msg.type === 'pair_kicked') {
    clearClientSession();
    emitStatus('kicked', { reason: msg.reason });
    playLanFail();
    return;
  }
  if (msg.type === 'stock_res' || msg.type === 'adjust_res') {
    const reqId = msg.reqId;
    const p = pending.get(reqId);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(reqId);
      p.resolve(msg);
    }
    if (msg.type === 'adjust_res') {
      if (msg.success) playLanSuccess();
      else {
        playLanFail();
        setLastLanError(msg.error || { message: 'Adjust failed' });
      }
    }
    if (msg.type === 'stock_res' && !msg.ok) {
      setLastLanError({ code: msg.reason, message: msg.reason || 'stock fail' });
    }
    try {
      window.dispatchEvent(new CustomEvent('smouha:lan-client-res', { detail: msg }));
    } catch (e) {}
    return;
  }
  if (msg.type === 'master_offline') {
    emitStatus('master_offline');
    setLastLanError({ message: 'Master offline' });
  }
}

export function clearClientSession() {
  session = null;
  saveMobileSession(null);
  closeLink();
  connState = 'idle';
  pending.forEach((p) => {
    clearTimeout(p.timer);
    p.resolve({ ok: false, success: false, reason: 'cleared' });
  });
  pending.clear();
  updateStatusBadge('idle');
  try {
    document.documentElement.removeAttribute('data-lan-role');
  } catch (e) {}
}

function waitReply(reqId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(reqId);
      resolve({
        type: 'timeout',
        reqId,
        ok: false,
        success: false,
        reason: 'timeout',
        error: { code: 'TIMEOUT', message: 'Master did not respond' },
      });
    }, timeoutMs || 18000);
    pending.set(reqId, { resolve, timer });
  });
}

export function clientSendView({ sku, name }) {
  if (!isLanChannelOpen()) return false;
  session = loadMobileSession();
  return sendLan(channel, {
    type: 'view',
    deviceId: session.deviceId,
    username: session.username,
    sku,
    name: name || '',
  });
}

export async function clientRequestStock(sku) {
  if (!isPairedApproved()) {
    return { ok: false, reason: 'not-paired', onHand: null, reserved: null, price: null };
  }
  if (!isLanChannelOpen()) {
    setLastLanError({ message: 'LAN channel closed' });
    return {
      ok: false,
      reason: 'bridge-offline',
      onHand: null,
      reserved: null,
      price: null,
    };
  }
  session = loadMobileSession();
  const reqId = genId('r');
  const sent = sendLan(channel, {
    type: 'stock_req',
    deviceId: session.deviceId,
    username: session.username,
    sku,
    reqId,
  });
  if (!sent) {
    return {
      ok: false,
      reason: 'bridge-offline',
      onHand: null,
      reserved: null,
      price: null,
    };
  }
  const res = await waitReply(reqId, 18000);
  return {
    ok: !!(res && res.ok),
    reason: res.reason || null,
    onHand: res.onHand != null ? res.onHand : null,
    reserved: res.reserved != null ? res.reserved : null,
    price: res.price != null ? res.price : null,
    via: 'lan',
  };
}

export async function clientRequestAdjust({ sku, quantity, direction }) {
  if (!isPairedApproved()) {
    return { success: false, error: { code: 'NOT_PAIRED', message: 'Not paired to Master' } };
  }
  if (isViewerRole()) {
    playLanFail();
    return {
      success: false,
      error: { code: 'VIEWER', message: 'Viewer mode — adjust disabled' },
    };
  }
  if (!isLanChannelOpen()) {
    playLanFail();
    setLastLanError({ message: 'Master offline' });
    return {
      success: false,
      error: {
        code: 'BRIDGE_OFFLINE',
        message: 'Master offline — reconnect when Master is back',
      },
    };
  }
  session = loadMobileSession();
  const reqId = genId('r');
  const sent = sendLan(channel, {
    type: 'adjust_req',
    deviceId: session.deviceId,
    username: session.username,
    sku,
    quantity,
    direction,
    reqId,
  });
  if (!sent) {
    playLanFail();
    return {
      success: false,
      error: {
        code: 'BRIDGE_OFFLINE',
        message: 'Master offline — reconnect when Master is back',
      },
    };
  }
  return waitReply(reqId, 22000);
}

function updateStatusBadge(status) {
  let el = document.getElementById('lanClientStatusBadge');
  if (!el) {
    el = document.createElement('div');
    el.id = 'lanClientStatusBadge';
    el.setAttribute(
      'style',
      'position:fixed;left:12px;bottom:120px;z-index:41;padding:6px 10px;border-radius:999px;font-size:11px;font-weight:800;box-shadow:0 2px 10px rgba(0,0,0,.15);display:none'
    );
    document.body.appendChild(el);
  }
  const map = {
    idle: null,
    pending: { t: 'LAN · Pending', bg: '#f59e0b', c: '#111' },
    approved: { t: 'LAN · Connected', bg: '#16a34a', c: '#fff' },
    master_offline: { t: 'LAN · Offline', bg: '#dc2626', c: '#fff' },
    link_failed: { t: 'LAN · Not connected', bg: '#dc2626', c: '#fff' },
    kicked: { t: 'LAN · Kicked', bg: '#64748b', c: '#fff' },
  };
  const m = map[status];
  if (!m) {
    el.style.display = 'none';
    return;
  }
  el.style.display = 'block';
  el.style.background = m.bg;
  el.style.color = m.c;
  let extra = '';
  try {
    const s = loadMobileSession();
    if (s && s.role === 'viewer' && status === 'approved') extra = ' · View';
  } catch (e) {}
  el.textContent = m.t + extra;
}

// After a reload the WebRTC channel is gone (it cannot be persisted): never show "Connected" from storage alone.
try {
  const s = loadMobileSession();
  if (s && s.status === 'approved') {
    updateStatusBadge('master_offline');
    document.documentElement.setAttribute('data-lan-role', s.role || 'operator');
  } else if (s && s.status === 'pending') updateStatusBadge('link_failed');
} catch (e) {}
