/**
 * settingsPage.js — standalone Settings page (settings.html)
 * Own URL so layout can use a desktop sidebar and full viewport freely.
 */
import * as settings from './settings.js';
import * as updater from './updater.js';

function toast(msg, type) {
  let host = document.getElementById('toastHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toastHost';
    host.className = 'toast-host';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = 'toast toast-' + (type === 'error' ? 'error' : 'success');
  el.textContent = msg;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 280);
  }, 2800);
}

function applyStoredTheme() {
  try {
    const raw = localStorage.getItem('tm_theme');
    const theme = raw ? JSON.parse(raw) : 'light';
    if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
  } catch (e) {}
}

function syncMobileNav() {
  const nav = document.getElementById('settingsNav');
  const navM = document.getElementById('settingsNavMobile');
  if (!nav || !navM) return;
  const copy = () => {
    navM.innerHTML = nav.innerHTML;
    navM.querySelectorAll('.settings-nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-section');
        const mirror = nav.querySelector('.settings-nav-btn[data-section="' + id + '"]');
        if (mirror) mirror.click();
      });
    });
  };
  copy();
  new MutationObserver(copy).observe(nav, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  });
}

async function boot() {
  applyStoredTheme();
  try {
    await updater.loadInitial();
  } catch (e) {
    try {
      const r = await fetch('data/version.json', { cache: 'no-store' });
      if (r.ok) window.__smouhaVersion = await r.json();
    } catch (err) {}
  }

  const panel = document.getElementById('settingsPanel');
  settings.enterStandaloneMode();
  settings.initSettingsPanel(
    { panel, closeBtn: null },
    {
      onForceUpdateResult: (r) =>
        toast(
          r.ok ? 'Database Updated Successfully' : 'Update failed — check your connection',
          r.ok ? 'success' : 'error'
        ),
    }
  );
  syncMobileNav();
}

boot().catch((e) => console.error('[settingsPage]', e));
