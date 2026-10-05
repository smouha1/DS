/**
 * lanClient.js — Mobile client: pair, reconnect, heartbeat, stock/adjust, roles.
 */
import {
  loadMobileSession,
  saveMobileSession,
  genId,
  normalizePinInput,
  packSignal,
  unpackSignal,
  setLastLanError,
} from './lanStore.js';
import { decodeSignal, sendLan, waitIceComplete } from './lanTransport.js';
import { playLanSuccess, playLanFail, playLanSoft } from './lanFeedback.js';

let session = loadMobileSession();
let pc = null;
let channel = null;
let connState = 'idle';
let heartbeatTimer = null;
const pending = new Map();
const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

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

export function isLanChannelOpen() {
  return !!(channel && channel.readyState === 'open' && isPairedApproved());
}

export function getConnState() {
  return connState;
}

export async function clientStartPairFixed({
  offerSignal,
  pin,
  expectedPin,
  username,
  deviceLabel,
  role,
}) {
  const uname = String(username || '').trim().slice(0, 32);
  if (!uname) throw new Error('Username required');
  if (normalizePinInput(pin) !== normalizePinInput(expectedPin)) {
    throw new Error('Invalid PIN');
  }
  if (!/^Ds60\d{4}$/i.test(normalizePinInput(pin))) {
    throw new Error('PIN must look like Ds60 + 4 digits');
  }

  let offerRaw = offerSignal;
  const unpacked = await unpackSignal(offerSignal);
  if (unpacked) offerRaw = unpacked;
  const offer = decodeSignal(offerRaw);
  if (!offer) throw new Error('Invalid offer QR/signal');

  const deviceId = genId('d');
  const deviceRole = role === 'viewer' ? 'viewer' : 'operator';
  const label = String(deviceLabel || '').trim().slice(0, 40);
  const peer = new RTCPeerConnection(ICE);

  const channelPromise = new Promise((resolve) => {
    peer.ondatachannel = (ev) => {
      channel = ev.channel;
      wireClientChannel(channel);
      if (channel.readyState === 'open') resolve(channel);
      else channel.onopen = () => resolve(channel);
    };
  });

  peer.onconnectionstatechange = () => {
    connState = peer.connectionState;
    if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
      emitStatus('master_offline');
      stopHeartbeat();
    }
  };

  await peer.setRemoteDescription(offer);
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  // CRITICAL: wait until ICE candidates are in the SDP (900ms was too short → channel never opens)
  await waitIceComplete(peer, 8000);

  pc = peer;
  session = {
    deviceId,
    username: uname,
    deviceLabel: label,
    role: deviceRole,
    status: 'pending',
    pairedAt: Date.now(),
    lastOfferPacked: typeof offerSignal === 'string' ? offerSignal : null,
  };
  saveMobileSession(session);
  emitStatus('pending');

  // When channel opens: hello + keep pinging while still pending so Master can resync Yes
  channelPromise.then((ch) => {
    const hello = () =>
      sendLan(ch, {
        type: 'hello',
        deviceId,
        username: uname,
        deviceLabel: label,
        role: deviceRole,
      });
    hello();
    let n = 0;
    const iv = setInterval(() => {
      n += 1;
      session = loadMobileSession();
      if (!session || session.status === 'approved' || n > 20) {
        clearInterval(iv);
        return;
      }
      if (ch.readyState === 'open') hello();
    }, 2500);
  });

  // Diagnostic: if channel never opens, surface it
  setTimeout(() => {
    session = loadMobileSession();
    if (!session || session.status === 'approved') return;
    if (!channel || channel.readyState !== 'open') {
      emitStatus('pending');
      try {
        window.dispatchEvent(
          new CustomEvent('smouha:lan-pair-status', {
            detail: {
              status: 'pending',
              channelOpen: false,
              hint: 'Channel not open — Master must scan your Answer QR (not only press Yes)',
            },
          })
        );
      } catch (e) {}
    }
  }, 12000);

  const answerSignalRaw = btoa(
    unescape(encodeURIComponent(JSON.stringify(peer.localDescription)))
  );
  const answerSignal = await packSignal(answerSignalRaw);
  return {
    deviceId,
    username: uname,
    answerSignal,
    answerBlob: JSON.stringify({
      answerSignal,
      username: uname,
      deviceId,
      deviceLabel: label,
      role: deviceRole,
    }),
  };
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
    expectedPin: pin,
    username: session.username,
    deviceLabel: session.deviceLabel || '',
    role: session.role || 'operator',
  });
}

function wireClientChannel(ch) {
  ch.onmessage = (e) => {
    try {
      handleMasterMessage(JSON.parse(e.data));
    } catch (err) {}
  };
  ch.onclose = () => {
    connState = 'channel-closed';
    stopHeartbeat();
    emitStatus('master_offline');
  };
  ch.onerror = () => {
    connState = 'channel-error';
  };
  ch.onopen = () => {
    connState = 'channel-open';
    // Re-announce so Master can re-send pair_approved if it was lost
    session = loadMobileSession() || session;
    if (session && session.deviceId) {
      sendLan(ch, {
        type: 'hello',
        deviceId: session.deviceId,
        username: session.username,
        deviceLabel: session.deviceLabel || '',
        role: session.role || 'operator',
      });
    }
    startHeartbeat();
  };
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
  stopHeartbeat();
  try {
    if (channel) channel.close();
    if (pc) pc.close();
  } catch (e) {}
  channel = null;
  pc = null;
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

try {
  const s = loadMobileSession();
  if (s && s.status === 'approved') {
    updateStatusBadge('approved');
    document.documentElement.setAttribute('data-lan-role', s.role || 'operator');
  } else if (s && s.status === 'pending') updateStatusBadge('pending');
} catch (e) {}
