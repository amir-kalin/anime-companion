"""
Streaming latency for whatever model .env points at.

Measures what the user actually waits for: time to first token, time to the
first complete sentence (speech can start there), and total. Runs a warmup
first, because a first inference on a freshly loaded model includes load time
and would make the numbers meaningless.
"""
import json
import re
import sys
import time
import urllib.request

URL = "http://127.0.0.1:5180/api/chat"

# NOTE: this used to inline a copy of the persona prompt, which silently drifted
# from src/utils/config.js. It is a latency benchmark, not a persona test, so it
# now asks the app for the real prompt instead of keeping its own.
def load_system() -> str:
    """Fetch the shipped persona prompt so this cannot drift from the app."""
    with urllib.request.urlopen(URL.replace("/api/chat", "/api/persona"), timeout=10) as r:
        return json.loads(r.read())["system"]

SYSTEM = None  # set in main(); see load_system()

try:
    SYSTEM = load_system()
except Exception as _e:  # noqa: BLE001
    print(f"could not fetch the persona prompt from the dev server ({_e}).")
    print("Is it running?  npm run dev")
    raise SystemExit(1)

QUESTIONS = sys.argv[1:] or [
    "hey",
    "i had a really bad day at work",
    "i miss you",
    "are you an AI?",
]


def turn(q, timeout=300):
    payload = json.dumps({"message": q, "system": SYSTEM, "stream": True}).encode()
    req = urllib.request.Request(
        URL, data=payload, headers={"Content-Type": "application/json"}, method="POST"
    )
    t0 = time.time()
    first_tok = None
    first_sent = None
    full = ""
    with urllib.request.urlopen(req, timeout=timeout) as r:
        for raw in r:
            line = raw.decode("utf-8", "ignore").strip()
            if not line.startswith("data:"):
                continue
            p = line[5:].strip()
            if not p or p == "[DONE]":
                continue
            try:
                d = json.loads(p)["choices"][0]["delta"].get("content")
            except Exception:
                continue
            if not d:
                continue
            if first_tok is None:
                first_tok = time.time() - t0
            full += d
            if first_sent is None and re.search(r"[.!?](\s|$)", full):
                first_sent = time.time() - t0
    return first_tok, first_sent, time.time() - t0, full.strip()


print("warming up...", flush=True)
try:
    turn("hi")
except Exception as e:  # noqa: BLE001
    print(f"warmup failed: {e}")
print(flush=True)

toks, sents, totals = [], [], []
for q in QUESTIONS:
    try:
        ft, fs, tot, text = turn(q)
    except Exception as e:  # noqa: BLE001
        print(f"--- {q}\n  FAILED: {e}\n")
        continue
    if ft:
        toks.append(ft)
    if fs:
        sents.append(fs)
    totals.append(tot)
    anim = re.match(r"\s*\[\[anim:(\w+)\]\]", text, re.I)
    print(f"--- {q}")
    print(f"    first token  : {ft:.2f}s" if ft else "    first token  : n/a")
    print(f"    1st sentence : {fs:.2f}s" if fs else "    1st sentence : n/a")
    print(f"    total        : {tot:.2f}s")
    print(f"    anim         : {anim.group(1) if anim else '(none)'}")
    print(f"    reply        : {text[:150]}")
    print()

if totals:
    n = len(totals)
    avg = lambda a: sum(a) / len(a) if a else float("nan")  # noqa: E731
    print(f"avg first token  : {avg(toks):.2f}s")
    print(f"avg 1st sentence : {avg(sents):.2f}s")
    print(f"avg total        : {avg(totals):.2f}s   ({n} turns)")
