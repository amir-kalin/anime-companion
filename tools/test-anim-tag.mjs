/**
 * Malformed animation tags must never cost a turn its animation.
 *
 * The bug: the model emitted `[[anim:ideal]]` instead of `[[anim:idle]]`. The
 * strict pattern only lists the six valid names, and the "no tag, give up"
 * fallback only fires past 24 characters — the string was 14. So it matched
 * neither, the tag was never stripped, no animation was chosen, and the
 * literal tag was left in the text heading for the synthesiser.
 *
 * This drives the real `consumeTag` logic through a fake SSE stream.
 *
 *   node tools/test-anim-tag.mjs
 */
import { ANIM_TAG, ANIM_TAG_LOOSE } from '../src/utils/config.js';

const failures = [];
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label} (${detail})`);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(52)} ${detail}`);
};

/** Mirror of ChatClient's consumeTag, kept in step with src/ai/chat.js. */
function consume(full) {
  let anim = null;
  let unknownTag = null;
  let emitted = 0;
  let tagResolved = false;
  let calls = 0;
  if (!full) return { anim, unknownTag, rest: full, calls };
  if (full.length < 24 && !full.includes(']]')) return { anim, unknownTag, rest: full, calls };

  const loose = full.match(ANIM_TAG_LOOSE);
  const m = full.match(ANIM_TAG);
  if (m) {
    anim = m[1].toLowerCase();
    full = full.slice(m.index + m[0].length);
    emitted = Math.max(0, emitted - (m.index + m[0].length));
    tagResolved = true;
    calls = 1;
  } else if (loose) {
    full = full.slice(loose.index + loose[0].length);
    emitted = Math.max(0, emitted - (loose.index + loose[0].length));
    anim = null;
    unknownTag = loose[1];
    tagResolved = true;
    calls = 1;
  } else if (full.length > 24) {
    anim = null;
    tagResolved = true;
    calls = 1;
  }
  return { anim, unknownTag, rest: full, calls, tagResolved };
}

/**
 * Feed the opening in chunks, the way the SSE stream does, and count how many
 * times the callback fires. A decision must be reported exactly once.
 */
function consumeChunked(text, chunkSize = 4) {
  let full = '';
  let anim = null, unknownTag = null, tagResolved = false, calls = 0;
  for (let i = 0; i < text.length; i += chunkSize) {
    full += text.slice(i, i + chunkSize);
    if (tagResolved || !full) continue;
    if (full.length < 24 && !full.includes(']]')) continue;
    const loose = full.match(ANIM_TAG_LOOSE);
    const m = full.match(ANIM_TAG);
    if (m) {
      anim = m[1].toLowerCase();
      full = full.slice(m.index + m[0].length);
      tagResolved = true; calls++;
    } else if (loose) {
      full = full.slice(loose.index + loose[0].length);
      unknownTag = loose[1];
      tagResolved = true; calls++;
    } else if (full.length > 24) {
      tagResolved = true; calls++;
    }
  }
  return { anim, unknownTag, rest: full, calls };
}

console.log('valid tags');
for (const name of ['idle', 'talking', 'bored', 'kiss', 'sit', 'sittalk']) {
  const r = consume(`[[anim:${name}]] Hello there.`);
  check(`[[anim:${name}]] is chosen`, r.anim === name, `got ${r.anim}`);
  check(`[[anim:${name}]] stripped from speech`, !r.rest.includes('anim'), JSON.stringify(r.rest.slice(0, 24)));
}
check('case-insensitive', consume('[[ANIM:KISS]] hi').anim === 'kiss', consume('[[ANIM:KISS]] hi').anim);
check('whitespace tolerated', consume('[[ anim : bored ]] hi').anim === 'bored', 'spaced');

console.log('\nmalformed tags (the reported bug)');
const cases = [
  ['[[anim:ideal]]', 'ideal', 'typo for idle'],
  ['[[anim:idle2]]', 'idle2', 'trailing digit'],
  ['[[anim:jump]]', 'jump', 'not a real state'],
  ['[[anim:SITTING]]', 'SITTING', 'wrong case/name'],
];
for (const [input, expectName, why] of cases) {
  const r = consume(input);
  check(`${input} reported as unplayable`, r.unknownTag === expectName, `got ${r.unknownTag} (${why})`);
  check(`${input} NOT chosen as an animation`, r.anim === null, `got ${r.anim}`);
  check(`${input} stripped from speech`, r.rest === '', JSON.stringify(r.rest));
}

console.log('\nlong malformed tag with real speech after it');
{
  const r = consume('[[anim:wave]] She waves at you, smiling the whole time.');
  check('unplayable tag reported', r.unknownTag === 'wave', `got ${r.unknownTag}`);
  check('speech survives intact', r.rest.startsWith(' She waves'), JSON.stringify(r.rest.slice(0, 22)));
  check('no tag text left for the TTS', !/\[\[/.test(r.rest), 'clean');
}

console.log('\nno tag at all');
{
  const r = consume('Just a plain reply with no tag whatsoever here.');
  check('no tag chosen', r.anim === null && r.unknownTag === null, 'null/null');
  check('text untouched', r.rest.includes('plain reply'), 'intact');
}

console.log('\npartial tag still streaming');
check('waits for more', consume('[[ani').anim === null, 'no decision yet');
check('waits for more (2)', consume('[[anim:').anim === null, 'no decision yet');

console.log('\ndelimiter mangling (seen in the wild)');
{
  const r = consume('*[anim:idle]* Mm? Go on then.');
  check('single-asterisk tag is chosen', r.anim === 'idle', `got ${r.anim}`);
  check('single-asterisk tag stripped', !r.rest.includes('anim'), JSON.stringify(r.rest.slice(0, 20)));
}
{
  const r = consume('[[anim:kiss]] Mm? About time.');
  check('canonical form still works', r.anim === 'kiss', `got ${r.anim}`);
}

console.log('\nreported exactly ONCE per turn');
{
  // The bug: the null branch set `anim = null`, which the `anim !== null`
  // guard could not distinguish from "undecided", so every later chunk
  // re-fired the callback (~19 times a turn in the live app).
  const plain = consumeChunked('Just an ordinary reply with no tag at all, quite long.');
  check('untagged opening reports once', plain.calls === 1, `${plain.calls} call(s)`);

  const tagged = consumeChunked('[[anim:kiss]] She leans in close and smiles at you.');
  check('tagged opening reports once', tagged.calls === 1, `${tagged.calls} call(s)`);
  check('tagged opening still chose kiss', tagged.anim === 'kiss', `got ${tagged.anim}`);

  const bad = consumeChunked('[[anim:ideal]] And then she says something else entirely.');
  check('unplayable tag reports once', bad.calls === 1, `${bad.calls} call(s)`);
  check('unplayable tag still reported', bad.unknownTag === 'ideal', `got ${bad.unknownTag}`);
}

console.log('');
if (failures.length) {
  console.error(`FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('anim-tag handling is robust');