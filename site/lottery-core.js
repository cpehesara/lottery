/*
 * Lottery printer - core image logic (port of lottery_printer.py)
 * Runs in the browser (Canvas API). Also loadable in Node with node-canvas for tests.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- settings
  const DPI = 300;
  const mm = (v) => Math.round((v / 25.4) * DPI);
  const PAGE_W = mm(297), PAGE_H = mm(210);   // default A4 landscape (kept for backwards compatibility)
  const MARGIN = mm(4);
  const GAP = mm(3);

  /** The print settings the user can change (the app saves them on the device). */
  const DEFAULT_OPTS = {
    orientation: 'landscape',  // 'landscape' | 'portrait'
    columns: 3,                // copies per page, side by side (1-6)
    textScale: 100,            // result rows: % of the biggest size that fits (40-100)
    titleScale: 100,           // heading above the table, % (70-140)
    footerScale: 100,          // the two boxes under the table, % (70-170)
    nameScale: 100,            // names inside the table (left column), % (50-200)
    letterScale: 100,          // the letter next to the numbers, % (50-200)
    numberScale: 100,          // the winning numbers, % (50-200)
    tall: 100,                 // stretch text taller (uses spare page height), % (100-200)
    bold: 0,                   // thicker, darker strokes, 0-100
  };

  const clamp = (v, lo, hi, dflt) => {
    v = Number(v);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
  };

  function normalizeOpts(o) {
    o = Object.assign({}, DEFAULT_OPTS, o || {});
    return {
      orientation: o.orientation === 'portrait' ? 'portrait' : 'landscape',
      columns: Math.round(clamp(o.columns, 1, 6, DEFAULT_OPTS.columns)),
      textScale: clamp(o.textScale, 40, 100, 100),
      titleScale: clamp(o.titleScale, 70, 140, 100),
      footerScale: clamp(o.footerScale, 70, 170, 100),
      nameScale: clamp(o.nameScale, 50, 200, 100),
      letterScale: clamp(o.letterScale, 50, 200, 100),
      numberScale: clamp(o.numberScale, 50, 200, 100),
      tall: clamp(o.tall, 100, 200, 100),
      bold: clamp(o.bold, 0, 100, 0),
    };
  }

  /** Page geometry (in pixels at 300 dpi) for the chosen settings. */
  function geometry(o) {
    const portrait = o.orientation === 'portrait';
    return {
      PAGE_W: portrait ? mm(210) : mm(297),
      PAGE_H: portrait ? mm(297) : mm(210),
      MARGIN, GAP, COLUMNS: o.columns, opts: o,
    };
  }

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
  function colSize(L) {
    return [Math.floor((L.PAGE_W - 2 * L.MARGIN - (L.COLUMNS - 1) * L.GAP) / L.COLUMNS), L.PAGE_H - 2 * L.MARGIN];
  }

  function cutGuides(page, colW, L) {
    const g = ctx(page);
    g.fillStyle = 'rgb(160,160,160)';
    for (let i = 1; i < L.COLUMNS; i++) {
      const x = L.MARGIN + i * (colW + L.GAP) - Math.floor(L.GAP / 2);
      for (let y = L.MARGIN; y < L.PAGE_H - L.MARGIN; y += 24) g.fillRect(x - 1, y, 2, 12);
    }
  }

  function composeSimple(src, stretch = true, opts) {
    const L = geometry(normalizeOpts(opts));
    src = autocrop(src);
    const [colW, colH] = colSize(L);
    let tile;
    if (stretch) {
      tile = resize(src, colW, colH);
    } else {
      const scale = Math.min(colW / src.width, colH / src.height);
      tile = resize(src, Math.floor(src.width * scale), Math.floor(src.height * scale));
    }
    tile = unsharp(tile, 3, 110, 2);
    const page = whiteCanvas(L.PAGE_W, L.PAGE_H);
    const g = ctx(page);
    for (let i = 0; i < L.COLUMNS; i++) {
      const x = L.MARGIN + i * (colW + L.GAP) + Math.floor((colW - tile.width) / 2);
      g.drawImage(tile, x, L.MARGIN);
    }
    cutGuides(page, colW, L);
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

  /** Bounding box of the dark pixels of a canvas: { l, t, r, b } (r and b exclusive) or null. */
  function inkExtent(c, thr = 170) {
    const w = c.width, h = c.height;
    const d = ctx(c).getImageData(0, 0, w, h).data;
    let l = w, t = h, r = -1, b = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if ((d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 < thr) {
          if (x < l) l = x; if (x > r) r = x;
          if (y < t) t = y; if (y > b) b = y;
        }
      }
    }
    return r < 0 ? null : { l, t, r: r + 1, b: b + 1 };
  }

  const median = (a) => {
    if (!a.length) return 0;
    const v = a.slice().sort((x, y) => x - y);
    return v[Math.floor(v.length / 2)];
  };

  /**
   * A4 (landscape or portrait), 1-6 columns, text rebuilt larger.
   *  - every row is trimmed to the real ink, so no page space is wasted on blank margins
   *  - names / letters / numbers have their own size
   *  - "tall" stretches the text vertically into the spare page height (width is usually the limit)
   *  - "bold" makes the strokes thicker and darker
   * Returns { canvas, info } where info has the printed text heights in millimetres.
   */
  function composeLargeDetailed(src, opts) {
    const O = normalizeOpts(opts);
    const L = geometry(O);
    const { title, rows, footerBoxes, tiny } = splitResults(src);
    const [colW, colH] = colSize(L);
    const pad = mm(1.8);
    const innerW = colW - 2 * pad;

    // stroke weight: moving the black/white threshold up makes strokes thicker
    const centre = 135 + O.bold * 0.45, halfRamp = 65 - O.bold * 0.2;
    const lo = centre - halfRamp, hi = centre + halfRamp;
    const rz = (c, fx, fy) => crisp(resize(c, c.width * fx, c.height * fy), lo, hi);

    const nm = O.nameScale / 100, lm = O.letterScale / 100, vm = O.numberScale / 100;
    const T = O.tall / 100;
    const M = Math.max(1, nm, lm, vm);          // the biggest part decides the row height

    // ---- trim the rows to their ink. One common vertical window for ALL rows keeps the rows the same
    // height and the text on the same baseline.
    const firstSlot = 17;
    const allExts = rows.map(({ name, tokens }) => [name].concat(tokens).map((c) => inkExtent(c)));
    let gt = 1e9, gb = -1;
    allExts.forEach((list) => list.forEach((e) => { if (e) { if (e.t < gt) gt = e.t; if (e.b > gb) gb = e.b; } }));
    if (gb < 0) { gt = 0; gb = rows[0].name.height; }
    gt = Math.max(0, gt - 1); gb = gb + 1;
    const winH = Math.max(1, gb - gt);
    const cropWin = (c, x, w) => {            // [x, x+w] x [gt, gb] of c, white where c is too short
      const out = whiteCanvas(Math.max(1, Math.round(w)), winH);
      ctx(out).drawImage(c, -x, -gt);
      return out;
    };
    const prepped = rows.map(({ name, tokens }, i) => {
      const exts = allExts[i];
      const ne = exts[0];
      return {
        h: winH,
        name: ne ? cropWin(name, ne.l, ne.r - ne.l) : cropWin(name, 0, name.width),
        tokens: tokens.map((tk) => cropWin(tk, 0, tk.width)),
        tokInk: exts.slice(1).map((e) => (e ? e.b - e.t : 0)),
        nameInk: ne ? ne.b - ne.t : 0,
      };
    });

    const nameW = Math.max(...prepped.map((r) => r.name.width));
    const nameGap = 12;
    const rowInk = prepped.map((r) => r.h);
    const maxInk = Math.max(...rowInk);
    const rightPad = 4;
    const sum = (a) => a.reduce((p, c) => p + c, 0);

    // the first small symbol after the name is the letter; everything after it is a number
    const hasLetter = (toks) => toks.length > 0 && toks[0].width <= firstSlot;
    const isLetter = (toks, k) => k === 0 && hasLetter(toks);
    const tokW = (toks, k) => (isLetter(toks, k) ? Math.max(toks[k].width, firstSlot) * lm : toks[k].width * vm);

    const baseW = prepped.map((r) => nameW * nm + nameGap + sum(r.tokens.map((_, k) => tokW(r.tokens, k))) + rightPad);
    const ntok = prepped.map((r) => Math.max(r.tokens.length - 1, 0));

    // ---- vertical budget
    const rowSrcH = rowInk.map((h) => h * M * T);          // text height of a row (source px)
    const padSrc = 0.55 * maxInk;                           // breathing space per row (source px)
    const titleH = title ? title.height : 0;
    const fixed = mm(1.5) + mm(1.0);
    const footH = mm(10.5 * O.footerScale / 100);
    const tinyH = tiny ? mm(2.4) : 0;
    const availH = colH - fixed - footH - tinyH;
    const lineW = Math.max(2, mm(0.35));
    const tScale = O.titleScale / 100;
    let s = (availH - (rows.length + 1) * lineW) / (titleH * 1.15 * tScale + sum(rowSrcH) + rows.length * padSrc);

    // ---- horizontal budget
    const minGap = 7;
    const need = Math.max(...baseW.map((b, i) => b + ntok[i] * minGap));
    const sWidth = innerW / need;
    s = Math.min(s, sWidth);
    s *= O.textScale / 100;          // overall text size (100% = biggest that fits)
    const availSrcW = innerW / s;

    let widest = 0;
    baseW.forEach((b, i) => { if (b + ntok[i] * minGap > baseW[widest] + ntok[widest] * minGap) widest = i; });
    const G = Math.max(minGap, Math.min(30, (availSrcW - baseW[widest]) / Math.max(ntok[widest], 1)));

    const used = (titleH * 1.15 * tScale + sum(rowSrcH) + rows.length * padSrc) * s + (rows.length + 1) * lineW + fixed + footH + tinyH;
    const rowExtra = Math.floor(Math.max(0, Math.min((colH - used) / rows.length, 0.6 * maxInk * s)));

    // ---- build the rows
    const built = prepped.map(({ name, tokens }, idx) => {
      const rh = Math.max(1, Math.round((rowSrcH[idx] + padSrc) * s)) + rowExtra;
      const row = whiteCanvas(Math.floor(innerW), rh);
      const g = ctx(row);
      const put = (part, mul, xSrc) => {      // each part is resized once, straight to its final size
        const im = rz(part, s * mul, s * mul * T);
        g.drawImage(im, Math.floor(xSrc * s), Math.floor((rh - im.height) / 2));
      };
      put(name, nm, 0);
      let x = nameW * nm + nameGap;
      tokens.forEach((t, k) => {
        put(t, isLetter(tokens, k) ? lm : vm, x);
        x += tokW(tokens, k) + G;
      });
      return row;
    });

    const tile = whiteCanvas(colW, colH);
    const g = ctx(tile);
    g.fillStyle = '#000';
    let y = 0;
    if (title) {
      const f = Math.min(s * 1.15 * tScale, (colW * 0.96) / title.width);
      const t = rz(title, f, f);
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
      const fi = rz(fb, f, f);
      const bx = i * (halfW + mm(1.5));
      roundedFrame(g, bx, footTop, halfW, footH, mm(1.5), lineW);
      g.drawImage(fi, bx + Math.floor((halfW - fi.width) / 2), footTop + Math.floor((footH - fi.height) / 2));
    });
    y = footTop + footH + mm(0.6);

    if (tiny && y < colH) {
      const ti = resize(tiny, colW, Math.max(1, Math.floor((tiny.height * colW) / tiny.width)));
      g.drawImage(ti, 0, y);
    }

    const page = whiteCanvas(L.PAGE_W, L.PAGE_H);
    const pg = ctx(page);
    for (let i = 0; i < L.COLUMNS; i++) pg.drawImage(tile, L.MARGIN + i * (colW + L.GAP), L.MARGIN);
    cutGuides(page, colW, L);

    // ---- printed text heights (millimetres) so the app can tell whether it is easy to read
    const mmPer = 25.4 / DPI;
    const digitInk = [], letterInk = [];
    prepped.forEach((r) => r.tokens.forEach((_, k) => (isLetter(r.tokens, k) ? letterInk : digitInk).push(r.tokInk[k])));
    const info = {
      numberMm: median(digitInk) * s * vm * T * mmPer,
      letterMm: median(letterInk) * s * lm * T * mmPer,
      nameMm: median(prepped.map((r) => r.nameInk)) * 0.75 * s * nm * T * mmPer,   // ~ capital-letter height
      scale: s,
      limit: sWidth <= availH / (titleH * 1.15 * tScale + sum(rowSrcH) + rows.length * padSrc) ? 'width' : 'height',
    };
    return { canvas: page, info };
  }

  const composeLarge = (src, opts) => composeLargeDetailed(src, opts).canvas;

  /** mode: 'large' | 'stretch' | 'fit'. Returns { canvas, note }. */
  function composePage(src, mode = 'large', opts) {
    if (mode === 'large') {
      try {
        const r = composeLargeDetailed(src, opts);
        return { canvas: r.canvas, note: '', info: r.info };
      } catch (e) {
        return {
          canvas: composeSimple(src, true, opts),
          note: `Large-print layout isn't possible for this image (${e.message}). Used the stretch layout instead.`,
          info: null,
        };
      }
    }
    return { canvas: composeSimple(src, mode !== 'fit', opts), note: '', info: null };
  }

  // ---------------------------------------------------------------- PDF (single JPEG page, no libraries)
  function canvasToBlob(c, type, q) {
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode image'))), type, q));
  }

  async function buildPdf(canvas) {
    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.95);
    const jpg = new Uint8Array(await blob.arrayBuffer());
    const land = canvas.width >= canvas.height;
    const W = land ? 841.89 : 595.28, H = land ? 595.28 : 841.89;   // A4 in points (follows the sheet's orientation)
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
    DPI, PAGE_W, PAGE_H, mm, LayoutError, DEFAULT_OPTS, normalizeOpts,
    toCanvas, autocrop, resize, crop,
    parseUserDate, todayISO, addDays, datesIn, readDate, lookupResult,
    splitResults, composePage, composeLarge, composeSimple,
    buildPdf, canvasToBlob,
  };
  root.LotteryCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);