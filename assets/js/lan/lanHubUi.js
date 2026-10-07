/**
 * lanHubUi.js — simple Hub connect UI (no WebRTC).
 */
import * as hub from './lanHub.js';

function el(html) {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstChild;
}

async function ensureMasterSession(on) {
  try {
    if (!on) {
      hub.stopMasterHub();
      return;
    }
    if (!hub.getHubUrl()) return;
    const live = await import('../dmartLive.js');
    const adj = await import('../dmartAdjust.js');
    const wh = await import('../warehouse.js');
    hub.startMasterHub({
      getMasterName: () => {
        try {
          const u = JSON.parse(localStorage.getItem('smouha_lan_hub_user_v1') || '{}');
          return u.username || 'Master';
        } catch (e) {
          return 'Master';
        }
      },
      getWarehouseId: () => (wh.getSelectedId && wh.getSelectedId()) || null,
      isBridgeOnline: () => !!(live.isBridgeOnline && live.isBridgeOnline()),
      fetchLive: (sku, wid, opts) => live.fetchLiveProductInfo(sku, wid, opts || { force: true, skipHub: true }),
      lookupProduct: (sku, wid, ms) => live.lookupProductViaBridge(sku, wid, ms || 14000, { skipHub: true }),
      adjustStock: async ({ sku, warehouseId, quantity, direction }) => {
        // Master must call extension only — never re-enter Hub (would loop / fail silently)
        if (typeof adj.requestStockAdjustBridgeOnly === 'function') {
          return adj.requestStockAdjustBridgeOnly({ sku, warehouseId, quantity, direction });
        }
        if (typeof adj.requestStockAdjust === 'function') {
          return adj.requestStockAdjust({ sku, warehouseId, quantity, direction, forceBridge: true });
        }
        return { success: false, error: { code: 'NO_ADJUST', message: 'Adjust module missing' } };
      },
    });
  } catch (e) {
    console.warn('[lanHubUi] ensureMasterSession', e);
  }
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

function ensureBadge() {
  let b = document.getElementById('lanHubStatusBadge');
  if (b) return b;
  b = el(
    `<div id="lanHubStatusBadge" style="position:fixed;left:12px;bottom:120px;z-index:41;padding:6px 10px;border-radius:999px;font-size:11px;font-weight:800;box-shadow:0 2px 10px rgba(0,0,0,.15);display:none"></div>`
  );
  document.body.appendChild(b);
  return b;
}

export function updateCardHubStatus(h) {
  document.querySelectorAll('.dmart-live-card').forEach((card) => {
    let b = card.querySelector('.dmart-hub-badge');
    if (!b) {
      b = document.createElement('div');
      b.className = 'dmart-hub-badge';
      b.style.cssText = 'font-size:11px;font-weight:700;margin:4px 0 6px';
      const head = card.querySelector('.dmart-live-head');
      if (head) head.after(b);
    }
    if (!hub.getHubUrl()) { b.textContent = ''; return; }
    const ext = document.querySelector('.dmart-conn-status.is-online, #bridgeStatusBadge.is-online');
    if (h && h.ok && h.masterOnline) {
      b.textContent = 'Hub Online';
      b.style.color = '#16a34a';
    } else if (h && h.ok) {
      b.textContent = 'Master missing';
      b.style.color = '#b45309';
    } else {
      b.textContent = 'Hub offline';
      b.style.color = '#64748b';
    }
    if (ext) { /* extension state is separate on PC */ }
  });
}
export function updateHubBadge(h) {
  try { updateCardHubStatus(h); } catch (e) {}

  const b = ensureBadge();
  if (!hub.getHubUrl()) {
    b.style.display = 'none';
    return;
  }
  b.style.display = 'block';
  if (h && h.ok && h.masterOnline) {
    b.textContent = 'Hub · Online';
    b.style.background = '#16a34a';
    b.style.color = '#fff';
  } else if (h && h.ok) {
    b.textContent = 'Hub · Waiting Master';
    b.style.background = '#f59e0b';
    b.style.color = '#111';
  } else {
    b.textContent = 'Hub · Offline';
    b.style.background = '#64748b';
    b.style.color = '#fff';
  }
}

function ensureFab() {
  if (document.getElementById('lanHubFab')) return;
  const btn = el(
    `<button type="button" id="lanHubFab" title="LAN Hub"
      style="position:fixed;left:12px;bottom:72px;z-index:40;border:none;border-radius:999px;padding:10px 14px;background:#0f172a;color:#fff;font-size:12px;font-weight:700;box-shadow:0 4px 14px rgba(0,0,0,.2)">Hub</button>`
  );
  document.body.appendChild(btn);
  btn.addEventListener('click', () => openHubModal());
}

export function openHubModal() {
  let bd = document.getElementById('lanHubBackdrop');
  if (bd) bd.remove();
  const id = hub.getHubIdentity();
  const url = hub.getHubUrl() || '';
  bd = el(`
    <div id="lanHubBackdrop" style="position:fixed;inset:0;z-index:600;background:rgba(15,23,42,.5);display:flex;align-items:flex-end;justify-content:center;padding:12px">
      <div style="background:#fff;color:#0f172a;width:100%;max-width:420px;border-radius:16px;padding:16px;max-height:90vh;overflow:auto">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <strong>LAN Hub</strong>
          <button type="button" id="lanHubClose">Close</button>
        </div>
        <p style="font-size:12px;opacity:.8;margin:0 0 10px">
          On the branch PC: run <b>hub/start-hub.bat</b>, then paste the Phone URL here (once).
        </p>
        <label style="font-size:12px;font-weight:700">Hub URL</label>
        <input id="lanHubUrlInput" type="url" value="${esc(url)}" placeholder="http://192.168.x.x:8787"
          style="width:100%;box-sizing:border-box;padding:10px;border-radius:10px;border:1px solid #e2e8f0;margin:4px 0 10px" />
        <label style="font-size:12px;font-weight:700">Your name</label>
        <input id="lanHubUserInput" type="text" maxlength="32" value="${esc(id.username)}"
          style="width:100%;box-sizing:border-box;padding:10px;border-radius:10px;border:1px solid #e2e8f0;margin:4px 0 10px" />
        <label style="font-size:12px;font-weight:700">Role</label>
        <select id="lanHubRoleInput" style="width:100%;padding:10px;border-radius:10px;border:1px solid #e2e8f0;margin:4px 0 12px">
          <option value="operator" ${id.role === 'operator' ? 'selected' : ''}>Operator (stock + adjust)</option>
          <option value="viewer" ${id.role === 'viewer' ? 'selected' : ''}>Viewer (stock only)</option>
          <option value="supervisor" ${id.role === 'supervisor' ? 'selected' : ''}>Supervisor</option>
        </select>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" id="lanHubSaveBtn" style="flex:1;padding:12px;border:none;border-radius:12px;background:#FF6B00;color:#fff;font-weight:800">Save & Test</button>
        </div>
        <div id="lanHubMsg" style="font-size:12px;margin-top:12px;min-height:1.2em"></div>
        <div id="lanHubQrHint" style="margin-top:12px;font-size:11px;opacity:.75"></div>
      </div>
    </div>`);
  document.body.appendChild(bd);
  bd.querySelector('#lanHubClose').onclick = () => bd.remove();
  bd.onclick = (e) => {
    if (e.target === bd) bd.remove();
  };
  bd.querySelector('#lanHubSaveBtn').onclick = async () => {
    const msg = bd.querySelector('#lanHubMsg');
    const u = bd.querySelector('#lanHubUrlInput').value;
    const name = bd.querySelector('#lanHubUserInput').value;
    const role = bd.querySelector('#lanHubRoleInput').value;
    hub.setHubUrl(u);
    hub.setHubIdentity({ username: name, role });
    msg.style.color = '#64748b';
    msg.textContent = 'Testing…';
    const h = await hub.probeHub();
    if (!h.ok) {
      msg.style.color = '#dc2626';
      msg.textContent =
        'Cannot reach Hub — check start-hub.bat is running and same Wi‑Fi. ' +
        (h.error || '');
      updateHubBadge(h);
      return;
    }
    const hello = await hub.hubDeviceHello();
    if (hello && hello.ok === false) {
      msg.style.color = '#dc2626';
      msg.textContent = hello.message || hello.reason || 'Blocked by Hub';
      updateHubBadge(h);
      return;
    }
    // If this PC is Master, restart SSE after URL change
    try {
      if (isHubMasterFlag()) {
        await ensureMasterSession(true);
      }
    } catch (e) {}
    const h2 = await hub.probeHub();
    msg.style.color = '#16a34a';
    msg.textContent = (h2.masterOnline || h.masterOnline)
      ? 'Connected — Master is online. Stock will use Hub.'
      : 'Hub reachable — waiting for Master tab on the PC (open site + Master).';
    updateHubBadge(h2.ok ? h2 : h);
  };
}

/** Settings section HTML + wiring for desktop Master */
export function mountHubSettingsSection(container) {
  if (!container || document.getElementById('lanHubSettingsBlock')) return;
  const id = hub.getHubIdentity();
  const block = el(`
    <div id="lanHubSettingsBlock" class="settings-section" style="margin-top:12px">
      <h3 style="font-size:14px;margin:0 0 8px">LAN Hub (local PC)</h3>
      <p style="font-size:12px;opacity:.8;margin:0 0 8px">
        Run <b>hub/start-hub.bat</b> on <b>one</b> branch PC. Phones use the same URL. One Master only.
      </p>
      <label style="font-size:12px;font-weight:700">Hub URL</label>
      <input id="lanHubSettingsUrl" type="url" placeholder="http://192.168.x.x:8787"
        style="width:100%;box-sizing:border-box;padding:8px;border-radius:8px;border:1px solid #e2e8f0;margin:4px 0 8px" />
      <label style="font-size:12px;font-weight:700">Your name (shown in log)</label>
      <input id="lanHubSettingsUser" type="text" maxlength="32" value="${esc(id.username)}"
        style="width:100%;box-sizing:border-box;padding:8px;border-radius:8px;border:1px solid #e2e8f0;margin:4px 0 8px" />
      <label style="font-size:12px;font-weight:700">Role on this device</label>
      <select id="lanHubSettingsRole" style="width:100%;padding:8px;border-radius:8px;border:1px solid #e2e8f0;margin:4px 0 8px">
        <option value="operator" ${id.role === 'operator' ? 'selected' : ''}>Operator — stock + add/remove (1–5, or 20 after ashraf)</option>
        <option value="viewer" ${id.role === 'viewer' ? 'selected' : ''}>Viewer — stock only, no adjust</option>
        <option value="supervisor" ${id.role === 'supervisor' ? 'selected' : ''}>Supervisor — same as operator + log</option>
      </select>
      <label style="font-size:12px;font-weight:700">Max phones (1–15)</label>
      <input id="lanHubMax" type="number" min="1" max="15" value="4"
        style="width:100%;box-sizing:border-box;padding:8px;border-radius:8px;border:1px solid #e2e8f0;margin:4px 0 8px" />
      <label class="settings-row" style="margin:6px 0">
        <span>This PC is Master (answers phones)</span>
        <input type="checkbox" id="lanHubMasterToggle" />
      </label>
      <label class="settings-row" style="margin:6px 0">
        <span>Show adjust on phones (LAN)</span>
        <input type="checkbox" id="lanHubMobileAdjust" checked />
      </label>
      <div id="lanHubQr" style="margin:8px 0"></div>
      <p style="font-size:11px;opacity:.75;margin:4px 0 8px">
        Adjust is refused if the Chrome extension is offline. Same SKU cannot be adjusted by two devices at once.
        Type <b>ashraf</b> in search = boost max 20 once (phone alternative to Ctrl+Y).
      </p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
        <button type="button" class="btn settings-action" id="lanHubSettingsSave" style="margin:0">Save</button>
        <button type="button" class="btn settings-action" id="lanHubSettingsTest" style="margin:0">Test</button>
        <button type="button" class="btn settings-action" id="lanHubShowLog" style="margin:0">Activity log</button>
        <button type="button" class="btn settings-action" id="lanHubExport" style="margin:0">Export CSV</button>
        <button type="button" class="btn settings-action" id="lanHubLock" style="margin:0">Lock shift</button>
      </div>
      <div id="lanHubSettingsStatus" style="font-size:12px;margin-top:8px"></div>
      <div id="lanHubDevices" style="font-size:11px;margin-top:8px;white-space:pre-wrap"></div>
    </div>`);
  container.appendChild(block);
  const urlIn = block.querySelector('#lanHubSettingsUrl');
  const userIn = block.querySelector('#lanHubSettingsUser');
  const roleIn = block.querySelector('#lanHubSettingsRole');
  const st = block.querySelector('#lanHubSettingsStatus');
  const devs = block.querySelector('#lanHubDevices');
  const masterCb = block.querySelector('#lanHubMasterToggle');
  const mobileAdj = block.querySelector('#lanHubMobileAdjust');
  try {
    if (mobileAdj) {
      const v = localStorage.getItem('smouha_hub_mobile_adjust');
      mobileAdj.checked = v !== '0';
    }
  } catch (e) {}
  urlIn.value = hub.getHubUrl() || '';
  try {
    masterCb.checked = localStorage.getItem('smouha_hub_is_master') === '1';
  } catch (e) {}

  const refresh = async () => {
    const h = await hub.probeHub(urlIn.value || hub.getHubUrl());
    if (!hub.getHubUrl() && !urlIn.value) {
      st.textContent = 'Hub URL not set';
      devs.textContent = '';
      return;
    }
    if (h.ok) {
      st.style.color = h.masterOnline ? '#16a34a' : '#b45309';
      st.textContent =
        (h.masterOnline ? 'Online · Master linked' : 'Hub up · waiting for Master tab on the PC') +
        (h.ips && h.ips.length ? ' · ' + h.ips.join(', ') : '') +
        (h.lastError ? ' · last error: ' + String(h.lastError).slice(0, 80) : '');
      const list = h.devices || [];
      devs.innerHTML = list.length
        ? '<div style="font-weight:700;margin-bottom:4px">Connected devices</div>' +
          list.map((d) =>
            '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin:4px 0">' +
            '<span>' + esc(d.username || d.deviceId) + ' · ' + esc(d.role || 'viewer') + (d.approved ? '' : ' · pending') + (d.agoSec != null ? ' · ' + d.agoSec + 's' : '') + '</span>' +
            '<span>' +
            (d.approved ? '' : '<button type="button" data-yes="' + esc(d.deviceId) + '" style="border:1px solid #bbf7d0;background:#fff;color:#166534;border-radius:8px;padding:4px 8px;font-size:11px;margin-right:4px">Yes</button>') +
            '<button type="button" data-kick="' + esc(d.deviceId) + '" style="border:1px solid #fecaca;background:#fff;color:#b91c1c;border-radius:8px;padding:4px 8px;font-size:11px">Kick</button></span>' +
            '</div>'
          ).join('')
        : 'No phones registered yet — open settings on the phone and Save.';
      devs.querySelectorAll('[data-kick]').forEach((btn) => {
        btn.onclick = async () => {
          const res = await hub.hubKick(btn.getAttribute('data-kick'));
          if (!res || !res.ok) {
            st.textContent = (res && (res.message || res.error)) || 'Kick failed';
            return;
          }
          refresh();
        };
      });
      devs.querySelectorAll('[data-yes]').forEach((btn) => {
        btn.onclick = async () => {
          const res = await hub.hubApprove(btn.getAttribute('data-yes'));
          st.textContent = res && res.ok ? 'Approved' : ((res && (res.message || res.error)) || 'Approve failed');
          refresh();
        };
      });
    } else {
      st.style.color = '#dc2626';
      st.textContent = 'Offline — ' + (h.error || 'start hub/start-hub.bat and same Wi‑Fi');
      devs.textContent = '';
    }
    updateHubBadge(h);
  };

  const save = () => {
    hub.setHubUrl(urlIn.value);
    hub.setHubIdentity({ username: userIn.value, role: roleIn.value });
    try {
      localStorage.setItem('smouha_hub_is_master', masterCb.checked ? '1' : '0');
      if (mobileAdj) localStorage.setItem('smouha_hub_mobile_adjust', mobileAdj.checked ? '1' : '0');
    } catch (e) {}
    try {
      import('../dmartLive.js').then((m) => m.updateBridgeStatusUi && m.updateBridgeStatusUi());
    } catch (e) {}
    window.dispatchEvent(new CustomEvent('smouha:hub-master-flag', { detail: { master: masterCb.checked } }));
    hub.hubDeviceHello().then((hello) => {
      if (hello && hello.ok === false && st) {
        st.style.color = '#dc2626';
        st.textContent = hello.message || hello.reason || 'Hello failed';
      }
    }).catch(() => {});
    ensureMasterSession(!!masterCb.checked).then(() => setTimeout(refresh, 400));
    refresh();
  };
  block.querySelector('#lanHubSettingsSave').onclick = save;
  block.querySelector('#lanHubSettingsTest').onclick = refresh;
  masterCb.onchange = save;

  block.querySelector('#lanHubExport').onclick = async () => {
    const rows = await hub.hubFetchLog(200);
    const head = 'time,user,type,action,sku,qty,direction,error';
    const lines = rows.map((r) => [r.t ? new Date(r.t).toISOString() : '', r.username || '', r.type || '', r.action || '', r.sku || '', r.quantity || '', r.direction || '', r.error || ''].join(','));
    const blob = new Blob([head + '\n' + lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'lan-log.csv';
    a.click();
  };
  block.querySelector('#lanHubLock').onclick = async () => {
    if (!confirm('Lock shift and disconnect all phones?')) return;
    const res = await hub.hubShiftLock();
    st.textContent = res && res.ok ? 'Shift locked' : 'Lock failed';
    refresh();
  };
  block.querySelector('#lanHubMax').onchange = () => {
    hub.hubSetMax(block.querySelector('#lanHubMax').value);
  };
  try {
    const qrHost = block.querySelector('#lanHubQr');
    const drawQr = () => {
      const url = hub.getHubUrl();
      if (!url || !qrHost) { if (qrHost) qrHost.innerHTML = ''; return; }
      const run = () => {
        try {
          const qr = window.qrcode(0, 'M');
          qr.addData(url);
          qr.make();
          qrHost.innerHTML = '<div style="font-size:11px;margin-bottom:4px">Phone scan once</div>' + qr.createSvgTag({ cellSize: 3, margin: 2 });
        } catch (e) { qrHost.textContent = url; }
      };
      if (window.qrcode) run();
      else {
        const s = document.createElement('script');
        s.src = 'assets/js/qrcode-generator.js';
        s.onload = run;
        document.head.appendChild(s);
      }
    };
    drawQr();
    block.querySelector('#lanHubSettingsSave').addEventListener('click', () => setTimeout(drawQr, 50));
  } catch (e) {}
  block.querySelector('#lanHubShowLog').onclick = async () => {
    const rows = await hub.hubFetchLog(80);
    const lines = rows.length
      ? rows.map((r) => {
          const tm = r.t ? new Date(r.t).toLocaleTimeString() : '';
          return tm + '  ' + (r.username || '-') + '  ' + (r.type || '') + '/' + (r.action || '') +
            '  ' + (r.sku || '') + (r.quantity ? ' x' + r.quantity : '') +
            (r.direction ? ' ' + r.direction : '') + (r.error ? '  ERR ' + r.error : '');
        }).join('\n')
      : 'No activity yet';
    alert(lines);
  };
  refresh();
}

export function initLanHubUi() {
  try {
    ensureFab();
    ensureBadge();
    hub.startHubHealthLoop();
    window.addEventListener('smouha:hub-health', (e) => updateHubBadge(e.detail || {}));
    window.addEventListener('smouha:hub-adjust-req', (e) => {
      const d = e.detail || {};
      const text = (d.username || 'Phone') + ' ' + (d.direction || 'adjust') + ' ' + (d.quantity || '') + ' · ' + (d.sku || '');
      try {
        if (window.ui && window.ui.toast) window.ui.toast(text);
        else alert(text);
      } catch (err) { alert(text); }
    });
    window.addEventListener('smouha:hub-master-flag', (e) => {
      ensureMasterSession(!!(e.detail && e.detail.master));
    });
    if (hub.getHubUrl()) {
      hub.probeHub().then(updateHubBadge);
      hub.hubDeviceHello().catch(() => {});
    }
    // Resume Master stream if this PC was marked Master (was never started before)
    if (isHubMasterFlag() && hub.getHubUrl()) {
      ensureMasterSession(true).then(() => {
        setTimeout(() => hub.probeHub().then(updateHubBadge), 500);
      });
    }
  } catch (e) {
    console.warn('[lanHubUi]', e);
  }
}

export function isHubMasterFlag() {
  try {
    return localStorage.getItem('smouha_hub_is_master') === '1';
  } catch (e) {
    return false;
  }
}


/* Single-master: this tab was replaced */
window.addEventListener('smouha:hub-master-superseded', (ev) => {
  try {
    const msg = (ev.detail && ev.detail.message) || 'Master moved to another tab';
    const el = document.getElementById('hubMasterStatus') || document.querySelector('[data-hub-master-status]');
    if (el) {
      el.textContent = msg;
      el.style.color = '#b91c1c';
    }
    console.warn('[hub]', msg);
  } catch (e) {}
});


window.addEventListener('smouha:hub-restarted', () => {
  try {
    const st = document.querySelector('[data-hub-status], #hubStatusLine, #lanHubStatus');
    if (st) {
      st.textContent = 'Hub restarted — reconnected';
      st.style.color = '#16a34a';
    }
  } catch (e) {}
});


window.addEventListener('smouha:warehouse-changed', async () => {
  try {
    if (!isHubMasterFlag()) return;
    const hub = await import('./lanHub.js');
    const base = hub.masterBaseUrl ? hub.masterBaseUrl() : hub.getHubUrl();
    if (!base) return;
    let wid = null;
    try {
      const wh = await import('../warehouse.js');
      wid = wh.getSelectedId && wh.getSelectedId();
    } catch (e) {}
    await fetch(base + '/api/master/hello', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: (hub.getHubIdentity && hub.getHubIdentity().username) || 'Master',
        warehouseId: wid,
      }),
    });
  } catch (e) {}
});
