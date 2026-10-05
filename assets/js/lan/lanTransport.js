/**
 * lanTransport.js — WebRTC DataChannel (host ICE only → stays on LAN).
 * Signaling is out-of-band via QR / paste (offer + answer JSON).
 */
const ICE = {
  // Host candidates preferred; STUN helps mobile browsers gather candidates on LAN
  // (empty iceServers caused CHANNEL never open on many Android Chrome builds)
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export function waitIceComplete(pc, timeoutMs = 8000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(), timeoutMs);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(t);
        resolve();
      }
    });
  });
}

export function encodeSignal(desc) {
  try {
    return btoa(unescape(encodeURIComponent(JSON.stringify(desc))));
  } catch (e) {
    return '';
  }
}

export function decodeSignal(raw) {
  try {
    const s = String(raw || '').trim();
    return JSON.parse(decodeURIComponent(escape(atob(s))));
  } catch (e) {
    try {
      return JSON.parse(String(raw || ''));
    } catch (e2) {
      return null;
    }
  }
}

/**
 * Master side: create offer + data channel.
 * @returns {Promise<{ pc, channel, offerSignal }>}
 */
export async function masterCreateOffer(onMessage, onState) {
  const pc = new RTCPeerConnection(ICE);
  const channel = pc.createDataChannel('smouha-lan', { ordered: true });
  wireChannel(channel, onMessage, onState);
  pc.onconnectionstatechange = () => {
    if (typeof onState === 'function') onState(pc.connectionState);
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIceComplete(pc);
  const offerSignal = encodeSignal(pc.localDescription);
  return { pc, channel, offerSignal };
}

export async function masterAcceptAnswer(pc, answerRaw) {
  const answer = decodeSignal(answerRaw);
  if (!answer) throw new Error('Invalid answer signal');
  await pc.setRemoteDescription(answer);
}

/**
 * Mobile side: accept offer, create answer.
 */
export async function mobileAcceptOffer(offerRaw, onMessage, onState) {
  const offer = decodeSignal(offerRaw);
  if (!offer) throw new Error('Invalid offer signal');
  const pc = new RTCPeerConnection(ICE);
  pc.ondatachannel = (ev) => {
    wireChannel(ev.channel, onMessage, onState);
  };
  pc.onconnectionstatechange = () => {
    if (typeof onState === 'function') onState(pc.connectionState);
  };
  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitIceComplete(pc);
  const answerSignal = encodeSignal(pc.localDescription);
  return { pc, answerSignal };
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
      if (typeof onMessage === 'function') onMessage(data);
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

/** Resolve when data channel is open (or timeout). */
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
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        channel.removeEventListener('open', onOpen);
      } catch (e) {}
      clearTimeout(timer);
      resolve(ok);
    };
    const onOpen = () => finish(true);
    const timer = setTimeout(() => finish(channel.readyState === 'open'), timeoutMs);
    try {
      channel.addEventListener('open', onOpen);
    } catch (e) {
      finish(false);
    }
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
