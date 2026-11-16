/**
 * Persona test: does she sound like a person she likes, or like an assistant?
 *
 * This replaces tools/test-persona.py, which held its OWN hardcoded copy of the
 * system prompt. It could therefore score a prompt the app no longer sends, and
 * would never notice the two drifting apart. Importing the real config is the
 * only way this can measure what actually ships.
 *
 * The metrics are aimed at the complaints that actually came up:
 *   - assistant register ("How about we...", "I can help")
 *   - over-writing: she is SPOKEN ALOUD, so a long purple reply is a long wait
 *   - a single repeated opener ("Mm?" on every turn) is the clearest tell that
 *     a model is generating a register rather than talking
 *   - ending every reply with a question
 *
 *   node tools/test-persona.mjs                 # default input set
 *   node tools/test-persona.mjs "hey" "i miss you"
 */
import { TTS } from '../src/utils/config.js';

const PORT = process.env.PORT || 5180;
const ENDPOINT = `http://127.0.0.1:${PORT}/api/chat`;

// The app appends the animation tag instruction to the persona. Reproduce that,
// or this measures a different prompt than the one in use.
const { ANIMATION_CHOICE } = await import('../src/utils/config.js');
const SYSTEM = `${TTS.system}\n\n${ANIMATION_CHOICE}`;

const ASSISTANT = [
  'how about we', 'i can help', "that's a great question", "i'm here to",
  'let me know if', 'as an ai', "i'd be happy to", 'certainly', 'of course!',
  'here are some', 'in summary', 'overall,', 'i understand', 'that sounds',
  'sounds great', 'i appreciate', 'feel free to', 'i hope this helps',
];

/**
 * Phrases that can also occur innocently, so a plain substring match reports a
 * false positive. "sounds great" matched her own name in a reply about a
 * greengrocer, and "certainly" matches inside "certainly not". Each is checked
 * as a whole word or clause instead.
 */
const ASSISTANT_PHRASE = [
  'sounds great', 'that sounds', 'i understand', 'certainly', 'of course!',
];

/**
 * Words and shapes that read as written prose rather than speech. A spoken line
 * does not contain "capturing your lips with a soft but sure kiss".
 */
const PURPLE = [
  'soft but sure', 'don\'t think you can', 'get out of it easy',
  'couldn\'t help', 'breath catching', 'my heart', 'your heart', 'the air',
  'destiny', 'just the start', 'slip away', 'every single',
  'more than anything', 'come closer', 'leaning in', 'close enough to',
  'i promise', 'promise you', 'forever and ever', 'my soul',
];

/**
 * Bare nouns that only mean "purple" in a romance register. "heart" matched
 * her own octopus and starfish facts, and a fact-based false positive teaches
 * nothing - it just makes the number untrustworthy.
 */
const PURPLE_BARE = ['heart', 'hearts', 'soul'];

const INPUTS = process.argv.slice(2).length ? process.argv.slice(2) : [
  'hey',
  'i had a really bad day at work',
  'i miss you',
  'what should i do about my boss',
  'are you an ai?',
  'thank you for being here',
  'what should we do tonight',
  'i am so tired of everything',
  'do you actually like me',
  'tell me something interesting',
];

/**
 * Affection-only inputs.
 *
 * Two different length budgets are correct, and scoring both with one limit is
 * what made a genuinely helpful reply look like a regression: answering "should I
 * learn python or rust?" needs two or three sentences, while "i miss you" needs
 * one. The warmth register is measured on its own set so a fix for the other one
 * cannot quietly cost it.
 */
const WARMTH_INPUTS = [
  'hey',
  'i had a really bad day at work',
  'i miss you',
  'thank you for being here',
  'do you actually like me',
  'come here',
];

async function ask(q) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: q, system: SYSTEM, stream: false, useMemory: false }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  // Strip the leading anim tag, which is not part of what she says.
  return String(j.text || '').replace(/[\[*]{1,2}\s*anim\s*:\s*[a-z0-9_]+\s*[\]*]{1,2}/i, '').trim();
}

const stats = {
  assistant: 0, contraction: 0, cue: 0, question: 0,
  over30: 0, over3sent: 0, purple: 0,
  words: [], openers: [],
};

console.log(`probing ${ENDPOINT}`);
console.log(`system prompt = TTS.system + ANIMATION_CHOICE (${SYSTEM.length} chars)\n`);

for (const q of INPUTS) {
  let text;
  try {
    text = await ask(q);
  } catch (e) {
    console.log(`  ERROR  "${q}" -> ${e.message}`);
    continue;
  }
  const low = text.toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);
  const sents = text.split(/[.!?]+/).filter((s) => s.trim()).length;

  // Literal phrases are safe to substring-match. The ambiguous ones must be
  // checked as whole words, or "certainly" fires on "certainly not" and
  // "sounds great" fires on any mention of a great-sounding anything.
  const banned = [
    ...ASSISTANT.filter((b) => !ASSISTANT_PHRASE.includes(b) && low.includes(b)),
    ...ASSISTANT_PHRASE.filter((b) => new RegExp(`\\b${b.replace(/[.!]/g, '')}\\b`).test(low)),
  ];
  const purple = [
    ...PURPLE.filter((p) => !PURPLE_BARE.includes(p) && low.includes(p)),
    // A bare noun only counts when it is hers, not a fact about octopuses.
    ...PURPLE_BARE.filter((p) => new RegExp(`\\b(my|your)\\s+${p}\\b`).test(low)),
  ];
  // "Mm. Say that again." is natural speech with no apostrophe, so requiring an
  // apostrophe scored it as a failure. What actually reads as stiff is the
  // UNCONTRACTED form, so that is what is measured.
  const formal = /\b(i am|you are|do not|it is|that is|i will|we are|they are|he is|she is|cannot|will not)\b/;
  const hasFormal = formal.test(low);
  const cue = /[(*]([a-z ]{2,30})[)*]/.test(text);

  stats.assistant += banned.length;
  stats.purple += purple.length;
  stats.contraction += hasFormal ? 1 : 0;
  stats.cue += cue ? 1 : 0;
  stats.question += /\?\s*$/.test(text.trim()) ? 1 : 0;
  stats.over30 += words.length > 30 ? 1 : 0;
  stats.over3sent += sents > 3 ? 1 : 0;
  stats.words.push(words.length);

  const opener = (text.match(/^\W*([A-Za-z']{1,12})/) || [, '?'])[1].toLowerCase();
  stats.openers.push(opener);

  console.log(`--- "${q}"`);
  console.log(`    ${text}`);
  const notes = [`${sents} sent`, `${words.length} words`];
  if (banned.length) notes.push(`ASSISTANT: ${banned.join(', ')}`);
  if (purple.length) notes.push(`PURPLE: ${purple.join(', ')}`);
  if (hasFormal) notes.push('UNCONTRACTED');
  if (cue) notes.push(`cue=${JSON.stringify(cue[1])}`);
  console.log(`    [${notes.join('; ')}]`);
  console.log();
}

const n = INPUTS.length;
const avgWords = (stats.words.reduce((a, b) => a + b, 0) / (stats.words.length || 1)).toFixed(1);
const topOpeners = [...stats.openers.reduce((m, o) => m.set(o, (m.get(o) || 0) + 1), new Map())]
  .filter(([, c]) => c > 1)
  .map(([o, c]) => `"${o}" x${c}`);

console.log('================================================');
console.log(`replies              : ${stats.words.length}/${n}`);
console.log(`assistant register   : ${stats.assistant} hits   (want 0)`);
console.log(`purple prose         : ${stats.purple} hits   (want 0-1)`);
console.log(`uncontracted ("I am"): ${stats.contraction}/${stats.words.length}   (want 0)`);
console.log(`stage cue            : ${stats.cue}/${stats.words.length}`);
console.log(`ends with a question : ${stats.question}/${stats.words.length}   (want < half)`);
console.log(`over 30 words        : ${stats.over30}/${stats.words.length}`);
console.log(`over 3 sentences     : ${stats.over3sent}/${stats.words.length}`);
console.log(`avg words            : ${avgWords}   (want ~10-18 for speech)`);
console.log(`repeated openers     : ${topOpeners.length ? topOpeners.join(', ') : 'none'}`);

const bad = [];
if (stats.assistant > 0) bad.push('assistant register');
if (stats.over30 > 1) bad.push('too many long replies');
if (stats.over3sent > 1) bad.push('too many run-on replies');
if (stats.contraction > 0) bad.push(`${stats.contraction} uncontracted reply(s)`);
if (topOpeners.length) bad.push('repeated opener');
console.log(`\nVERDICT: ${bad.length ? 'needs work - ' + bad.join(', ') : 'register is good'}`);
process.exit(bad.length ? 1 : 0);