/**
 * lanBridge.js — Master executes stock/adjust for mobiles (queued + SKU unlock).
 */
import * as master from './lanMaster.js';
import { appendLanLog, setLastLanError } from './lanStore.js';

let started = false;
let queue = Promise.resolve();
let deps = {
  fetchLive: null,
  adjustStock: null,
  isBridgeOnline: null,
  getWarehouseId: null,
};

export function initLanBridge(d = {}) {
  deps = { ...deps, ...d };
  if (started) return;
  started = true;
  window.addEventListener('smouha:lan-stock-req', (ev) => enqueue(() => handleStock(ev.detail || {})));
  window.addEventListener('smouha:lan-adjust-req', (ev) => enqueue(() => handleAdjust(ev.detail || {})));
}

function enqueue(fn) {
  queue = queue.then(fn, fn);
  return queue;
}

async function handleStock(msg) {
  const { deviceId, reqId, sku, username } = msg;
  if (!master.isDeviceApproved(deviceId)) {
    master.replyToDevice(deviceId, { type: 'stock_res', reqId, ok: false, reason: 'not-approved' });
    return;
  }
  if (typeof deps.isBridgeOnline === 'function' && !deps.isBridgeOnline()) {
    master.replyToDevice(deviceId, {
      type: 'stock_res',
      reqId,
      ok: false,
      reason: 'bridge-offline',
      onHand: null,
      reserved: null,
      price: null,
    });
    setLastLanError({ code: 'BRIDGE_OFFLINE', message: 'Stock denied — extension offline' });
    appendLanLog({ type: 'stock', action: 'deny_offline', username, deviceId, sku });
    return;
  }
  const warehouseId = typeof deps.getWarehouseId === 'function' ? deps.getWarehouseId() : null;
  if (!sku || !warehouseId || typeof deps.fetchLive !== 'function') {
    master.replyToDevice(deviceId, { type: 'stock_res', reqId, ok: false, reason: 'missing-ids' });
    return;
  }
  try {
    const data = await deps.fetchLive(sku, warehouseId, { force: true });
    master.replyToDevice(deviceId, {
      type: 'stock_res',
      reqId,
      ok: !!(data && data.ok),
      reason: (data && data.reason) || null,
      onHand: data ? data.onHand : null,
      reserved: data ? data.reserved : null,
      price: data ? data.price : null,
    });
    appendLanLog({
      type: 'stock',
      action: data && data.ok ? 'ok' : 'fail',
      username,
      deviceId,
      sku,
      onHand: data && data.onHand,
    });
    if (!(data && data.ok)) {
      setLastLanError({ code: data && data.reason, message: 'Stock fail: ' + sku });
    }
  } catch (e) {
    master.replyToDevice(deviceId, {
      type: 'stock_res',
      reqId,
      ok: false,
      reason: 'error',
      message: (e && e.message) || 'error',
    });
    setLastLanError({ message: (e && e.message) || 'stock error' });
  }
}

async function handleAdjust(msg) {
  const deviceId = msg.deviceId;
  const reqId = msg.reqId;
  const sku = msg.sku;
  const quantity = parseInt(msg.quantity, 10);
  const direction = msg.direction === 'increase' ? 'increase' : 'decrease';
  const username = msg.username || '?';

  const finish = (payload) => {
    try {
      master.unlockSku(sku, deviceId);
    } catch (e) {}
    master.replyToDevice(deviceId, { ...payload, sku });
  };

  if (!master.isDeviceApproved(deviceId)) {
    finish({
      type: 'adjust_res',
      reqId,
      success: false,
      error: { code: 'NOT_APPROVED', message: 'Device not approved' },
    });
    return;
  }
  if (typeof deps.isBridgeOnline === 'function' && !deps.isBridgeOnline()) {
    finish({
      type: 'adjust_res',
      reqId,
      success: false,
      error: {
        code: 'BRIDGE_OFFLINE',
        message: 'Master offline / extension disconnected — reconnect when Master is back',
      },
    });
    setLastLanError({ code: 'BRIDGE_OFFLINE', message: 'Adjust denied — offline' });
    appendLanLog({
      type: 'adjust',
      action: 'deny_offline',
      username,
      deviceId,
      sku,
      quantity,
      direction,
    });
    return;
  }
  const warehouseId = typeof deps.getWarehouseId === 'function' ? deps.getWarehouseId() : null;
  if (!sku || !warehouseId || typeof deps.adjustStock !== 'function') {
    finish({
      type: 'adjust_res',
      reqId,
      success: false,
      error: { code: 'MISSING', message: 'Missing warehouse or API' },
    });
    return;
  }
  const qty = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
  try {
    const res = await deps.adjustStock({ sku, warehouseId, quantity: qty, direction });
    finish({
      type: 'adjust_res',
      reqId,
      success: !!(res && res.success),
      error: res && res.error ? res.error : null,
      onHand: res && res.onHand != null ? res.onHand : null,
    });
    appendLanLog({
      type: 'adjust',
      action: res && res.success ? (direction === 'increase' ? 'add' : 'remove') : 'fail',
      username,
      deviceId,
      sku,
      quantity: qty,
      direction,
    });
    if (!(res && res.success)) {
      setLastLanError({
        code: res && res.error && res.error.code,
        message: (res && res.error && res.error.message) || 'Adjust failed',
      });
    }
  } catch (e) {
    finish({
      type: 'adjust_res',
      reqId,
      success: false,
      error: { code: 'ERROR', message: (e && e.message) || 'error' },
    });
    setLastLanError({ message: (e && e.message) || 'adjust error' });
  }
}
