/*
 * Lottery printer - core image logic (port of lottery_printer.py)
 * Runs in the browser (Canvas API). Also loadable in Node with node-canvas for tests.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- settings
  const DPI = 300;
  const mm = (v) => Math.round((v / 25.4) * DPI);
  const PAGE_W = mm(297), PAGE_H = mm(210);   // A4 landscape
  const MARGIN = mm(4);
  const GAP = mm(3);
  const COLUMNS = 3;

  class LayoutError extends Error {}

  // ---------------------------------------------------------------- canvas helpers
  function mk(w, h) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      return c;
    }
    return root.__mkCanvas(w, h);
  }
  const ctx = (c) => c.getContext('2d', { willReadFrequently: true });

  function whiteCanvas(w, h) {
    const c = mk(w, h);
    const g = ctx(c);
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    return c;
  }

  /** Any drawable (Image, ImageBitmap, canvas) -> white-backed canvas */
  function toCanvas(src) {
    const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
    const c = whiteCanvas(w, h);
    ctx(c).drawImage(src, 0, 0);
    return c;
  }

  function crop(c, x, y, w, h) {
    x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y));
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    const out = mk(w, h);
    ctx(out).drawImage(c, x, y, w, h, 0, 0, w, h);
    return out;
  }

  function resize(c, w, h) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    // step down in halves for clean downscaling
    let cur = c;
    while (cur.width / 2 > w && cur.height / 2 > h) {
      const t = mk(Math.ceil(cur.width / 2), Math.ceil(cur.height / 2));
      const g = ctx(t); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
      g.drawImage(cur, 0, 0, t.width, t.height);
      cur = t;
    }
    const out = mk(w, h);
    const g = ctx(out);
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(cur, 0, 0, w, h);
    return out;
  }

  /** Trim the plain white border around the results image. */
  function autocrop(c, pad = 4, thr = 30) {
    const w = c.width, h = c.height;
    const d = ctx(c).getImageData(0, 0, w, h).data;
    let l = w, t = h, r = -1, b = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const diff = ((255 - d[i]) * 299 + (255 - d[i + 1]) * 587 + (255 - d[i + 2]) * 114) / 1000;
        if (diff > thr) {
          if (x < l) l = x; if (x > r) r = x;
          if (y < t) t = y; if (y > b) b = y;
        }
      }
    }
    if (r < 0) return c;
    const left = Math.max(l - pad, 0), top = Math.max(t - pad, 0);
    const right = Math.min(r + 1 + pad, w), bottom = Math.min(b + 1 + pad, h);
    return crop(c, left, top, right - left, bottom - top);
  }

  /** Steep contrast curve: makes up-scaled text dark and sharp. */
  function crisp(c, lo = 70, hi = 200) {
    const lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) lut[v] = Math.max(0, Math.min(255, Math.trunc(((v - lo) * 255) / (hi - lo))));
    const g = ctx(c);
    const id = g.getImageData(0, 0, c.width, c.height);
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = lut[(d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0];
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
    g.putImageData(id, 0, 0);
    return c;
  }

  const resizeCrisp = (c, factor) => crisp(resize(c, c.width * factor, c.height * factor));

  /** Unsharp mask (box-blur approximation of PIL's UnsharpMask). */
  function unsharp(c, radius = 3, percent = 110, threshold = 2) {
    const w = c.width, h = c.height;
    const g = ctx(c);
    const id = g.getImageData(0, 0, w, h);
    const src = id.data;
    const tmp = new Float32Array(w * h * 3);
    const blur = new Float32Array(w * h * 3);
    const win = radius * 2 + 1;
    for (let ch = 0; ch < 3; ch++) {            // horizontal pass
      for (let y = 0; y < h; y++) {
        let sum = 0;
        const row = y * w;
        for (let k = -radius; k <= radius; k++) sum += src[(row + Math.min(w - 1, Math.max(0, k))) * 4 + ch];
        for (let x = 0; x < w; x++) {
          tmp[(row + x) * 3 + ch] = sum / win;
          const add = Math.min(w - 1, x + radius + 1), rem = Math.max(0, x - radius);
          sum += src[(row + add) * 4 + ch] - src[(row + rem) * 4 + ch];
        }
      }
    }
    for (let ch = 0; ch < 3; ch++) {            // vertical pass
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += tmp[(Math.min(h - 1, Math.max(0, k)) * w + x) * 3 + ch];
        for (let y = 0; y < h; y++) {
          blur[(y * w + x) * 3 + ch] = sum / win;
          const add = Math.min(h - 1, y + radius + 1), rem = Math.max(0, y - radius);
          sum += tmp[(add * w + x) * 3 + ch] - tmp[(rem * w + x) * 3 + ch];
        }
      }
    }
    const amt = percent / 100;
    for (let i = 0, p = 0; i < src.length; i += 4, p += 3) {
      for (let ch = 0; ch < 3; ch++) {
        const diff = src[i + ch] - blur[p + ch];
        if (Math.abs(diff) > threshold) src[i + ch] = Math.max(0, Math.min(255, src[i + ch] + amt * diff));
      }
    }
    g.putImageData(id, 0, 0);
    return c;
  }

  // ---------------------------------------------------------------- date helpers
  const pad2 = (n) => String(n).padStart(2, '0');
  const isoOf = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;

  function validDate(y, m, d) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  function todayISO() {
    const n = new Date();
    return isoOf(n.getFullYear(), n.getMonth() + 1, n.getDate());
  }

  function plausible(iso) {
    const max = new Date(); max.setDate(max.getDate() + 2);
    return iso >= '2015-01-01' && iso <= isoOf(max.getFullYear(), max.getMonth() + 1, max.getDate());
  }

  /** Accept 2026-10-03, 2026.10.03, 2026/10/03, 03-10-2026, 03.10.2026, 03/10/2026 -> ISO or null */
  function parseUserDate(text) {
    const t = String(text || '').trim();
    let m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/.exec(t);
    if (m && validDate(+m[1], +m[2], +m[3])) return isoOf(+m[1], +m[2], +m[3]);
    m = /^(\d{1,2})[-./](\d{1,2})[-./](\d{4})$/.exec(t);
    if (m && validDate(+m[3], +m[2], +m[1])) return isoOf(+m[3], +m[2], +m[1]);
    return null;
  }

  function addDays(iso, delta) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + delta));
    return isoOf(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }

  /** Find plausible dates in an OCR text piece (fixes common digit mix-ups). */
  function datesIn(text) {
    const s = String(text).replace(/[^0-9OoIl|\-./:]/g, '').replace(/[Oo]/g, '0').replace(/[Il|]/g, '1');
    const out = [];
    const re = /(20\d{2})[-./:](\d{2})[-./:](\d{2})/g;
    let m;
    while ((m = re.exec(s))) {
      if (validDate(+m[1], +m[2], +m[3])) {
        const iso = isoOf(+m[1], +m[2], +m[3]);
        if (plausible(iso)) out.push(iso);
      }
    }
    if (!out.length) {
      m = /^(20\d{2})(\d{2})(\d{2})$/.exec(s);
      if (m && validDate(+m[1], +m[2], +m[3])) {
        const iso = isoOf(+m[1], +m[2], +m[3]);
        if (plausible(iso)) out.push(iso);
      }
    }
    return out;
  }

  /** ocrFn(canvas) -> Promise<string>. Returns ISO date or null. */
  async function readDate(src, ocrFn) {
    const img = autocrop(src);
    const w = img.width, h = img.height;
    for (const frac of [0.12, 0.2, 0.35]) {
      let strip = crop(img, 0, Math.floor(h * (1 - frac)), w, h - Math.floor(h * (1 - frac)));
      const factor = Math.max(1, Math.min(4, Math.round(1400 / Math.max(strip.width, 1))));
      if (factor > 1) strip = resize(strip, strip.width * factor, strip.height * factor);
      let text = '';
      try { text = await ocrFn(strip); } catch (e) { text = ''; }
      for (const line of String(text).split(/\n+/)) {
        const ds = datesIn(line);
        if (ds.length) return ds[0];
      }
      const ds = datesIn(String(text).replace(/\s+/g, ''));
      if (ds.length) return ds[0];
    }
    return null;
  }

  /**
   * Look a date up in results/index.json  ({ updated, dates: { 'YYYY-MM-DD': 'file' } }).
   * Returns { file } when available, otherwise { file: null, newest, oldest, before, after }.
   */
  function lookupResult(index, iso) {
    const dates = (index && index.dates) || {};
    const keys = Object.keys(dates).sort();
    if (dates[iso]) return { file: dates[iso] };
    return {
      file: null,
      newest: keys.length ? keys[keys.length - 1] : null,
      oldest: keys.length ? keys[0] : null,
      before: keys.filter((k) => k < iso).pop() || null,
      after: keys.find((k) => k > iso) || null,
      count: keys.length,
    };
  }

  // ---------------------------------------------------------------- layouts
  function colSize() {
    return [Math.floor((PAGE_W - 2 * MARGIN - (COLUMNS - 1) * GAP) / COLUMNS), PAGE_H - 2 * MARGIN];
  }

  function cutGuides(page, colW) {
    const g = ctx(page);
    g.fillStyle = 'rgb(160,160,160)';
    for (let i = 1; i < COLUMNS; i++) {
      const x = MARGIN + i * (colW + GAP) - Math.floor(GAP / 2);
      for (let y = MARGIN; y < PAGE_H - MARGIN; y += 24) g.fillRect(x - 1, y, 2, 12);
    }
  }

  function composeSimple(src, stretch = true) {
    src = autocrop(src);
    const [colW, colH] = colSize();
    let tile;
    if (stretch) {
      tile = resize(src, colW, colH);
    } else {
      const scale = Math.min(colW / src.width, colH / src.height);
      tile = resize(src, Math.floor(src.width * scale), Math.floor(src.height * scale));
    }
    tile = unsharp(tile, 3, 110, 2);
    const page = whiteCanvas(PAGE_W, PAGE_H);
    const g = ctx(page);
    for (let i = 0; i < COLUMNS; i++) {
      const x = MARGIN + i * (colW + GAP) + Math.floor((colW - tile.width) / 2);
      g.drawImage(tile, x, MARGIN);
    }
    cutGuides(page, colW);
    return page;
  }

  /** Group consecutive true values; gaps <= mergeGap are merged. Returns [start, endExclusive][] */
  function runs(flags, mergeGap) {
    const out = [];
    for (let x = 0; x < flags.length; x++) {
      if (flags[x]) {
        if (out.length && x - out[out.length - 1][1] <= mergeGap + 1) out[out.length - 1][1] = x;
        else out.push([x, x]);
      }
    }
    return out.map(([a, b]) => [a, b + 1]);
  }

  /** Cut the daily results image into title, table rows, footer boxes and credit line. */
  function splitResults(src) {
    let img = autocrop(src);
    if (Math.abs(img.width - 495) > 4) img = resize(img, 495, Math.round((img.height * 495) / img.width));
    const W = img.width, H = img.height;
    const px = ctx(img).getImageData(0, 0, W, H).data;
    const gray = new Uint8Array(W * H);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = (px[p] * 299 + px[p + 1] * 587 + px[p + 2] * 114) / 1000;
    const ink = (x, y) => gray[y * W + x] < 150;

    const wide = new Array(H);
    for (let y = 0; y < H; y++) {
      let n = 0;
      for (let x = 0; x < W; x++) if (gray[y * W + x] < 200) n++;
      wide[y] = n / W > 0.55;
    }

    const lines = runs(wide, 1);
    const centres = lines.map(([a, b]) => Math.floor((a + b - 1) / 2));
    if (!centres.length) throw new LayoutError('no table lines');
    const table = [centres[0]];
    for (let i = 1; i < centres.length; i++) {
      if (centres[i] - table[table.length - 1] >= 25) table.push(centres[i]);
      else break;
    }
    const nRows = table.length - 1;
    if (!(nRows >= 8 && nRows <= 30)) throw new LayoutError(`unexpected number of rows: ${nRows}`);

    const X0 = 9, X1 = W - 9;
    const agg = new Int32Array(W);
    for (let r = 0; r < nRows; r++) {
      for (let y = table[r] + 3; y < table[r + 1] - 2; y++) for (let x = 0; x < W; x++) if (ink(x, y)) agg[x]++;
    }
    const occ = Array.from(agg, (v) => v > 0);
    for (let x = 0; x < X0; x++) occ[x] = false;
    for (let x = X1; x < W; x++) occ[x] = false;
    const half = occ.slice(0, Math.floor(W / 2) + 40).map((v) => !v);
    const gaps = runs(half, 0).filter(([a, b]) => a > 60 && b - a >= 10);
    if (!gaps.length) throw new LayoutError('cannot find name/value split');
    const split = Math.floor((gaps[0][0] + gaps[0][1]) / 2);
    const firstOcc = occ.slice(0, split).indexOf(true);
    const nameX0 = Math.max(X0, (firstOcc < 0 ? 0 : firstOcc) - 3);

    const rows = [];
    for (let r = 0; r < nRows; r++) {
      const y0 = table[r] + 3, y1 = table[r + 1] - 2, bh = y1 - y0;
      if (bh < 2) throw new LayoutError('row too thin');
      const cols = new Array(X1 - split).fill(false);
      for (let y = y0; y < y1; y++) for (let x = split; x < X1; x++) if (ink(x, y)) cols[x - split] = true;
      const name = crop(img, nameX0, y0, split - nameX0, bh);
      const tokens = runs(cols, 6).map(([s, e]) => crop(img, split + s, y0, e - s, bh));
      rows.push({ name, tokens });
    }

    const bbox = (xa, ya, xb, yb) => {
      let l = 1e9, t = 1e9, r = -1, b = -1;
      for (let y = Math.max(0, ya); y < Math.min(H, yb); y++) {
        for (let x = Math.max(0, xa); x < Math.min(W, xb); x++) {
          if (ink(x, y)) { if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > b) b = y; }
        }
      }
      return r < 0 ? null : { x: l, y: t, w: r + 1 - l, h: b + 1 - t };
    };

    let title = null;
    const tb = bbox(0, 0, W, table[0] - 2);
    if (tb) title = crop(img, tb.x, tb.y, tb.w, tb.h);

    const f0 = table[nRows] + 3;
    const footerBoxes = [];
    let tiny = null;
    const fl = runs(wide.slice(f0), 1);
    if (fl.length >= 2 && fl[1][0] - fl[0][0] > 12) {
      const top = f0 + fl[0][1], bottom = f0 + fl[1][0];
      const mid = Math.floor(W / 2);
      for (const [xa, xb] of [[0, mid - 3], [mid + 3, W]]) {
        const bb = bbox(xa + 8, top + 3, xb - 8, bottom - 2);
        if (bb) footerBoxes.push(crop(img, bb.x, bb.y, bb.w, bb.h));
      }
      if (bottom + 4 < H) tiny = crop(img, 0, bottom + 3, W, H - (bottom + 3));
    }
    if (footerBoxes.length !== 2) throw new LayoutError('footer not recognised');
    return { title, rows, footerBoxes, tiny };
  }

  function frame(g, x, y, w, h, lw) {
    g.fillRect(x, y, w, lw); g.fillRect(x, y + h - lw, w, lw);
    g.fillRect(x, y, lw, h); g.fillRect(x + w - lw, y, lw, h);
  }

  function roundedFrame(g, x, y, w, h, r, lw) {
    g.lineWidth = lw; g.strokeStyle = '#000';
    // inset by half the line width so the outline stays inside the box
    g.beginPath();
    const i = lw / 2;
    const xx = x + i, yy = y + i, ww = w - lw, hh = h - lw, rr = Math.max(0, r - i);
    g.moveTo(xx + rr, yy);
    g.arcTo(xx + ww, yy, xx + ww, yy + hh, rr);
    g.arcTo(xx + ww, yy + hh, xx, yy + hh, rr);
    g.arcTo(xx, yy + hh, xx, yy, rr);
    g.arcTo(xx, yy, xx + ww, yy, rr);
    g.closePath();
    g.stroke();
  }

  /** A4 landscape, 3 columns, text rebuilt larger without distortion. */
  function composeLarge(src) {
    const { title, rows, footerBoxes, tiny } = splitResults(src);
    const [colW, colH] = colSize();
    const pad = mm(1.2);
    const innerW = colW - 2 * pad;

    const nameW = rows[0].name.width;
    const nameGap = 6;
    const rowH = rows.map((r) => r.name.height);
    const firstSlot = 17, rightPad = 6;
    const sum = (a) => a.reduce((p, c) => p + c, 0);

    const fixedW = (toks) => {
      const extra = toks.length && toks[0].width <= firstSlot ? Math.max(0, firstSlot - toks[0].width) : 0;
      return nameW + nameGap + sum(toks.map((t) => t.width)) + extra + rightPad;
    };
    const baseW = rows.map((r) => fixedW(r.tokens));
    const ntok = rows.map((r) => Math.max(r.tokens.length - 1, 0));

    const titleH = title ? title.height : 0;
    const fixed = mm(1.5) + mm(1.0);
    const footH = mm(10.5);
    const tinyH = tiny ? mm(2.4) : 0;
    const availH = colH - fixed - footH - tinyH;
    const lineW = Math.max(2, mm(0.35));
    let s = (availH - (rows.length + 1) * lineW) / (titleH * 1.15 + sum(rowH));

    const minGap = 7;
    const need = Math.max(...baseW.map((b, i) => b + ntok[i] * minGap));
    s = Math.min(s, innerW / need);
    const availSrcW = innerW / s;

    let widest = 0;
    baseW.forEach((b, i) => { if (b + ntok[i] * minGap > baseW[widest] + ntok[widest] * minGap) widest = i; });
    const G = Math.max(minGap, Math.min(30, (availSrcW - baseW[widest]) / Math.max(ntok[widest], 1)));

    const est = (titleH * 1.15 + sum(rowH)) * s + (rows.length + 1) * lineW + fixed + footH + tinyH;
    const rowExtra = Math.floor(Math.max(0, Math.min((colH - est) / rows.length, 0.30 * Math.max(...rowH) * s)));

    const built = rows.map(({ name, tokens }, idx) => {
      const h = rowH[idx];
      const row = whiteCanvas(Math.floor(availSrcW) + 1, h);
      const g = ctx(row);
      g.drawImage(name, 0, 0);
      let x = nameW + nameGap;
      tokens.forEach((t, k) => {
        g.drawImage(t, Math.floor(x), 0);
        const slot = k === 0 && t.width <= firstSlot ? Math.max(t.width, firstSlot) : t.width;
        x += slot + G;
      });
      let r = resizeCrisp(row, s);
      if (rowExtra) {
        const padded = whiteCanvas(r.width, r.height + rowExtra);
        ctx(padded).drawImage(r, 0, Math.floor(rowExtra / 2));
        r = padded;
      }
      return r;
    });

    const tile = whiteCanvas(colW, colH);
    const g = ctx(tile);
    g.fillStyle = '#000';
    let y = 0;
    if (title) {
      const t = resizeCrisp(title, Math.min(s * 1.15, (colW * 0.96) / title.width));
      g.drawImage(t, Math.floor((colW - t.width) / 2), y);
      y += t.height + mm(1.5);
    }
    const boxTop = y;
    const boxH = sum(built.map((r) => r.height)) + (built.length + 1) * lineW;
    frame(g, 0, boxTop, colW, boxH, lineW);
    y = boxTop + lineW;
    built.forEach((r) => {
      g.drawImage(r, pad, y);
      y += r.height;
      g.fillRect(0, y, colW, lineW);
      y += lineW;
    });
    y = boxTop + boxH + mm(1.0);

    const halfW = Math.floor((colW - mm(1.5)) / 2);
    const footTop = y;
    footerBoxes.forEach((fb, i) => {
      const f = Math.min((halfW - 2 * mm(3.0)) / fb.width, (footH - 2 * mm(2.2)) / fb.height);
      const fi = resizeCrisp(fb, f);
      const bx = i * (halfW + mm(1.5));
      roundedFrame(g, bx, footTop, halfW, footH, mm(1.5), lineW);
      g.drawImage(fi, bx + Math.floor((halfW - fi.width) / 2), footTop + Math.floor((footH - fi.height) / 2));
    });
    y = footTop + footH + mm(0.6);

    if (tiny && y < colH) {
      const ti = resize(tiny, colW, Math.max(1, Math.floor((tiny.height * colW) / tiny.width)));
      g.drawImage(ti, 0, y);
    }

    const page = whiteCanvas(PAGE_W, PAGE_H);
    const pg = ctx(page);
    for (let i = 0; i < COLUMNS; i++) pg.drawImage(tile, MARGIN + i * (colW + GAP), MARGIN);
    cutGuides(page, colW);
    return page;
  }

  /** mode: 'large' | 'stretch' | 'fit'. Returns { canvas, note }. */
  function composePage(src, mode = 'large') {
    if (mode === 'large') {
      try {
        return { canvas: composeLarge(src), note: '' };
      } catch (e) {
        return {
          canvas: composeSimple(src, true),
          note: `Large-print layout isn't possible for this image (${e.message}). Used the stretch layout instead.`,
        };
      }
    }
    return { canvas: composeSimple(src, mode !== 'fit'), note: '' };
  }

  // ---------------------------------------------------------------- PDF (single JPEG page, no libraries)
  function canvasToBlob(c, type, q) {
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode image'))), type, q));
  }

  async function buildPdf(canvas) {
    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.95);
    const jpg = new Uint8Array(await blob.arrayBuffer());
    const W = 841.89, H = 595.28;   // A4 landscape in points
    const enc = new TextEncoder();
    const parts = [], offsets = [];
    let len = 0;
    const push = (d) => { const u = typeof d === 'string' ? enc.encode(d) : d; parts.push(u); len += u.length; };
    const begin = (n) => { offsets[n] = len; push(`${n} 0 obj\n`); };
    const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;

    push('%PDF-1.4\n');
    begin(1); push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    begin(2); push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
    begin(3); push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`);
    begin(4);
    push(`<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`);
    push(jpg); push('\nendstream\nendobj\n');
    begin(5); push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
    const xref = len;
    let x = 'xref\n0 6\n0000000000 65535 f \n';
    for (let n = 1; n <= 5; n++) x += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
    push(x + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(parts, { type: 'application/pdf' });
  }

  const api = {
    DPI, PAGE_W, PAGE_H, mm, LayoutError,
    toCanvas, autocrop, resize, crop,
    parseUserDate, todayISO, addDays, datesIn, readDate, lookupResult,
    splitResults, composePage, composeLarge, composeSimple,
    buildPdf, canvasToBlob,
  };
  root.LotteryCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
