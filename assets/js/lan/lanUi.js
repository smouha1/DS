/**
 * lanUi.js — Master/Mobile UI: QR, reconnect, shift summary, last error, roles.
 */
import * as master from './lanMaster.js';
import * as client from './lanClient.js';
import {
  getLanLog,
  clearLanLog,
  getLastLanError,
  getShiftSummary,
  loadMasterState,
} from './lanStore.js';

function el(html) {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstChild;
}
function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

async function ensureQrLib() {
  if (typeof window.qrcode === 'function') return true;
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'assets/js/qrcode-generator.js';
    s.onload = () => resolve(typeof window.qrcode === 'function');
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

function renderQrTo(container, text) {
  container.innerHTML = '';
  if (!text || typeof window.qrcode !== 'function') {
    container.textContent = 'QR unavailable — use paste';
    return;
  }
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(String(text));
    qr.make();
    container.innerHTML = qr.createSvgTag(4, 2);
    const svg = container.querySelector('svg');
    if (svg) {
      svg.style.width = '100%';
      svg.style.maxWidth = '240px';
      svg.style.height = 'auto';
      svg.style.display = 'block';
      svg.style.margin = '0 auto';
      svg.style.background = '#fff';
      svg.style.borderRadius = '8px';
    }
  } catch (e) {
    container.textContent = 'QR error — use paste';
  }
}

function formatLastErr() {
  const e = getLastLanError();
  if (!e) return '';
  const t = new Date(e.at).toLocaleTimeString();
  return `Last error ${t}: ${e.code ? e.code + ' · ' : ''}${e.message || ''}`;
}

export function mountMasterSettingsSection(container) {
  if (!container) return;
  if (document.getElementById('lanMasterSection')) return;

  const st = master.getMasterState();
  const errHtml = formatLastErr()
    ? `<div class="lan-last-err" id="lanLastErrBox">${esc(formatLastErr())}</div>`
    : `<div class="lan-last-err" id="lanLastErrBox" hidden></div>`;

  // Prefer dedicated LAN tab mount (settings page); fall back to append on container
  const host =
    document.getElementById('settingsLanMount') ||
    (container.id === 'settingsLanMount' ? container : null);

  const bodyHtml = `
      <p class="settings-hint" style="font-size:12px;opacity:.8;margin:0 0 10px">
        One Master PC. Mobiles scan QR. Stock &amp; adjust over LAN.
      </p>
      <label class="settings-row">
        <span>Enable Master mode</span>
        <span class="switch ${st.enabled ? 'on' : ''}" id="lanMasterToggle" role="switch" aria-checked="${st.enabled}" tabindex="0"></span>
      </label>
      <label class="settings-row" style="flex-wrap:wrap;gap:8px">
        <span>Master name</span>
        <input type="text" id="lanMasterName" value="${esc(st.masterName)}" maxlength="40" style="flex:1;min-width:120px;padding:6px 10px;border-radius:8px;border:1px solid var(--border,#ccc)" />
      </label>
      <label class="settings-row" style="flex-wrap:wrap;gap:8px">
        <span>Max mobiles (1–15)</span>
        <input type="number" id="lanMaxDevices" min="1" max="15" value="${st.maxDevices}" style="width:72px;padding:6px 8px;border-radius:8px;border:1px solid var(--border,#ccc)" />
      </label>
      <label class="settings-row" style="flex-wrap:wrap;gap:8px">
        <span>Session hours (0 = until kick)</span>
        <input type="number" id="lanSessionHours" min="0" max="336" value="${st.sessionHours}" style="width:72px;padding:6px 8px;border-radius:8px;border:1px solid var(--border,#ccc)" />
      </label>
      <div class="settings-row" style="flex-wrap:wrap;gap:8px">
        <span>PIN</span>
        <code id="lanPinDisplay" style="font-weight:800">${esc(master.getFullPin())}</code>
        <button type="button" class="btn settings-action" id="lanRotatePin" style="margin:0">Rotate PIN</button>
      </div>
      ${errHtml}
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px">
        <button type="button" class="btn settings-action" id="lanStartPair" style="margin:0">Show pair QR</button>
        <button type="button" class="btn settings-action" id="lanOpenLog" style="margin:0">LAN log</button>
        <button type="button" class="btn settings-action" id="lanShiftSummary" style="margin:0">Shift summary</button>
        <button type="button" class="btn settings-action" id="lanExportLog" style="margin:0">Export CSV</button>
        <button type="button" class="btn settings-action" id="lanResyncApproved" style="margin:0">Resync mobiles</button>
      </div>
      <div id="lanPendingList" style="margin-top:12px"></div>
      <div id="lanDeviceList" style="margin-top:8px"></div>
      <div id="lanPairWorkbench" style="margin-top:12px" hidden></div>
  `;

  let section;
  if (host) {
    // Fill existing LAN tab section (keep its h4 + data-section)
    const tip = host.querySelector('.settings-hint');
    if (tip) tip.remove();
    const wrap = document.createElement('div');
    wrap.id = 'lanMasterSection';
    wrap.innerHTML = bodyHtml;
    host.appendChild(wrap);
    section = host;
  } else {
    section = el(`
    <div class="settings-section" id="lanMasterSection" data-section="lan">
      <h4>LAN / Master</h4>
      ${bodyHtml}
    </div>
  `);
    container.appendChild(section);
  }
  wireMasterSection(section);
  refreshDeviceLists();
  syncPairBtnVisibility();
}

function wireMasterSection(section) {
  const toggle = section.querySelector('#lanMasterToggle');
  toggle.addEventListener('click', () => {
    const on = !toggle.classList.contains('on');
    master.setMasterEnabled(on);
    toggle.classList.toggle('on', on);
    toggle.setAttribute('aria-checked', on ? 'true' : 'false');
    syncPairBtnVisibility();
  });
  section.querySelector('#lanMasterName').addEventListener('change', (e) => master.setMasterName(e.target.value));
  section.querySelector('#lanMaxDevices').addEventListener('change', (e) => {
    master.setMaxDevices(e.target.value);
    e.target.value = master.getMasterState().maxDevices;
  });
  section.querySelector('#lanSessionHours').addEventListener('change', (e) => master.setSessionHours(e.target.value));
  section.querySelector('#lanRotatePin').addEventListener('click', () => {
    section.querySelector('#lanPinDisplay').textContent = master.doRotatePin();
  });
  section.querySelector('#lanStartPair').addEventListener('click', () => startPairWorkbench(section));
  section.querySelector('#lanOpenLog').addEventListener('click', () => showLogModal());
  section.querySelector('#lanExportLog').addEventListener('click', exportLogCsv);
  section.querySelector('#lanShiftSummary').addEventListener('click', showShiftSummary);
}

async function startPairWorkbench(section) {
  const box = section.querySelector('#lanPairWorkbench');
  box.hidden = false;
  box.innerHTML = `<div style="font-size:13px">Creating offer…</div>`;
  try {
    await ensureQrLib();
    const offer = await master.beginPairOffer();
    box.innerHTML = `
      <div class="lan-pair-box" style="border:1px solid var(--border,#ddd);border-radius:12px;padding:12px;background:rgba(255,255,255,.75)">
        <div style="font-size:12px;font-weight:800;text-align:center;margin-bottom:8px">Mobile: scan this QR</div>
        <div id="lanOfferQr"></div>
        <div style="text-align:center;margin:10px 0;font-size:15px">PIN: <b>${esc(offer.pin)}</b></div>
        <p style="font-size:12px;font-weight:700;color:#c2410c;margin:8px 0 4px">After mobile Connect: scan their Answer QR below (required for channel)</p>
        <details style="font-size:11px"><summary>Paste fallback (offer)</summary>
          <textarea id="lanOfferOut" readonly rows="2" style="width:100%;font-size:10px;box-sizing:border-box">${esc(offer.offerSignal)}</textarea>
        </details>
        <div style="font-size:12px;font-weight:800;margin:12px 0 6px">Scan Answer QR from mobile</div>
        <button type="button" class="btn settings-action" id="lanScanAnswer" style="margin:0 0 8px">Scan Answer QR</button>
        <div id="lanScanVideoWrap" hidden>
          <video id="lanScanVideo" playsinline style="width:100%;max-height:200px;border-radius:8px;background:#000"></video>
          <button type="button" class="btn settings-action" id="lanScanStop" style="margin:6px 0">Stop camera</button>
        </div>
        <textarea id="lanAnswerIn" placeholder="Paste mobile answer JSON here" rows="2" style="width:100%;font-size:10px;box-sizing:border-box" placeholder="Answer blob"></textarea>
        <button type="button" class="btn settings-action" id="lanAcceptAnswer" style="margin-top:8px">Accept → Pending</button>
        <div id="lanPairMsg" style="font-size:12px;margin-top:8px"></div>
      </div>`;
    renderQrTo(box.querySelector('#lanOfferQr'), offer.offerSignal);

    let scanStream = null;
    let scanTimer = null;
    const stopScan = () => {
      if (scanTimer) clearInterval(scanTimer);
      scanTimer = null;
      if (scanStream) {
        scanStream.getTracks().forEach((t) => t.stop());
        scanStream = null;
      }
      const wrap = box.querySelector('#lanScanVideoWrap');
      if (wrap) wrap.hidden = true;
    };

    box.querySelector('#lanAcceptAnswer').addEventListener('click', async () => {
      const msg = box.querySelector('#lanPairMsg');
      try {
        const device = await master.ingestMobileAnswerBlob(box.querySelector('#lanAnswerIn').value);
        msg.textContent = `Pending: ${device.username}${device.deviceLabel ? ' (' + device.deviceLabel + ')' : ''}`;
        refreshDeviceLists();
      } catch (e) {
        msg.textContent = e.message || 'Failed';
      }
    });

    box.querySelector('#lanScanAnswer').addEventListener('click', async () => {
      const msg = box.querySelector('#lanPairMsg');
      const wrap = box.querySelector('#lanScanVideoWrap');
      const video = box.querySelector('#lanScanVideo');
      wrap.hidden = false;
      msg.textContent = 'Point camera at mobile Answer QR…';
      try {
        scanStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        video.srcObject = scanStream;
        await video.play();
        if (!window.BarcodeDetector) {
          msg.textContent = 'No detector — paste Answer blob';
          return;
        }
        const det = new window.BarcodeDetector({ formats: ['qr_code'] });
        scanTimer = setInterval(async () => {
          try {
            if (video.readyState < 2) return;
            const codes = await det.detect(video);
            if (!codes || !codes[0] || !codes[0].rawValue) return;
            box.querySelector('#lanAnswerIn').value = codes[0].rawValue;
            stopScan();
            const device = await master.ingestMobileAnswerBlob(codes[0].rawValue);
            msg.textContent = `Pending: ${device.username}`;
            refreshDeviceLists();
          } catch (e) {}
        }, 500);
      } catch (e) {
        msg.textContent = 'Camera blocked — paste Answer';
      }
    });
    box.querySelector('#lanScanStop')?.addEventListener('click', stopScan);
  } catch (e) {
    box.innerHTML = `<div style="color:#dc2626">${esc(e.message || 'Offer failed')}</div>`;
  }
}

function refreshDeviceLists() {
  const st = master.getMasterState();
  const pendingEl = document.getElementById('lanPendingList');
  const deviceEl = document.getElementById('lanDeviceList');
  const errBox = document.getElementById('lanLastErrBox');
  if (errBox) {
    const t = formatLastErr();
    if (t) {
      errBox.hidden = false;
      errBox.textContent = t;
    }
  }

  if (pendingEl) {
    if (!st.pending.length) {
      pendingEl.innerHTML = '<div style="font-size:12px;opacity:.7">No pending devices</div>';
    } else {
      pendingEl.innerHTML =
        '<div style="font-size:12px;font-weight:800;margin-bottom:6px">Pending</div>' +
        st.pending
          .map((d) => {
            const meta = [d.username, d.deviceLabel, d.role === 'viewer' ? 'viewer' : '']
              .filter(Boolean)
              .join(' · ');
            return `<div class="settings-row" style="gap:8px;flex-wrap:wrap">
            <span>${esc(meta)}</span>
            <button type="button" class="btn settings-action" data-approve="${esc(d.id)}" style="margin:0">Yes</button>
            <button type="button" class="btn settings-action" data-reject="${esc(d.id)}" style="margin:0">No</button>
          </div>`;
          })
          .join('');
      pendingEl.querySelectorAll('[data-approve]').forEach((btn) => {
        btn.addEventListener('click', () => {
          try {
            master.approveDevice(btn.getAttribute('data-approve'));
            try {
              if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
            } catch (e) {}
            refreshDeviceLists();
          } catch (e) {
            alert(e.message || 'Approve failed');
          }
        });
      });
      pendingEl.querySelectorAll('[data-reject]').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (!confirm('Reject this device?')) return;
          master.rejectOrKickDevice(btn.getAttribute('data-reject'), 'rejected');
          refreshDeviceLists();
        });
      });
    }
  }

  if (deviceEl) {
    const now = Date.now();
    const list = st.devices.filter(
      (d) => d.status === 'approved' && (!d.expiresAt || d.expiresAt > now)
    );
    if (!list.length) {
      deviceEl.innerHTML = '<div style="font-size:12px;opacity:.7">No approved mobiles</div>';
    } else {
      deviceEl.innerHTML =
        '<div style="font-size:12px;font-weight:800;margin-bottom:6px">Approved (' +
        list.length +
        '/' +
        st.maxDevices +
        ')</div>' +
        list
          .map((d) => {
            const seen = d.lastSeen ? new Date(d.lastSeen).toLocaleTimeString() : '—';
            const meta = [d.username, d.deviceLabel, d.role === 'viewer' ? 'viewer' : 'op', 'seen ' + seen]
              .filter(Boolean)
              .join(' · ');
            return `<div class="settings-row" style="gap:8px;flex-wrap:wrap">
            <span style="font-size:12px">${esc(meta)}</span>
            <button type="button" class="btn settings-action" data-kick="${esc(d.id)}" style="margin:0">Kick</button>
          </div>`;
          })
          .join('');
      deviceEl.querySelectorAll('[data-kick]').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (!confirm('Kick this device? They will lose LAN adjust until they pair again.')) return;
          master.rejectOrKickDevice(btn.getAttribute('data-kick'), 'kicked');
          refreshDeviceLists();
        });
      });
    }
  }
}

function showShiftSummary() {
  const s = getShiftSummary();
  const users = Object.keys(s.byUser);
  let body = `<div class="lan-shift-summary">
    <div><b>Last ~12h</b></div>
    <div>Adds: <b>${s.adds}</b> · Removes: <b>${s.removes}</b> · Views: <b>${s.views}</b></div>
    <div style="margin-top:8px">`;
  if (!users.length) body += 'No activity yet.';
  else {
    body += users
      .map((u) => {
        const x = s.byUser[u];
        return `<div>${esc(u)} — +${x.add} / −${x.remove} · views ${x.view} · fails ${x.fail}</div>`;
      })
      .join('');
  }
  body += '</div></div>';
  alert(body.replace(/<[^>]+>/g, '\n').replace(/\n+/g, '\n'));
  // nicer modal
  let bd = document.getElementById('lanShiftBackdrop');
  if (bd) bd.remove();
  bd = el(`<div id="lanShiftBackdrop" style="position:fixed;inset:0;z-index:600;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;padding:16px">
    <div style="background:#fff;color:#111;max-width:400px;width:100%;border-radius:14px;padding:16px">
      <strong>Shift summary</strong>
      ${body}
      <button type="button" id="lanShiftClose" style="margin-top:12px">Close</button>
    </div>
  </div>`);
  document.body.appendChild(bd);
  bd.querySelector('#lanShiftClose').onclick = () => bd.remove();
  bd.onclick = (e) => {
    if (e.target === bd) bd.remove();
  };
}

function showLogModal() {
  const rows = getLanLog(100);
  let backdrop = document.getElementById('lanLogBackdrop');
  if (backdrop) backdrop.remove();
  backdrop = el(`
    <div id="lanLogBackdrop" style="position:fixed;inset:0;z-index:600;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px">
      <div style="background:#fff;color:#111;max-width:520px;width:100%;max-height:80vh;overflow:auto;border-radius:16px;padding:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:8px;flex-wrap:wrap">
          <strong>LAN log</strong>
          <span>
            <button type="button" id="lanLogExport">CSV</button>
            <button type="button" id="lanLogClear">Clear</button>
            <button type="button" id="lanLogClose">Close</button>
          </span>
        </div>
        <div id="lanLogBody" style="font-size:12px;font-family:ui-monospace,monospace"></div>
      </div>
    </div>`);
  document.body.appendChild(backdrop);
  const body = backdrop.querySelector('#lanLogBody');
  body.innerHTML = rows.length
    ? rows
        .map((r) => {
          const t = new Date(r.t).toLocaleString();
          return `<div style="padding:4px 0;border-bottom:1px solid #eee">${esc(t)} · ${esc(r.username || '')} · ${esc(r.deviceLabel || '')} · ${esc(r.action || r.type)} · ${esc(r.sku || '')}</div>`;
        })
        .join('')
    : '<div>No entries</div>';
  backdrop.querySelector('#lanLogClose').onclick = () => backdrop.remove();
  backdrop.querySelector('#lanLogExport').onclick = exportLogCsv;
  backdrop.querySelector('#lanLogClear').onclick = () => {
    if (confirm('Clear LAN log?')) {
      clearLanLog();
      body.innerHTML = '<div>No entries</div>';
    }
  };
}

function exportLogCsv() {
  const rows = getLanLog(500);
  const header = 'time,username,deviceLabel,type,action,sku,quantity,direction\n';
  const lines = rows.map((r) =>
    [new Date(r.t).toISOString(), r.username || '', r.deviceLabel || '', r.type || '', r.action || '', r.sku || '', r.quantity ?? '', r.direction || '']
      .map((c) => '"' + String(c).replace(/"/g, '""') + '"')
      .join(',')
  );
  const blob = new Blob([header + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'lan-log-' + Date.now() + '.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function syncPairBtnVisibility() {
  const btn = document.getElementById('lanClientPairBtn');
  if (!btn) return;
  try {
    const st = loadMasterState();
    // Hide on Master PC when Master mode is enabled (desktop)
    const isDesktop = window.matchMedia('(min-width: 900px)').matches;
    btn.classList.toggle('is-master-hidden', !!(st.enabled && isDesktop));
  } catch (e) {}
}

export function ensureClientPairEntry() {
  if (document.getElementById('lanClientPairBtn')) {
    syncPairBtnVisibility();
    return;
  }
  const btn = el(`
    <button type="button" id="lanClientPairBtn" title="Pair to Master"
      style="position:fixed;left:12px;bottom:72px;z-index:40;border:none;border-radius:999px;padding:10px 14px;background:#0f172a;color:#fff;font-size:12px;font-weight:700;box-shadow:0 4px 14px rgba(0,0,0,.2)">
      Pair Master
    </button>`);
  document.body.appendChild(btn);
  btn.addEventListener('click', () => openClientPairModal());
  syncPairBtnVisibility();
  window.addEventListener('smouha:lan-master-changed', syncPairBtnVisibility);
}

function openClientPairModal(opts) {
  const reconnect = !!(opts && opts.reconnect);
  const prev = client.getClientSession();
  let backdrop = document.getElementById('lanClientBackdrop');
  if (backdrop) backdrop.remove();
  backdrop = el(`
    <div id="lanClientBackdrop" style="position:fixed;inset:0;z-index:600;background:rgba(0,0,0,.5);display:flex;align-items:flex-end;justify-content:center;padding:12px">
      <div style="background:#fff;color:#111;width:100%;max-width:480px;border-radius:16px;padding:16px;max-height:90vh;overflow:auto">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong>${reconnect ? 'Reconnect to Master' : 'Pair to Master (LAN)'}</strong>
          <button type="button" id="lanClientClose">Close</button>
        </div>
        <p style="font-size:12px;opacity:.8">Scan Master QR, enter PIN${reconnect ? ' (name kept)' : ' + name'}.</p>
        <button type="button" class="btn" id="lanClientScanOffer" style="width:100%;padding:10px;margin-bottom:8px;background:#FF6B00;color:#fff;border:none;border-radius:10px;font-weight:800">Scan Master QR</button>
        <div id="lanClientScanWrap" hidden>
          <video id="lanClientScanVideo" playsinline style="width:100%;max-height:220px;border-radius:8px;background:#000"></video>
          <button type="button" id="lanClientScanStop">Stop</button>
        </div>
        <label style="font-size:12px;font-weight:700">Offer</label>
        <textarea id="lanClientOffer" rows="2" style="width:100%;box-sizing:border-box;font-size:10px"></textarea>
        <label style="font-size:12px;font-weight:700">PIN</label>
        <input id="lanClientPin" type="text" placeholder="Ds60xxxx" style="width:100%;box-sizing:border-box;padding:8px;margin:4px 0 8px" />
        <div id="lanClientIdentity" ${reconnect ? 'hidden' : ''}>
          <label style="font-size:12px;font-weight:700">Username</label>
          <input id="lanClientUser" type="text" maxlength="32" value="${esc(prev && prev.username)}" style="width:100%;box-sizing:border-box;padding:8px;margin:4px 0 8px" />
          <label style="font-size:12px;font-weight:700">Device label (optional)</label>
          <input id="lanClientLabel" type="text" maxlength="40" placeholder="e.g. Cashier 2" value="${esc(prev && prev.deviceLabel)}" style="width:100%;box-sizing:border-box;padding:8px;margin:4px 0 8px" />
          <label class="settings-row" style="margin:8px 0">
            <span style="font-size:12px">Viewer only (stock, no adjust)</span>
            <input type="checkbox" id="lanClientViewer" ${prev && prev.role === 'viewer' ? 'checked' : ''} />
          </label>
        </div>
        <button type="button" class="btn" id="lanClientGo" style="width:100%;padding:12px;background:#0f172a;color:#fff;border:none;border-radius:12px;font-weight:800">${reconnect ? 'Reconnect' : 'Connect'}</button>
        <div id="lanClientMsg" style="font-size:12px;margin-top:10px"></div>
        <div id="lanClientAnswerQr" style="margin-top:10px"></div>
        <textarea id="lanClientAnswerOut" hidden rows="2" style="width:100%;font-size:10px;margin-top:8px"></textarea>
      </div>
    </div>`);
  document.body.appendChild(backdrop);

  let scanStream = null;
  let scanTimer = null;
  function stopClientScan() {
    if (scanTimer) clearInterval(scanTimer);
    scanTimer = null;
    if (scanStream) {
      scanStream.getTracks().forEach((t) => t.stop());
      scanStream = null;
    }
    const w = backdrop.querySelector('#lanClientScanWrap');
    if (w) w.hidden = true;
  }

  backdrop.querySelector('#lanClientClose').onclick = () => {
    stopClientScan();
    backdrop.remove();
  };

  backdrop.querySelector('#lanClientScanOffer').onclick = async () => {
    const msg = backdrop.querySelector('#lanClientMsg');
    const wrap = backdrop.querySelector('#lanClientScanWrap');
    const video = backdrop.querySelector('#lanClientScanVideo');
    wrap.hidden = false;
    msg.textContent = 'Point at Master QR…';
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      video.srcObject = scanStream;
      await video.play();
      if (!window.BarcodeDetector) {
        msg.textContent = 'Scanner not supported — paste offer';
        return;
      }
      const det = new window.BarcodeDetector({ formats: ['qr_code'] });
      scanTimer = setInterval(async () => {
        try {
          if (video.readyState < 2) return;
          const codes = await det.detect(video);
          if (!codes || !codes[0] || !codes[0].rawValue) return;
          backdrop.querySelector('#lanClientOffer').value = codes[0].rawValue;
          stopClientScan();
          msg.textContent = 'Offer captured — enter PIN, then Connect';
        } catch (e) {}
      }, 400);
    } catch (e) {
      msg.textContent = 'Camera blocked — paste offer';
    }
  };

  backdrop.querySelector('#lanClientGo').onclick = async () => {
    const msg = backdrop.querySelector('#lanClientMsg');
    const offer = backdrop.querySelector('#lanClientOffer').value;
    const pin = backdrop.querySelector('#lanClientPin').value;
    msg.textContent = 'Connecting…';
    try {
      await ensureQrLib();
      let res;
      if (reconnect) {
        res = await client.clientReconnectWithOffer({ offerSignal: offer, pin });
      } else {
        res = await client.clientStartPairFixed({
          offerSignal: offer,
          pin,
          expectedPin: pin,
          username: backdrop.querySelector('#lanClientUser').value,
          deviceLabel: backdrop.querySelector('#lanClientLabel').value,
          role: backdrop.querySelector('#lanClientViewer').checked ? 'viewer' : 'operator',
        });
      }
      const out = backdrop.querySelector('#lanClientAnswerOut');
      out.hidden = false;
      out.value = res.answerBlob;
      const qrBox = backdrop.querySelector('#lanClientAnswerQr');
      qrBox.innerHTML =
        '<div style="font-size:13px;font-weight:800;text-align:center;color:#c2410c">① Master must scan THIS QR (or paste below)</div>' +
        '<div style="font-size:11px;text-align:center;opacity:.85;margin:4px 0 8px">② Then press <b>Yes</b> on the PC</div>';
      const holder = document.createElement('div');
      holder.style.cssText = 'display:flex;justify-content:center';
      qrBox.appendChild(holder);
      renderQrTo(holder, res.answerBlob);
      const copyRow = document.createElement('div');
      copyRow.style.cssText = 'margin-top:10px;display:flex;gap:8px;flex-wrap:wrap';
      copyRow.innerHTML =
        '<button type="button" id="lanCopyAnswer" style="flex:1;padding:10px;border-radius:10px;border:none;background:#0f172a;color:#fff;font-weight:700">Copy answer for Master</button>';
      qrBox.appendChild(copyRow);
      copyRow.querySelector('#lanCopyAnswer').onclick = async () => {
        try {
          await navigator.clipboard.writeText(res.answerBlob);
          msg.textContent = 'Answer copied — paste it on Master PC';
        } catch (e) {
          out.select();
          msg.textContent = 'Select & copy the text below manually';
        }
      };
      msg.innerHTML =
        'Channel starting… Master must <b>scan/paste your answer</b>, then press <b>Yes</b>.';
    } catch (e) {
      msg.textContent = e.message || 'Pair failed';
    }
  };
}

/** Last-SKU quick chip (PWA-friendly, no notification permission required). */
function ensureLastSkuChip() {
  if (document.getElementById('lanLastSkuChip')) return;
  const chip = el(`
    <button type="button" id="lanLastSkuChip" hidden
      style="position:fixed;right:12px;bottom:72px;z-index:40;border:none;border-radius:999px;padding:8px 12px;background:#fff;color:#0f172a;font-size:11px;font-weight:700;box-shadow:0 4px 14px rgba(0,0,0,.15);max-width:42vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
    </button>`);
  document.body.appendChild(chip);
  chip.addEventListener('click', () => {
    try {
      const sku = localStorage.getItem('smouha_last_sku');
      if (!sku) return;
      const input = document.getElementById('searchInput');
      if (input) {
        input.value = sku;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } catch (e) {}
  });
  const refresh = () => {
    try {
      const sku = localStorage.getItem('smouha_last_sku');
      if (!sku) {
        chip.hidden = true;
        return;
      }
      chip.hidden = false;
      chip.textContent = '↩ ' + sku;
      chip.title = 'Open last SKU';
    } catch (e) {}
  };
  refresh();
  window.addEventListener('storage', refresh);
  setInterval(refresh, 4000);
}

export function initLanUi() {
  try {
    ensureClientPairEntry();
    ensureLastSkuChip();
  } catch (e) {}
  window.addEventListener('smouha:lan-pair-status', (ev) => {
    const st = ev.detail && ev.detail.status;
    if (st === 'master_offline') {
      // offer reconnect
      const btn = document.getElementById('lanClientPairBtn');
      if (btn) {
        btn.textContent = 'Reconnect';
        btn.onclick = () => openClientPairModal({ reconnect: true });
      }
    }
    if (st === 'approved') {
      const btn = document.getElementById('lanClientPairBtn');
      if (btn) {
        btn.textContent = 'Pair Master';
        btn.onclick = () => openClientPairModal();
      }
    }
  });
}


/** Full-screen success when Master Yes actually arrives on the phone */
function showPairSuccessModal(detail) {
  let bd = document.getElementById('lanPairOkBackdrop');
  if (bd) bd.remove();
  const name = (detail && detail.username) || '';
  bd = el(`
    <div id="lanPairOkBackdrop" style="position:fixed;inset:0;z-index:700;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:20px">
      <div style="background:#fff;color:#0f172a;border-radius:18px;padding:24px 20px;max-width:340px;width:100%;text-align:center;box-shadow:0 20px 50px rgba(0,0,0,.25)">
        <div style="width:56px;height:56px;border-radius:50%;background:#16a34a;color:#fff;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:800;margin:0 auto 12px">✓</div>
        <div style="font-size:18px;font-weight:800;margin-bottom:6px">LAN Connected</div>
        <div style="font-size:13px;opacity:.75;margin-bottom:16px">${name ? 'Hi ' + esc(name) + ' — ' : ''}Master approved this device. Stock will use the fast LAN path.</div>
        <button type="button" id="lanPairOkBtn" style="width:100%;padding:12px;border:none;border-radius:12px;background:#FF6B00;color:#fff;font-weight:800;font-size:15px">OK</button>
      </div>
    </div>`);
  document.body.appendChild(bd);
  const close = () => {
    bd.remove();
    const pairBd = document.getElementById('lanClientBackdrop');
    if (pairBd) pairBd.remove();
  };
  bd.querySelector('#lanPairOkBtn').onclick = close;
  bd.onclick = (e) => {
    if (e.target === bd) close();
  };
}

window.addEventListener('smouha:lan-pair-confirmed', (e) => {
  try {
    showPairSuccessModal(e.detail || {});
  } catch (err) {}
});
