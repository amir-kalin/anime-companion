/**
 * Can she actually TALK about things, or does she only flatter?
 *
 * The complaint this measures: asked for a project recommendation, she replied
 * "That's actually a great question, and I love it. You have this amazing spark
 * in your projects" — which is praise wearing the costume of an answer, and
 * contains no recommendation at all.
 *
 * Two distinct failure modes are scored separately, because they need different
 * fixes and hide each other in a single number:
 *
 *   FLATTERY   the reply talks about him/her rather than the topic. Banned by
 *              the prompt already, but a ban without a positive instruction to
 *              answer does not produce an answer - it produces a pivot.
 *   DEFLECTION  she declines or evades the question ("that's not my department").
 *
 * SUBSTANCE is the positive check: does the reply contain at least one concrete
 * thing he could act on - a concrete noun from the question, or a recommendation
 * shape ("start with", "build", "use X", "begin by")?
 *
 *   node tools/test-substance.mjs
 */
import { TTS, ANIMATION_CHOICE } from '../src/utils/config.js';

const PORT = process.env.PORT || 5180;
const ENDPOINT = `http://127.0.0.1:${PORT}/api/chat`;

// Deliberately real questions, not greetings or affection. This is the case the
// prompt was failing.
const INPUTS = process.argv.slice(2).length ? process.argv.slice(2) : [
  'mika what do you recommend me for my next project?',
  'what are some good ideas for my new app?',
  'should I learn python or rust?',
  'help me pick a laptop under 1000 dollars',
  'whats a good way to stay focused while working',
  'give me a name idea for my steam game',
  'is it worth learning blender',
  'how do i start running',
];

/**
 * Praise that REPLACES the answer instead of following it.
 *
 * A bare word list cannot tell these apart: "you look way too good in them" is
 * fine after a useful answer, but "you have this amazing spark in your projects"
 * is praise standing in for a recommendation. The difference is positional — the
 * flattery case is the WHOLE reply, or leads the reply with nothing before it.
 *
 * So flattery is only counted when praise is all there is: a short reply, or a
 * reply that opens with the praise and never reaches anything concrete.
 */
const PRAISE = [
  'great question', 'spark', 'amazing', 'so sweet of you', 'love when you',
  'proud of you', 'inspire me', 'i adore', 'that is lovely', 'your creativity',
  'beautiful', 'i love that you',
];

/** Replies that decline rather than answer. */
const DEFLECTION = [
  "not my department", "that's up to you", 'i cannot', "i can't help with that",
  'i do not know', "i don't know", 'ask someone', 'out of my', 'beyond me',
  'not something i', 'too vague', 'tell me more',
];

/**
 * Signals that she actually answered, rather than only sounding warm.
 *
 * Deliberately loose. The earlier version scored 6/8 on one run and 8/8 on the
 * next with identical behaviour, because it matched phrases like "first" and
 * "use" — which appear in chatty openers as often as in real advice. A metric
 * that swings on phrasing alone cannot tell you whether she is useful, so this
 * measures the two things that are unambiguous instead:
 *
 *   1. it is long enough to contain an answer at all
 *   2. it engages the thing asked — either a noun from the question, or a
 *      recommendation shape
 *
 * Anything softer than this is left to the printed replies, which are the real
 * evidence and are shown for every case anyway.
 */
const SUBSTANTIVE = [
  'start with', 'begin with', 'build', 'pick', 'try ', 'use ', 'avoid', 'instead',
  'aim', 'budget', 'spend', 'first step', 'go with', 'i would', "i'd", 'either',
  'python', 'rust', 'blender', 'pomodoro', 'running', 'laptop', 'minutes', 'hours',
  'weeks', 'daily', 'app', 'project', 'game', 'name',
];

async function ask(q, system) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: q, system, stream: false, useMemory: false }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return String(j.text || '')
    .replace(/[\[*]{1,2}\s*anim\s*:\s*[a-z0-9_]+\s*[\]*]{1,2}/gi, '')
    .trim();
}

const SYSTEM = `${TTS.system}\n\n${ANIMATION_CHOICE}`;

const stats = { flattery: 0, deflection: 0, substance: 0 };
const rows = [];

for (const q of INPUTS) {
  let text;
  try {
    text = await ask(q, SYSTEM);
  } catch (e) {
    console.log(`  ERROR  "${q}" -> ${e.message}`);
    continue;
  }
  const low = text.toLowerCase();
  const flat = PRAISE.filter((f) => low.includes(f));
  const defl = DEFLECTION.filter((d) => low.includes(d));
  const subs = SUBSTANTIVE.filter((s) => low.includes(s));
  const w = text.split(/\s+/).filter(Boolean).length;
  // Enough words to hold an answer, plus a sign she engaged the topic.
  const answered = w >= 15 && subs.length > 0;

  // Praise only counts as a failure when it IS the answer: no substance, or a
  // short reply. Praise that trails a real answer is her being her, which is
  // the thing being preserved here.
  const praiseIsTheAnswer = PRAISE.some((p) => low.includes(p)) && !answered;

  if (praiseIsTheAnswer) stats.flattery++;
  if (defl.length) stats.deflection++;
  if (answered) stats.substance++;

  rows.push({ q, text, flat, defl, subs });
  console.log(`--- "${q}"`);
  console.log(`    ${text}`);
  const notes = [];
  if (flat.length) notes.push(`FLATTERY(${flat.length})`);
  if (defl.length) notes.push(`DEFLECTION(${defl.length})`);
  if (subs.length) notes.push(`substance(${subs.length})`);
  console.log(`    [${notes.join('; ') || 'NO substance signals'}]`);
  console.log();
}

const n = rows.length;
console.log('================================================');
console.log(`replies            : ${n}`);
console.log(`flattery, not answer: ${stats.flattery}/${n}   (want 0)`);
console.log(`deflection          : ${stats.deflection}/${n}   (want 0)`);
console.log(`has substance       : ${stats.substance}/${n}   (want most)`);

const bad = [];
if (stats.flattery > 0) bad.push('flattery');
if (stats.deflection > 0) bad.push('deflection');
if (stats.substance < n - 1) bad.push('no substance');
console.log(`\nVERDICT: ${bad.length ? 'cannot hold a real conversation - ' + bad.join(', ') : 'she answers real questions'}`);
process.exit(bad.length ? 1 : 0);