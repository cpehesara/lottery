"""
One-time helper: log in to Facebook in a real browser window and save the session
to fetcher/state.json. Paste the content of that file into the GitHub secret
FB_STORAGE_STATE. Never commit state.json (it is in .gitignore).

    python fetcher/save_login.py
"""
from pathlib import Path

from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parent / "state.json"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=False)
    ctx = browser.new_context(viewport={"width": 1200, "height": 900}, locale="en-US")
    page = ctx.new_page()
    page.goto("https://www.facebook.com/lklottery/")
    input("Log in to Facebook in the opened window, wait until the page shows, then press Enter here ... ")
    ctx.storage_state(path=str(OUT))
    browser.close()
print("Saved", OUT)
