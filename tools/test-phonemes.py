"""
How does Piper phonemise interjections?

The complaint is that "Mm" is spoken as the letters "M M". Piper goes through
espeak for grapheme-to-phoneme, and espeak treats a short capitalised run like
an initialism. This dumps the phonemes for several spellings so the fix can be
picked from evidence rather than guessed.
"""
import sys

from piper import PiperVoice

voice = PiperVoice.load(r"voice\voices\en_US-amy-medium.onnx")

CASES = [
    "Mm. Say that again.",
    "Mmm. Say that again.",
    "Hmm. Say that again.",
    "Mmm hmm. Say that again.",
    "Mm, yes.",
    "Mhm. Okay.",
    "Um. Sure.",
    "Ah, I see.",
    "Oh. Really?",
    "Mm...",
]

phonemizer = None
for attr in ("phonemize", "Phonemizer"):
    if hasattr(voice, attr):
        phonemizer = getattr(voice, attr)
        break

out = open("voice/phonemes.txt", "w", encoding="utf-8")
out.write(f"phonemizer: {type(phonemizer).__name__}\n")
out.write(f"phoneme_type: {getattr(getattr(voice, 'config', None), 'phoneme_type', '?')}\n\n")

for text in CASES:
    try:
        ph = phonemizer(text)
    except Exception as e:  # noqa: BLE001
        ph = f"<err {e}>"
    if not isinstance(ph, str):
        ph = repr(ph)
    out.write(f"{text!r:34s} -> {ph}\n")

out.close()
print("wrote voice/phonemes.txt")

# Letter-spelling is the tell: espeak emits a sequence of individual letter
# phonemes (or a long 'm' with stress markers) rather than a nasal vowel.
print()
print("look for: a bare run of m-like phonemes = spelled out letters")
