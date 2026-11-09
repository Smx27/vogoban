import asyncio
import os
import subprocess
import edge_tts

# Act timeline (total 60 seconds):
# Act 1 (00:00 - 00:08): Monolith Chaos & Architecture friction
# Act 2 (00:08 - 00:16): Roslyn C# AST Analysis
# Act 3 (00:16 - 00:26): Dynamic Architecture Graph
# Act 4 (00:26 - 00:36): Deep Inspector & Bicep IaC Linage
# Act 5 (00:36 - 00:45): Sovereign Shield & SQLite Local Performance
# Act 6 (00:45 - 00:52): Multi-Stack Ecosystem (.NET, React, Azure)
# Act 7 (00:52 - 00:60): Brand Finale & CLI CTA

VOICE = "en-US-ChristopherNeural"

SEGMENTS = [
    {
        "id": "act1",
        "start_sec": 0.5,
        "text": "Every enterprise codebase evolves into an unmapped monolith. Hidden dependencies, silent regressions, and broken microservices."
    },
    {
        "id": "act2",
        "start_sec": 8.5,
        "text": "Meet Vogoban. Powered by Roslyn semantic intelligence, Vogoban parses your C-sharp source trees, method calls, and endpoints with compiler-grade precision."
    },
    {
        "id": "act3",
        "start_sec": 17.0,
        "text": "Explore an interactive architecture canvas. Visualize downstream blast radius, inspect live message flows, and navigate your software topology in real time."
    },
    {
        "id": "act4",
        "start_sec": 26.5,
        "text": "Unify code and cloud. Vogoban connects ASP.NET controllers to Azure Service Bus and Bicep infrastructure with verifiable, evidence-backed proof."
    },
    {
        "id": "act5",
        "start_sec": 36.5,
        "text": "Zero telemetry. Zero cloud leakage. All evidence is indexed into a local, sovereign SQLite engine in under three seconds."
    },
    {
        "id": "act6",
        "start_sec": 45.5,
        "text": "From Dot-NET solutions and React frontends to serverless Azure Functions. Complete visibility across your entire modern stack."
    },
    {
        "id": "act7",
        "start_sec": 52.5,
        "text": "Vogoban. Sovereign codebase intelligence. Run Vogoban graph today."
    }
]

async def generate_speech():
    os.makedirs("showcase/audio", exist_ok=True)

    # Generate each segment
    for seg in SEGMENTS:
        output_file = f"showcase/audio/{seg['id']}.mp3"
        print(f"Generating TTS for {seg['id']}...")
        communicate = edge_tts.Communicate(seg["text"], VOICE, rate="+4%")
        await communicate.save(output_file)

        # Check duration with ffprobe
        res = subprocess.run([
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", output_file
        ], capture_output=True, text=True)
        dur = float(res.stdout.strip())
        print(f"  Duration: {dur:.2f}s (target start: {seg['start_sec']}s)")

    # Build FFmpeg command to mix segments at precise timestamps onto a 60-second silent base
    # inputs:
    # 0: 60s silence
    # 1..7: segment audio files
    filter_complex = ["[0:a]"]
    inputs = ["-f", "lavfi", "-t", "60", "-i", "anullsrc=r=48000:cl=stereo"]

    for i, seg in enumerate(SEGMENTS):
        idx = i + 1
        inputs.extend(["-i", f"showcase/audio/{seg['id']}.mp3"])
        delay_ms = int(seg["start_sec"] * 1000)
        filter_complex.append(f"[{idx}:a]adelay={delay_ms}|{delay_ms},volume=1.2[a{idx}];")

    # Mix all inputs
    mix_inputs = "".join(f"[a{i+1}]" for i in range(len(SEGMENTS)))
    filter_str = "".join(filter_complex[1:]) + f"[0:a]{mix_inputs}amix=inputs={len(SEGMENTS)+1}:duration=first:dropout_transition=2[outa]"

    master_audio = "showcase/audio/narration.mp3"
    cmd = ["ffmpeg", "-y"] + inputs + [
        "-filter_complex", filter_str,
        "-map", "[outa]",
        "-c:a", "libmp3lame",
        "-b:a", "192k",
        master_audio
    ]

    print("Mixing final narration track...")
    subprocess.run(cmd, check=True)
    print(f"Master audio saved to {master_audio}")

if __name__ == "__main__":
    asyncio.run(generate_speech())
