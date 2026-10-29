import asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); page = await b.new_page(viewport={"width": 1440, "height": 900})
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        await page.goto("http://127.0.0.1:8090/", wait_until="networkidle"); await page.wait_for_timeout(4000)
        print("verified:", await page.inner_text("#verified"))
        print("fake warning visible:", await page.is_visible("#fakeWarn"))
        print("create panel visible (no wallet):", await page.is_visible("#createCard"))
        print("deploy button visible:", await page.is_visible("#deployCard"))
        print("markets:", (await page.inner_text("#markets"))[:300].replace("\n", " | "))
        print("js errors:", errs or "none")
        await b.close()
asyncio.run(main())
