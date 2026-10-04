"""
Cloud robot (runs on GitHub Actions every 15 minutes between ~21:30 and ~02:15 Sri Lanka time).

  python robot.py --precheck   quick stdlib-only check -> tells the workflow whether to continue
  python robot.py              find the day's image on the Facebook page, build the PDF,
                               save it into site/results/, send it to WhatsApp / Telegram
"""
import io
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "site" / "results"
TZ = ZoneInfo("Asia/Colombo")
KEEP_DAYS = 45
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def target_date(now):
    """Before 06:00 we are still waiting for the previous evening's results."""
    return (now - timedelta(hours=6)).date()


def in_window(now):
    m = now.hour * 60 + now.minute
    return m >= 21 * 60 + 25 or m <= 2 * 60 + 20


def wanted():
    """Returns (date, is_manual_backfill) or None when there is nothing to do."""
    now = datetime.now(TZ)
    given = os.environ.get("INPUT_DATE", "").strip()
    manual = os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
    if given:
        return datetime.strptime(given, "%Y-%m-%d").date(), True
    if not manual and not in_window(now):
        print("Outside the nightly window - nothing to do.")
        return None
    t = target_date(now)
    if (RES / f"{t}.pdf").exists():
        print(f"{t} already saved - nothing to do.")
        return None
    return t, False


def precheck():
    w = wanted()
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as f:
            f.write(f"run={'true' if w else 'false'}\n")
    print("continue" if w else "skip")


# ---------------------------------------------------------------- Facebook
def load_cookies(raw):
    """Accepts a cookie export (browser extension JSON) and converts it for Playwright."""
    same = {"no_restriction": "None", "lax": "Lax", "strict": "Strict"}
    out = []
    for c in json.loads(raw):
        item = {
            "name": c["name"], "value": c["value"],
            "domain": c.get("domain", ".facebook.com"), "path": c.get("path", "/"),
            "secure": True, "httpOnly": bool(c.get("httpOnly", False)),
            "sameSite": same.get(str(c.get("sameSite", "")).lower(), "Lax"),
        }
        exp = c.get("expirationDate", c.get("expires"))
        if exp and float(exp) > 0:
            item["expires"] = float(exp)
        out.append(item)
    return out


def fetch_image(target):
    from PIL import Image
    from playwright.sync_api import sync_playwright
    import lottery_printer as lp

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--disable-notifications"])
        ctx = browser.new_context(viewport={"width": 1200, "height": 900}, locale="en-GB", user_agent=UA)
        if os.environ.get("FB_COOKIES", "").strip():
            ctx.add_cookies(load_cookies(os.environ["FB_COOKIES"]))
        page = ctx.new_page()
        page.goto(lp.FB_PAGE, wait_until="domcontentloaded", timeout=60000)
        seen, older, idle = set(), 0, 0
        try:
            for _ in range(80):
                page.wait_for_timeout(2000)
                try:
                    page.keyboard.press("Escape")
                except Exception:
                    pass
                new = [u for u in lp._pick_results_images(page.evaluate(lp._COLLECT_JS))
                       if u.split("?")[0] not in seen]
                for u in new:
                    seen.add(u.split("?")[0])
                    try:
                        img = Image.open(io.BytesIO(ctx.request.get(u).body())).convert("RGB")
                    except Exception:
                        continue
                    d = lp.read_date(img)
                    print("image date read:", d)
                    if d == target:
                        return img
                    if d and d < target:
                        older += 1
                if older >= 3:
                    break
                idle = 0 if new else idle + 1
                if idle >= 8:
                    break
                page.mouse.wheel(0, 2500)
        finally:
            browser.close()
    print(f"Page title/images seen: {len(seen)} (0 usually means Facebook showed a login wall)")
    return None


# ---------------------------------------------------------------- build + publish
def publish(img, target):
    from PIL import Image
    import lottery_printer as lp

    RES.mkdir(parents=True, exist_ok=True)
    page = lp.compose_page(img, "large")
    if lp.compose_page.note:
        print(lp.compose_page.note)
    pdf = RES / f"{target}.pdf"
    page.save(pdf, "PDF", resolution=float(lp.DPI))
    prev = page.resize((1400, int(1400 * page.height / page.width)), Image.LANCZOS).convert("RGB")
    prev.save(RES / f"{target}.jpg", quality=88)

    dates = sorted({p.stem for p in RES.glob("*.pdf")}, reverse=True)
    keep = set(dates[:KEEP_DAYS])
    for p in RES.iterdir():
        if p.suffix in (".pdf", ".jpg") and p.stem not in keep:
            p.unlink()
    (RES / "index.json").write_text(json.dumps(sorted(keep, reverse=True)))
    return pdf


# ---------------------------------------------------------------- notifications
def send_whatsapp(pdf, label):
    import requests

    token, pid, to = (os.environ.get(k, "").strip() for k in ("WA_TOKEN", "WA_PHONE_ID", "WA_TO"))
    if not (token and pid and to):
        print("WhatsApp: not configured - skipped")
        return
    base = f"https://graph.facebook.com/{os.environ.get('WA_API_VERSION', 'v23.0')}/{pid}"
    auth = {"Authorization": f"Bearer {token}"}
    up = requests.post(f"{base}/media", headers=auth, timeout=60,
                       data={"messaging_product": "whatsapp", "type": "application/pdf"},
                       files={"file": (pdf.name, pdf.read_bytes(), "application/pdf")})
    if up.status_code != 200:
        print("WhatsApp upload failed:", up.text)
        return
    media_id = up.json()["id"]
    doc = {"id": media_id, "filename": pdf.name}
    template = {
        "messaging_product": "whatsapp", "to": to, "type": "template",
        "template": {
            "name": os.environ.get("WA_TEMPLATE", "").strip() or "daily_lottery_results",
            "language": {"code": os.environ.get("WA_LANG", "en")},
            "components": [
                {"type": "header", "parameters": [{"type": "document", "document": doc}]},
                {"type": "body", "parameters": [{"type": "text", "text": label}]},
            ],
        },
    }
    r = requests.post(f"{base}/messages", headers=auth, json=template, timeout=60)
    print("WhatsApp template:", r.status_code, r.text[:300])
    if r.status_code != 200:   # fallback: only works if the contact messaged the number in the last 24h
        free = {"messaging_product": "whatsapp", "to": to, "type": "document",
                "document": {**doc, "caption": f"Lottery results {label}"}}
        r = requests.post(f"{base}/messages", headers=auth, json=free, timeout=60)
        print("WhatsApp free-form:", r.status_code, r.text[:300])


def send_telegram(pdf, label):
    import requests

    tok, chat = os.environ.get("TELEGRAM_TOKEN", "").strip(), os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if not (tok and chat):
        return
    r = requests.post(f"https://api.telegram.org/bot{tok}/sendDocument", timeout=60,
                      data={"chat_id": chat, "caption": f"Lottery results {label}"},
                      files={"document": (pdf.name, pdf.read_bytes(), "application/pdf")})
    print("Telegram:", r.status_code)


def main():
    w = wanted()
    if not w:
        return
    target, backfill = w
    print("Looking for results dated", target)
    img = fetch_image(target)
    if img is None:
        print("Not published yet (or not reachable). Will try again at the next run.")
        return
    pdf = publish(img, target)
    print("Saved", pdf)
    if not backfill:
        send_whatsapp(pdf, str(target))
        send_telegram(pdf, str(target))


if __name__ == "__main__":
    if "--precheck" in sys.argv:
        precheck()
    else:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        main()
