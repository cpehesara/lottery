(function () {
  'use strict';
  const C = window.LotteryCore;
  const $ = (id) => document.getElementById(id);

  const state = { src: null, imgDate: null, page: null, pageUrl: null, busy: false, token: 0 };

  // ------------------------------------------------------------ status
  function status(msg, kind) {
    const el = $('status');
    el.className = kind || '';
    if (kind === 'ok' && msg.includes('{d}')) {
      el.innerHTML = '';
      const [a, b] = msg.split('{d}');
      el.append(a);
      const bold = document.createElement('b'); bold.textContent = state.imgDate; el.append(bold, b);
    } else {
      el.textContent = msg;
    }
  }

  // ------------------------------------------------------------ date
  const dateInput = $('date');
  dateInput.value = C.todayISO();
  dateInput.max = C.addDays(C.todayISO(), 2);

  function setDate(iso) {
    dateInput.value = iso;
    findForDate();
  }
  $('today').onclick = () => setDate(C.todayISO());
  $('prev').onclick = () => setDate(C.addDays(dateInput.value || C.todayISO(), -1));
  $('next').onclick = () => setDate(C.addDays(dateInput.value || C.todayISO(), 1));
  dateInput.addEventListener('change', () => findForDate());
  $('find').onclick = () => findForDate(true);

  function dayForFiles() {
    return state.imgDate || C.parseUserDate(dateInput.value) || C.todayISO();
  }

  // ------------------------------------------------------------ OCR (loaded on first use)
  let ocrWorkerPromise = null;
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load OCR library'));
      document.head.appendChild(s);
    });
  }
  function getOcr() {
    if (!ocrWorkerPromise) {
      ocrWorkerPromise = (async () => {
        if (!window.Tesseract) await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js');
        const w = await window.Tesseract.createWorker('eng');
        await w.setParameters({ tessedit_char_whitelist: '0123456789-./:', tessedit_pageseg_mode: '11' });
        return w;
      })();
      ocrWorkerPromise.catch(() => { ocrWorkerPromise = null; });
    }
    return ocrWorkerPromise;
  }
  async function ocrText(canvas) {
    const w = await getOcr();
    const r = await w.recognize(canvas);
    return r.data.text || '';
  }

  // ------------------------------------------------------------ rendering
  const layoutValue = () => document.querySelector('input[name=layout]:checked').value;
  const nextFrame = () => new Promise((r) => setTimeout(r, 30));

  function setActionsEnabled(on) {
    ['savePdf', 'print', 'share'].forEach((id) => { $(id).disabled = !on; });
  }

  async function render(noteExtra) {
    if (!state.src) return;
    const token = ++state.token;
    status('Building the A4 sheet …');
    setActionsEnabled(false);
    await nextFrame();
    let res;
    try {
      res = C.composePage(state.src, layoutValue());
    } catch (e) {
      status('Could not build the page: ' + e.message, 'err');
      return;
    }
    if (token !== state.token) return;
    state.page = res.canvas;
    if (state.pageUrl) { URL.revokeObjectURL(state.pageUrl); state.pageUrl = null; }

    const pv = $('preview');
    const g = pv.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(state.page, 0, 0, pv.width, pv.height);
    $('previewBox').classList.add('ready');
    $('zoomHint').hidden = false;
    setActionsEnabled(true);
    if (res.note) status(res.note, 'warn');
    else if (noteExtra) status(noteExtra.text, noteExtra.kind);
    else status('Preview updated.');
  }

  async function pageUrl() {
    if (!state.pageUrl) state.pageUrl = URL.createObjectURL(await C.canvasToBlob(state.page, 'image/png'));
    return state.pageUrl;
  }

  document.querySelectorAll('input[name=layout]').forEach((r) => r.addEventListener('change', () => render()));

  // ------------------------------------------------------------ automatic lookup (results/index.json)
  const cfg = window.APP_CONFIG || {};
  const base = (cfg.resultsBase || 'results/').replace(/\/?$/, '/');
  let index = null, indexError = false, findToken = 0;

  async function loadIndex() {
    try {
      const r = await fetch(base + 'index.json?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      index = await r.json();
      indexError = false;
    } catch (e) {
      index = null; indexError = true;
    }
    updateAvail();
    return index;
  }

  function updateAvail() {
    const el = $('avail');
    el.textContent = '';
    if (!index) {
      el.textContent = 'Automatic results are not available right now. Use “Add an image yourself”.';
      $('manual').open = true;
      return;
    }
    const keys = Object.keys(index.dates || {}).sort();
    if (!keys.length) { el.textContent = 'No results have been fetched yet.'; return; }
    const newest = keys[keys.length - 1];
    el.append('Available: ' + keys[0] + ' to ' + newest + ' (' + keys.length + ' days). ');
    const b = document.createElement('button');
    b.className = 'linkbtn'; b.textContent = 'Use latest (' + newest + ')';
    b.onclick = () => setDate(newest);
    el.append(b);
  }

  function setRunLink(show) {
    const a = $('runLink');
    if (show && cfg.actionsUrl) { a.href = cfg.actionsUrl; a.hidden = false; } else { a.hidden = true; }
  }

  async function findForDate(explicit) {
    const iso = C.parseUserDate(dateInput.value);
    if (!iso) { status('Pick a valid date.', 'warn'); return; }
    const token = ++findToken;
    setRunLink(false);
    if (iso > C.todayISO()) {
      status('That date is in the future – no results exist yet.', 'warn');
      return;
    }
    status('Looking for the result of ' + iso + ' …');
    if (!index || explicit) await loadIndex();
    if (token !== findToken) return;
    if (!index) {
      status('Could not reach the results list' + (cfg.resultsBase === 'results/' ? ' (results/index.json is missing)' : '') +
        '. Use “Add an image yourself” to load the image by hand.', 'warn');
      return;
    }
    const hit = C.lookupResult(index, iso);
    if (!hit.file) {
      let msg = 'No result for ' + iso + ' has been fetched yet.';
      if (hit.newest) msg += ' Newest available: ' + hit.newest + '.';
      msg += ' New results are fetched automatically every few hours; you can also add the image yourself.';
      status(msg, 'warn');
      setRunLink(true);
      return;
    }
    status('Downloading the result for ' + iso + ' …');
    try {
      const r = await fetch(base + hit.file, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const blob = await r.blob();
      if (token !== findToken) return;
      await loadFromBlob(blob.type.startsWith('image/') ? blob : new Blob([blob], { type: 'image/jpeg' }),
        'Result for ' + iso, iso);
    } catch (e) {
      if (token === findToken) status('Could not download the image for ' + iso + ' (' + e.message + '). Try again or add it yourself.', 'err');
    }
  }

  // ------------------------------------------------------------ loading an image
  async function loadFromBlob(blob, label, knownDate) {
    if (!knownDate) findToken++;
    if (!blob || !(blob.type || '').startsWith('image/')) {
      status('That file is not an image.', 'err');
      return;
    }
    status(label + ' – opening …');
    let bmp;
    try {
      bmp = await (window.createImageBitmap ? createImageBitmap(blob) : new Promise((res, rej) => {
        const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = URL.createObjectURL(blob);
      }));
    } catch (e) {
      status('This image could not be opened. Try a PNG or JPG.', 'err');
      return;
    }
    state.src = C.toCanvas(bmp);
    if (bmp.close) bmp.close();
    state.imgDate = null;

    let detected = knownDate || null;
    if (!detected) {
      status(label + ' – reading the date from the image (first time downloads the reader) …');
      try { detected = await C.readDate(state.src, ocrText); } catch (e) { detected = null; }
    }
    state.imgDate = detected;
    if (detected) {
      dateInput.value = detected;
      await render({ text: label + '. Date confirmed: {d}', kind: 'ok' });
    } else {
      await render({ text: label + '. Could not read the date – using the date set above.', kind: 'warn' });
    }
  }

  $('choose').onclick = () => $('file').click();
  $('file').onchange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) loadFromBlob(f, 'Loaded ' + (f.name || 'image'));
    e.target.value = '';
  };

  async function pasteFromClipboard() {
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const type = it.types.find((t) => t.startsWith('image/'));
        if (type) return loadFromBlob(await it.getType(type), 'Image pasted');
      }
      status('There is no image on the clipboard.', 'warn');
    } catch (e) {
      status('Paste is blocked here. Long-press in the page and choose Paste, or use Choose image.', 'warn');
    }
  }
  $('paste').onclick = pasteFromClipboard;
  document.addEventListener('paste', (e) => {
    const f = [...(e.clipboardData ? e.clipboardData.files : [])].find((x) => x.type.startsWith('image/'));
    if (f) { e.preventDefault(); loadFromBlob(f, 'Image pasted'); }
  });

  $('fromLink').onclick = () => {
    const row = $('linkRow');
    row.classList.toggle('open');
    if (row.classList.contains('open')) $('url').focus();
  };
  $('loadUrl').onclick = async () => {
    const url = $('url').value.trim();
    if (!/^https?:\/\//i.test(url)) { status('Paste a direct image link that starts with https://', 'warn'); return; }
    status('Downloading the image …');
    try {
      const r = await fetch(url, { mode: 'cors' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      await loadFromBlob(await r.blob(), 'Image downloaded');
    } catch (e) {
      status('This site does not let the app download images by link (common with Facebook). ' +
        'Save the image to your phone and use Choose image instead.', 'err');
    }
  };

  // drag & drop (desktop)
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFromBlob(f, 'Loaded ' + f.name);
  });

  // ------------------------------------------------------------ output
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }

  $('savePdf').onclick = async () => {
    if (!state.page) return;
    const name = 'lottery_' + dayForFiles() + '.pdf';
    status('Creating the PDF …');
    try {
      download(await C.buildPdf(state.page), name);
      status('PDF saved: ' + name + ' (check your Downloads).');
    } catch (e) { status('Could not create the PDF: ' + e.message, 'err'); }
  };

  $('print').onclick = async () => {
    if (!state.page) return;
    const img = $('printImg');
    img.onload = () => setTimeout(() => window.print(), 150);
    img.src = await pageUrl();
    status('Print dialog opening. If nothing appears, use Save PDF and print from your files app.');
  };

  // Share sheet (lets phone users send the PDF to a printer app)
  (async function initShare() {
    try {
      const probe = new File([new Uint8Array(1)], 'x.pdf', { type: 'application/pdf' });
      if (navigator.canShare && navigator.canShare({ files: [probe] })) $('share').hidden = false;
    } catch (e) { /* not supported */ }
  })();
  $('share').onclick = async () => {
    if (!state.page) return;
    try {
      const blob = await C.buildPdf(state.page);
      const file = new File([blob], 'lottery_' + dayForFiles() + '.pdf', { type: 'application/pdf' });
      await navigator.share({ files: [file], title: 'Lottery results' });
    } catch (e) {
      if (e && e.name !== 'AbortError') status('Sharing failed: ' + e.message, 'err');
    }
  };

  // ------------------------------------------------------------ full-screen preview
  async function openZoom() {
    if (!state.page) return;
    $('zoomImg').src = await pageUrl();
    $('zoom').classList.add('open');
    $('zoom').setAttribute('aria-hidden', 'false');
  }
  const closeZoom = () => { $('zoom').classList.remove('open'); $('zoom').setAttribute('aria-hidden', 'true'); };
  $('preview').onclick = openZoom;
  $('zoomClose').onclick = closeZoom;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeZoom(); });

  // ------------------------------------------------------------ start
  const startedShared = /[?&]shared=1/.test(location.search);
  loadIndex().then(() => { if (!startedShared) findForDate(); });

  // ------------------------------------------------------------ PWA + "share to app" (Android)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  (async function checkShared() {
    if (!/[?&]shared=1/.test(location.search) || !window.caches) return;
    try {
      const cache = await caches.open('lottery-shared');
      const res = await cache.match('shared-image');
      if (res) {
        await cache.delete('shared-image');
        history.replaceState(null, '', location.pathname);
        loadFromBlob(await res.blob(), 'Image shared to the app');
      }
    } catch (e) { /* ignore */ }
  })();
})();
