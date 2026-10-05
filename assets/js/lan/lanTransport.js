/**
 * lanTransport.js — WebRTC DataChannel for LAN pairing.
 * Signaling is out-of-band via QR / paste (offer + answer, see packPayload in lanStore).
 */
import { unpackPayload, unpackSignal } from './lanStore.js';

export const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export function countCandidates(sdp) {
  return (String(sdp || '').match(/^a=candidate:/gm) || []).length;
}

/** Resolves true when gathering finished, false on timeout (caller checks candidate count). */
export function waitIceComplete(pc, timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve(true);
      return;
    }
    const done = (ok) => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve(ok);
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') done(true);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

/**
 * Chrome replaces LAN IPs with random "xxxx.local" mDNS names unless the page holds a
 * media permission. Many Wi‑Fi networks drop mDNS multicast, so the peer can never resolve
 * the name and ICE silently fails. Holding a getUserMedia stream while gathering makes
 * Chrome emit real host IPs. Returns a release() function; failure is non-fatal.
 */
export async function holdMediaPermission(order) {
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) return () => {};
  for (const kind of order) {
    const req = md.getUserMedia({ [kind]: true });
    const stream = await Promise.race([
      req.catch(() => null),
      new Promise((r) => setTimeout(() => r(null), 6000)),
    ]);
    if (stream) return () => stream.getTracks().forEach((t) => t.stop());
    req.then((late) => late.getTracks().forEach((t) => t.stop()), () => {});
  }
  return () => {};
}

/**
 * Keep only IPv4 host candidates (LAN). srflx/IPv6 lines only bloat the QR and cannot
 * help on one Wi‑Fi. If filtering would leave nothing, the SDP is returned untouched.
 */
function lanOnlySdp(sdp) {
  const lines = String(sdp).split(/\r?\n/);
  const kept = lines.filter((l) => {
    if (!l.startsWith('a=candidate:')) return true;
    const addr = l.split(' ')[4] || '';
    return !/ typ (srflx|relay)\b/.test(l) && !addr.includes(':');
  });
  return kept.some((l) => l.startsWith('a=candidate:')) ? kept.join('\r\n') : String(sdp);
}

function localDescriptionInit(pc) {
  return { type: pc.localDescription.type, sdp: lanOnlySdp(pc.localDescription.sdp) };
}

/** Legacy base64(JSON(desc)) — still decoded so old QR codes keep working. */
export function decodeSignal(raw) {
  try {
    return JSON.parse(decodeURIComponent(escape(atob(String(raw || '').trim()))));
  } catch (e) {
    try {
      return JSON.parse(String(raw || ''));
    } catch (e2) {
      return null;
    }
  }
}

/** Accepts v2 ("2:…") and legacy ("0:"/"1:"/plain) codes → { t, id, s, … } */
export async function decodeAnySignal(raw) {
  const s = String(raw || '').trim();
  if (s.startsWith('2:')) return unpackPayload(s);
  const text = await unpackSignal(s);
  const desc = decodeSignal(text || s);
  if (!desc || !desc.sdp) throw new Error('Not a valid pair code — scan/copy it again in full');
  return { t: desc.type === 'offer' ? 'offer' : 'answer', id: null, s: desc.sdp };
}

/**
 * Master side: create offer + data channel.
 * @returns {Promise<{ pc, channel, desc }>}
 */
export async function masterCreateOffer(onMessage, onState) {
  const release = await holdMediaPermission(['audio', 'video']);
  let pc;
  try {
    pc = new RTCPeerConnection(ICE_CONFIG);
    const channel = pc.createDataChannel('smouha-lan', { ordered: true });
    wireChannel(channel, onMessage, onState);
    pc.onconnectionstatechange = () => {
      if (typeof onState === 'function') onState(pc.connectionState);
    };
    await pc.setLocalDescription(await pc.createOffer());
    await waitIceComplete(pc);
    const desc = localDescriptionInit(pc);
    if (!countCandidates(desc.sdp)) throw new Error('No network candidates — is Wi‑Fi on? Try again');
    return { pc, channel, desc };
  } catch (e) {
    try {
      if (pc) pc.close();
    } catch (e2) {}
    throw e;
  } finally {
    release();
  }
}

export async function masterAcceptAnswer(pc, answerDesc) {
  // A second answer on the same offer (or an answer for another offer) would never connect.
  if (pc.signalingState !== 'have-local-offer') {
    throw new Error('This QR was already used — press "Show pair QR" again');
  }
  try {
    await pc.setRemoteDescription({ type: 'answer', sdp: answerDesc.sdp });
  } catch (e) {
    throw new Error('Answer does not match this QR — scan the newest QR on the phone and retry');
  }
}

/**
 * Mobile side: accept offer, create answer (candidates fully gathered before returning).
 * @returns {Promise<{ pc, desc }>}
 */
export async function mobileAnswerOffer(offerSdp, onDataChannel, onState) {
  const release = await holdMediaPermission(['video', 'audio']);
  let pc;
  try {
    pc = new RTCPeerConnection(ICE_CONFIG);
    pc.ondatachannel = (ev) => onDataChannel(ev.channel);
    pc.onconnectionstatechange = () => {
      if (typeof onState === 'function') onState(pc.connectionState);
    };
    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await waitIceComplete(pc);
    const desc = localDescriptionInit(pc);
    if (!countCandidates(desc.sdp)) {
      throw new Error('No network candidates — Wi‑Fi on? Allow camera access, then retry');
    }
    return { pc, desc };
  } catch (e) {
    try {
      if (pc) pc.close();
    } catch (e2) {}
    throw e;
  } finally {
    release();
  }
}

function wireChannel(channel, onMessage, onState) {
  channel.onopen = () => {
    if (typeof onState === 'function') onState('channel-open');
  };
  channel.onclose = () => {
    if (typeof onState === 'function') onState('channel-closed');
  };
  channel.onerror = () => {
    if (typeof onState === 'function') onState('channel-error');
  };
  channel.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (typeof onMessage === 'function') onMessage(data, channel);
    } catch (e) {
      /* ignore bad payload */
    }
  };
}

export function sendLan(channel, msg) {
  if (!channel || channel.readyState !== 'open') return false;
  try {
    channel.send(JSON.stringify({ ...msg, ts: Date.now() }));
    return true;
  } catch (e) {
    return false;
  }
}

/** Resolve when data channel is open (false on timeout or if it is closing/closed). */
export function waitChannelOpen(channel, timeoutMs = 12000) {
  return new Promise((resolve) => {
    if (!channel) {
      resolve(false);
      return;
    }
    if (channel.readyState === 'open') {
      resolve(true);
      return;
    }
    if (channel.readyState === 'closing' || channel.readyState === 'closed') {
      resolve(false);
      return;
    }
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      channel.removeEventListener('open', onOpen);
      channel.removeEventListener('close', onClose);
      clearTimeout(timer);
      resolve(ok);
    };
    const onOpen = () => finish(true);
    const onClose = () => finish(false);
    const timer = setTimeout(() => finish(channel.readyState === 'open'), timeoutMs);
    channel.addEventListener('open', onOpen);
    channel.addEventListener('close', onClose);
  });
}

/** Send now, or queue until channel opens (best-effort). */
export function sendLanWhenOpen(channel, msg, timeoutMs = 12000) {
  if (sendLan(channel, msg)) return Promise.resolve(true);
  return waitChannelOpen(channel, timeoutMs).then((ok) => {
    if (!ok) return false;
    return sendLan(channel, msg);
  });
}
