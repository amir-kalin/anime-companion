"""End-to-end streaming latency test through the Vite proxy.

Measures what the user actually waits for: time to first token, time to the
first complete sentence (which is when speech can start), and total time.
"""
import json
import sys
import time
import urllib.request

URL = "http://127.0.0.1:5180/api/chat"
SYSTEM = (
    "You are Mika, a warm and playful anime companion. Reply in one or two short "
    "sentences, because your replies are spoken aloud. Never use markdown, emoji "
    "or code blocks."
)


def turn(question, timeout=180):
    payload = json.dumps({"message": question, "system": SYSTEM, "stream": True}).encode()
    req = urllib.request.Request(
        URL, data=payload, headers={"Content-Type": "application/json"}, method="POST"
    )
    t0 = time.time()
    first_token = None
    first_sentence = None
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
            if first_token is None:
                first_token = time.time() - t0
            full += d
            if first_sentence is None:
                import re
                if re.search(r"[.!?](\s|$)", full):
                    first_sentence = time.time() - t0
    total = time.time() - t0
    return first_token, first_sentence, total, full.strip()


for q in sys.argv[1:] or [
    "Hi Mika! What can you do?",
    "Tell me something nice about yourself.",
]:
    print(f"=== {q}")
    try:
        ft, fs, tot, text = turn(q)
        print(f"  first token   : {ft:.2f}s" if ft else "  first token   : n/a")
        print(f"  1st sentence  : {fs:.2f}s" if fs else "  1st sentence  : n/a")
        print(f"  total         : {tot:.2f}s")
        print(f"  reply         : {text}")
    except Exception as e:  # noqa: BLE001
        print(f"  FAILED: {e}")
    print()
