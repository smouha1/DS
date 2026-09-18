/* ============================================================================
   settings.js — MODULE: settings
   ------------------------------------------------------------------------
   Lazy-loaded (see app.js): the Settings panel isn't needed until the user
   opens it, so this module is dynamically imported on first click of the
   floating Settings button rather than bundled into the critical startup
   path.

   Persists all toggles to localStorage under one key. Two of the toggles
   have real, app-wide visual effects applied via CSS classes on <html>:
     Performance Mode -> .performance-mode  (disables animations, hover
       preview, QR rendering, transitions — see main.css/cards.css/etc.)
     Compact Mode      -> .compact-mode     (reduces padding, card height,
       spacing, button size — see main.css/cards.css/buttons.css)
   Everything else is either a simple behavioral flag read by other modules
   (autoCopyBarcode, autoCopySku, hoverPreview, showProductCount, qrCode,
   scanSound) or a one-shot action (Force Update, Clear IndexedDB, Run
   Image Check, Reset Settings).
   ============================================================================ */

import * as db from './indexeddb.js';
import * as updater from './updater.js';
import * as search from './search.js';
import { formatBytes, getRecentLogs, log} from './utils.js';

const STORAGE_KEY = 'smouhaPickSettings';

const DEFAULTS = {
  autoCopyBarcode: false,
  autoCopySku: false,
  hoverPreview: true,
  compactMode: false,
  performanceMode: false,
  largeBarcode: false,
  largeProductImage: false,
  qrCode: true,
  scanSound: true,
  showProductCount: true,
  showVersion: true,
  warehouseDisplay: 'original', // PC default; mobile uses friendly via effective logic
  recentBesideBarcode: true,
  dmartPopupEnabled: true,
  intensiveAutoFocus: false,
};

let current = null;

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    current = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch (e) {
    current = { ...DEFAULTS };
  }
  return current;
}

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch (e) { /* storage full/unavailable */ }
}

export function getSettings() {
  if (!current) load();
  return current;
}

export function setSetting(key, value) {
  if (!current) load();
  current[key] = value;
  save();
  applyGlobalModes();
  try { window.dispatchEvent(new CustomEvent('smouha:settings-changed', { detail: { ...current } })); } catch (e) {}
  // Notify warehouse module when display mode changes (lazy import safe)
  if (key === 'warehouseDisplay') {
    import('./warehouse.js').then(wh => {
      wh.setDisplayMode(value === 'friendly' ? 'friendly' : 'original');
    }).catch(() => {});
  }
  // Notify app to re-draw the on-screen product barcode when QR / Performance
  // toggles change so the user sees the effect immediately without re-searching.
  if (key === 'qrCode' || key === 'performanceMode') {
    try {
      window.dispatchEvent(new CustomEvent('smouha:settings-barcode', { detail: { key, value } }));
    } catch (e) { /* ignore */ }
  }
}

export function resetSettings() {
  current = { ...DEFAULTS };
  save();
  applyGlobalModes();
  return current;
}

/** Applies the two app-wide visual toggles as classes on <html>, and
 *  respects the OS-level prefers-reduced-motion signal as an additional,
 *  independent reason to fall back to Performance-Mode-like behavior. */
export function applyGlobalModes() {
  const s = getSettings();
  document.documentElement.classList.toggle('performance-mode', !!s.performanceMode);
  document.documentElement.classList.toggle('compact-mode', !!s.compactMode);
  document.documentElement.classList.toggle('large-barcode', !!s.largeBarcode);
  document.documentElement.classList.toggle('large-product-image', !!s.largeProductImage);
  try {
    const mobile = window.matchMedia('(max-width:720px)').matches;
    let on = !!s.recentBesideBarcode;
    if (mobile) {
      on = localStorage.getItem('smouha_rb_mobile_on') === '1' && !!s.recentBesideBarcode;
    } else if (!Object.prototype.hasOwnProperty.call(s, 'recentBesideBarcode')) {
      on = true;
    }
    document.documentElement.classList.toggle('recent-beside-barcode', on);
  } catch (e) {
    document.documentElement.classList.toggle('recent-beside-barcode', !!s.recentBesideBarcode);
  }
}

// ---------------------------------------------------------------------------
// Panel UI
// ---------------------------------------------------------------------------

const TOGGLE_DEFS = [
  { key: 'autoCopySku', label: 'Auto Copy SKU' },
  { key: 'autoCopyBarcode', label: 'Auto Copy Barcode' },
  { key: 'hoverPreview', label: 'Hover Preview (Desktop)' },
  { key: 'compactMode', label: 'Compact Mode' },
  { key: 'performanceMode', label: 'Performance Mode' },
  { key: 'largeBarcode', label: 'Large Barcode' },
  { key: 'largeProductImage', label: 'Large Product Image' },
  { key: 'qrCode', label: 'QR Code Generator' },
  { key: 'scanSound', label: 'Play Scan Sound' },
  { key: 'intensiveAutoFocus', label: 'Intensive Auto Focus (Search)' },
  { key: 'showProductCount', label: 'Show DMart Live Card' },
  { key: 'showVersion', label: 'Show Version' },
  { key: 'recentBesideBarcode', label: 'Recent Beside Barcode (Desktop only)' },
  { key: 'dmartPopupEnabled', label: 'Dmart Confirm Popup' },
];

let panelEl = null;
let onForceUpdateResult = null; // callback(result) supplied by app.js for toast feedback

export function initSettingsPanel(elements, callbacks = {}) {
  panelEl = elements.panel;
  onForceUpdateResult = callbacks.onForceUpdateResult || (() => {});
  load();
  applyGlobalModes();
  renderPanel();

  elements.openBtn.addEventListener('click', () => openPanel());
  elements.closeBtn.addEventListener('click', () => closePanel());
  elements.backdrop.addEventListener('click', (e) => { if (e.target === elements.backdrop) closePanel(); });
}

export function openPanel() {
  if (!panelEl) return;
  // Refresh content so newly added options always appear
  try { renderPanel(); } catch (e) { /* ignore */ }
  panelEl.closest('.settings-backdrop').classList.add('open');
}
export function closePanel() { if (panelEl) panelEl.closest('.settings-backdrop').classList.remove('open'); }

function toggleRowHtml(def) {
  const s = getSettings();
  const checked = !!s[def.key];
  return `
    <label class="settings-row">
      <span>${def.label}</span>
      <span class="switch ${checked ? 'on' : ''}" data-key="${def.key}" role="switch" aria-checked="${checked}" tabindex="0"></span>
    </label>`;
}

async function developerInfoHtml() {
  try {
    const mapsCount = search.getMapsCount ? search.getMapsCount() : { bySku: 0, byBarcode: 0, bySuffix6: 0 };
    const loadTime = (typeof performance !== 'undefined')
      ? ((performance.now() / 1000).toFixed(2) + 's')
      : '—';
    let memory = 'Unavailable in this browser';
    try {
      if (performance.memory) {
        memory = formatBytes(performance.memory.usedJSHeapSize) + ' / ' + formatBytes(performance.memory.jsHeapSizeLimit);
      }
    } catch (e) { /* ignore */ }
    let dbSize = 'Unknown';
    try {
      const est = await db.estimateStorageUsage();
      if (est && est.usage != null) dbSize = formatBytes(est.usage) + ' (origin total)';
    } catch (e) { dbSize = 'Unavailable'; }
    const versionInfo = (updater.getLastVersionInfo && updater.getLastVersionInfo()) || {};
    const productCount = search.count ? search.count() : 0;
    const dataSource = updater.getLastLoadSource ? updater.getLastLoadSource() : '—';

    let indexMs = '—';
    try { if (window.__smouhaIndexMs != null) indexMs = window.__smouhaIndexMs + ' ms'; } catch (e) {}
    let liveMs = '—';
    try { if (window.__smouhaLastLiveMs != null) liveMs = window.__smouhaLastLiveMs + ' ms'; } catch (e) {}
    let bridgeSeen = '—';
    try {
      const mod = await import('./dmartLive.js');
      const ts = mod.getBridgeLastSeen && mod.getBridgeLastSeen();
      if (ts) {
        const sec = Math.round((Date.now() - ts) / 1000);
        bridgeSeen = sec < 60 ? (sec + 's ago') : (Math.round(sec / 60) + 'm ago');
      } else bridgeSeen = 'Never';
    } catch (e) { bridgeSeen = '—'; }
    let logsHtml = '';
    try {
      const logs = (typeof getRecentLogs === 'function' ? getRecentLogs() : []);
      if (logs && logs.length) {
        logsHtml = logs.slice().reverse().map((row) => {
          const ts = new Date(row.t).toLocaleTimeString();
          return `<div class="dev-log-line"><span>${escapeHtmlLocal(ts)} ${escapeHtmlLocal(row.level)}</span><b>${escapeHtmlLocal((row.scope ? row.scope + ': ' : '') + row.message)}</b></div>`;
        }).join('');
      } else {
        logsHtml = '<div class="dev-log-line"><span>Logs</span><b>Empty</b></div>';
      }
    } catch (e) {
      logsHtml = '<div class="dev-log-line"><span>Logs</span><b>Unavailable</b></div>';
    }

    return `
    <div><span>Version</span><b>${escapeHtmlLocal(String(versionInfo.version || '—'))}</b></div>
    <div><span>Build</span><b>${versionInfo.build != null ? versionInfo.build : '—'}</b></div>
    <div><span>Products</span><b>${Number(productCount).toLocaleString()}</b></div>
    <div><span>Data Source</span><b>${escapeHtmlLocal(String(dataSource || '—'))}</b></div>
    <div><span>Maps (sku/barcode/last6)</span><b>${mapsCount.bySku || 0} / ${mapsCount.byBarcode || 0} / ${mapsCount.bySuffix6 || 0}</b></div>
    <div><span>Load Time</span><b>${loadTime}</b></div>
    <div><span>Index Build</span><b>${escapeHtmlLocal(indexMs)}</b></div>
    <div><span>Last Live Fetch</span><b>${escapeHtmlLocal(liveMs)}</b></div>
    <div><span>Bridge last seen</span><b>${escapeHtmlLocal(bridgeSeen)}</b></div>
    <div><span>Memory Usage</span><b>${escapeHtmlLocal(memory)}</b></div>
    <div><span>Storage Usage</span><b>${escapeHtmlLocal(dbSize)}</b></div>
    <div><span>Last Updated</span><b>${escapeHtmlLocal(String(versionInfo.updated || '—'))}</b></div>
    <div><span>Browser</span><b>${escapeHtmlLocal(navigator.userAgent).slice(0, 60)}…</b></div>
    <div class="dev-log-block"><span>Recent Logs (20)</span></div>
    ${logsHtml}
  `;
  } catch (e) {
    return `<div><span>Developer info</span><b>Could not load (${escapeHtmlLocal(e && e.message ? e.message : 'error')})</b></div>`;
  }
}

function escapeHtmlLocal(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function getChangelogByVersion() {
  const v = updater.getLastVersionInfo && updater.getLastVersionInfo();
  if (v && Array.isArray(v.changelogByVersion) && v.changelogByVersion.length) {
    return v.changelogByVersion;
  }
  // Fallback: parse flat strings that start with "vX.Y.Z"
  const entries = (v && v.changelog) || [];
  const map = new Map();
  for (const line of entries) {
    const m = String(line).match(/^v?(\d+\.\d+(?:\.\d+)?)\s*[—\-:]\s*(.*)$/i);
    if (m) {
      const ver = m[1];
      if (!map.has(ver)) map.set(ver, []);
      if (m[2]) map.get(ver).push(m[2]);
    } else if (map.size) {
      // append to last version bucket
      const last = [...map.keys()].pop();
      map.get(last).push(String(line));
    }
  }
  return [...map.entries()].map(([version, items]) => ({ version, items }));
}

function changelogHtml() {
  const groups = getChangelogByVersion();
  if (!groups.length) return '<p class="settings-empty">No changelog available.</p>';
  const latest = groups[0] || { version: '—', items: [] };
  const latestItems = (latest.items || []).slice(0, 12);
  const latestBlock =
    '<div class="changelog-latest">' +
    '<div class="changelog-latest-head">v' + escapeHtmlLocal(latest.version) + ' — latest</div>' +
    '<ul class="changelog-latest-list">' +
    (latestItems.length
      ? latestItems.map((it) => '<li>' + escapeHtmlLocal(it) + '</li>').join('')
      : '<li>No details</li>') +
    '</ul>' +
    ((latest.items || []).length > 12
      ? '<button type="button" class="changelog-ver-btn changelog-latest-more" data-cl-idx="0">Show all v' +
        escapeHtmlLocal(latest.version) + '…</button>'
      : '') +
    '</div>';
  const older = groups.slice(1);
  const buttons =
    older.length
      ? '<div class="changelog-versions-label">Previous versions</div>' +
        '<div class="changelog-versions">' +
        older
          .map(
            (g, i) =>
              '<button type="button" class="changelog-ver-btn" data-cl-idx="' +
              (i + 1) +
              '">v' +
              escapeHtmlLocal(g.version) +
              '</button>'
          )
          .join('') +
        '</div>'
      : '';
  return latestBlock + buttons;
}

function openChangelogPopup(version, items) {
  let backdrop = document.getElementById('changelogPopupBackdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = 'changelogPopupBackdrop';
    backdrop.className = 'changelog-popup-backdrop';
    backdrop.innerHTML = `
      <div class="changelog-popup-box" role="dialog" aria-modal="true">
        <div class="changelog-popup-header">
          <span class="changelog-popup-title" id="changelogPopupTitle"></span>
          <button type="button" class="changelog-popup-close" id="changelogPopupClose" aria-label="Close">×</button>
        </div>
        <ul class="changelog-popup-list" id="changelogPopupList"></ul>
      </div>`;
    document.body.appendChild(backdrop);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) backdrop.classList.remove('open');
    });
    backdrop.querySelector('#changelogPopupClose').addEventListener('click', () => {
      backdrop.classList.remove('open');
    });
  }
  backdrop.querySelector('#changelogPopupTitle').textContent = 'v' + version;
  const list = backdrop.querySelector('#changelogPopupList');
  list.innerHTML = (items && items.length)
    ? items.map((it) => `<li>${escapeHtmlLocal(it)}</li>`).join('')
    : '<li>No details</li>';
  backdrop.classList.add('open');
}

function wireChangelogButtons(panel) {
  const groups = getChangelogByVersion();
  panel.querySelectorAll('.changelog-ver-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.clIdx);
      const g = groups[idx];
      if (g) openChangelogPopup(g.version, g.items);
    });
  });
}

async function renderPanel() {
  if (!panelEl) return;
  const byKey = Object.fromEntries(TOGGLE_DEFS.map(d => [d.key, d]));
  const rows = (keys) => keys.map(k => byKey[k] ? toggleRowHtml(byKey[k]) : '').join('');
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  panelEl.innerHTML = `
    <div class="settings-section">
      <h4>Appearance</h4>
      <label class="settings-row">
        <span>Dark Mode</span>
        <span class="switch ${isDark ? 'on' : ''}" data-key="__theme" role="switch" aria-checked="${isDark}" tabindex="0"></span>
      </label>
      ${rows(['compactMode', 'performanceMode', 'largeProductImage', 'showProductCount', 'showVersion'])}
    </div>
    <div class="settings-section">
      <h4>General</h4>
      ${rows(['dmartPopupEnabled', 'recentBesideBarcode', 'autoCopySku', 'autoCopyBarcode', 'scanSound', 'intensiveAutoFocus', 'hoverPreview'])}
    </div>
    <div class="settings-section">
      <h4>Barcode</h4>
      ${rows(['qrCode', 'largeBarcode'])}
    </div>
    <div class="settings-section">
      <h4>Warehouse</h4>
      <div class="settings-wh-display">
        <div class="settings-wh-display-label">Warehouse Display</div>
        <div class="settings-wh-display-options" role="radiogroup" aria-label="Warehouse Display">
          <label class="settings-wh-option">
            <input type="radio" name="warehouseDisplay" value="original" ${getSettings().warehouseDisplay !== 'friendly' ? 'checked' : ''}>
            <span>Original Names</span>
          </label>
          <label class="settings-wh-option">
            <input type="radio" name="warehouseDisplay" value="friendly" ${getSettings().warehouseDisplay === 'friendly' ? 'checked' : ''}>
            <span>Friendly Names</span>
          </label>
        </div>
      </div>
    </div>
    <div class="settings-section">
      <h4>Database</h4>
      <button class="btn settings-action" id="settingsForceUpdate">Force Update Database</button>
      <button class="btn settings-action" id="settingsClearDb">Clear IndexedDB</button>
      <button class="btn settings-action" id="settingsClearDmartCache">Clear DMart Cache</button>
      <button class="btn settings-action" id="settingsRunImageCheck">Run Image Check</button>
      <button class="btn settings-action" id="settingsSmokeTest">Run Smoke Test</button>
      <button class="btn settings-action" id="settingsDeployChecklist">Deploy Checklist</button>
      <button class="btn settings-action" id="settingsExportBackup">Export Settings & Recent</button>
      <button class="btn settings-action" id="settingsImportBackup">Import Settings & Recent</button>
      <input type="file" id="settingsImportFile" accept="application/json,.json" hidden>
      <button class="btn settings-action" id="settingsReset">Reset Settings</button>
      <div id="settingsSmokeResult" class="dev-grid" style="margin-top:8px;display:none"></div>
    </div>
    <div class="settings-section">
      <h4>Developer</h4>
      <div id="settingsDevInfo" class="dev-grid">Loading…</div>
    </div>
    <div class="settings-section">
      <h4>Changelog</h4>
      ${changelogHtml()}
    </div>
  `;

  // Fill developer diagnostics early so UI never stuck on Loading
  const devInfoElEarly = panelEl.querySelector('#settingsDevInfo');
  if (devInfoElEarly) {
    developerInfoHtml()
      .then(html => { if (devInfoElEarly.isConnected) { devInfoElEarly.innerHTML = html; } })
      .catch(() => { if (devInfoElEarly.isConnected) devInfoElEarly.innerHTML = '<div><span>Error</span><b>Failed</b></div>'; });
  }

  wireChangelogButtons(panelEl);

  const deployBtn = panelEl.querySelector('#settingsDeployChecklist');
  if (deployBtn) {
    deployBtn.addEventListener('click', async () => {
      const out = panelEl.querySelector('#settingsSmokeResult');
      if (out) { out.style.display = 'grid'; out.innerHTML = '<div><span>Checklist</span><b>Running…</b></div>'; }
      const rows = [];
      try {
        const v = (updater.getLastVersionInfo && updater.getLastVersionInfo()) || {};
        rows.push(['version.json version', !!v.version, String(v.version || '—')]);
        rows.push(['version.json build', v.build != null, String(v.build ?? '—')]);
        const count = search.count ? search.count() : 0;
        rows.push(['In-memory products', count > 0, String(count)]);
        if (v.products != null) {
          rows.push(['Count matches version.products', count === Number(v.products), count + ' vs ' + v.products]);
        }
        try {
          const r = await fetch('data/products-search.json', { method: 'HEAD', cache: 'no-store' });
          rows.push(['products-search.json', r.ok, 'HTTP ' + r.status]);
        } catch (e) {
          rows.push(['products-search.json', false, e.message || 'err']);
        }
        try {
          const r = await fetch('data/products.json', { method: 'HEAD', cache: 'no-store' });
          rows.push(['products.json', r.ok, 'HTTP ' + r.status]);
        } catch (e) {
          rows.push(['products.json', false, e.message || 'err']);
        }
        try {
          const r = await fetch('sw.js', { method: 'HEAD', cache: 'no-store' });
          rows.push(['sw.js reachable', r.ok, 'HTTP ' + r.status]);
        } catch (e) {
          rows.push(['sw.js', false, e.message || 'err']);
        }
        const swCtrl = navigator.serviceWorker && navigator.serviceWorker.controller;
        rows.push(['SW controlling page', !!swCtrl, swCtrl ? 'yes' : 'no']);
        try {
          const live = await import('./dmartLive.js');
          rows.push(['Bridge online', !!(live.isBridgeOnline && live.isBridgeOnline()), '']);
          const ts = live.getBridgeLastSeen && live.getBridgeLastSeen();
          rows.push(['Bridge last seen', !!ts, ts ? (Math.round((Date.now() - ts) / 1000) + 's ago') : 'never']);
        } catch (e) {
          rows.push(['Bridge module', false, e.message || 'err']);
        }
        if (out) {
          out.innerHTML = rows.map(([k, ok, d]) =>
            `<div><span>${escapeHtmlLocal(k)}</span><b style="color:${ok ? '#16a34a' : '#dc2626'}">${ok ? 'PASS' : 'CHECK'} — ${escapeHtmlLocal(String(d))}</b></div>`
          ).join('');
        }
      } catch (e) {
        if (out) out.innerHTML = `<div><span>Checklist</span><b style="color:#dc2626">${escapeHtmlLocal(e.message || 'error')}</b></div>`;
      }
    });
  }


  const exportBtn = panelEl.querySelector('#settingsExportBackup');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      try {
        const payload = {
          version: 1,
          exportedAt: new Date().toISOString(),
          settings: getSettings(),
          recent: null,
          favorites: null,
          theme: null,
        };
        try { payload.recent = JSON.parse(localStorage.getItem('tm_recent_searches') || 'null'); } catch (e) {}
        try { payload.favorites = JSON.parse(localStorage.getItem('tm_favorites') || 'null'); } catch (e) {}
        try { payload.theme = localStorage.getItem('tm_theme'); } catch (e) {}
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'smouha-pick-backup-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) {} }, 500);
        try { log('info', 'backup', 'Settings exported'); } catch (e) {}
      } catch (e) {
        alert('Export failed: ' + (e.message || e));
      }
    });
  }
  const importBtn = panelEl.querySelector('#settingsImportBackup');
  const importFile = panelEl.querySelector('#settingsImportFile');
  if (importBtn && importFile) {
    importBtn.addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', async () => {
      const file = importFile.files && importFile.files[0];
      importFile.value = '';
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!data || typeof data !== 'object') throw new Error('Invalid file');
        if (data.settings && typeof data.settings === 'object') {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...getSettings(), ...data.settings }));
        }
        if (data.recent != null) localStorage.setItem('tm_recent_searches', JSON.stringify(data.recent));
        if (data.favorites != null) localStorage.setItem('tm_favorites', JSON.stringify(data.favorites));
        if (data.theme != null) localStorage.setItem('tm_theme', data.theme);
        try { applyGlobalModes(); } catch (e) {}
        try { log('info', 'backup', 'Settings imported — reloading'); } catch (e) {}
        alert('Import OK. The page will reload.');
        location.reload();
      } catch (e) {
        alert('Import failed: ' + (e.message || e));
      }
    });
  }


  const smokeBtn = panelEl.querySelector('#settingsSmokeTest');
  if (smokeBtn) {
    smokeBtn.addEventListener('click', async () => {
      const out = panelEl.querySelector('#settingsSmokeResult');
      if (out) { out.style.display = 'grid'; out.innerHTML = '<div><span>Smoke</span><b>Running…</b></div>'; }
      try {
        const results = [];
        const count = search.count ? search.count() : 0;
        results.push(['Products loaded', count > 0, String(count)]);
        // sample first product via maps if possible
        let sampleSku = null;
        try {
          const maps = search.getMapsCount ? search.getMapsCount() : {};
          results.push(['SKU map', (maps.bySku || 0) > 0, String(maps.bySku || 0)]);
          results.push(['Barcode map', (maps.byBarcode || 0) > 0, String(maps.byBarcode || 0)]);
          results.push(['Last6 map', (maps.bySuffix6 || 0) > 0, String(maps.bySuffix6 || 0)]);
        } catch (e) {
          results.push(['Maps', false, e.message || 'err']);
        }
        // Try a known-pattern: if any product in recent localStorage
        try {
          const raw = localStorage.getItem('tm_recent_searches');
          const arr = raw ? JSON.parse(raw) : [];
          if (Array.isArray(arr) && arr[0] && arr[0].sku) sampleSku = String(arr[0].sku);
        } catch (e) {}
        if (sampleSku && search.findBySku) {
          const p = search.findBySku(sampleSku);
          results.push(['findBySku(recent)', !!p, sampleSku]);
          if (p && p.barcodes && p.barcodes[0] && p.barcodes[0].length >= 6) {
            const suf = p.barcodes[0].slice(-6);
            const list = search.findBySuffix ? search.findBySuffix(suf) : [];
            results.push(['findBySuffix(last6)', Array.isArray(list) && list.length > 0, suf]);
          }
        } else {
          results.push(['findBySku sample', count > 0, 'no recent SKU']);
        }
        try {
          const wid = (await import('./warehouse.js')).getSelectedId();
          results.push(['Warehouse selected', !!wid, String(wid || 'none')]);
        } catch (e) {
          results.push(['Warehouse', false, e.message || 'err']);
        }
        results.push(['Search input', !!document.getElementById('searchInput'), 'DOM']);
        results.push(['DMart card host', true, 'ok']);
        // Live probe when bridge online
        try {
          const live = await import('./dmartLive.js');
          const online = live.isBridgeOnline && live.isBridgeOnline();
          results.push(['Bridge online', !!online, online ? 'yes' : 'no']);
          if (online && sampleSku && live.fetchLiveProductInfo) {
            const wid = (await import('./warehouse.js')).getSelectedId();
            if (wid) {
              const t0 = performance.now();
              const data = await live.fetchLiveProductInfo(sampleSku, wid);
              const ms = Math.round(performance.now() - t0);
              const ok = !!(data && (data.ok || data.onHand != null || data.price != null));
              results.push(['Live fetch', ok, (data && data.via ? data.via + ' · ' : '') + ms + 'ms']);
            }
          } else {
            results.push(['Live fetch', true, 'skipped (bridge offline or no sample)']);
          }
        } catch (e) {
          results.push(['Live fetch', false, e.message || 'err']);
        }
        // Search catalog file reachability
        try {
          const res = await fetch('data/products-search.json', { method: 'HEAD', cache: 'no-store' });
          results.push(['products-search.json', res.ok, 'HTTP ' + res.status]);
        } catch (e) {
          results.push(['products-search.json', false, e.message || 'err']);
        }
        if (out) {
          out.innerHTML = results.map(([k, ok, d]) =>
            `<div><span>${escapeHtmlLocal(k)}</span><b style="color:${ok ? '#16a34a' : '#dc2626'}">${ok ? 'PASS' : 'FAIL'} — ${escapeHtmlLocal(String(d))}</b></div>`
          ).join('');
        }
        try { log('info', 'smoke', 'Smoke test finished', results.filter(r => !r[1]).length + ' fails'); } catch (e) {}
      } catch (e) {
        if (out) out.innerHTML = `<div><span>Smoke</span><b style="color:#dc2626">${escapeHtmlLocal(e.message || 'error')}</b></div>`;
      }
    });
  }


  panelEl.querySelectorAll('.switch').forEach(sw => {
    const activate = () => {
      const key = sw.dataset.key;
      if (key === '__theme') {
        window.dispatchEvent(new CustomEvent('smouha:toggle-theme'));
        requestAnimationFrame(() => {
          const dark = document.documentElement.getAttribute('data-theme') === 'dark';
          sw.classList.toggle('on', dark);
          sw.setAttribute('aria-checked', String(dark));
        });
        return;
      }
      const next = !getSettings()[key];
      setSetting(key, next);
      sw.classList.toggle('on', next);
      sw.setAttribute('aria-checked', String(next));
      if (key === 'hoverPreview' && !next) {
        try { window.dispatchEvent(new CustomEvent('smouha:hover-preview-off')); } catch (e) {}
      }
      if (key === 'showProductCount') {
        document.documentElement.classList.toggle('hide-dmart-live', !next);
        try { window.dispatchEvent(new CustomEvent('smouha:dmart-live-layout')); } catch (e) {}
      }
      if (key === 'recentBesideBarcode') {
        document.documentElement.classList.toggle('recent-beside-barcode', next);
        try {
          if (window.matchMedia('(max-width:720px)').matches) {
            localStorage.setItem('smouha_rb_mobile_on', next ? '1' : '0');
          }
        } catch (e) { /* ignore */ }
        try {
          window.dispatchEvent(new CustomEvent('smouha:recent-layout'));
        } catch (e) { /* ignore */ }
      }
      if (key === 'dmartPopupEnabled') {
        try {
          if (window.matchMedia('(max-width:720px)').matches) {
            localStorage.setItem('smouha_dmart_popup_mobile_on', next ? '1' : '0');
          }
        } catch (e) { /* ignore */ }
      }
    };
    sw.addEventListener('click', activate);
    sw.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } });
  });

  panelEl.querySelectorAll('input[name="warehouseDisplay"]').forEach(radio => {
    radio.addEventListener('change', () => {
      if (radio.checked) setSetting('warehouseDisplay', radio.value);
    });
  });

  panelEl.querySelector('#settingsForceUpdate')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = 'Updating…';
    try {
      const count = await updater.forceUpdate();
      onForceUpdateResult({ ok: true, count });
    } catch (err) {
      onForceUpdateResult({ ok: false, error: err });
    }
    btn.disabled = false; btn.textContent = 'Force Update Database';
    renderPanel();
  });

    panelEl.querySelector('#settingsClearDmartCache')?.addEventListener('click', (e) => {
    e.preventDefault();
    try {
      window.dispatchEvent(new CustomEvent('smouha:clear-dmart-cache'));
    } catch (err) {}
  });

  panelEl.querySelector('#settingsClearDb')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = 'Clearing…';
    try {
      const result = await updater.clearAndRebuild();
      onForceUpdateResult({ ok: true, count: result.count });
    } catch (err) {
      onForceUpdateResult({ ok: false, error: err });
    }
    btn.disabled = false; btn.textContent = 'Clear IndexedDB';
    renderPanel();
  });

  panelEl.querySelector('#settingsRunImageCheck')?.addEventListener('click', () => {
    window.open('maintenance/image-check/', '_blank', 'noopener,noreferrer');
  });

  panelEl.querySelector('#settingsReset')?.addEventListener('click', () => {
    resetSettings();
    renderPanel();
  });

  const devInfoEl = panelEl.querySelector('#settingsDevInfo');
  developerInfoHtml()
    .then(html => {
      if (!devInfoEl) return;
      devInfoEl.innerHTML = html;
      devInfoEl.classList.add('is-ready');
    })
    .catch((e) => {
      if (devInfoEl) devInfoEl.innerHTML = '<div><span>Error</span><b>Failed to load diagnostics</b></div>';
    });
}
