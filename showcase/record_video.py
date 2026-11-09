import asyncio
import os
import subprocess
import time
from playwright.async_api import async_playwright

DURATION_SEC = 60.5
TEMP_DIR = "showcase/temp_record"
OUTPUT_MP4 = "showcase/vogoban-showcase.mp4"

async def record_showcase():
    os.makedirs(TEMP_DIR, exist_ok=True)
    html_path = os.path.abspath("showcase/index.html")
    file_url = f"file://{html_path}?clean=1"

    print("Starting Playwright video recording...")
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=[
            "--allow-file-access-from-files",
            "--enable-gpu",
            "--use-gl=angle",
            "--enable-webgl",
            "--ignore-gpu-blocklist"
        ])
        context = await browser.new_context(
            viewport={"width": 1920, "height": 1080},
            record_video_dir=TEMP_DIR,
            record_video_size={"width": 1920, "height": 1080}
        )
        page = await context.new_page()

        print(f"Loading {file_url}...")
        await page.goto(file_url, wait_until="networkidle")
        await page.wait_for_function("() => window.SHOWCASE && window.SHOWCASE.ready")
        await page.evaluate("() => document.fonts.ready")

        # Reset timeline to 0 and play at normal speed
        await page.evaluate("() => { window.SHOWCASE.seek(0); window.SHOWCASE.tl.play(); }")

        print(f"Recording playback for {DURATION_SEC} seconds in real time...")
        start_t = time.time()
        while time.time() - start_t < DURATION_SEC:
            elapsed = time.time() - start_t
            if int(elapsed) % 10 == 0:
                print(f"Recorded {elapsed:.1f}s / {DURATION_SEC}s...")
            await asyncio.sleep(1)

        print("Finishing recording...")
        await page.close()
        video_path = await page.video.path()
        print(f"Raw recorded video at: {video_path}")
        await context.close()
        await browser.close()

        # Now convert/transcode to high-quality MP4 using FFmpeg
        print(f"Transcoding {video_path} to {OUTPUT_MP4} (H.264 / 1920x1080 / 30fps / yuv420p)...")
        ffmpeg_cmd = [
            "ffmpeg",
            "-y",
            "-i", video_path,
            "-t", "60",
            "-r", "30",
            "-vf", "scale=1920:1080",
            "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            "-preset", "medium",
            "-crf", "18",
            OUTPUT_MP4
        ]
        res = subprocess.run(ffmpeg_cmd, capture_output=True, text=True)
        if res.returncode != 0:
            print("FFmpeg error:", res.stderr)
            raise RuntimeError("FFmpeg transcode failed")

        print(f"Transcoding successful! Output saved to {OUTPUT_MP4}")

    # Clean up temp dir
    for f in os.listdir(TEMP_DIR):
        os.remove(os.path.join(TEMP_DIR, f))
    os.rmdir(TEMP_DIR)

if __name__ == "__main__":
    asyncio.run(record_showcase())
