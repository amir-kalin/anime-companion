"""
Local voice service: TTS (Piper) + STT (faster-whisper), loopback only.

    python voice/local_voice.py --port 4123

Endpoints
    GET  /health          -> {"ok":true,"tts":true,"stt":true,"stt_device":"cuda"}
    POST /tts  {"text":}   -> audio/wav bytes
    POST /stt  raw wav     -> {"text": "..."}

Design notes
- Models load once at startup so the first request is not 10x slower.
- STT prefers ctranslate2's CUDA. Note that `torch` being a CPU-only build is
  irrelevant here: faster-whisper uses ctranslate2 for GPU inference, not torch.
- Every route is bound to 127.0.0.1; the service is not exposed to the network.
"""
import argparse
import io
import wave
from pathlib import Path

import numpy as np
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

app = FastAPI(title="local-voice", docs_url=None, redoc_url=None)

PIPER = None
WHISPER = None
STT_MODEL = "base.en"
STT_DEVICE = "cpu"
STT_COMPUTE = "int8"
TTS_VOICE_PATH = None
# Which engine /tts actually speaks through. "kitten" only once a cloned
# reference is present; otherwise Piper, which is instant on CPU.
TTS_ENGINE = "piper"
KITTEN = None
KITTEN_REFERENCE = None


class TtsIn(BaseModel):
    text: str
    # Piper length_scale: 1.0 normal, >1 slower, <1 faster. Driven by the
    # emotional stage direction in the model's reply, so her delivery varies
    # instead of every line having identical pacing.
    speed: float | None = None


def load_kitten(reference: str):
    """
    Load KittenTTS with a cloned reference voice.

    KittenTTS clones a speaker from 5-30s of a single voice, no fine-tuning.
    Only `kitten-tts-2` supports it - the nano/micro/mini builds have no
    cloning path - so this pulls the 1.7B / 506 MiB model.

    This is a 1.7B model on CPU, so it is markedly slower than Piper. It is
    loaded lazily and only when a reference exists, and Piper stays loaded as
    the fallback so a failure here cannot leave her mute.
    """
    from kittenml import KittenTTS

    m = KittenTTS("KittenML/kitten-tts-2")
    return m


def kitten_to_wav(model, text: str, reference: str, reference_text: str | None = None) -> bytes:
    """Synthesise `text` in the cloned voice and return WAV bytes."""
    import io as _io

    import numpy as np
    import soundfile as sf

    kwargs = {"reference": reference}
    # The transcript is part of the prompt; supplying it skips the Whisper pass,
    # which is the single biggest chunk of latency on a cloned generation.
    if reference_text:
        kwargs["reference_text"] = reference_text
    audio = model.generate(text, **kwargs)

    arr = np.asarray(audio, dtype="float32")
    if arr.ndim > 1:
        arr = arr.reshape(-1)
    buf = _io.BytesIO()
    sf.write(buf, arr, 24000, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def resolve_voice_reference():
    """
    Find a reference clip to clone from.

    Returns (path, transcript) or (None, None). The transcript is optional -
    KittenTTS runs Whisper over the clip when it is absent - but providing it
    removes that pass entirely.
    """
    for name in ("jinx.wav", "reference.wav", "voice.wav"):
        p = Path(__file__).resolve().parent / "reference" / name
        if p.is_file():
            txt = p.with_suffix(".txt")
            return str(p), (txt.read_text(encoding="utf-8").strip() if txt.is_file() else None)
    return None, None


def pick_default_voice() -> str | None:
    """
    Choose the best Piper voice available locally.

    Preference order is deliberate. `en_US-lessac-medium` is Piper's LOWEST
    tier and sounds like it; the voices below are the same size and run at the
    same speed but are audibly more natural, so a drop-in replacement gets a
    large quality win for free. `high` models are slower to synthesise, so they
    come after `medium`.
    """
    here = Path(__file__).resolve().parent
    candidates = [
        here / "voices" / "en_US-amy-medium.onnx",
        here / "voices" / "en_US-ryan-high.onnx",
        here / "voices" / "en_US-lessac-medium.onnx",
        Path.home() / "Downloads" / "en_US-lessac-medium.onnx",
    ]
    for c in candidates:
        if c.is_file():
            return str(c)
    return None


def load_piper(path: str, threads: int = 4):
    """
    Piper 1.7 yields AudioChunks; write them into one WAV buffer.

    The ORT session is rebuilt with an explicit thread count because Piper leaves
    it on the ONNX default. Measured on this machine (Core 7 240H, 10c/16t):
    default = 108.8 ms/frame, 4 threads = 32.4 ms/frame, i.e. 3.4x faster.
    Going wider makes it *worse* (6 -> 64.8, 16 -> 186.2 ms/frame) because the
    hybrid P+E cores oversubscribe.
    """
    import onnxruntime as ort
    from piper import PiperVoice

    voice = PiperVoice.load(path)

    try:
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
        voice.session = ort.InferenceSession(
            path, so, providers=["CPUExecutionProvider"]
        )
        print(f"[voice] piper session rebuilt with {threads} threads", flush=True)
    except Exception as e:  # noqa: BLE001 - keep going on the default session
        print(f"[voice] could not set piper threads ({e})", flush=True)

    def synth(text: str, length_scale: float | None = None) -> bytes:
        sr = voice.config.sample_rate if hasattr(voice, "config") else 22050
        buf = io.BytesIO()
        wrote = False
        kwargs = {}
        if length_scale:
            try:
                from piper import SynthesisConfig

                kwargs["syn_config"] = SynthesisConfig(length_scale=length_scale)
            except Exception as e:  # noqa: BLE001 - fall back to the default rate
                print(f"[voice] speed unsupported ({e}); using 1.0", flush=True)
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sr)
            for chunk in voice.synthesize(text, **kwargs):
                pcm = getattr(chunk, "audio_int16_array", None)
                if pcm is None:
                    raw = getattr(chunk, "audio_int16_bytes", None)
                    if raw is None and isinstance(chunk, (bytes, bytearray)):
                        raw = chunk
                    if raw is None:
                        continue
                    wf.writeframes(raw)
                    wrote = True
                else:
                    wf.writeframes(np.asarray(pcm, dtype=np.int16).tobytes())
                    wrote = True
        data = buf.getvalue()
        return data if wrote and len(data) > 100 else b""

    return synth


def load_whisper(model_name: str, device: str = "auto"):
    """
    Load faster-whisper.

    `faster-whisper` does NOT use torch for inference - it uses ctranslate2, so
    a CPU-only torch build is irrelevant and CUDA can still work.

    On a small GPU that is already occupied by the LLM, though, the two
    compete for VRAM and CUDA initialisation can stall for a very long time. So
    `device` is configurable, and the default is CPU int8: transcription of a
    short dictation is fast enough there and it leaves the whole GPU to the
    model, which is where the latency that the user actually notices comes from.
    """
    from faster_whisper import WhisperModel

    global STT_DEVICE, STT_COMPUTE

    if device == "auto":
        try:
            import ctranslate2

            device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
        except Exception:  # noqa: BLE001
            device = "cpu"

    if device == "cuda":
        try:
            model = WhisperModel(model_name, device="cuda", compute_type="float16")
            STT_DEVICE, STT_COMPUTE = "cuda", "float16"
            return model
        except Exception as e:  # noqa: BLE001
            print(f"[voice] CUDA init failed ({e}); falling back to CPU int8", flush=True)

    # Measured on this machine (Core 7 240H, CPU int8, ~2.8s of clean speech):
    #   tiny.en 1.72x realtime | base.en 0.92x | small.en 0.33x
    # All three hit 9/9 words on clean audio, but real mic audio with noise and
    # accents separates them, so base.en is the default balance. ctranslate2
    # parallelises on its own, so cpu_threads makes almost no difference here
    # (unlike Piper, which was 3.4x thread-starved).
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    STT_DEVICE, STT_COMPUTE = "cpu", "int8"
    return model


@app.get("/health")
def health():
    return {
        "ok": True,
        "tts": PIPER is not None,
        "tts_engine": TTS_ENGINE,
        "stt": WHISPER is not None,
        "stt_device": STT_DEVICE,
        "stt_model": STT_MODEL,
    }


@app.post("/tts")
def tts(inp: TtsIn):
    text = (inp.text or "").strip()[:2000]
    if not text:
        return JSONResponse({"error": "empty text"}, status_code=400)
    speed = inp.speed
    if speed is not None:
        # Clamp defensively: an extreme length_scale is very slow and sounds
        # broken, and this value comes from model-generated text.
        speed = max(0.7, min(1.4, float(speed)))

    # Cloned voice, when a reference clip has been supplied. Any failure falls
    # through to Piper rather than returning a 500: a companion with a generic
    # voice is far better than a mute one.
    if TTS_ENGINE == "kitten" and KITTEN is not None and KITTEN_REFERENCE:
        try:
            ref, ref_text = KITTEN_REFERENCE
            wav = kitten_to_wav(KITTEN, text, ref, ref_text)
            if wav:
                return Response(content=wav, media_type="audio/wav")
        except Exception as e:  # noqa: BLE001
            print(f"[voice] kitten failed, falling back to piper: {e}", flush=True)

    if PIPER is None:
        return JSONResponse({"error": "TTS not loaded"}, status_code=503)
    try:
        wav = PIPER(text, length_scale=speed)
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": f"tts failed: {e}"}, status_code=500)
    if not wav:
        return JSONResponse({"error": "tts produced no audio"}, status_code=500)
    return Response(content=wav, media_type="audio/wav")


@app.post("/stt")
async def stt(request: Request):
    """
    NOTE: the transcription itself MUST run in a threadpool.

    faster-whisper is a blocking, synchronous library. Calling it directly from
    an `async def` route blocks the event loop, which freezes every other
    endpoint (including /health) for the whole duration of the transcription.
    """
    if WHISPER is None:
        return JSONResponse({"error": "STT not loaded"}, status_code=503)
    body = await request.body()
    if len(body) < 500:
        return {"text": ""}
    try:
        text = await run_in_threadpool(_transcribe, body)
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": f"stt failed: {e}"}, status_code=500)
    return {"text": text}


def _transcribe(pcm: bytes) -> str:
    segments, _ = WHISPER.transcribe(
        io.BytesIO(pcm), language="en", vad_filter=True, beam_size=1
    )
    return " ".join(s.text for s in segments).strip()


def main():
    import uvicorn

    # Must precede any use of these names in this function. Without this the
    # assignments below create *local* variables and the routes keep seeing
    # None, so /health reports "tts": false and /tts returns 503.
    global TTS_VOICE_PATH, STT_MODEL, PIPER, WHISPER

    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=4123)
    ap.add_argument(
        "--voice",
        default=None,
        help="Piper .onnx voice. Defaults to the best bundled voice that exists.",
    )
    ap.add_argument(
        "--stt-model",
        default=STT_MODEL,
    )
    ap.add_argument(
        "--stt-device",
        default="cpu",
        choices=["cpu", "cuda", "auto"],
        help="cpu (default) leaves the GPU to the LLM; cuda is faster but competes for VRAM",
    )
    ap.add_argument("--tts-threads", type=int, default=4)
    ap.add_argument("--no-stt", action="store_true", help="skip whisper for a faster start")
    ap.add_argument("--no-kitten", action="store_true", help="skip the cloned-voice engine; Piper only")
    args = ap.parse_args()

    TTS_VOICE_PATH = args.voice
    STT_MODEL = args.stt_model

    voice_path = args.voice or pick_default_voice()
    if not voice_path:
        print("[voice] FATAL: no Piper voice found", flush=True)
        raise SystemExit(1)
    TTS_VOICE_PATH = voice_path

    print(f"[voice] loading TTS: {voice_path}", flush=True)
    PIPER = load_piper(voice_path, threads=args.tts_threads)
    print("[voice] TTS ready", flush=True)

    # Cloned voice. Only attempted when a reference clip exists, and a failure
    # here is never fatal - Piper is already loaded and stays the fallback.
    if not args.no_kitten:
        try:
            global TTS_ENGINE, KITTEN, KITTEN_REFERENCE
            ref, ref_text = resolve_voice_reference()
            if ref:
                print(f"[voice] cloning a voice from {ref}", flush=True)
                KITTEN_REFERENCE = (ref, ref_text)
                KITTEN = load_kitten(ref)
                TTS_ENGINE = "kitten"
                print("[voice] cloned voice ready (kitten-tts-2)", flush=True)
            else:
                print("[voice] no reference clip; using piper", flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"[voice] kitten unavailable ({e}); using piper", flush=True)

    if not args.no_stt:
        print(f"[voice] loading STT: {STT_MODEL} on {args.stt_device}", flush=True)
        WHISPER = load_whisper(STT_MODEL, device=args.stt_device)
        print(f"[voice] STT ready on {STT_DEVICE} ({STT_COMPUTE})", flush=True)

    print(f"[voice] listening on http://127.0.0.1:{args.port}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
