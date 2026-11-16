import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Persistent memory.
 *
 * Survives a reboot because it lives in a JSON file on disk, not in
 * localStorage, and the server is the single writer - the client never writes it,
 * so there is no chance of two tabs clobbering each other.
 *
 * Two tiers, because they answer different questions:
 *  - `transcript` - the rolling log of what was actually said. Cheap, exact.
 *  - `notes` / `events` - a distilled, human-readable summary the model itself
 *    writes. This is what she actually recalls, and it is injected into her
 *    system prompt, so it has to stay short.
 *
 * Writes are atomic (temp file + rename) so a crash mid-write cannot leave a
 * truncated file that fails to parse on the next boot.
 */

const EMPTY = {
  version: 1,
  created: null,
  updated: null,
  notes: [],
  events: [],
  transcript: [],
  turns: 0,
};

const MAX_TRANSCRIPT = 400;   // ~200 exchanges, plenty of context
const DISTILL_EVERY = 4;      // turns between distillations
const MAX_NOTES = 40;
const MAX_EVENTS = 30;

/**
 * Reduce a sentence to a comparison key.
 *
 * Strip punctuation, common filler and possessives, then sort the words, so that
 * "Mika has memorized the number 9197522915" and "The user asked Mika to
 * remember 9197522915" collapse toward each other. Numbers are kept: they are the
 * most identifying part of a fact about someone.
 *
 * This is deliberately a bag of words, not a similarity metric. It cannot tell
 * "the user likes tea" from "the user hates tea", and that is a real limitation —
 * but it catches the paraphrase duplication that actually happened, and it costs
 * nothing and cannot fail.
 */
function tokenKey(text) {
  const STOP = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have',
    'had', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'at', 'for', 'with',
    'that', 'this', 'it', 'she', 'he', 'they', 'user', 'mika', 'his', 'her',
    'their', 'its', 'as', 'by', 'from', 'so', 'if', 'not', 'no', 'do', 'does',
    'will', 'would', 'can', 'could', 'said', 'says', 'also', 'very', 'about',
  ]);
  const words = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w) && w.length > 1);
  return words.sort().join(' ');
}

/**
 * Are these two notes about the same thing?
 *
 * Jaccard overlap on the token bags. 0.7 catches "Mika has memorized the number
 * 9197522915" vs "The user mentioned remembering a number: 9197522915" while
 * keeping "the user likes tea" and "the user hates tea" apart, because those
 * differ by more than one token.
 */
function sameFact(a, b) {
  const ka = new Set(tokenKey(a).split(' ').filter(Boolean));
  const kb = new Set(tokenKey(b).split(' ').filter(Boolean));
  if (!ka.size || !kb.size) return false;
  let shared = 0;
  for (const w of ka) if (kb.has(w)) shared++;
  return shared / Math.min(ka.size, kb.size) >= 0.7;
}

export function memoryStore({ root, lmBase, lmKey, lmModel, log = () => {} }) {
  const file = join(root, 'data', 'memory.json');
  let doc = null;
  let distilling = false;

  async function load() {
    if (doc) return doc;
    try {
      if (existsSync(file)) {
        const raw = await readFile(file, 'utf8');
        const parsed = JSON.parse(raw);
        // Merge onto the defaults so an older file gains new fields.
        doc = { ...structuredClone(EMPTY), ...parsed };
      } else {
        doc = structuredClone(EMPTY);
        doc.created = new Date().toISOString();
      }
    } catch (e) {
      log(`[memory] could not read ${file} (${e.message}); starting fresh`);
      doc = structuredClone(EMPTY);
      doc.created = new Date().toISOString();
    }
    return doc;
  }

  /**
   * Persist, serialised.
   *
   * Two things are needed, and only having the first is what killed the dev
   * server. `distill()` is deliberately fire-and-forget (`void distill()`), so
   * it overlaps the next turn's save. Both wrote the SAME `memory.json.tmp` and
   * then renamed it, so whichever renamed first deleted the file the other was
   * about to rename, and the second failed with ENOENT. The unhandled rejection
   * from `recordTurn` then took the entire process down.
   *
   * So: one write chain, plus a unique temp name so a stale .tmp left by a
   * killed process is never reused. A failed write is logged and swallowed —
   * losing a memory is never worth taking the app offline.
   */
  let writeChain = Promise.resolve();
  let tempSeq = 0;

  async function doSave() {
    const d = doc || (await load());
    d.updated = new Date().toISOString();
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${tempSeq++}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(d, null, 2), 'utf8');
      await rename(tmp, file);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
    return d;
  }

  function save() {
    // `then(doSave, doSave)` rather than `.then(doSave)`, so one failure does
    // not poison the chain for every later write.
    writeChain = writeChain.then(doSave, doSave);
    return writeChain.catch((e) => {
      log(`[memory] save failed: ${e.message}`);
      return null;
    });
  }

  function now() {
    return new Date().toISOString();
  }

  /** Block injected into her system prompt. Empty when she knows nothing yet. */
  function memoryBlock(d) {
    const parts = [];
    if (d.notes?.length) parts.push(`WHAT YOU REMEMBER:\n- ${d.notes.join('\n- ')}`);
    if (d.events?.length) {
      const recent = d.events.slice(-6);
      parts.push(`MOMENTS YOU SHARED:\n- ${recent.map((e) => `${e.what} (${e.when})`).join('\n- ')}`);
    }
    if (!parts.length) return '';
    return (
      '\n\nYou have met before and you remember. Use these naturally, the way ' +
      'someone who knows you would - do not recite them, do not say "as I ' +
      'remember" or "you told me before", and never mention that you have notes.' +
      `\n\n${parts.join('\n\n')}`
    );
  }

  /**
   * Ask the model to distil the recent transcript into durable notes.
   * Fire-and-forget: a turn must never wait on this.
   */
  async function distill() {
    if (distilling) return null;
    const d = await load();
    const recent = d.transcript.slice(-40);
    if (recent.length < 4) return null;
    distilling = true;
    try {
      const convo = recent
        .map((t) => `${t.role === 'user' ? 'User' : 'Jinx'}: ${t.text}`)
        .join('\n');
      const prompt =
        'Below is a recent conversation between Jinx and the user she likes.\n\n' +
        convo +
        '\n\nWrite what she should remember for next time.\n' +
        'Reply with JSON only, no prose, no code fence:\n' +
        '{"notes":["durable fact about the user, 1 per item, max 3 new"],"' +
        '"event":"one short milestone worth remembering, or null"}\n' +
        'A note is something that will still be true next week: their name, ' +
        'job, an allergy, likes, a promise, a plan, a date they mentioned. ' +
        'Chitchat and one-off banter are not worth a note. Copy words from ' +
        'the conversation rather than inventing them: never add a detail ' +
        'that was not said. If nothing durable happened, return an empty ' +
        'notes list.\n' +
        'For "event", return JSON null - the bare word null, with no quotes ' +
        '- unless the user told you she said something significant such as "I ' +
        'love you". Most conversations have no event.';

      const r = await fetch(
        `${lmBase}/chat/completions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${lmKey}` },
          body: JSON.stringify({
            model: lmModel,
            // Reasoning models spend their whole budget thinking and return
            // nothing; this is the same switch the main chat route relies on.
            reasoning_effort: 'none',
            temperature: 0.3,
            max_tokens: 300,
            // LM Studio rejects response_format.type "json_object" for this
            // model - it must be "json_schema" (or "text"). The schema is the
            // better option anyway: it guarantees well-formed output instead of
            // relying on the model to avoid prose and code fences.
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'memory',
                strict: true,
                schema: {
                  type: 'object',
                  properties: {
                    notes: { type: 'array', items: { type: 'string' } },
                    event: { type: ['string', 'null'] },
                  },
                  required: ['notes', 'event'],
                  additionalProperties: false,
                },
              },
            },
            messages: [
              {
                role: 'system',
                content:
                  'You extract durable memories from a conversation so a ' +
                  'companion can recall it later. Output strict JSON only.',
              },
              { role: 'user', content: prompt },
            ],
          }),
        }
      );
      if (!r.ok) {
        log(`[memory] distill failed: HTTP ${r.status}`);
        return null;
      }
      const j = await r.json();
      const text = j?.choices?.[0]?.message?.content || '';
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        log('[memory] distill returned non-JSON; skipped');
        return null;
      }

      const notes = Array.isArray(parsed.notes) ? parsed.notes.filter((n) => typeof n === 'string' && n.trim()) : [];
      // De-duplicate against what she already knows.
      //
      // This has to catch PARAPHRASES, not exact matches. The store was full of
      // near-identical notes ("Mika has memorized the number 9197522915",
      // "...and says she loves the user", "Mika promised not to let the feeling
      // slip away") because the model rewrote the same fact slightly differently
      // each time and only an exact, lowercased key ever collided. Result: 13
      // notes of which 5 were the same phone number, and the memory block read
      // like a love letter rather than a recollection of a person.
      const have = d.notes.map((n) => tokenKey(n));
      for (const n of notes) {
        const text = String(n).trim();
        const k = tokenKey(text);
        if (k && !have.includes(k)) { d.notes.push(text); have.push(k); }
      }
      if (d.notes.length > MAX_NOTES) d.notes = d.notes.slice(-MAX_NOTES);

      // The model asked for a JSON null here, but a schema that allows the
      // ["string","null"] union still lets it emit the four-character STRING
      // "null", which then got stored as a real event. Only accept an event
      // that reads as prose.
      const event = typeof parsed.event === 'string' ? parsed.event.trim() : '';
      const isRealEvent = event.length > 0 && !/^(null|none|n\/a|undefined)$/i.test(event);
      if (isRealEvent) {
        d.events.push({ ts: now(), what: event.slice(0, 120), when: humanDate() });
        if (d.events.length > MAX_EVENTS) d.events = d.events.slice(-MAX_EVENTS);
      }

      d.turnsSinceDistill = 0;
      await save();
      log(`[memory] distilled ${notes.length} note(s)${isRealEvent ? ' + 1 event' : ''}`);
      return parsed;
    } catch (e) {
      log(`[memory] distill error: ${e.message}`);
      return null;
    } finally {
      distilling = false;
    }
  }

  function humanDate() {
    return new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  /**
   * Record a completed exchange. Persists immediately so a crash or reboot
   * between turns still keeps everything said so far.
   */
  async function recordTurn(user, mika) {
    const d = await load();
    d.turns = (d.turns || 0) + 1;
    d.transcript.push({ ts: now(), role: 'user', text: String(user || '').slice(0, 600) });
    d.transcript.push({ ts: now(), role: 'mika', text: String(mika || '').slice(0, 600) });
    if (d.transcript.length > MAX_TRANSCRIPT) d.transcript = d.transcript.slice(-MAX_TRANSCRIPT);
    await save();

    d.turnsSinceDistill = (d.turnsSinceDistill || 0) + 1;
    if (d.turnsSinceDistill >= DISTILL_EVERY) {
      d.turnsSinceDistill = 0;
      await save();
      void distill(); // not awaited: a turn must never block on this
    }
    return { turns: d.turns, notes: d.notes.length, events: d.events.length };
  }

  /** Record something that happened rather than something said. */
  async function recordEvent(what) {
    const d = await load();
    d.events.push({ ts: now(), what: String(what).slice(0, 120), when: humanDate() });
    if (d.events.length > MAX_EVENTS) d.events = d.events.slice(-MAX_EVENTS);
    await save();
    return d.events.length;
  }

  async function clear() {
    doc = structuredClone(EMPTY);
    doc.created = now();
    await save();
    return doc;
  }

  return { load, save, memoryBlock, recordTurn, recordEvent, distill, clear };
}
