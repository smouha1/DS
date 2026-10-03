/* ============================================================================
   maintenance.js — MODULE: maintenance
   ------------------------------------------------------------------------
   Maintenance Panel. Password-protected as an INTERFACE restriction only —
   there is no backend, so this cannot be real security. Anyone who reads
   this file's source can see the password. This is accepted and intended
   for this internal tool: the goal is to keep casual users from stumbling
   into destructive actions (Clear Database), not to guard against a
   determined bad actor.

   Triggered by a hidden entry point (see app.js): tapping the footer
   version line 5 times, or Ctrl+Shift+M on desktop. It's deliberately not
   a visible nav item, matching how /maintenance/image-check/ already works.

   No upload functionality, per spec — Force Update always re-pulls from
   data/products.json (the committed file), never accepts a file from the
   user's device.
   ============================================================================ */

import * as db from './indexeddb.js';
import * as updater from './updater.js';
import * as search from './search.js';
import { formatBytes } from './utils.js';

// UI-only gate — see module comment above. Change this string and redeploy
// if you want a different passphrase; there is no way to make this secret
// in a static, backend-less site.
const MAINTENANCE_PASSWORD = 'smouha-maint-2026';

let panelBackdropEl = null;
let panelBodyEl = null;
let unlocked = false;

export function initMaintenancePanel(elements) {
  panelBackdropEl = elements.backdrop;
  panelBodyEl = elements.body;
  elements.closeBtn.addEventListener('click', close);
  panelBackdropEl.addEventListener('click', (e) => { if (e.target === panelBackdropEl) close(); });
}

export function open() {
  if (!panelBackdropEl) return;
  panelBackdropEl.classList.add('open');
  if (unlocked) renderPanel();
  else renderPasswordGate();
}

export function close() {
  if (panelBackdropEl) panelBackdropEl.classList.remove('open');
}

function renderPasswordGate() {
  panelBodyEl.innerHTML = `
    <div class="maint-gate">
      <p>This panel is for internal maintenance only.</p>
      <input type="password" id="maintPasswordInput" placeholder="Password" autocomplete="off">
      <button class="btn btn-primary" id="maintUnlockBtn">Unlock</button>
      <p class="maint-gate-hint" id="maintGateError" hidden>Incorrect password.</p>
    </div>`;

  const input = panelBodyEl.querySelector('#maintPasswordInput');
  const errorEl = panelBodyEl.querySelector('#maintGateError');
  const tryUnlock = () => {
    if (input.value === MAINTENANCE_PASSWORD) {
      unlocked = true;
      renderPanel();
    } else {
      errorEl.hidden = false;
      input.value = '';
      input.focus();
    }
  };
  panelBodyEl.querySelector('#maintUnlockBtn').addEventListener('click', tryUnlock);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });
  input.focus();
}

async function renderPanel() {
  const versionInfo = updater.getLastVersionInfo() || {};
  const est = await db.estimateStorageUsage();
  const dbSizeText = est ? formatBytes(est.usage) + ' used of ' + formatBytes(est.quota) + ' quota (origin total)' : 'Unknown';
  const t0 = (window.__smouhaLoadStart || performance.now());
  const loadTime = ((performance.now() - t0) / 1000).toFixed(2) + 's since navigation start';

  panelBodyEl.innerHTML = `
    <div class="maint-section">
      <h4>Database Info</h4>
      <div class="dev-grid">
        <div><span>Current Version</span><b>${versionInfo.version || '—'}</b></div>
        <div><span>Build</span><b>${versionInfo.build != null ? versionInfo.build : '—'}</b></div>
        <div><span>Product Count</span><b>${search.count().toLocaleString()}</b></div>
        <div><span>IndexedDB Size</span><b>${dbSizeText}</b></div>
        <div><span>Data Source</span><b>${updater.getLastLoadSource()}</b></div>
        <div><span>Last Updated</span><b>${versionInfo.updated || '—'}</b></div>
      </div>
    </div>

    <div class="maint-section">
      <h4>Actions</h4>
      <button class="btn settings-action" id="maintForceUpdate">Force Update</button>
      <button class="btn settings-action" id="maintClearDb">Clear Database</button>
      <a class="btn settings-action" href="../image-check/" target="_blank" rel="noopener noreferrer" style="text-decoration:none;text-align:center;">Image Check</a>
      <button class="btn settings-action" id="maintExportBroken">Broken Images Export (via Image Check)</button>
    </div>

    <div class="maint-section">
      <h4>Performance Information</h4>
      <div class="dev-grid">
        <div><span>Load Time</span><b>${loadTime}</b></div>
        <div><span>Memory Usage</span><b>${performance.memory ? formatBytes(performance.memory.usedJSHeapSize) : 'Unavailable in this browser'}</b></div>
        <div><span>Maps (sku/barcode/last6)</span><b>${Object.values(search.getMapsCount()).join(' / ')}</b></div>
      </div>
    </div>

    <div class="maint-section">
      <h4>Developer Utilities</h4>
      <p class="maint-note">Dmart URL investigation: TODO — see dmart.js for the documented open questions (warehouse ID source, product UUID mapping, session/auth behavior). Requires manual verification against the live Portal; not something this tool can determine on its own.</p>
    </div>

    <button class="btn settings-action" id="maintLock" style="margin-top:12px;">Lock Panel</button>
  `;

  panelBodyEl.querySelector('#maintForceUpdate').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = 'Updating…';
    try { await updater.forceUpdate(); } catch (err) { /* swallow — shown implicitly via re-render */ }
    renderPanel();
  });

  panelBodyEl.querySelector('#maintClearDb').addEventListener('click', async (e) => {
    if (!confirm('Clear the local database? It will be rebuilt from data/products.json.')) return;
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = 'Clearing…';
    try { await updater.clearAndRebuild(); } catch (err) { /* swallow */ }
    renderPanel();
  });

  panelBodyEl.querySelector('#maintExportBroken').addEventListener('click', () => {
    window.open('../image-check/', '_blank', 'noopener,noreferrer');
  });

  panelBodyEl.querySelector('#maintLock').addEventListener('click', () => {
    unlocked = false;
    close();
  });
}
