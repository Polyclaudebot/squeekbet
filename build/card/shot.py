import asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={"width":1200,"height":675})
        await pg.goto("file:///w/card.html"); await pg.wait_for_timeout(800)
        await pg.screenshot(path="/w/card.png")
        await b.close()
asyncio.run(main())
