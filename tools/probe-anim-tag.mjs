/**
 * Does the model actually emit the animation tag?
 *
 * Goes through the app's own proxy (`/api/chat` on the dev server) rather than
 * straight to LM Studio, so the request shape, `reasoning_effort: "none"` and
 * the SSE framing are all the real ones.
 *
 *   node tools/probe-anim-tag.mjs
 *   node tools/probe-anim-tag.mjs "kiss me" "are you bored" "sit down"
 */
import { TTS, ANIMATION_CHOICE, ANIM_TAG } from '../src/utils/config.js';

const PORT = process.env.PORT || 5180;
const ENDPOINT = `http://127.0.0.1:${PORT}/api/chat`;
const SYSTEM = `${TTS.system}\n\n${ANIMATION_CHOICE}`;

const inputs = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['kiss me', 'are you bored', 'sit down', 'come here', 'hello', 'i had a bad day'];

/** Read an SSE body into the concatenated `delta` values. */
async function streamOnce(message) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, system: SYSTEM, stream: true, useMemory: false }),
  });
  if (!res.ok) return { text: '', error: `HTTP ${res.status}`, body: await res.text() };

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        text += j.choices?.[0]?.delta?.content ?? '';
      } catch {
        /* partial frame */
      }
    }
  }
  return { text };
}

console.log(`probing ${ENDPOINT}`);
console.log(`model system prompt = TTS.system + ANIMATION_CHOICE (${SYSTEM.length} chars)\n`);

let tagged = 0;
for (const input of inputs) {
  const { text, error, body } = await streamOnce(input);
  if (error) {
    console.log(`  ERROR  "${input}" -> ${error} ${String(body).slice(0, 200)}`);
    continue;
  }
  const m = text.match(ANIM_TAG);
  const got = m ? m[1].toLowerCase() : null;
  if (got) tagged++;
  console.log(`  ${got ? 'TAG ' : 'none'}  "${input}"`);
  console.log(`         got:  ${got ?? '(no tag)'}`);
  console.log(`         raw:  ${JSON.stringify(text.slice(0, 120))}`);
}

console.log(`\n${tagged}/${inputs.length} replies carried a tag`);