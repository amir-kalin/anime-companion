/**
 * The two registers, measured separately.
 *
 * She has two jobs now, and they want opposite things from a reply:
 *
 *   AFFECTION  "i miss you"     -> short, warm, one or two sentences
 *   SUBSTANCE  "should I learn python or rust?" -> a concrete answer, however
 *               many sentences that takes
 *
 * Scoring them against one length limit is what made fixing helpfulness look
 * like a regression: avg words went 10 -> 25 when the prompt changed, and it was
 * impossible to tell from that number alone whether warmth had broken or
 * substance had simply arrived. Two sets, two budgets.
 *
 *   node tools/test-registers.mjs
 */
import { TTS, ANIMATION_CHOICE } from '../src/utils/config.js';

const PORT = process.env.PORT || 5180;
const ENDPOINT = `http://127.0.0.1:${PORT}/api/chat`;
const SYSTEM = `${TTS.system}\n\n${ANIMATION_CHOICE}`;

const WARMTH = [
  'hey',
  'i had a really bad day at work',
  'i miss you',
  'thank you for being here',
  'do you actually like me',
  'come here',
  'goodnight',
];

const SUBSTANCE = [
  'should I learn python or rust?',
  'help me pick a laptop under 1000 dollars',
  'whats a good way to stay focused while working',
  'give me a name idea for my steam game',
  'how do i start running',
  'mika what do you recommend me for my next project?',
];

const FLATTERY = ['great question', 'spark', 'amazing', 'so sweet of you', 'love when you', 'proud of you', 'inspire me'];
const REFUSAL = ['not my department', 'not something i', "i can't help with that", 'out of my', 'beyond me', 'i do not know'];
const CONCRETE = ['start with', 'begin', 'build', 'try', 'use ', 'first', 'next', 'then', 'avoid', 'aim', 'instead', 'pick', 'minutes', 'hours', 'weeks'];

async function ask(q) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: q, system: SYSTEM, stream: false, useMemory: false }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return String(j.text || '')
    .replace(/[\[*]{1,2}\s*anim\s*:\s*[a-z0-9_]+\s*[\]*]{1,2}/gi, '')
    .trim();
}

async function run(inputs, { label, maxWords, maxSent }) {
  const words = [];
  let sents = [];
  let bad = 0;
  console.log(`\n=== ${label} ===`);
  for (const q of inputs) {
    let t;
    try { t = await ask(q); } catch (e) { console.log(`  ERROR ${q} -> ${e.message}`); continue; }
    const low = t.toLowerCase();
    const w = t.split(/\s+/).filter(Boolean).length;
    const s = t.split(/[.!?]+/).filter((x) => x.trim()).length;
    const flat = FLATTERY.filter((f) => low.includes(f));
    const ref = REFUSAL.filter((f) => low.includes(f));
    const con = CONCRETE.filter((f) => low.includes(f));
    words.push(w);
    sents.push(s);
    const over = w > maxWords || s > maxSent;
    if (over) bad++;
    console.log(`  ${over ? 'OVER' : 'ok  '} ${String(w).padStart(3)}w ${s}sent  "${q}"`);
    console.log(`        ${t}`);
    if (flat.length) console.log(`        FLATTERY: ${flat.join(', ')}`);
    if (ref.length) console.log(`        REFUSAL: ${ref.join(', ')}`);
    if (label === 'SUBSTANCE' && !con.length) console.log(`        no concrete suggestion`);
  }
  const avg = (words.reduce((a, b) => a + b, 0) / (words.length || 1)).toFixed(1);
  console.log(`  -> avg ${avg} words, ${bad}/${words.length} over budget`);
  return { avg: Number(avg), bad, total: words.length };
}

const w = await run(WARMTH, { label: 'AFFECTION (warm, short)', maxWords: 30, maxSent: 3 });
const s = await run(SUBSTANCE, { label: 'SUBSTANCE (answers questions)', maxWords: 70, maxSent: 5 });

console.log('\n================================================');
console.log(`affection avg words : ${w.avg}   (want ~10-20, not bloated)`);
console.log(`substance avg words : ${s.avg}   (want long enough to answer)`);

const problems = [];
if (w.avg > 30) problems.push('affection replies are bloated - she has turned into a helper');
if (w.bad > 1) problems.push(`${w.bad} affection replies too long`);
if (s.avg < 20) problems.push('substance replies too short to actually help');
console.log(`\nVERDICT: ${problems.length ? 'needs work - ' + problems.join('; ') : 'both registers intact'}`);
process.exit(problems.length ? 1 : 0);