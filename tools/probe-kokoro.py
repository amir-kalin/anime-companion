"""Minimal Kokoro probe: isolate exactly where it fails, with a real traceback."""
import sys
import traceback

print("python:", sys.version.split()[0], flush=True)

try:
    import torch
    print("torch:", torch.__version__, flush=True)
    import kokoro
    print("kokoro:", getattr(kokoro, "__version__", "?"), flush=True)
    import misaki
    print("misaki: ok", flush=True)
except Exception:
    traceback.print_exc()
    sys.exit(1)

# Which G2P backends can actually be constructed?
for name, fn in [
    ("EspeakG2P", lambda: __import__("misaki.en", fromlist=["EspeakG2P"]).EspeakG2P),
]:
    try:
        g = fn()
        print(f"{name}: constructed ok", flush=True)
        try:
            print(f"{name} phonemize test: {g('hello world')!r}"[:200], flush=True)
        except Exception:
            print(f"{name} phonemize FAILED:", flush=True)
            traceback.print_exc()
    except Exception:
        print(f"{name} import/construct FAILED:", flush=True)
        traceback.print_exc()

from kokoro import KPipeline

try:
    pipe = KPipeline(lang_code="a")
    print("pipeline constructed", flush=True)
except Exception:
    print("pipeline construction FAILED:", flush=True)
    traceback.print_exc()
    sys.exit(1)

try:
    chunks = list(pipe("Hello there.", voice="af_heart", speed=1.0))
    # `c.audio` is a torch tensor, so test it against None rather than for
    # truthiness - `if tensor` raises for multi-element tensors.
    total = sum(
        c.audio.numel() for c in chunks if getattr(c, "audio", None) is not None
    )
    print(f"synthesis ok: {len(chunks)} chunks, {total} samples", flush=True)
except Exception:
    print("SYNTHESIS FAILED:", flush=True)
    traceback.print_exc()
    sys.exit(1)
