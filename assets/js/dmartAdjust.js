/* ============================================================================
   dmartAdjust.js — stock adjust UI (modal, panel, boost, bridge postMessage)
   ------------------------------------------------------------------------
   Extracted from dmartLive.js. Call initDmartAdjust({...}) once from dmartLive
   after live helpers exist.
   ============================================================================ */

import { getSelectedId, getSelected, getDisplayName } from './warehouse.js';

const ADJUST_MAX_DEFAULT = 5;
const ADJUST_MAX_BOOST = 20;
let boostMaxOnce = false;
let boostMaxTimer = null;

/** @type {{
 *  isBridgeOnline?: () => boolean,
 *  isDesktopViewport?: () => boolean,
 *  setLiveValues?: (root: Element, data: object) => void,
 *  invalidateCacheKey?: (key: string) => void,
 * }} */
let api = {};

export function initDmartAdjust(deps = {}) {
  api = deps || {};
  wireAdjustHotkeys();
}

function isBridgeOnline() {
  return typeof api.isBridgeOnline === 'function' ? !!api.isBridgeOnline() : false;
}

function isDesktopViewport() {
  if (typeof api.isDesktopViewport === 'function') return !!api.isDesktopViewport();
  try {
    return window.matchMedia('(min-width: 900px)').matches;
  } catch (e) {
    return window.innerWidth >= 900;
  }
}

function setLiveValues(root, data) {
  if (typeof api.setLiveValues === 'function') api.setLiveValues(root, data);
}

function invalidateCacheKey(key) {
  if (typeof api.invalidateCacheKey === 'function') api.invalidateCacheKey(key);
}

function requestStockAdjust({ sku, warehouseId, quantity, direction }) {
  return new Promise((resolve) => {
    const requestId = 'adj_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      window.removeEventListener('message', onMsg);
      resolve({ success: false, error: { code: 'TIMEOUT', message: 'Bridge timed out' } });
    }, 20000);

    function onMsg(event) {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== 'smouha-dmart-bridge') return;
      if (data.type !== 'SMOUHA_PICK_DMART_STOCK_ADJUST_RESPONSE') return;
      if (data.requestId !== requestId) return;
      if (done) return;
      done = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMsg);
      resolve(data);
    }
    window.addEventListener('message', onMsg);
    try {
      window.postMessage(
        {
          type: 'SMOUHA_PICK_DMART_STOCK_ADJUST',
          requestId,
          sku: String(sku),
          warehouseId: String(warehouseId),
          quantity: Number(quantity) || 1,
          direction: direction === 'decrease' ? 'decrease' : 'increase',
        },
        window.location.origin
      );
    } catch (e) {
      clearTimeout(timer);
      window.removeEventListener('message', onMsg);
      resolve({ success: false, error: { code: 'POST_FAILED', message: String(e && e.message || e) } });
    }
  });
}

function getAdjustMax() {
  return boostMaxOnce ? ADJUST_MAX_BOOST : ADJUST_MAX_DEFAULT;
}

function showCenterToast(html, className, ms) {
  let el = document.getElementById('dmartCenterToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'dmartCenterToast';
    el.className = 'dmart-center-toast';
    el.setAttribute('aria-live', 'assertive');
    document.body.appendChild(el);
  }
  el.className = 'dmart-center-toast ' + (className || '');
  el.innerHTML = html;
  el.classList.add('is-visible');
  clearTimeout(showCenterToast._t);
  showCenterToast._t = setTimeout(() => {
    el.classList.remove('is-visible');
  }, ms || 1200);
}

function enableBoostMaxOnce() {
  boostMaxOnce = true;
  showCenterToast('<div class="dmart-toast-card is-boost"><span class="dmart-toast-on">On</span><div class="dmart-toast-label">Max 20 once</div></div>', 'is-boost', 1100);
  document.querySelectorAll('.dmart-adjust-qty').forEach((inp) => {
    inp.max = String(ADJUST_MAX_BOOST);
  });
  if (boostMaxTimer) clearTimeout(boostMaxTimer);
  boostMaxTimer = setTimeout(() => {
    clearBoostMaxOnce();
  }, 30000);
}

function clearBoostMaxOnce() {
  boostMaxOnce = false;
  if (boostMaxTimer) {
    clearTimeout(boostMaxTimer);
    boostMaxTimer = null;
  }
  document.querySelectorAll('.dmart-adjust-qty').forEach((inp) => {
    inp.max = String(ADJUST_MAX_DEFAULT);
    const n = parseInt(inp.value, 10);
    if (Number.isFinite(n) && n > ADJUST_MAX_DEFAULT) inp.value = String(ADJUST_MAX_DEFAULT);
  });
}

function getProductContext(sku) {
  const imgEl = document.getElementById('prodImg');
  const nameEl = document.querySelector('.product-name-under-img') || document.querySelector('.product-name');
  let name = nameEl ? (nameEl.textContent || '').trim() : '';
  let image = imgEl ? (imgEl.currentSrc || imgEl.src || '') : '';
  if (!name) name = 'SKU ' + sku;
  return { name, image, sku: String(sku) };
}

function getWarehouseLabel() {
  try {
    const wh = getSelected();
    if (wh) return getDisplayName(wh) || wh.name || 'Warehouse';
  } catch (e) {}
  return 'Warehouse';
}

function readAvailableNumber(root) {
  try {
    const el = root && root.querySelector('[data-live="available"]');
    if (!el) return null;
    const m = String(el.textContent || '').match(/-?\d+/);
    return m ? parseInt(m[0], 10) : null;
  } catch (e) {
    return null;
  }
}

function ensureAdjustModal() {
  let modal = document.getElementById('dmartAdjustModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'dmartAdjustModal';
  modal.className = 'dmart-adjust-modal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="dmart-adjust-modal-backdrop" data-adj-cancel></div>
    <div class="dmart-adjust-modal-card" role="dialog" aria-modal="true" aria-labelledby="dmartAdjTitle">
      <div class="dmart-adj-glow" aria-hidden="true"></div>
      <div class="dmart-adj-shell">
        <header class="dmart-adj-head">
          <div class="dmart-adj-badge" id="dmartAdjBadge">Stock</div>
          <h2 id="dmartAdjTitle" class="dmart-adj-title">Confirm change</h2>
        </header>

        <div class="dmart-adj-hero">
          <div class="dmart-adj-hero-delta" id="dmartAdjDelta">−2</div>
          <div class="dmart-adj-hero-label" id="dmartAdjAction">Decrease · 2</div>
        </div>

        <div class="dmart-adj-product">
          <div class="dmart-adj-img-wrap" id="dmartAdjImgWrap">
            <img id="dmartAdjImg" alt="" />
            <div class="dmart-adj-img-fallback" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
            </div>
          </div>
          <div class="dmart-adj-product-meta">
            <div class="dmart-adj-name" id="dmartAdjName"></div>
            <div class="dmart-adj-sku-line">SKU <span id="dmartAdjSku"></span></div>
          </div>
        </div>

        <ul class="dmart-adj-meta" role="list">
          <li><span class="dmart-adj-k">Available now</span><span class="dmart-adj-v" id="dmartAdjAvail">—</span></li>
          <li><span class="dmart-adj-k">Warehouse</span><span class="dmart-adj-v" id="dmartAdjWh">—</span></li>
        </ul>

        <div class="dmart-adj-warn" dir="rtl">
          <svg class="dmart-adj-warn-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><circle cx="12" cy="12" r="10"/></svg>
          <span>ميزة الحذف والإضافة متاحة حصرياً لفرع Smouha DS60 لدواعي الأمان</span>
        </div>

        <div class="dmart-adj-actions">
          <button type="button" class="dmart-adj-btn dmart-adj-cancel" data-adj-cancel>Cancel</button>
          <button type="button" class="dmart-adj-btn dmart-adj-confirm" data-adj-confirm>
            <span class="dmart-adj-confirm-label">Confirm</span>
          </button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  // Hover preview / mobile enlarge for modal image
  const wrap = modal.querySelector('#dmartAdjImgWrap');
  const img = modal.querySelector('#dmartAdjImg');
  let hoverLayer = null;
  wrap.addEventListener('mouseenter', () => {
    if (window.matchMedia('(max-width: 899px)').matches) return;
    if (!img.src) return;
    hoverLayer = document.createElement('div');
    hoverLayer.className = 'dmart-adj-hover-preview';
    hoverLayer.innerHTML = '<img alt="" />';
    hoverLayer.querySelector('img').src = img.src;
    document.body.appendChild(hoverLayer);
  });
  wrap.addEventListener('mousemove', (e) => {
    if (!hoverLayer) return;
    hoverLayer.style.left = Math.min(window.innerWidth - 280, e.clientX + 18) + 'px';
    hoverLayer.style.top = Math.min(window.innerHeight - 280, e.clientY + 18) + 'px';
  });
  wrap.addEventListener('mouseleave', () => {
    if (hoverLayer) { hoverLayer.remove(); hoverLayer = null; }
  });
  wrap.addEventListener('click', () => {
    if (!img.src) return;
    if (window.matchMedia('(min-width: 900px)').matches) return;
    // mobile enlarge
    let big = document.getElementById('dmartAdjImgBig');
    if (!big) {
      big = document.createElement('div');
      big.id = 'dmartAdjImgBig';
      big.className = 'dmart-adj-img-big';
      big.innerHTML = '<img alt="" /><button type="button" class="dmart-adj-img-big-close" aria-label="Close">×</button>';
      document.body.appendChild(big);
      big.addEventListener('click', (ev) => {
        if (ev.target === big || ev.target.classList.contains('dmart-adj-img-big-close')) big.hidden = true;
      });
    }
    big.querySelector('img').src = img.src;
    big.hidden = false;
  });

  return modal;
}

function openAdjustConfirm({ sku, direction, quantity, available }) {
  return new Promise((resolve) => {
    const modal = ensureAdjustModal();
    const ctx = getProductContext(sku);
    const isInc = direction === 'increase';
    const img = modal.querySelector('#dmartAdjImg');
    const nameEl = modal.querySelector('#dmartAdjName');
    img.src = ctx.image || '';
    img.alt = ctx.name || '';
    img.style.display = ctx.image ? '' : 'none';
    nameEl.textContent = ctx.name || ('SKU ' + sku);
    modal.querySelector('#dmartAdjSku').textContent = sku;
    modal.querySelector('#dmartAdjAvail').textContent =
      available != null && Number.isFinite(available) ? String(available) + ' units' : '—';
    modal.querySelector('#dmartAdjWh').textContent = getWarehouseLabel();
    const act = modal.querySelector('#dmartAdjAction');
    act.textContent = (isInc ? 'Increase stock' : 'Decrease stock') + ' · ' + quantity;
    act.className = 'dmart-adj-hero-label';
    const delta = modal.querySelector('#dmartAdjDelta');
    if (delta) {
      delta.textContent = (isInc ? '+' : '−') + quantity;
      delta.className = 'dmart-adj-hero-delta ' + (isInc ? 'is-inc' : 'is-dec');
    }
    const badge = modal.querySelector('#dmartAdjBadge');
    if (badge) {
      badge.textContent = isInc ? 'Add' : 'Remove';
      badge.className = 'dmart-adj-badge ' + (isInc ? 'is-inc' : 'is-dec');
    }
    const title = modal.querySelector('#dmartAdjTitle');
    if (title) title.textContent = isInc ? 'Confirm add to stock' : 'Confirm remove from stock';
    const confirmLabel = modal.querySelector('.dmart-adj-confirm-label');
    if (confirmLabel) confirmLabel.textContent = isInc ? 'Add to stock' : 'Remove from stock';
    const card = modal.querySelector('.dmart-adjust-modal-card');
    if (card) {
      card.classList.toggle('is-inc', isInc);
      card.classList.toggle('is-dec', !isInc);
    }

    const confirmBtn = modal.querySelector('[data-adj-confirm]');
    confirmBtn.disabled = false;
    modal.classList.remove('is-closing');
    modal.hidden = false;
    // force reflow so enter animation restarts every open
    void modal.offsetWidth;
    modal.classList.add('is-open');
    document.body.classList.add('dmart-modal-open');
    setTimeout(() => { try { confirmBtn.focus(); } catch (e) {} }, 80);

    let settled = false;
    function close(val) {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      modal.removeEventListener('click', onClick);
      modal.classList.remove('is-open');
      modal.classList.add('is-closing');
      const finish = () => {
        modal.classList.remove('is-closing');
        modal.hidden = true;
        document.body.classList.remove('dmart-modal-open');
        resolve(val);
      };
      let done = false;
      const once = () => {
        if (done) return;
        done = true;
        finish();
      };
      const card = modal.querySelector('.dmart-adjust-modal-card');
      if (card) {
        card.addEventListener('animationend', once, { once: true });
        setTimeout(once, 320);
      } else {
        setTimeout(once, 220);
      }
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (confirmBtn.disabled) return;
        confirmBtn.disabled = true;
        close(true);
      }
    }
    function onClick(e) {
      const t = e.target;
      if (t.closest('[data-adj-cancel]')) close(false);
      if (t.closest('[data-adj-confirm]')) {
        if (confirmBtn.disabled) return;
        confirmBtn.disabled = true;
        close(true);
      }
    }
    document.addEventListener('keydown', onKey);
    modal.addEventListener('click', onClick);
  });
}

function playSuccessOverlay(direction, quantity) {
  const isInc = direction === 'increase';
  const sign = isInc ? '+' : '−';
  const label = isInc ? ('Added ' + quantity) : ('Removed ' + quantity);
  const colorClass = isInc ? 'is-inc' : 'is-dec';
  showCenterToast(
    '<div class="dmart-toast-card ' + colorClass + '">' +
      '<div class="dmart-toast-delta">' + sign + quantity + '</div>' +
      '<div class="dmart-toast-label">' + label + '</div>' +
    '</div>',
    'is-result',
    1400
  );
}

function playFailOverlay() {
  showCenterToast(
    '<div class="dmart-toast-card is-fail">' +
      '<div class="dmart-toast-fail" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>' +
      '</div>' +
      '<div class="dmart-toast-label">Failed</div>' +
    '</div>',
    'is-fail',
    1200
  );
}

function blinkAvailable(root, times) {
  const row = root.querySelector('.dmart-live-available-row') || root.querySelector('[data-live="available"]');
  if (!row) return;
  let n = 0;
  const max = times || 4;
  // 4× longer than original (~90/70ms → ~360/280ms)
  function tick() {
    row.classList.add('dmart-avail-blink-off');
    setTimeout(() => {
      row.classList.remove('dmart-avail-blink-off');
      n += 1;
      if (n < max) setTimeout(tick, 280);
    }, 360);
  }
  tick();
}

function playCardDrop(root) {
  try {
    root.classList.remove('dmart-card-shake', 'dmart-card-drop', 'dmart-card-avail-pop', 'dmart-card-type');
    void root.offsetWidth;
    // 1) typewriter / draw reveal of whole card
    root.classList.add('dmart-card-type');
    setTimeout(() => {
      root.classList.remove('dmart-card-type');
      // 2) strong drop impact
      void root.offsetWidth;
      root.classList.add('dmart-card-drop');
      setTimeout(() => root.classList.remove('dmart-card-drop'), 750);
    }, 760);
  } catch (e) {}
}

function buildAdjustPanelHtml(sku) {
  const safe = String(sku || '').replace(/"/g, '');
  return `
    <div class="dmart-adjust-panel" data-adjust-sku="${safe}" hidden>
      <div class="dmart-adjust-title">
        <span class="dmart-adjust-title-text">Adjust stock</span>
        <span class="dmart-adjust-title-hint">1–5 units</span>
      </div>
      <div class="dmart-adjust-row" role="group" aria-label="Quantity">
        <button type="button" class="dmart-adjust-btn dmart-adjust-minus" data-adj="minus" aria-label="Decrease">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 12h12"/></svg>
        </button>
        <div class="dmart-adjust-qty-wrap">
          <input type="number" class="dmart-adjust-qty" min="1" max="5" value="1" inputmode="numeric" aria-label="Quantity" />
        </div>
        <button type="button" class="dmart-adjust-btn dmart-adjust-plus" data-adj="plus" aria-label="Increase">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 6v12M6 12h12"/></svg>
        </button>
      </div>
      <div class="dmart-adjust-msg" data-adj-msg hidden></div>
    </div>`;
}

function bindAdjustPanel(root, sku) {
  if (!root || !sku) return;
  const panel = root.querySelector('.dmart-adjust-panel');
  if (!panel || panel.dataset.bound === '1') return;
  panel.dataset.bound = '1';
  const qtyInput = panel.querySelector('.dmart-adjust-qty');
  const msg = panel.querySelector('[data-adj-msg]');

  function clampQty(fromInput) {
    const max = getAdjustMax();
    qtyInput.max = String(max);
    let raw = qtyInput.value;
    let n = parseInt(raw, 10);
    let invalid = false;
    if (!Number.isFinite(n)) {
      n = 1;
      invalid = !!String(raw).trim();
    }
    if (n > max || n < 1) invalid = true;
    n = Math.min(max, Math.max(1, n));
    qtyInput.value = String(n);
    if (invalid && fromInput) {
      qtyInput.classList.remove('is-shake');
      void qtyInput.offsetWidth;
      qtyInput.classList.add('is-shake');
      setTimeout(() => qtyInput.classList.remove('is-shake'), 450);
      if (msg) {
        msg.hidden = false;
        msg.className = 'dmart-adjust-msg is-err';
        msg.textContent = 'Allowed: 1–' + max;
      }
    }
    return n;
  }

  async function run(direction) {
    if (!isBridgeOnline()) {
      if (msg) {
        msg.hidden = false;
        msg.textContent = 'Offline';
        msg.className = 'dmart-adjust-msg is-err';
      }
      playFailOverlay();
      try {
        root.classList.remove('dmart-card-shake');
        void root.offsetWidth;
        root.classList.add('dmart-card-shake');
        setTimeout(() => root.classList.remove('dmart-card-shake'), 700);
      } catch (e) {}
      return;
    }
    if (!isDesktopViewport()) return;
    const quantity = clampQty();
    const warehouseId = getSelectedId();
    if (!warehouseId) {
      if (msg) {
        msg.hidden = false;
        msg.textContent = 'Select a warehouse first';
        msg.className = 'dmart-adjust-msg is-err';
      }
      return;
    }

    const available = readAvailableNumber(root);
    const confirmed = await openAdjustConfirm({ sku, direction, quantity, available });
    if (!confirmed) return;

    panel.classList.add('is-busy');
    panel.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    if (msg) {
      msg.hidden = false;
      msg.className = 'dmart-adjust-msg';
      msg.textContent = 'Working…';
    }

    const res = await requestStockAdjust({ sku, warehouseId, quantity, direction });
    panel.classList.remove('is-busy');
    panel.querySelectorAll('button').forEach((b) => { b.disabled = false; });

    if (!res || !res.success) {
      const err = (res && res.error) || {};
      if (msg) {
        msg.hidden = false;
        msg.className = 'dmart-adjust-msg is-err';
        msg.textContent = (err.code || 'ERROR') + (err.message ? ': ' + err.message : '');
        if (/reload this page|not reachable|invalidated/i.test(String(err.message || ''))) {
          msg.textContent = 'Refresh this page (F5) after updating the extension, then try again';
        }
      }
      playFailOverlay();
      try {
        root.classList.remove('dmart-card-shake');
        void root.offsetWidth;
        root.classList.add('dmart-card-shake');
        setTimeout(() => root.classList.remove('dmart-card-shake'), 700);
      } catch (e) {}
      return;
    }

    const d = res.data || {};
    if (msg) {
      msg.hidden = false;
      msg.className = 'dmart-adjust-msg is-ok';
      msg.textContent =
        'OK ' +
        (d.stock_delta > 0 ? '+' : '') +
        d.stock_delta +
        (d.location ? ' · ' + d.location : '') +
        (d.available != null ? ' · on hand ' + d.available : '');
    }

    playSuccessOverlay(direction, quantity);

    const applyValues = () => {
      if (d.available != null || d.reserved != null || d.price != null) {
        setLiveValues(root, {
          onHand: d.available != null ? d.available : null,
          reserved: d.reserved != null ? d.reserved : null,
          price: d.price != null ? d.price : null,
          ok: true,
        });
      }
      try {
        const key = String(warehouseId) + '::' + String(sku);
        cache.delete(key);
      } catch (e) {}
    };

    try {
      applyValues();
      blinkAvailable(root, 4);
      try {
        root.classList.remove('dmart-card-avail-pop');
        void root.offsetWidth;
        root.classList.add('dmart-card-avail-pop');
        setTimeout(() => root.classList.remove('dmart-card-avail-pop'), 500);
      } catch (e) {}
      playCardDrop(root);
    } catch (e) {
      applyValues();
    }
  }

  panel.querySelector('[data-adj="minus"]')?.addEventListener('click', () => run('decrease'));
  panel.querySelector('[data-adj="plus"]')?.addEventListener('click', () => run('increase'));
  qtyInput?.addEventListener('change', () => clampQty(true));
  qtyInput?.addEventListener('input', () => {
    const max = getAdjustMax();
    const n = parseInt(qtyInput.value, 10);
    if (Number.isFinite(n) && (n > max || n < 1)) clampQty(true);
  });
}

export { buildAdjustPanelHtml, bindAdjustPanel, enableBoostMaxOnce, clearBoostMaxOnce, getAdjustMax, requestStockAdjust };

function wireAdjustHotkeys() {
  if (wireAdjustHotkeys._done) return;
  wireAdjustHotkeys._done = true;
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.code !== 'KeyY' && e.key !== 'y' && e.key !== 'Y') return;
    try {
      if (!window.matchMedia('(min-width: 900px)').matches) return;
    } catch (err) {}
    e.preventDefault();
    enableBoostMaxOnce();
  }, true);
}
