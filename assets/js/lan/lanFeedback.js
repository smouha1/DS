/**
 * lanFeedback.js — short WebAudio beeps + vibration (success light / fail strong).
 */
let audioCtx = null;

function ctx() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  } catch (e) {
    return null;
  }
}

function tone(freq, dur, type, gainVal) {
  const c = ctx();
  if (!c) return;
  try {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type || 'sine';
    o.frequency.value = freq;
    g.gain.value = gainVal != null ? gainVal : 0.06;
    o.connect(g);
    g.connect(c.destination);
    const t0 = c.currentTime;
    o.start(t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.stop(t0 + dur + 0.02);
  } catch (e) {}
}

export function playLanSuccess() {
  tone(880, 0.08, 'sine', 0.05);
  setTimeout(() => tone(1175, 0.1, 'sine', 0.045), 70);
  try {
    if (navigator.vibrate) navigator.vibrate(25);
  } catch (e) {}
}

export function playLanFail() {
  tone(220, 0.14, 'square', 0.05);
  setTimeout(() => tone(160, 0.18, 'square', 0.04), 100);
  try {
    if (navigator.vibrate) navigator.vibrate([40, 30, 40, 30, 80]);
  } catch (e) {}
}

export function playLanSoft() {
  tone(660, 0.06, 'sine', 0.04);
  try {
    if (navigator.vibrate) navigator.vibrate(15);
  } catch (e) {}
}
