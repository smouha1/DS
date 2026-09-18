/* ============================================================================
   smartScan.js — Pelican Mode (camera + ZXing + optional OCR)
   ------------------------------------------------------------------------
   Extracted from app.js. Depends only on a search callback:
     createSmartScan({ searchFromExternalInput(code) })
   ============================================================================ */

/* ============================================================================
   MODULE: smartScan (internal module name unchanged — user-facing feature
   is now called "Pelican Mode")
   ------------------------------------------------------------------------
   Flow (speed-optimized):
     Open Camera → ZXing scans continuously (PRIMARY engine), analyzing
     only the center ROI of the frame → if a FULL BARCODE is detected →
     search using Pelican Mode priority (full barcode -> SKU -> last 6
     digits) → display product → generate Code128(s) → stop camera.

     If ZXing finds nothing after ~1000ms → OCR fallback, cropped to the
     white product card only:
       Step 2: extract SKU → search by SKU
       Step 3: if no SKU, extract full barcode → use its LAST 6 DIGITS →
               search via the existing last-6-digits engine

   BarcodeDetector is OPTIONAL: used only as a cheap opportunistic check
   run alongside ZXing (never gating it, never the primary loop). No
   search logic is duplicated — everything routes through
   searchFromExternal(), which reuses search.queryPelican().
   ============================================================================ */
export function createSmartScan(deps = {}) {
  const searchFromExternal =
    typeof deps.searchFromExternalInput === 'function'
      ? deps.searchFromExternalInput
      : () => {};


  function loadExternalScript(src) {
    return new Promise((resolve, reject) => {
      const found = document.querySelector('script[data-smouha-src="' + src + '"]');
      if (found) {
        if (found.dataset.loaded === '1') return resolve();
        found.addEventListener('load', () => resolve());
        found.addEventListener('error', () => reject(new Error('load fail ' + src)));
        return;
      }
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.dataset.smouhaSrc = src;
      s.onload = () => { s.dataset.loaded = '1'; resolve(); };
      s.onerror = () => reject(new Error('load fail ' + src));
      document.head.appendChild(s);
    });
  }

  let scanLibsPromise = null;
  function ensureScanLibs() {
    if (window.ZXingBrowser && window.ZXing) return Promise.resolve(true);
    if (scanLibsPromise) return scanLibsPromise;
    scanLibsPromise = (async () => {
      try {
        await loadExternalScript('https://unpkg.com/@zxing/library@0.20.0/umd/index.min.js');
        await loadExternalScript('https://unpkg.com/@zxing/browser@0.1.5');
        // OCR is optional — load in background, do not block camera start
        loadExternalScript('https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.0.4/tesseract.min.js').catch(() => {});
        return !!(window.ZXingBrowser && window.ZXing);
      } catch (e) {
        scanLibsPromise = null;
        return false;
      }
    })();
    return scanLibsPromise;
  }


  const OCR_FALLBACK_MS = 1000;      // ZXing detection window before OCR kicks in
  const DUPLICATE_IGNORE_MS = 2000;  // ignore repeat detections of the same code

  let els = {};
  let stream = null;
  let zxingReader = null;
  let zxingControls = null;
  let nativeDetector = null;
  let nativeCheckId = null;
  let ocrTimer = null;
  let running = false;
  let ocrBusy = false;
  let lastCode = null;
  let lastCodeAt = 0;

  function cacheEls() {
    els.scanBtn = document.getElementById('smartScanBtn');
    els.backdrop = document.getElementById('scanBackdrop');
    els.closeBtn = document.getElementById('scanCloseBtn');
    els.video = document.getElementById('scanVideo');
    els.ocrCanvas = document.getElementById('scanOcrCanvas');
    els.status = document.getElementById('scanStatus');
  }

  function setStatus(text, kind) {
    els.status.textContent = text;
    els.status.classList.remove('error', 'success');
    if (kind) els.status.classList.add(kind);
  }

  /* ---------- Lifecycle ---------- */
  async function open() {
    els.backdrop.classList.add('open');
    setStatus('Loading scanner…');

    const ok = await ensureScanLibs();
    if (!ok || !window.ZXingBrowser || !window.ZXing) {
      setStatus('Scanner engine failed to load', 'error');
      setTimeout(close, 1800);
      return;
    }
    setStatus('Requesting camera…');

    running = true;
    lastCode = null;
    lastCodeAt = 0;
    initNativeDetector(); // optional, opportunistic only — never blocks ZXing

    const hints = new Map();
    const { BarcodeFormat, DecodeHintType } = window.ZXing;
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
      BarcodeFormat.CODE_128, BarcodeFormat.CODE_39
    ]);
    hints.set(DecodeHintType.TRY_HARDER, false); // favor speed over exhaustive retries per frame
    zxingReader = new window.ZXingBrowser.BrowserMultiFormatReader(hints);

    try {
      setStatus('Searching…');
      scheduleOcrFallback();

      const baseVideo = {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        advanced: [{ focusMode: 'continuous' }]
      };

      // Acquire REAR-only stream BEFORE attaching to video / ZXing.
      // Never use facingMode:ideal or unconstrained video — those briefly open the front camera on many phones.
      const isFrontLabel = (label) => /front|user|face|selfie|أمام|امام/i.test(String(label || ''));
      const isRearLabel = (label) => /back|rear|environment|world|خلف|خلفية/i.test(String(label || ''));

      async function stopStream(s) {
        if (!s) return;
        try { s.getTracks().forEach(t => { try { t.stop(); } catch (e) {} }); } catch (e) {}
      }

      async function openRearStreamOnly() {
        // 1) exact environment only (never ideal / never default)
        const exactTries = [
          { audio: false, video: { facingMode: { exact: 'environment' }, ...baseVideo } },
          { audio: false, video: { facingMode: { exact: 'environment' } } },
        ];
        for (const c of exactTries) {
          try {
            const s = await navigator.mediaDevices.getUserMedia(c);
            const label = (s.getVideoTracks()[0] && s.getVideoTracks()[0].label) || '';
            if (isFrontLabel(label)) { await stopStream(s); continue; }
            return s;
          } catch (e) { /* try next */ }
        }

        // 2) Permission granted — labels should exist; pick rear by deviceId
        let devices = [];
        try {
          devices = await navigator.mediaDevices.enumerateDevices();
        } catch (e) { devices = []; }
        const cams = devices.filter(d => d.kind === 'videoinput');
        const rear =
          cams.find(d => isRearLabel(d.label)) ||
          cams.find(d => d.label && !isFrontLabel(d.label)) ||
          null;
        if (rear && rear.deviceId) {
          try {
            const s = await navigator.mediaDevices.getUserMedia({
              audio: false,
              video: { deviceId: { exact: rear.deviceId }, ...baseVideo }
            });
            const label = (s.getVideoTracks()[0] && s.getVideoTracks()[0].label) || '';
            if (isFrontLabel(label)) { await stopStream(s); }
            else return s;
          } catch (e) { /* fall through */ }
        }

        // 3) Last resort: any non-front deviceId
        for (const cam of cams) {
          if (!cam.deviceId || isFrontLabel(cam.label)) continue;
          try {
            const s = await navigator.mediaDevices.getUserMedia({
              audio: false,
              video: { deviceId: { exact: cam.deviceId }, ...baseVideo }
            });
            const label = (s.getVideoTracks()[0] && s.getVideoTracks()[0].label) || '';
            if (isFrontLabel(label)) { await stopStream(s); continue; }
            return s;
          } catch (e) { /* next */ }
        }
        return null;
      }

      stream = await openRearStreamOnly();
      if (!stream) {
        throw Object.assign(new Error('No rear camera available'), { name: 'NotFoundError' });
      }

      // Final guard: never attach a front track
      {
        const label = (stream.getVideoTracks()[0] && stream.getVideoTracks()[0].label) || '';
        if (isFrontLabel(label)) {
          await stopStream(stream);
          stream = null;
          throw Object.assign(new Error('Front camera blocked'), { name: 'NotFoundError' });
        }
      }

      const onDetect = (result) => {
        if (result && running) onCodeDetected(result.getText());
      };

      // Prefer decodeFromStream so ZXing does not open its own (possibly front) constraints
      if (typeof zxingReader.decodeFromStream === 'function') {
        zxingControls = await zxingReader.decodeFromStream(stream, els.video, onDetect);
      } else {
        els.video.srcObject = stream;
        await els.video.play().catch(() => {});
        zxingControls = await zxingReader.decodeFromConstraints(
          { audio: false, video: { facingMode: { exact: 'environment' } } },
          els.video,
          onDetect
        );
        // If ZXing replaced the stream, re-check
        stream = els.video.srcObject || stream;
        const label = (stream.getVideoTracks && stream.getVideoTracks()[0] && stream.getVideoTracks()[0].label) || '';
        if (isFrontLabel(label)) {
          if (zxingControls) { try { zxingControls.stop(); } catch (e) {} zxingControls = null; }
          await stopStream(stream);
          throw Object.assign(new Error('Front camera blocked'), { name: 'NotFoundError' });
        }
      }
    } catch (err) {
      handleCameraError(err);
    }
  }


  function close() {
    running = false;
    clearTimeout(ocrTimer);
    if (nativeCheckId) { clearInterval(nativeCheckId); nativeCheckId = null; }
    if (zxingControls) {
      try { zxingControls.stop(); } catch (e) { /* already stopped */ }
      zxingControls = null;
    }
    zxingReader = null;
    if (stream) {
      stream.getTracks().forEach(track => track.stop()); // release camera immediately
      stream = null;
    }
    els.video.srcObject = null;
    els.backdrop.classList.remove('open');
    nativeDetector = null;
    ocrBusy = false;
  }

  function handleCameraError(err) {
    if (err && err.name === 'NotAllowedError') {
      setStatus('Camera permission denied', 'error');
    } else if (err && err.name === 'NotFoundError') {
      setStatus('No camera found on this device', 'error');
    } else {
      setStatus('Unable to access camera', 'error');
    }
    setTimeout(close, 1800);
  }

  function pickRearCamera(devices) {
    if (!devices || !devices.length) return null;
    // Never guess "last device" when labels are empty — that often picks the front camera.
    const labeled = devices.filter(d => d && d.label && String(d.label).trim());
    if (!labeled.length) return null;
    const rear = labeled.find(d => /back|rear|environment|world|خلف/i.test(d.label));
    if (rear) return rear;
    const notFront = labeled.find(d => !/front|user|face|أمام/i.test(d.label));
    return notFront || null;
  }

  /* ---------- Optional secondary check: native BarcodeDetector ----------
     Purely opportunistic — on devices that support it, this can catch an
     obvious code a few frames earlier than ZXing. It never gates or
     replaces the ZXing loop above, and is skipped entirely if unsupported.
     It also only analyzes the center ROI, matching the ZXing crop. */
  function initNativeDetector() {
    if (!('BarcodeDetector' in window)) return;
    try {
      nativeDetector = new BarcodeDetector({
        formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39']
      });
    } catch (e) {
      nativeDetector = null;
      return;
    }
    nativeCheckId = setInterval(async () => {
      if (!running || !nativeDetector || !els.video.videoWidth) return;
      try {
        const roiBitmap = await centerRoiBitmap();
        const codes = await nativeDetector.detect(roiBitmap);
        if (codes && codes.length && running) onCodeDetected(codes[0].rawValue);
      } catch (e) { /* opportunistic only — ignore and keep relying on ZXing */ }
    }, 150);
  }

  /** Crops the live video down to the center ROI (matching the on-screen
   *  .scan-frame guide) and returns it as an ImageBitmap for detection.
   *  Keeps analysis focused on where the user is asked to hold the code,
   *  which is faster and more accurate than scanning the full frame. */
  async function centerRoiBitmap() {
    const rect = centerRoiRect();
    els.ocrCanvas.width = rect.w;
    els.ocrCanvas.height = rect.h;
    const ctx = els.ocrCanvas.getContext('2d');
    ctx.drawImage(els.video, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    return createImageBitmap(els.ocrCanvas);
  }

  function centerRoiRect() {
    const vw = els.video.videoWidth, vh = els.video.videoHeight;
    // Matches the .scan-frame overlay proportions (inset 12% vertical, 8% horizontal)
    return {
      x: Math.round(vw * 0.08),
      y: Math.round(vh * 0.12),
      w: Math.round(vw * 0.84),
      h: Math.round(vh * 0.76)
    };
  }

  function onCodeDetected(rawValue) {
    if (!running) return;
    const code = String(rawValue).trim();

    // Ignore duplicate detections of the same code within the debounce window
    const now = Date.now();
    if (code === lastCode && (now - lastCodeAt) < DUPLICATE_IGNORE_MS) return;
    lastCode = code;
    lastCodeAt = now;

    running = false; // stop every running process immediately
    clearTimeout(ocrTimer);
    if (nativeCheckId) { clearInterval(nativeCheckId); nativeCheckId = null; }
    setStatus('Product Found', 'success');
    close();
    searchFromExternal(code);
  }

  /* ---------- Step 2 & 3: OCR fallback (cropped to the white info card) ---------- */
  function scheduleOcrFallback() {
    ocrTimer = setTimeout(() => {
      if (running && !ocrBusy) runOcrPass();
    }, OCR_FALLBACK_MS);
  }

  async function runOcrPass() {
    if (!running || !window.Tesseract || !els.video.videoWidth) {
      if (running) scheduleOcrFallback();
      return;
    }
    ocrBusy = true;
    setStatus('Detecting barcode…');
    try {
      const cropRect = locateInfoCard();
      const ocrCanvas = els.ocrCanvas;
      ocrCanvas.width = cropRect.w;
      ocrCanvas.height = cropRect.h;
      const ctx = ocrCanvas.getContext('2d');
      ctx.drawImage(els.video, cropRect.x, cropRect.y, cropRect.w, cropRect.h, 0, 0, cropRect.w, cropRect.h);

      setStatus('Reading SKU…');
      const { data } = await Tesseract.recognize(ocrCanvas, 'eng', { logger: () => {} });

      if (!running) return; // a barcode may have been found while OCR was running

      // Step 2: SKU first
      const sku = extractSku(data.text);
      if (sku) {
        setStatus('Product Found', 'success');
        close();
        searchFromExternal(sku);
        return;
      }

      // Step 3: fall back to the full barcode's last 6 digits
      const last6 = extractLast6FromBarcode(data.text);
      if (last6) {
        setStatus('Product Found', 'success');
        close();
        searchFromExternal(last6);
        return;
      }

      setStatus('No Barcode Detected — Reading Again…', 'error');
      ocrBusy = false;
      if (running) scheduleOcrFallback();
    } catch (e) {
      setStatus('OCR Failed — Retrying…', 'error');
      ocrBusy = false;
      if (running) scheduleOcrFallback();
    }
  }

  /** Locates the white product-info card region within the frame.
   *  Uses a fixed relative crop matching the on-screen scan-frame guide,
   *  which is where the app instructs the user to align the card. This
   *  avoids OCR-ing the full frame, keeping recognition fast and accurate. */
  function locateInfoCard() {
    return centerRoiRect();
  }

  /** Extracts ONLY the SKU value from OCR text, ignoring product name,
   *  price, location, buttons, icons, and everything else on the card. */
  function extractSku(text) {
    const skuMatch = text.match(/SKU[:\s]*([0-9]{4,10})/i);
    return skuMatch ? skuMatch[1] : null;
  }

  /** Extracts a full barcode from OCR text and returns only its last 6
   *  digits, to be routed through the existing last-6-digits search. */
  function extractLast6FromBarcode(text) {
    const barcodeMatch = text.match(/Barcode[:\s]*([0-9A-Za-z]{6,20})/i);
    const code = barcodeMatch ? barcodeMatch[1] : null;
    if (!code) return null;
    return code.length >= 6 ? code.slice(-6) : code;
  }

  function init() {
    cacheEls();
    // Unlock WebAudio after first gesture so scan sound works on mobile
    const unlockAudio = () => {
      try {
        if (!_scanAudioCtx) {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (AC) _scanAudioCtx = new AC();
        }
        if (_scanAudioCtx && _scanAudioCtx.state === 'suspended') _scanAudioCtx.resume();
      } catch (e) { /* ignore */ }
      document.removeEventListener('pointerdown', unlockAudio, true);
    };
    document.addEventListener('pointerdown', unlockAudio, true);

    els.scanBtn.addEventListener('click', open);
    els.closeBtn.addEventListener('click', close);
    els.backdrop.addEventListener('click', (e) => { if (e.target === els.backdrop) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && els.backdrop.classList.contains('open')) close(); });
  }

  return { init };

}
