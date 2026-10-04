"""
Fetch the daily lottery results images from the lklottery Facebook page.

Same idea as the desktop app: scroll back through the posts, READ THE DATE PRINTED
AT THE BOTTOM OF EACH RESULTS IMAGE (OCR) and keep the image for that date.
Images are saved as results/YYYY-MM-DD.<ext> and listed in results/index.json,
which the web app reads.

Usage (run from the repository root):
    python fetcher/fetch_results.py                  # today + previous 2 days
    python fetcher/fetch_results.py --days 7
    python fetcher/fetch_results.py --dates 2026-10-03,2026-10-01
    python fetcher/fetch_results.py --storage-state fetcher/state.json
"""
import argparse
import io
import json
import re
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from PIL import Image, ImageChops

FB_PAGE = "https://www.facebook.com/lklottery/"
LK_TZ = timezone(timedelta(hours=5, minutes=30))     # Sri Lanka time
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "results"


def today_lk():
    return datetime.now(LK_TZ).date()


# ---------------------------------------------------------------- date reading (from the desktop app)
_FIX = str.maketrans("OoIl|", "00111")
_DATE_SEP = re.compile(r"(20\d{2})[-./:](\d{2})[-./:](\d{2})")
_DATE_COMPACT = re.compile(r"(20\d{2})(\d{2})(\d{2})")


def _plausible(d):
    return date(2015, 1, 1) <= d <= today_lk() + timedelta(days=2)


def dates_in(text):
    s = re.sub(r"[^0-9OoIl|\-./:]", "", text).translate(_FIX)
    found = list(_DATE_SEP.finditer(s))
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


def autocrop(img, pad=4, threshold=30):
    img = img.convert("RGB")
    bg = Image.new("RGB", img.size, (255, 255, 255))
    diff = ImageChops.difference(img, bg).convert("L").point(lambda p: 255 if p > threshold else 0)
    box = diff.getbbox()
    if not box:
        return img
    l, t, r, b = box
    return img.crop((max(l - pad, 0), max(t - pad, 0), min(r + pad, img.width), min(b + pad, img.height)))


_ocr_engine = None


def _get_ocr():
    global _ocr_engine
    if _ocr_engine is None:
        try:
            from rapidocr import RapidOCR
        except ImportError:
            from rapidocr_onnxruntime import RapidOCR
        _ocr_engine = RapidOCR()
    return _ocr_engine


def _ocr_texts(array):
    out = _get_ocr()(array)
    if hasattr(out, "txts"):
        return list(out.txts or ())
    result = out[0] if isinstance(out, tuple) else out
    return [item[1] for item in (result or [])]


def read_date(img):
    """Date printed in the footer of a results image, or None."""
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
            ds = dates_in(text)
            if ds:
                return ds[0]
    return None


# ---------------------------------------------------------------- page scanning (independent of the browser)
_COLLECT_JS = """
() => Array.from(document.images).map(i => ({
    src: i.currentSrc || i.src, w: i.naturalWidth, h: i.naturalHeight,
    top: i.getBoundingClientRect().top + window.scrollY
}))
"""


def pick_results_images(items):
    """Tall, A4-shaped Facebook photos, newest (top of page) first."""
    seen, urls = set(), []
    for it in sorted(items, key=lambda i: i["top"]):
        w, h = it["w"], it["h"]
        if w < 300 or not h:
            continue
        if not (1.25 <= h / w <= 1.65):
            continue
        if not any(k in it["src"] for k in ("fbcdn", "scontent")):
            continue
        key = it["src"].split("?")[0]
        if key in seen:
            continue
        seen.add(key)
        urls.append(it["src"])
    return urls


def scan(wanted, source, reader, max_steps=60, older_to_stop=3, idle_limit=8, log=print):
    """
    Scroll through the page and collect results images.
    source needs: items(), fetch(url)->bytes, scroll(), wait(ms)
    reader(PIL image) -> date or None
    Returns ({date: image bytes} for EVERY dated image met on the way, number of images seen).
    """
    found, seen_keys = {}, set()
    older = idle = 0
    oldest_wanted = min(wanted)

    for step in range(max_steps):
        source.wait(2000)
        new_urls = []
        for u in pick_results_images(source.items()):
            key = u.split("?")[0]
            if key not in seen_keys:
                seen_keys.add(key)
                new_urls.append(u)

        for u in new_urls:
            try:
                data = source.fetch(u)
                img = Image.open(io.BytesIO(data)).convert("RGB")
            except Exception as e:  # noqa: BLE001
                log(f"  could not download an image: {e}")
                continue
            d = reader(img)
            if d is None:
                log("  image without a readable date - skipped")
                continue
            log(f"  image dated {d.isoformat()}")
            found.setdefault(d, data)
            if d < oldest_wanted:
                older += 1

        if wanted <= set(found):
            log("All wanted dates found.")
            break
        if older >= older_to_stop:
            log("Reached images older than the wanted dates.")
            break
        idle = 0 if new_urls else idle + 1
        if idle >= idle_limit:
            log("Nothing more is loading.")
            break
        source.scroll()
    return found, len(seen_keys)


# ---------------------------------------------------------------- saving
def image_ext(data):
    fmt = (Image.open(io.BytesIO(data)).format or "JPEG").upper()
    return {"JPEG": "jpg", "PNG": "png", "WEBP": "webp"}.get(fmt, "jpg")


def save_results(found, out_dir, overwrite=False):
    """Write images + index.json. Returns list of newly added dates (ISO strings)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    index_path = out_dir / "index.json"
    index = {"updated": None, "dates": {}}
    if index_path.exists():
        try:
            index = json.loads(index_path.read_text(encoding="utf-8"))
            index.setdefault("dates", {})
        except ValueError:
            pass

    added = []
    for d, data in sorted(found.items()):
        key = d.isoformat()
        existing = index["dates"].get(key)
        if existing and (out_dir / existing).exists() and not overwrite:
            continue
        name = f"{key}.{image_ext(data)}"
        (out_dir / name).write_bytes(data)
        index["dates"][key] = name
        added.append(key)

    if added:
        index["dates"] = dict(sorted(index["dates"].items()))
        index["updated"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        index_path.write_text(json.dumps(index, indent=1) + "\n", encoding="utf-8")
    return added


# ---------------------------------------------------------------- real browser
class PlaywrightSource:
    def __init__(self, page, ctx):
        self.page, self.ctx = page, ctx

    def items(self):
        return self.page.evaluate(_COLLECT_JS)

    def fetch(self, url):
        return self.ctx.request.get(url).body()

    def scroll(self):
        self.page.mouse.wheel(0, 2500)

    def wait(self, ms):
        self.page.wait_for_timeout(ms)
        try:
            self.page.keyboard.press("Escape")      # close the login pop-up if shown
        except Exception:
            pass


def run_browser(wanted, args, log=print):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed, args=["--disable-notifications"])
        kw = dict(
            viewport={"width": 1200, "height": 900},
            locale="en-US",
            user_agent=("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"),
        )
        if args.storage_state and Path(args.storage_state).exists():
            kw["storage_state"] = args.storage_state
            log("Using saved Facebook login.")
        ctx = browser.new_context(**kw)
        try:
            page = ctx.new_page()
            log("Opening the Facebook page ...")
            page.goto(FB_PAGE, wait_until="domcontentloaded", timeout=60000)
            log("Loading OCR ...")
            _get_ocr()
            return scan(wanted, PlaywrightSource(page, ctx), read_date,
                        max_steps=args.max_steps, log=log)
        finally:
            ctx.close()
            browser.close()


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dates", default="", help="comma separated YYYY-MM-DD list")
    ap.add_argument("--days", type=int, default=3, help="fetch today and the previous N-1 days (default 3)")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="output folder (default: results/)")
    ap.add_argument("--storage-state", default="", help="Playwright login state json (optional)")
    ap.add_argument("--max-steps", type=int, default=60, help="maximum scroll steps")
    ap.add_argument("--overwrite", action="store_true", help="replace images that already exist")
    ap.add_argument("--headed", action="store_true", help="show the browser window")
    return ap.parse_args(argv)


def wanted_dates(args):
    if args.dates.strip():
        out = set()
        for part in args.dates.split(","):
            part = part.strip()
            if part:
                out.add(datetime.strptime(part, "%Y-%m-%d").date())
        if out:
            return out
    t = today_lk()
    return {t - timedelta(days=i) for i in range(max(1, args.days))}


def main(argv=None):
    args = parse_args(argv)
    wanted = wanted_dates(args)
    print("Looking for:", ", ".join(d.isoformat() for d in sorted(wanted)))
    found, n_images = run_browser(wanted, args)
    out = Path(args.out)
    added = save_results(found, out, overwrite=args.overwrite)

    missing = sorted(d.isoformat() for d in wanted if d not in found)
    print(f"Result images seen: {n_images}; with a readable date: {len(found)}")
    print("Saved new:", ", ".join(added) if added else "nothing new")
    if missing:
        print("Not found:", ", ".join(missing))
    if not found:
        print("ERROR: no dated results images were found. Facebook probably showed a login wall - "
              "see README (Facebook login).", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
