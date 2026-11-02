# Visitor without a wallet, production config (real Sepolia), production CSP.
import sys, time
from playwright.sync_api import sync_playwright
URL = sys.argv[1]
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={"width": 1440, "height": 900})
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.on("console", lambda m: errs.append(m.text) if m.type == "error" and not m.text.startswith("Failed to load resource") and "squeekchain.com" not in m.text else None)
    page.goto(URL, wait_until="domcontentloaded")
    page.wait_for_selector("#markets .m", timeout=30000)
    print("verified:", page.inner_text("#verified"))
    print("tabs:", page.evaluate("[...document.querySelectorAll('.tab')].map(t => t.textContent).join(' | ')"))
    print("cards:", page.eval_on_selector_all("#markets .chip", "e => e.map(x => x.textContent)"))
    page.click('.tab[data-tab="mine"]'); page.wait_for_timeout(200)
    print("my bets (no wallet):", page.inner_text("#markets").replace("\n", " "))
    page.click('.tab[data-tab="open"]'); page.wait_for_timeout(200)
    print("open tab:", page.inner_text("#markets").replace("\n", " "))
    page.set_viewport_size({"width": 390, "height": 844}); page.wait_for_timeout(300)
    print("mobile h-scroll:", page.evaluate("document.documentElement.scrollWidth > innerWidth"))
    print("errors:", errs or "none")
    b.close()
