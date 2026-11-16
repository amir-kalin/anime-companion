"""STT round-trip test.

Synthesises a known sentence with Piper, then feeds that WAV straight into the
faster-whisper endpoint. Whisper is far more accurate on clean synthetic speech
than on real mic audio, so a clean transcript here proves the whole path
(capture format, resampling, 16kHz mono PCM16, transcription) is wired correctly
rather than merely reachable.
"""
import io
import json
import time
import urllib.request
import wave

VOICE = "http://127.0.0.1:4123"
PHRASE = "Hello Mika, can you hear me clearly right now?"

print(f"saying: {PHRASE!r}\n")

body = json.dumps({"text": PHRASE}).encode()
req = urllib.request.Request(
    f"{VOICE}/tts", data=body, headers={"Content-Type": "application/json"}, method="POST"
)
t0 = time.time()
with urllib.request.urlopen(req, timeout=120) as r:
    audio = r.read()
synth_s = time.time() - t0

with wave.open(io.BytesIO(audio), "rb") as wf:
    sr = wf.getframerate()
    dur = len(audio) / (sr * 2)

print(f"TTS  : {len(audio)} bytes, {dur:.2f}s audio @ {sr}Hz, synthesised in {synth_s:.2f}s "
      f"({dur / synth_s:.2f}x realtime)")

# Resample to 16k mono PCM16 exactly as the browser does, so the test exercises
# the same path a real recording takes.
target = 16000
with wave.open(io.BytesIO(audio), "rb") as wf:
    frames = wf.readframes(wf.getnframes())
import array

samples = array.array("h", frames)
ratio = sr / target
out_n = int(len(samples) / ratio)
resampled = array.array("h", [int(samples[int(i * ratio)]) for i in range(out_n)])
buf = io.BytesIO()
with wave.open(buf, "wb") as wf:
    wf.setnchannels(1)
    wf.setsampwidth(2)
    wf.setframerate(target)
    wf.writeframes(resampled.tobytes())
pcm16 = buf.getvalue()

print(f"STT  : sending {len(pcm16)} bytes ({len(pcm16)/(target*2):.2f}s @ 16kHz)")
t0 = time.time()
req = urllib.request.Request(
    f"{VOICE}/stt", data=pcm16, headers={"Content-Type": "audio/wav"}, method="POST"
)
with urllib.request.urlopen(req, timeout=180) as r:
    out = json.loads(r.read())
stt_s = time.time() - t0

print(f"      transcribed in {stt_s:.2f}s ({len(pcm16)/(target*2)/stt_s:.1f}x realtime)")
print(f"      heard: {out.get('text','')!r}")

heard = (out.get("text") or "").lower().strip(" .!?")
words = set(heard.split())
expected = set(PHRASE.lower().replace("?", "").split())
missing = expected - words
print(f"\n  word recall: {len(expected & words)}/{len(expected)}")
if missing:
    print(f"  missed     : {sorted(missing)}")
print("  RESULT     :", "PASS" if not missing else "PARTIAL")
