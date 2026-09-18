/* appCatalogUi.js — catalog status badge + session auth banner */
export function wireCatalogAndSessionUi() {
  function setCatalogBadge(state, message) {
    const el = document.getElementById('catalogStatusBadge');
    if (!el) return;
    if (!state || state === 'ok') {
      el.hidden = true;
      el.textContent = '';
      el.setAttribute('data-state', 'ok');
      return;
    }
    el.hidden = false;
    el.setAttribute('data-state', state);
    el.textContent = message || (state === 'updating' ? 'Updating catalog…' : 'Catalog may be outdated');
  }

  window.addEventListener('smouha:catalog-status', (ev) => {
    const d = (ev && ev.detail) || {};
    setCatalogBadge(d.state, d.message);
    if (d.state === 'ok') setTimeout(() => setCatalogBadge('ok'), 2500);
  });
  window.addEventListener('smouha:db-updated', () => setCatalogBadge('ok', 'Catalog updated'));
  window.addEventListener('smouha:db-update-failed', () => setCatalogBadge('stale', 'Catalog may be outdated'));

  function setSessionBanner(visible, text) {
    const el = document.getElementById('sessionAuthBanner');
    if (!el) return;
    if (!visible) {
      el.classList.remove('is-visible');
      el.textContent = '';
      return;
    }
    el.textContent =
      text ||
      'DMart session needs refresh — open the branch inventory page on the PC with the extension.';
    el.classList.add('is-visible');
  }

  window.addEventListener('smouha:session-auth-required', (ev) => {
    const msg = ev && ev.detail && ev.detail.message;
    setSessionBanner(true, msg);
  });
  window.addEventListener('smouha:session-auth-ok', () => setSessionBanner(false));
}
