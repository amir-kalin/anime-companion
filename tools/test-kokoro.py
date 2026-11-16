"""
Does Kokoro actually work here?

Installed via uv into a Python 3.12 venv (the system Python is 3.14, which has
no wheels for this dependency stack). Kokoro also needs a G2P backend for
English; if espeak-ng is missing it should fall back, but the fallback is where
Windows installs usually break, so it is tested rather than assumed.

Run:  voice\\.venv-kokoro\\Scripts\\python.exe tools/test-kokoro.py
"""
import io
import sys
import time
import wave

PHASES = [
    ("af_heart", "Oh! You pet me? That feels wonderful."),
    ("af_bella", "Hi there! I like it when you stroke my hair."),
    ("am_michael", "Hey. Noted."),
]

try:
    import torch
    from kokoro import KPipeline
except Exception as e:  # noqa: BLE001
    print(f"IMPORT FAILED: {e}")
    sys.exit(1)

print(f"torch {torch.__version__}  threads={torch.get_num_threads()}")
print(f"device: cpu\n")

pipeline = KPipeline(lang_code="a")  # American English

ok = 0
for voice, text in PHASES:
    t0 = time.time()
    try:
        chunks = list(pipeline(text, voice=voice, speed=1.0))
    except Exception as e:  # noqa: BLE001
        print(f"  {voice:12s} FAILED: {type(e).__name__}: {e}")
        continue
    if not chunks:
        print(f"  {voice:12s} no audio produced")
        continue

    # Kokoro yields float32 torch tensors at 24kHz, so they must be scaled to
    # int16 PCM before they can go into a WAV container.
    import numpy as np

    pcm = []
    for c in chunks:
        a = getattr(c, "audio", None)
        if a is None:
            continue
        arr = a.detach().cpu().numpy() if hasattr(a, "detach") else np.asarray(a)
        pcm.append((np.clip(arr, -1.0, 1.0) * 32767).astype(np.int16))

    if not pcm:
        print(f"  {voice:12s} empty audio")
        continue
    audio = np.concatenate(pcm).tobytes()
    sr = 24000
    with wave.open(io.BytesIO(audio), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(audio)
    dur = len(audio) / (sr * 2)
    el = time.time() - t0
    ok += 1
    print(
        f"  {voice:12s} {dur:5.2f}s audio in {el:5.2f}s  "
        f"({dur/el:5.1f}x realtime)  first_chunk_in="
        f"{getattr(chunks[0], 'tts_time', '?')}"
    )

print(f"\n{ok}/{len(PHASES)} voices synthesised")
if ok == 0:
    print("Kokoro is not usable here; stick with Piper.")
    sys.exit(1)
print("Kokoro works.")
