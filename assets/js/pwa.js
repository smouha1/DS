/* ============================================================================
   pwa.js — service worker registration, offline banner, update toast
   (Install UI removed — APK download is separate.)
   ------------------------------------------------------------------------ */
(function initPwa() {
  function updateOfflineBanner() {
    const banner = document.getElementById('pwaOfflineBanner');
    if (!banner) return;
    const offline = !navigator.onLine;
    banner.hidden = !offline;
    document.documentElement.classList.toggle('is-offline', offline);
    if (offline) {
      banner.innerHTML =
        '<span class="pwa-offline-dot" aria-hidden="true"></span>' +
        '<span>Offline mode — search & barcodes work from cache. Live stock needs internet.</span>';
    }
  }

  function showUpdateToast(reg) {
    if (document.getElementById('pwaUpdateToast')) return;
    const el = document.createElement('div');
    el.id = 'pwaUpdateToast';
    el.className = 'pwa-update-toast';
    el.innerHTML =
      '<span>Update available</span>' +
      '<button type="button" id="pwaUpdateBtn">Refresh</button>';
    document.body.appendChild(el);
    el.querySelector('#pwaUpdateBtn').addEventListener('click', () => {
      try {
        if (reg && reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      } catch (e) {}
      window.location.reload();
    });
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker
      .register('./sw.js', { scope: './' })
      .then((reg) => {
        try {
          if (reg.waiting) showUpdateToast(reg);
          reg.addEventListener('updatefound', () => {
            const w = reg.installing;
            if (!w) return;
            w.addEventListener('statechange', () => {
              if (w.state === 'installed' && navigator.serviceWorker.controller) {
                showUpdateToast(reg);
              }
            });
          });
          setInterval(() => { reg.update().catch(() => {}); }, 60 * 60 * 1000);
        } catch (e) {}
      })
      .catch(() => {});
  }

  window.addEventListener('online', updateOfflineBanner);
  window.addEventListener('offline', updateOfflineBanner);

  function boot() {
    updateOfflineBanner();
    registerSW();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
