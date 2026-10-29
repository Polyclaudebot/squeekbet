import asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); page = await b.new_page()
        page.on("requestfailed", lambda r: print("FAILED:", r.url, r.failure))
        page.on("response", lambda r: print("HTTP", r.status, r.url) if r.status >= 400 else None)
        await page.goto("http://127.0.0.1:8090/", wait_until="networkidle"); await page.wait_for_timeout(2500)
        print("LED wheel text:", await page.inner_text("#wheel"), "| height:", await page.inner_text("#height"), "| rate:", await page.inner_text("#rate"))
        await b.close()
asyncio.run(main())
