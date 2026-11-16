/**
 * Which examples is she copying, and how much is run-to-run noise?
 *
 * The prompt change cut word count and purple prose, but she started reciting
 * the few-shot examples verbatim ("He's doing it again? Document everything.
 * I'll be annoyed with him for you." is the example, word for word). Two
 * questions decide what to do next:
 *
 *   1. Is the copying caused by a specific example, or by having examples at
 *      all? -> re-run the same inputs with EXAMPLES=off.
 *   2. How much does any single run tell us? -> the model is sampled at
 *      temperature 0.9, so one run is a sample, not a measurement.
 *
 *   node tools/probe-copying.mjs [runs]
 */
import { TTS, ANIMATION_CHOICE } from '../src/utils/config.js';

const PORT = process.env.PORT || 5180;
const ENDPOINT = `http://127.0.0.1:${PORT}/api/chat`;
const RUNS = Number(process.argv[2] || 3);

/** Split the persona prompt so the EXAMPLES block can be dropped. */
function withoutExamples(system) {
  const cut = system.indexOf('EXAMPLES of the register');
  if (cut < 0) return system;
  return system.slice(0, cut).trimEnd() + '\n';
}

const INPUTS = [
  'i had a really bad day',
  'what should i do about my boss',
  'are you an ai?',
  'i miss you',
  'hey',
  "i'm so tired",
  'thank you',
];

// Normalised n-grams from each example's reply, to detect verbatim reuse.
// Updated to the "direction not script" phrasing, and kept at the old wording
// too so a regression back to literal transcripts is still detected.
const EXAMPLE_LINES = [
  'hey sit down for a sec',
  'was it the meeting',
  'mm say that again',
  "he's doing it again document everything",
  "ha don't be silly i'm right here",
  "then sleep i'm not going anywhere",
  "don't thank me yet",
  'nothing absolutely nothing is that so hard',
  'ask what happened then be there',
  'ask them to say it again thats the whole reply',
  'something short and warm or nothing at all',
  'deflect it dryly youre right here',
];

async function ask(q, system) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: q, system, stream: false, useMemory: false }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return String(j.text || '').replace(/[\[*]{1,2}\s*anim\s*:\s*[a-z0-9_]+\s*[\]*]{1,2}/i, '').trim();
}

function copyScore(text) {
  const flat = text.toLowerCase().replace(/[*()[]]/g, ' ').replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const hits = EXAMPLE_LINES.filter((line) => {
    // A copy counts if most of an example's distinctive phrase survives.
    const words = line.split(' ');
    let run = 0, best = 0;
    for (const w of words) {
      if (flat.includes(w)) { run++; best = Math.max(best, run); } else run = 0;
    }
    return best >= 4 && words.length >= 4;
  });
  return hits;
}

async function sweep(label, system) {
  let copied = 0, total = 0, words = 0;
  const examples = [];
  for (let r = 0; r < RUNS; r++) {
    for (const q of INPUTS) {
      let text;
      try { text = await ask(q, system); } catch { continue; }
      total++;
      words += text.split(/\s+/).filter(Boolean).length;
      const hits = copyScore(text);
      if (hits.length) { copied++; examples.push(`"${q}" -> ${hits.join(' | ')}`); }
    }
  }
  console.log(`\n${label}`);
  console.log(`  replies        : ${total}`);
  console.log(`  copied example : ${copied}/${total} (${((copied / total) * 100).toFixed(0)}%)`);
  console.log(`  avg words      : ${(words / (total || 1)).toFixed(1)}`);
  for (const e of examples.slice(0, 5)) console.log(`    ${e}`);
  return { copied, total };
}

const withEx = `${TTS.system}\n\n${ANIMATION_CHOICE}`;
const noEx = `${withoutExamples(TTS.system)}\n\n${ANIMATION_CHOICE}`;

console.log(`probing ${ENDPOINT} — ${RUNS} run(s) x ${INPUTS.length} inputs, two prompt variants\n`);
const a = await sweep('WITH examples (current prompt)', withEx);
const b = await sweep('WITHOUT examples (rules only)', noEx);

console.log('\n================================================');
const rateA = (a.copied / (a.total || 1)) * 100;
const rateB = (b.copied / (b.total || 1)) * 100;
console.log(`copying rate: ${rateA.toFixed(0)}% with examples, ${rateB.toFixed(0)}% without`);
if (rateA - rateB > 15) {
  console.log('=> the examples are causing the copying.');
} else if (Math.abs(rateA - rateB) <= 15) {
  console.log('=> no clear difference; the copying is model behaviour, not the examples.');
}