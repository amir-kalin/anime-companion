"""
Whisper CPU benchmark: does it suffer the same thread starvation as Piper?

Piper defaulted to ~1 thread and lost 3.4x. ctranslate2 has its own thread
setting, and `cpu_threads=0` is ambiguous, so measure explicitly and also
compare model sizes - a smaller model may beat a bigger one on a CPU that is
otherwise busy.
"""
import io
import json
import time
import urllib.request
import wave

VOICE = "http://127.0.0.1:4123"
PHRASE = "Hello Mika, can you hear me clearly right now?"

# Make the test WAV once via the running service.
body = json.dumps({"text": PHRASE}).encode()
req = urllib.request.Request(
    f"{VOICE}/tts", data=body, headers={"Content-Type": "application/json"}, method="POST"
)
with urllib.request.urlopen(req, timeout=120) as r:
    audio = r.read()
with wave.open(io.BytesIO(audio), "rb") as wf:
    sr, frames, n = wf.getframerate(), wf.readframes(wf.getnframes()), wf.getnframes()
dur = n / sr
print(f"test clip: {dur:.2f}s @ {sr}Hz\n")

import array

samples = array.array("h", frames)
ratio = sr / 16000
res = array.array("h", [int(samples[int(i * ratio)]) for i in range(int(len(samples) / ratio))])
buf = io.BytesIO()
with wave.open(buf, "wb") as wf:
    wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(16000)
    wf.writeframes(res.tobytes())
pcm = buf.getvalue()

from faster_whisper import WhisperModel

for name in ["tiny.en", "base.en", "small.en"]:
    for threads in [0, 4, 8]:
        t0 = time.time()
        m = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=threads)
        load = time.time() - t0
        t0 = time.time()
        segs, _ = m.transcribe(io.BytesIO(pcm), language="en", vad_filter=True, beam_size=1)
        text = " ".join(s.text for s in segs).strip()
        el = time.time() - t0
        words = set(text.lower().strip(" .!?").split())
        exp = set(PHRASE.lower().replace("?", "").split())
        recall = len(exp & words)
        print(
            f"{name:9s} threads={threads:<2d} "
            f"{el:6.2f}s  ({dur/el:5.2f}x realtime)  load={load:5.1f}s  recall={recall}/{len(exp)}"
        )
        del m
    print()
