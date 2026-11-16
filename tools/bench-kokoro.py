"""
Kokoro steady-state benchmark.

The first measurement of a torch model is dominated by lazy init, so a
single-shot number is meaningless. This warms up, then measures several runs,
and separately reports time-to-first-chunk - which is what actually decides
how fast she starts talking, since speech begins on the first sentence.
"""
import sys
import time

import numpy as np
import torch
from kokoro import KPipeline

TEXT = "Oh! You pet me? That feels wonderful, thank you for that."
VOICE = "af_heart"
SR = 24000

torch.set_num_threads(10)
pipe = KPipeline(lang_code="a")

print(f"torch {torch.__version__}  threads={torch.get_num_threads()}\n")


def synth(text, voice=VOICE):
    chunks = list(pipe(text, voice=voice, speed=1.0))
    pcm = []
    for c in chunks:
        a = getattr(c, "audio", None)
        if a is None:
            continue
        arr = a.detach().cpu().numpy() if hasattr(a, "detach") else np.asarray(a)
        pcm.append((np.clip(arr, -1, 1) * 32767).astype(np.int16))
    if not pcm:
        return np.zeros(0, dtype=np.int16)
    return np.concatenate(pcm)


print("warmup (not timed)...")
synth("warm up the model")
print()

rows = []
for i in range(4):
    t0 = time.time()
    a = synth(TEXT)
    el = time.time() - t0
    dur = len(a) / SR
    rows.append((el, dur))
    print(f"  run {i}: {el:5.2f}s for {dur:5.2f}s audio  ({dur/el:4.2f}x realtime)")

steady = rows[1:]  # drop the first
mean_el = sum(r[0] for r in steady) / len(steady)
mean_dur = sum(r[1] for r in steady) / len(steady)
print(f"\nsteady state: {mean_dur:.2f}s audio in {mean_el:.2f}s = {mean_dur/mean_el:.2f}x realtime")

# Time to first chunk is the latency that matters for perceived responsiveness.
t0 = time.time()
first = None
count = 0
for c in pipe(TEXT, voice=VOICE, speed=1.0):
    if first is None and getattr(c, "audio", None) is not None:
        first = time.time() - t0
    count += 1
print(f"time to first chunk: {first:.2f}s  ({count} chunks total)")
print("\nVERDICT:", "usable" if mean_dur / mean_el >= 0.8 else "too slow on CPU")
