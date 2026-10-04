"""
Lottery Results Printer  (v2 - search by date)
==============================================
Workflow
  1. Type a date (or press "Today").
  2. "Search on Facebook" opens the lklottery page in Microsoft Edge, scrolls
     back through the posts and READS THE DATE PRINTED AT THE BOTTOM OF EACH
     RESULTS IMAGE (OCR) until it finds the one that matches your date.
  3. The image is placed 3 times on an A4 landscape page and shown as a preview.
  4. "Submit & Print in Edge" saves the PDF and opens the Edge print dialog.

Run:  python lottery_printer.py
"""

import io
import queue
import re
import shutil
import subprocess
import threading
import urllib.request
import webbrowser
from datetime import date, datetime, timedelta
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageGrab

# --------------------------------------------------------------------------
# Settings
# --------------------------------------------------------------------------
APP_DIR = Path(__file__).resolve().parent
OUT_DIR = APP_DIR / "output"              # PDFs / PNGs / HTML are saved here
PROFILE_DIR = APP_DIR / "edge_profile"    # keeps your Facebook login for next time
FB_PAGE = "https://www.facebook.com/lklottery/"

MAX_SCROLL_STEPS = 400    # safety limit while searching back through old posts
OLDER_IMAGES_TO_STOP = 3  # stop after this many images older than the wanted date

DPI = 300                 # print quality


def mm(value):
    return int(round(value / 25.4 * DPI))


PAGE_W, PAGE_H = mm(297), mm(210)         # A4 landscape
MARGIN = mm(4)                            # outer white margin
GAP = mm(3)                               # gap between columns (cut line goes here)
COLUMNS = 3


class SearchCancelled(Exception):
    pass


# --------------------------------------------------------------------------
# Date helpers
# --------------------------------------------------------------------------
def parse_user_date(text):
    """Accept 2026-10-03, 2026.10.03, 2026/10/03, 03-10-2026, 03.10.2026, 03/10/2026."""
    t = text.strip()
    for fmt in ("%Y-%m-%d", "%Y.%m.%d", "%Y/%m/%d", "%d-%m-%Y", "%d.%m.%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(t, fmt).date()
        except ValueError:
            pass
    raise ValueError("Please type the date like 2026-10-03")


_FIX = str.maketrans("OoIl|", "00111")          # common OCR mix-ups in digits
_DATE_SEP = re.compile(r"(20\d{2})[-./:](\d{2})[-./:](\d{2})")
_DATE_COMPACT = re.compile(r"(20\d{2})(\d{2})(\d{2})")


def _plausible(d):
    return date(2015, 1, 1) <= d <= date.today() + timedelta(days=2)


def _dates_in(text):
    s = re.sub(r"[^0-9OoIl|\-./:]", "", text).translate(_FIX)
    found = []
    for m in _DATE_SEP.finditer(s):
        found.append(m)
    if not found:
        m = _DATE_COMPACT.fullmatch(s)
        if m:
            found.append(m)
    out = []
    for m in found:
        try:
            d = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            continue
        if _plausible(d):
            out.append(d)
    return out


_ocr_engine = None


def _get_ocr():
    """Load the OCR engine once. Works with the new 'rapidocr' package (Python 3.13 ok)
    and falls back to the older 'rapidocr_onnxruntime' package."""
    global _ocr_engine
    if _ocr_engine is None:
        try:
            from rapidocr import RapidOCR
        except ImportError:
            from rapidocr_onnxruntime import RapidOCR
        _ocr_engine = RapidOCR()
    return _ocr_engine


def _ocr_texts(array):
    """Run OCR on a numpy image and return the list of text pieces found."""
    out = _get_ocr()(array)
    if hasattr(out, "txts"):                      # new rapidocr package
        return list(out.txts or ())
    result = out[0] if isinstance(out, tuple) else out   # old package
    return [item[1] for item in (result or [])]


def read_date(img):
    """Read the date printed in the footer of a results image. Returns a date or None."""
    import numpy as np

    img = autocrop(img)
    w, h = img.size
    for frac in (0.12, 0.2, 0.35):
        strip = img.crop((0, int(h * (1 - frac)), w, h))
        factor = max(1, min(4, 1400 // max(strip.width, 1)))
        if factor > 1:
            strip = strip.resize((strip.width * factor, strip.height * factor), Image.LANCZOS)
        try:
            texts = _ocr_texts(np.array(strip))
        except Exception:
            texts = []
        for text in texts:
            ds = _dates_in(text)
            if ds:
                return ds[0]
    return None


# --------------------------------------------------------------------------
# Image helpers
# --------------------------------------------------------------------------
def autocrop(img, pad=4, threshold=30):
    """Trim the plain white border around the results image."""
    img = img.convert("RGB")
    bg = Image.new("RGB", img.size, (255, 255, 255))
    diff = ImageChops.difference(img, bg).convert("L").point(
        lambda p: 255 if p > threshold else 0
    )
    box = diff.getbbox()
    if not box:
        return img
    left, top, right, bottom = box
    return img.crop(
        (
            max(left - pad, 0),
            max(top - pad, 0),
            min(right + pad, img.width),
            min(bottom + pad, img.height),
        )
    )


def compose_simple(src, stretch=True):
    """Plain layout: the whole picture repeated 3 times (stretched or proportional)."""
    src = autocrop(src)
    col_w = (PAGE_W - 2 * MARGIN - (COLUMNS - 1) * GAP) // COLUMNS
    col_h = PAGE_H - 2 * MARGIN

    if stretch:
        tile = src.resize((col_w, col_h), Image.LANCZOS)      # fills the column
    else:
        scale = min(col_w / src.width, col_h / src.height)    # keeps proportions
        tile = src.resize(
            (int(src.width * scale), int(src.height * scale)), Image.LANCZOS
        )

    tile = tile.filter(ImageFilter.UnsharpMask(radius=2, percent=110, threshold=2))

    page = Image.new("RGB", (PAGE_W, PAGE_H), "white")
    for i in range(COLUMNS):
        x = MARGIN + i * (col_w + GAP) + (col_w - tile.width) // 2
        page.paste(tile, (x, MARGIN))

    draw = ImageDraw.Draw(page)                               # dashed cut guides
    for i in range(1, COLUMNS):
        x = MARGIN + i * (col_w + GAP) - GAP // 2
        for y in range(MARGIN, PAGE_H - MARGIN, 24):
            draw.line([(x, y), (x, y + 12)], fill=(160, 160, 160), width=2)
    return page



# --------------------------------------------------------------------------
# LARGE-PRINT layout: cut the image into rows and rebuild them bigger
# --------------------------------------------------------------------------
class LayoutError(Exception):
    pass


def _runs(flags, merge_gap):
    """Group consecutive True positions; gaps <= merge_gap are merged."""
    out = []
    for x in range(len(flags)):
        if flags[x]:
            if out and x - out[-1][1] <= merge_gap + 1:
                out[-1][1] = x
            else:
                out.append([x, x])
    return [(a, b + 1) for a, b in out]


def _crisp(img, lo=70, hi=200):
    """Make up-scaled text sharp and dark (steep contrast curve)."""
    lut = [max(0, min(255, int((v - lo) * 255 / (hi - lo)))) for v in range(256)]
    return img.convert("L").point(lut).convert("RGB")


def _resize(img, factor):
    w, h = max(1, int(round(img.width * factor))), max(1, int(round(img.height * factor)))
    return _crisp(img.resize((w, h), Image.LANCZOS))


def split_results_image(src):
    """
    Cut the daily results image into: title, table rows (name cell + value tokens), footer.
    Raises LayoutError if the picture does not look like the usual template.
    """
    import numpy as np

    img = autocrop(src)
    # normalise width so pixel measurements below match the usual 495px template
    if abs(img.width - 495) > 4:
        img = img.resize((495, int(round(img.height * 495 / img.width))), Image.LANCZOS)
    gray = np.array(img.convert("L")).astype(int)
    H, W = gray.shape
    ink = gray < 150
    wide = (gray < 200).mean(axis=1) > 0.55

    lines = _runs(wide, 1)
    centres = [(a + b - 1) // 2 for a, b in lines]
    if not centres:
        raise LayoutError("no table lines")
    table = [centres[0]]
    for c in centres[1:]:
        if c - table[-1] >= 25:
            table.append(c)
        else:
            break
    if not (8 <= len(table) - 1 <= 30):
        raise LayoutError(f"unexpected number of rows: {len(table) - 1}")

    X0, X1 = 9, W - 9
    # name column / value column split = widest empty gap in the early part of the row
    agg = np.zeros(W, int)
    for a, b in zip(table[:-1], table[1:]):
        agg += ink[a + 3:b - 2].sum(axis=0)
    occ = agg > 0
    occ[:X0] = False
    occ[X1:] = False
    gaps = [(a, b) for a, b in _runs(~occ[: W // 2 + 40], 0) if a > 60 and b - a >= 10]
    if not gaps:
        raise LayoutError("cannot find name/value split")
    split = (gaps[0][0] + gaps[0][1]) // 2
    name_x0 = max(X0, int(np.argmax(occ[:split])) - 3)       # trim empty padding on the left

    rows = []
    for a, b in zip(table[:-1], table[1:]):
        y0, y1 = a + 3, b - 2
        band = img.crop((0, y0, W, y1))
        band_ink = ink[y0:y1]
        name_cell = band.crop((name_x0, 0, split, band.height))
        cols = band_ink[:, split:X1].any(axis=0)
        tokens = [band.crop((split + s, 0, split + e, band.height)) for s, e in _runs(cols, 6)]
        rows.append((name_cell, tokens))

    # title: ink area above the table box
    t_ink = ink[: table[0] - 2]
    ys, xs = np.where(t_ink)
    title = img.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)) if len(ys) else None

    # footer: two boxes (date | day) and a tiny credit line
    f0 = table[-1] + 3
    footer_boxes, tiny = [], None
    fl = _runs(wide[f0:], 1)
    if len(fl) >= 2 and fl[1][0] - fl[0][0] > 12:
        top, bottom = f0 + fl[0][1], f0 + fl[1][0]
        mid = W // 2
        for xa, xb in ((0, mid - 3), (mid + 3, W)):
            cell = ink[top + 3:bottom - 2, xa + 8:xb - 8]
            ys, xs = np.where(cell)
            if len(ys):
                footer_boxes.append(
                    img.crop((xa + 8 + xs.min(), top + 3 + ys.min(),
                              xa + 8 + xs.max() + 1, top + 3 + ys.max() + 1))
                )
        if bottom + 4 < H:
            tiny = img.crop((0, bottom + 3, W, H))
    if len(footer_boxes) != 2:
        raise LayoutError("footer not recognised")
    return title, rows, footer_boxes, tiny


def compose_large(src):
    """A4 landscape, 3 columns, text rebuilt at a larger size without distortion."""
    title, rows, footer_boxes, tiny = split_results_image(src)

    col_w = (PAGE_W - 2 * MARGIN - (COLUMNS - 1) * GAP) // COLUMNS
    col_h = PAGE_H - 2 * MARGIN
    pad = mm(1.2)                       # inner padding of the table box
    inner_w = col_w - 2 * pad

    name_w = rows[0][0].width
    name_gap = 6                        # source pixels between name cell and values
    row_h = [r[0].height for r in rows]

    first_slot = 17                                   # keeps the first number column aligned
    right_pad = 6                                     # source px kept free at the right edge

    def fixed_w(toks):
        extra = max(0, first_slot - toks[0].width) if toks and toks[0].width <= first_slot else 0
        return name_w + name_gap + sum(t.width for t in toks) + extra + right_pad

    base_w = [fixed_w(toks) for _, toks in rows]
    ntok = [max(len(toks) - 1, 0) for _, toks in rows]

    # vertical budget (mm -> px)
    title_h_src = title.height if title else 0
    fixed = mm(1.5) + mm(1.0)                       # gaps around title and footer
    foot_h = mm(10.5)                               # footer boxes (drawn at larger size)
    tiny_h = mm(2.4) if tiny is not None else 0
    avail_h = col_h - fixed - foot_h - tiny_h
    line_w = max(2, mm(0.35))                       # thickness of table lines
    s = (avail_h - (len(rows) + 1) * line_w) / (title_h_src * 1.15 + sum(row_h))   # height limit

    # width limit: the widest row must fit with at least `min_gap` between values
    min_gap = 7
    need = max(b + n * min_gap for b, n in zip(base_w, ntok))
    s = min(s, inner_w / need)
    avail_src_w = inner_w / s

    # spread any free width as extra gap between values (same gap for every row)
    widest = max(range(len(rows)), key=lambda i: base_w[i] + ntok[i] * min_gap)
    G = max(min_gap, min(30, (avail_src_w - base_w[widest]) / max(ntok[widest], 1)))

    est = (title_h_src * 1.15 + sum(row_h)) * s + (len(rows) + 1) * line_w + fixed + foot_h + tiny_h
    row_extra = int(max(0, min((col_h - est) / len(rows), 0.30 * max(row_h) * s)))

    built = []
    for (name_cell, toks), h in zip(rows, row_h):
        total_w = int(avail_src_w) + 1
        row = Image.new("RGB", (total_w, h), "white")
        row.paste(name_cell, (0, 0))
        x = name_w + name_gap
        for k, t in enumerate(toks):
            row.paste(t, (int(x), 0))
            slot = max(t.width, first_slot) if k == 0 and t.width <= first_slot else t.width
            x += slot + G
        row = _resize(row, s)
        if row_extra:
            padded = Image.new("RGB", (row.width, row.height + row_extra), "white")
            padded.paste(row, (0, row_extra // 2))
            row = padded
        built.append(row)

    # ---- assemble the column -------------------------------------------------
    tile = Image.new("RGB", (col_w, col_h), "white")
    d = ImageDraw.Draw(tile)
    y = 0
    if title is not None:
        t_img = _resize(title, min(s * 1.15, (col_w * 0.96) / title.width))
        tile.paste(t_img, ((col_w - t_img.width) // 2, y))
        y += t_img.height + mm(1.5)

    box_top = y
    box_h = sum(r.height for r in built) + (len(built) + 1) * line_w
    d.rectangle((0, box_top, col_w - 1, box_top + box_h), outline="black", width=line_w)
    y = box_top + line_w
    for i, r in enumerate(built):
        tile.paste(r, (pad, y))
        y += r.height
        d.line([(0, y + line_w // 2), (col_w - 1, y + line_w // 2)], fill="black", width=line_w)
        y += line_w
    y = box_top + box_h + mm(1.0)

    # footer boxes: date and weekday, enlarged to fill their boxes
    half = (col_w - mm(1.5)) // 2
    foot_top = y
    for i, fb in enumerate(footer_boxes):
        f = min((half - 2 * mm(3.0)) / fb.width, (foot_h - 2 * mm(2.2)) / fb.height)
        fi = _resize(fb, f)
        bx = i * (half + mm(1.5))
        d.rounded_rectangle((bx, foot_top, bx + half - 1, foot_top + foot_h - 1),
                            radius=mm(1.5), outline="black", width=line_w)
        tile.paste(fi, (bx + (half - fi.width) // 2, foot_top + (foot_h - fi.height) // 2))
    y = foot_top + foot_h + mm(0.6)

    if tiny is not None and y < col_h:
        ti = tiny.resize((col_w, max(1, int(tiny.height * col_w / tiny.width))), Image.LANCZOS)
        tile.paste(ti, (0, y))

    page = Image.new("RGB", (PAGE_W, PAGE_H), "white")
    for i in range(COLUMNS):
        page.paste(tile, (MARGIN + i * (col_w + GAP), MARGIN))
    _cut_guides(page, col_w)
    compose_large.last_info = {"mm_per_src_px": s / DPI * 25.4, "gap": G, "used_h": y}
    return page


def _cut_guides(page, col_w):
    draw = ImageDraw.Draw(page)
    for i in range(1, COLUMNS):
        x = MARGIN + i * (col_w + GAP) - GAP // 2
        for y in range(MARGIN, PAGE_H - MARGIN, 24):
            draw.line([(x, y), (x, y + 12)], fill=(160, 160, 160), width=2)


def compose_page(src, mode="large"):
    """
    Build the A4 landscape page.
      mode "large"   : rows rebuilt at a bigger size, no distortion (default, easiest to read)
      mode "stretch" : whole picture stretched to fill each column
      mode "fit"     : whole picture, original proportions
    If the picture does not match the usual template, "large" falls back to "stretch".
    Check compose_page.note afterwards for a message to show the user.
    """
    compose_page.note = ""
    if mode == "large":
        try:
            return compose_large(src)
        except Exception as e:  # noqa: BLE001
            compose_page.note = f"(Large-print layout not possible for this image: {e}. Used stretch layout.)"
            return compose_simple(src, True)
    return compose_simple(src, mode != "fit")



HTML_TEMPLATE = """<!doctype html>
<html><head><meta charset="utf-8"><title>Lottery Results {day}</title>
<style>
  @page {{ size: A4 landscape; margin: 0; }}
  html, body {{ margin: 0; padding: 0; background: #fff; }}
  img {{ display: block; width: 297mm; height: 210mm; }}
  @media print {{ html, body {{ width: 297mm; height: 210mm; overflow: hidden; }} }}
  @media screen {{
    body {{ background: #555; display: flex; justify-content: center; }}
    img {{ width: min(98vw, calc(98vh * 297 / 210)); height: auto; }}
  }}
</style></head>
<body>
<img src="{png}" alt="Lottery results">
<script>window.addEventListener('load', function () {{
  setTimeout(function () {{ window.print(); }}, 700);
}});</script>
</body></html>
"""


def save_outputs(page, day):
    """Save PNG, PDF and a print-ready HTML file. Returns (pdf, html) paths."""
    OUT_DIR.mkdir(exist_ok=True)
    stem = "lottery_" + day.isoformat()
    png = OUT_DIR / (stem + ".png")
    pdf = OUT_DIR / (stem + ".pdf")
    html = OUT_DIR / (stem + ".html")
    page.save(png)
    page.save(pdf, "PDF", resolution=float(DPI))
    html.write_text(HTML_TEMPLATE.format(day=day.isoformat(), png=png.name), encoding="utf-8")
    return pdf, html


def find_edge():
    for c in (
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ):
        if Path(c).exists():
            return c
    return shutil.which("msedge")


def print_in_edge(html_path):
    """Open the print-ready page in Edge; the page itself triggers the print dialog."""
    edge = find_edge()
    url = Path(html_path).resolve().as_uri()
    if edge:
        subprocess.Popen([edge, "--new-window", url])
    else:
        webbrowser.open(url)


# --------------------------------------------------------------------------
# Getting the image from Facebook
# --------------------------------------------------------------------------
_COLLECT_JS = """
() => Array.from(document.images).map(i => ({
    src: i.currentSrc || i.src,
    w: i.naturalWidth,
    h: i.naturalHeight,
    top: i.getBoundingClientRect().top + window.scrollY
}))
"""


def _pick_results_images(items):
    """Tall, A4-shaped Facebook photos from the page, top (newest) first."""
    seen, urls = set(), []
    for it in sorted(items, key=lambda i: i["top"]):
        w, h = it["w"], it["h"]
        if w < 300 or not h:
            continue
        if not (1.25 <= h / w <= 1.65):          # results image is ~A4 portrait
            continue
        if not any(k in it["src"] for k in ("fbcdn", "scontent")):
            continue
        key = it["src"].split("?")[0]
        if key in seen:
            continue
        seen.add(key)
        urls.append(it["src"])
    return urls


def search_facebook_for_date(target, status, cancel):
    """
    Scroll the lklottery page and OCR every results image until one shows `target`.
    Returns (image or None, sorted list of dates that were seen).
    """
    from playwright.sync_api import sync_playwright

    PROFILE_DIR.mkdir(exist_ok=True)
    seen_keys, seen_dates = set(), set()
    older, idle = 0, 0

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(PROFILE_DIR),
            channel="msedge",
            headless=False,
            viewport={"width": 1200, "height": 900},
            args=["--disable-notifications"],
        )
        try:
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            status("Opening the Facebook page in Edge ...")
            page.goto(FB_PAGE, wait_until="domcontentloaded", timeout=60000)
            status("Loading OCR (first time takes a few seconds) ...")
            _get_ocr()

            for step in range(MAX_SCROLL_STEPS):
                if cancel.is_set():
                    raise SearchCancelled()

                page.wait_for_timeout(2000)
                try:
                    page.keyboard.press("Escape")             # close login pop-up if shown
                except Exception:
                    pass

                new_urls = []
                for u in _pick_results_images(page.evaluate(_COLLECT_JS)):
                    key = u.split("?")[0]
                    if key not in seen_keys:
                        seen_keys.add(key)
                        new_urls.append(u)

                for u in new_urls:
                    if cancel.is_set():
                        raise SearchCancelled()
                    try:
                        img = Image.open(io.BytesIO(ctx.request.get(u).body())).convert("RGB")
                    except Exception:
                        continue
                    d = read_date(img)
                    if d is None:
                        continue
                    seen_dates.add(d)
                    status(f"Checked image dated {d.isoformat()} - looking for {target.isoformat()} ...")
                    if d == target:
                        return img, sorted(seen_dates)
                    if d < target:
                        older += 1

                if older >= OLDER_IMAGES_TO_STOP:
                    break                                      # we are already past that date

                idle = 0 if new_urls else idle + 1
                limit = 8 if seen_keys else 25                 # allow time to log in
                if idle >= limit:
                    break                                      # nothing more is loading
                if not seen_keys and step % 5 == 4:
                    status("No result images yet. If a login box blocks the page, "
                           "log in inside the Edge window ...")
                page.mouse.wheel(0, 2500)
            return None, sorted(seen_dates)
        finally:
            ctx.close()


def image_from_url(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return Image.open(io.BytesIO(r.read())).convert("RGB")


# --------------------------------------------------------------------------
# GUI
# --------------------------------------------------------------------------
def run_gui():
    import tkinter as tk
    from tkinter import filedialog, messagebox, simpledialog, ttk

    from PIL import ImageTk

    class App:
        def __init__(self, root):
            self.root = root
            root.title("Lottery Results Printer")
            root.geometry("1200x880")

            self.src_img = None          # the loaded results image
            self.img_date = None         # date of the loaded image
            self.page = None
            self.tkimg = None
            self.q = queue.Queue()
            self.cancel = threading.Event()
            self.layout = tk.StringVar(value="large")
            self.date_var = tk.StringVar(value=date.today().isoformat())
            self._resize_job = None

            row1 = ttk.Frame(root, padding=(8, 8, 8, 2))
            row1.pack(fill="x")
            ttk.Label(row1, text="Date (YYYY-MM-DD):").pack(side="left")
            ttk.Entry(row1, textvariable=self.date_var, width=12).pack(side="left", padx=6)
            ttk.Button(row1, text="<", width=3, command=lambda: self.shift_day(-1)).pack(side="left")
            ttk.Button(row1, text=">", width=3, command=lambda: self.shift_day(1)).pack(side="left", padx=(2, 0))
            ttk.Button(row1, text="Today", command=self.set_today).pack(side="left", padx=6)
            self.search_btn = ttk.Button(row1, text="1. Search on Facebook", command=self.search)
            self.search_btn.pack(side="left", padx=(12, 0))
            self.stop_btn = ttk.Button(row1, text="Stop", command=self.stop, state="disabled")
            self.stop_btn.pack(side="left", padx=6)

            row2 = ttk.Frame(root, padding=(8, 2, 8, 6))
            row2.pack(fill="x")
            ttk.Label(row2, text="Or load manually:").pack(side="left")
            ttk.Button(row2, text="Open image...", command=self.open_file).pack(side="left", padx=(8, 0))
            ttk.Button(row2, text="Paste", command=self.paste).pack(side="left", padx=(6, 0))
            ttk.Button(row2, text="From URL...", command=self.from_url).pack(side="left", padx=(6, 0))
            ttk.Label(row2, text="Layout:").pack(side="left", padx=(24, 4))
            for text, val in (("Large print (easiest to read)", "large"),
                              ("Stretch whole picture", "stretch"),
                              ("Original proportions", "fit")):
                ttk.Radiobutton(row2, text=text, value=val, variable=self.layout,
                                command=self.render).pack(side="left", padx=4)

            self.canvas = tk.Canvas(root, bg="#444444", highlightthickness=0)
            self.canvas.pack(fill="both", expand=True, padx=8)
            self.canvas.bind("<Configure>", self._on_resize)

            bottom = ttk.Frame(root, padding=8)
            bottom.pack(fill="x")
            self.status = ttk.Label(bottom, text="Ready. Enter a date and press 'Search on Facebook'.")
            self.status.pack(side="left", fill="x", expand=True)
            ttk.Button(bottom, text="Save PDF only", command=self.save_only).pack(side="right", padx=(8, 0))
            ttk.Button(bottom, text="2. Submit & Print in Edge", command=self.submit).pack(side="right")

            self.poll()

        # ---- small helpers ----------------------------------------------
        def set_status(self, msg):
            self.status.config(text=msg)

        def poll(self):
            try:
                while True:
                    self.q.get_nowait()()
            except queue.Empty:
                pass
            self.root.after(100, self.poll)

        def get_date(self):
            try:
                return parse_user_date(self.date_var.get())
            except ValueError as e:
                messagebox.showerror("Date", str(e))
                return None

        def set_today(self):
            self.date_var.set(date.today().isoformat())

        def shift_day(self, delta):
            try:
                d = parse_user_date(self.date_var.get())
            except ValueError:
                d = date.today()
            self.date_var.set((d + timedelta(days=delta)).isoformat())

        # ---- preview ------------------------------------------------------
        def set_image(self, img, detected):
            self.src_img = img
            self.img_date = detected
            if detected:
                self.date_var.set(detected.isoformat())
            self.render()

        def render(self):
            if self.src_img is None:
                return
            self.page = compose_page(self.src_img, self.layout.get())
            self.show_preview()
            if compose_page.note:
                self.set_status(compose_page.note)

        def show_preview(self):
            if self.page is None:
                return
            cw, ch = max(self.canvas.winfo_width(), 50), max(self.canvas.winfo_height(), 50)
            scale = min(cw / self.page.width, ch / self.page.height)
            size = (int(self.page.width * scale), int(self.page.height * scale))
            self.tkimg = ImageTk.PhotoImage(self.page.resize(size, Image.LANCZOS))
            self.canvas.delete("all")
            self.canvas.create_image(cw // 2, ch // 2, image=self.tkimg)

        def _on_resize(self, _event):
            if self._resize_job:
                self.root.after_cancel(self._resize_job)
            self._resize_job = self.root.after(150, self.show_preview)

        # ---- Facebook search ----------------------------------------------
        def search(self):
            target = self.get_date()
            if target is None:
                return
            if target > date.today():
                messagebox.showinfo("Date", "That date is in the future - no results exist yet.")
                return
            self.cancel.clear()
            self.search_btn.config(state="disabled")
            self.stop_btn.config(state="normal")
            self.set_status(f"Searching for {target.isoformat()} ...")

            def work():
                try:
                    res = search_facebook_for_date(
                        target, lambda m: self.q.put(lambda: self.set_status(m)), self.cancel
                    )
                    self.q.put(lambda: self.search_done(target, res, None))
                except Exception as e:  # noqa: BLE001
                    self.q.put(lambda: self.search_done(target, None, e))

            threading.Thread(target=work, daemon=True).start()

        def stop(self):
            self.cancel.set()
            self.set_status("Stopping ...")

        def search_done(self, target, res, err):
            self.search_btn.config(state="normal")
            self.stop_btn.config(state="disabled")
            if isinstance(err, SearchCancelled):
                self.set_status("Search stopped.")
                return
            if err:
                self.set_status("Search failed.")
                messagebox.showerror(
                    "Search failed",
                    f"{err}\n\nYou can still use 'Open image...', 'Paste' or 'From URL...'.",
                )
                return
            img, seen = res
            if img is not None:
                self.set_image(img, target)
                self.set_status(
                    f"Found {target.isoformat()} (date confirmed by reading the image). "
                    "Check the preview, then press Submit."
                )
            elif seen:
                self.set_status(f"No result image for {target.isoformat()} was found.")
                messagebox.showwarning(
                    "Not found",
                    f"No image dated {target.isoformat()} was found.\n\n"
                    f"Newest date seen: {seen[-1].isoformat()}\n"
                    f"Oldest date seen: {seen[0].isoformat()}\n\n"
                    "The page may not have posted that day. If Facebook limits what you "
                    "can scroll, log in inside the Edge window and search again.",
                )
            else:
                self.set_status("No result images were found on the page.")
                messagebox.showwarning(
                    "Nothing found",
                    "No result images were found.\nLog in to Facebook in the Edge window "
                    "and search again, or load the image manually.",
                )

        # ---- manual sources -----------------------------------------------
        def load_manual(self, img, label):
            self.set_status(f"{label} - reading the date from the image ...")
            self.root.update_idletasks()
            detected = None
            try:
                detected = read_date(img)
            except Exception:
                pass
            self.set_image(img, detected)
            if detected:
                self.set_status(f"{label}. Date read from image: {detected.isoformat()}")
            else:
                self.set_status(f"{label}. Could not read the date - using the date typed above.")

        def open_file(self):
            path = filedialog.askopenfilename(
                filetypes=[("Images", "*.png *.jpg *.jpeg *.webp *.bmp"), ("All files", "*.*")]
            )
            if path:
                self.load_manual(Image.open(path).convert("RGB"), f"Loaded {Path(path).name}")

        def paste(self):
            clip = ImageGrab.grabclipboard()
            if isinstance(clip, Image.Image):
                self.load_manual(clip.convert("RGB"), "Image pasted")
            elif isinstance(clip, list) and clip:
                self.load_manual(Image.open(clip[0]).convert("RGB"), "Image loaded from clipboard")
            else:
                messagebox.showinfo("Paste", "There is no image on the clipboard.")

        def from_url(self):
            url = simpledialog.askstring("Image URL", "Paste the direct image URL:")
            if not url:
                return
            try:
                self.load_manual(image_from_url(url.strip()), "Image downloaded")
            except Exception as e:  # noqa: BLE001
                messagebox.showerror("Download failed", str(e))

        # ---- output --------------------------------------------------------
        def _day_for_files(self):
            return self.img_date or self.get_date() or date.today()

        def save_only(self):
            if self.page is None:
                messagebox.showinfo("Nothing to save", "Load or search for an image first.")
                return
            pdf, _ = save_outputs(self.page, self._day_for_files())
            self.set_status(f"PDF saved: {pdf}")

        def submit(self):
            if self.page is None:
                messagebox.showinfo("Nothing to print", "Load or search for an image first.")
                return
            pdf, html = save_outputs(self.page, self._day_for_files())
            print_in_edge(html)
            self.set_status(f"PDF saved ({pdf.name}). Edge opened with the print dialog.")

    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    run_gui()
