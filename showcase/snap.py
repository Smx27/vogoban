import asyncio
import os
from playwright.async_api import async_playwright

KEY_FRAMES = [
    (3.5, "act1-monolith.png"),
    (11.5, "act2-roslyn-terminal.png"),
    (21.0, "act3-architecture-canvas.png"),
    (32.0, "act4-inspector-trace.png"),
    (42.0, "act5-sovereign-shield.png"),
    (50.0, "act6-multi-stack-pillars.png"),
    (57.5, "act7-brand-finale.png")
]

async def snap_frames():
    os.makedirs("showcase/snapshots", exist_ok=True)
    html_path = os.path.abspath("showcase/index.html")
    file_url = f"file://{html_path}?clean=1"

    async with async_playwright() as p:
        browser = await p.chromium.launch(args=["--allow-file-access-from-files"])
        context = await browser.new_context(viewport={"width": 1920, "height": 1080})
        page = await context.new_page()

        print(f"Navigating to {file_url}...")
        await page.goto(file_url, wait_until="networkidle")

        # Wait until SHOWCASE is ready
        await page.wait_for_function("() => window.SHOWCASE && window.SHOWCASE.ready")

        for t, filename in KEY_FRAMES:
            print(f"Seeking to t={t}s...")
            await page.evaluate(f"window.SHOWCASE.seek({t})")
            await asyncio.sleep(0.3)
            out_path = os.path.join("showcase/snapshots", filename)
            await page.screenshot(path=out_path)
            print(f"Saved snapshot to {out_path}")

        await browser.close()

if __name__ == "__main__":
    asyncio.run(snap_frames())
