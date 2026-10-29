import asyncio, json
from playwright.async_api import async_playwright

SAMPLE = '''
<article class="m" data-state="open"><div class="m-head"><span class="chip open">Betting open · closes in 24m</span><span class="m-id">#2</span></div>
<h3 class="q">Will the hamster mine 120+ blocks?</h3><div class="m-meta">6:30 PM → 7:30 PM · pool 1,250 SQK</div>
<div class="bar"><i style="width:62%"></i></div><div class="sides">
<div class="side-box yes"><div class="side-top"><span>YES</span><b>62%</b></div><div class="side-meta">775 SQK · pays 1.61x</div><div class="side-mine">Your stake: 100 SQK</div></div>
<div class="side-box no"><div class="side-top"><span>NO</span><b>38%</b></div><div class="side-meta">475 SQK · pays 2.63x</div></div></div>
<div class="m-actions"><div class="amt"><input type="number" value="100"><span>SQK</span></div><button class="btn yes">Bet YES</button><button class="btn no">Bet NO</button></div></article>
<article class="m" data-state="settled"><div class="m-head"><span class="chip yes">YES won · 131 blocks mined</span><span class="m-id">#1</span></div>
<h3 class="q">Will the hamster mine 100+ blocks?</h3><div class="m-meta">Mon, Oct 26, 3:00 PM → 4:00 PM · pool 3,400 SQK</div>
<div class="bar"><i style="width:45%"></i></div><div class="sides">
<div class="side-box yes won"><div class="side-top"><span>YES ✓</span><b>45%</b></div><div class="side-meta">1,530 SQK · pays 2.22x</div></div>
<div class="side-box no"><div class="side-top"><span>NO</span><b>55%</b></div><div class="side-meta">1,870 SQK · pays 1.82x</div></div></div>
<div class="m-actions"><button class="btn acc">Claim 222 SQK</button></div></article>'''

async def check(p, w, h, name):
    b = await p.chromium.launch()
    page = await b.new_page(viewport={"width": w, "height": h})
    logs = []
    page.on("console", lambda m: logs.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: logs.append(f"pageerror: {e}"))
    await page.goto("http://127.0.0.1:8090/", wait_until="networkidle", timeout=60000)
    await page.wait_for_timeout(2500)
    await page.evaluate("s => { const m = document.getElementById('markets'); m.innerHTML = s; document.getElementById('createForm').classList.remove('hidden'); }", SAMPLE)
    await page.wait_for_timeout(300)
    r = await page.evaluate("""() => {
      const docW = document.documentElement.scrollWidth, vw = window.innerWidth;
      const over = [...document.querySelectorAll('body *')].filter(e => { const b = e.getBoundingClientRect(); return b.width && (b.right > vw + 1 || b.left < -1); })
        .slice(0, 8).map(e => e.tagName + '.' + (e.className || '') + ' ' + Math.round(e.getBoundingClientRect().right));
      const clipped = [...document.querySelectorAll('.led-stats span, .q, .btn, .chip, .side-meta')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.className + ': ' + e.textContent.trim().slice(0, 30));
      return { docW, vw, hScroll: docW > vw, over, clipped,
        fonts: [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family + ' ' + f.weight).sort(),
        height: document.documentElement.scrollHeight };
    }""")
    await page.screenshot(path=f"{name}.png", full_page=True)
    print(f"== {name} {w}x{h}:", json.dumps(r))
    print("   console:", [l for l in logs if "squeekchain.com" not in l][:8] or "clean", f"(+{sum('squeekchain.com' in l for l in logs)} api-from-VPS errors, expected: Cloudflare blocks the VPS IP)")
    await b.close()

async def main():
    async with async_playwright() as p:
        await check(p, 1440, 900, "desktop")
        await check(p, 390, 844, "mobile")

asyncio.run(main())
