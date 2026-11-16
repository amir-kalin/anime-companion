import { TTS, FALLBACK_REPLIES, sanitizeForSpeech, ANIM_TAG, ANIM_TAG_LOOSE, ANIMATION_CHOICE } from '../utils/config.js';
import { cloudConfigured, loadCloudSettings, streamCloud } from './cloudChat.js';
import { apiUrl } from '../utils/connection.js';

/**
 * ChatClient — talks to the local LM Studio model through the Vite proxy.
 *
 * Streaming is the point. The model emits tokens, we accumulate them, and the
 * caller is handed each completed *sentence* as soon as it exists. That lets
 * speech begin on the first sentence instead of after the whole reply, which
 * takes perceived latency from seconds to well under one.
 *
 * The wire format is OpenAI `chat/completions`, which LM Studio, Ollama,
 * llama.cpp and vLLM all implement, so the backend stays swappable.
 */
export class ChatClient {
  constructor({ maxTurns = 8 } = {}) {
    this.maxTurns = maxTurns;
    /** @type {Array<{role: 'user'|'assistant', text: string}>} */
    this.history = [];
    this.available = null;
    this.lastError = null;
    /**
     * What she remembers, for the cloud path.
     *
     * The local path gets its memory injected server-side by the proxy,
     * which reads the memory file on the PC. The cloud path cannot reach
     * that file, so the notes the client fetched at boot are injected
     * instead. Without this she would forget everything the moment the PC
     * went to sleep.
     * @type {string[]}
     */
    this.memoryNotes = [];
  }

  /** @param {string[]} notes */
  setMemoryNotes(notes) {
    this.memoryNotes = Array.isArray(notes) ? notes.map(String) : [];
  }

  /**
   * Ask the dev server which local services are up.
   *
   * A failed probe leaves `available` as null ("unknown"), NOT false. The voice
   * service needs ~60s to start, so a probe during startup used to latch the
   * client into permanent fallback and she never talked again until a reload.
   */
  async probe() {
    try {
      // no-store: /api/health is a live status probe, and a cached response from
      // a moment when the voice service was still loading reported
      // "stt: false" indefinitely.
      const r = await fetch(apiUrl(TTS.healthEndpoint), { cache: 'no-store' });
      if (!r.ok) throw new Error(`health ${r.status}`);
      const j = await r.json();
      this.available = Boolean(j.llm);
      this.model = j.llmModel || null;
      this.isGemini = Boolean(j.isGemini);
      this.voice = !!j.voice;
      this.stt = !!j.stt;
      this.sttDevice = j.sttDevice || null;
      return j;
    } catch (e) {
      // Unknown, not unavailable - retry on the next turn.
      this.available = null;
      this.lastError = e.message;
      return { llm: false, voice: false, stt: false };
    }
  }

  reset() {
    this.history.length = 0;
  }

  /**
   * Stream a reply, invoking `onSentence` for each completed sentence as it
   * arrives so the caller can start synthesising immediately.
   *
   * @param {string} message
   * @param {(sentence: string) => void} onSentence
   * @param {{system?: string, force?: boolean}} [opts] `system` overrides the
   *   persona (used by petting), `force` allows an empty message so an
   *   event like "you were petted" can drive a reply on its own.
   * @returns {Promise<{text: string, source: 'model'|'fallback'}>}
   */
  async sendStreaming(message, onSentence, opts = {}) {
    const text = String(message || '').trim();
    if (!text && !opts.force) return { text: '', source: 'fallback' };
    const onAnimation = opts.onAnimation || (() => {});
    const onStatus = opts.onStatus || (() => {});
    // Petting and kissing decide the animation themselves, so the model is not
    // asked to choose in those cases.
    const system = opts.system
      ? opts.system
      : opts.allowAnimation
        ? `${TTS.system}\n\n${ANIMATION_CHOICE}`
        : TTS.system;

    if (this.available === null) await this.probe();

    /**
     * Two transports, tried in order.
     *
     * The local one is the good one — the 27B on the PC knows her, and it is
     * private. The cloud one is the "your PC is asleep" path, and it is only
     * ever used when the local attempt has failed AND the user has
     * deliberately configured a provider.
     */
    const localUsable = this.available !== false;
    const cloudUsable = cloudConfigured();

    // Nothing to try at all: no local model and no cloud provider.
    if (!localUsable && !cloudUsable) {
      const fb = pick();
      onSentence?.(fb);
      return { text: fb, source: 'fallback' };
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TTS.chatTimeoutMs);

    const maxSentences = TTS.maxSpokenSentences ?? 2;
    let full = '';
    let emitted = 0;
    let spoken = 0;
    let anim = null;   // the model's animation choice, if it tagged one
    // A tag-shaped string whose name is not playable, e.g. `[[anim:ideal]]`.
    let unknownTag = null;
    // Whether the opening has been judged yet. This CANNOT be inferred from
    // `anim !== null`, because "no tag at all" and "not decided yet" are both
    // null — so the null branch re-fired on every remaining chunk, spamming the
    // caller and resetting the HUD ~19 times a turn.
    let tagResolved = false;
    // Buffer across chunk boundaries: a sentence can straddle two SSE frames.
    const flush = (force) => {
      for (;;) {
        const rest = full.slice(emitted);
        // Look for a natural break; keep the tail buffered until more arrives.
        const m = rest.match(/^(.+?[.!?])(\s|$)/);
        if (!m) {
          if (force && rest.trim()) {
            const tail = trimFragment(rest);
            emitted = full.length;
            if (tail && spoken < maxSentences) { spoken++; onSentence?.(tail); }
          }
          return;
        }
        const upto = emitted + m[1].length;
        const sentence = full.slice(emitted, upto).trim();
        emitted = upto;
        // Hard cap: a chatty model otherwise produces a 20+ second turn.
        if (spoken < maxSentences) { spoken++; onSentence?.(sentence); }
        else return;
      }
    };

    /**
     * Drop a trailing fragment the model never finished.
     *
     * When the response hits `max_tokens` it is cut mid-word, and the sentence
     * splitter would happily speak "I've got sna". A tail with no terminal
     * punctuation is therefore discarded rather than spoken.
     */
    const trimFragment = (rest) => {
      const tail = rest.trim();
      if (!tail) return '';
      if (/[.!?]["')\]]?$/.test(tail)) return tail;      // complete sentence
      // Incomplete: back off to the last completed word, and only keep it if
      // there is enough left to be a standalone utterance.
      const cut = tail.replace(/[^\s]*$/, '').trim();
      return cut.length >= 12 ? cut : '';
    };

    // The animation tag is expected in the first chunk. Pull it off before any
    // sentence is handed on, so it is never spoken and never synthesised.
    const consumeTag = () => {
      if (tagResolved || !full) return;
      // Wait a little: the tag may be split across two SSE frames.
      if (full.length < 24 && !full.includes(']]')) return;

      // Loose first, so a tag-shaped string is ALWAYS treated as a tag and
      // always stripped. Matching the strict pattern first meant a near-miss
      // (`[[anim:ideal]]`, or `*[anim:idle]*`) matched neither it nor the
      // give-up branch below, and the tag stayed in the text: no animation, and
      // the literal tag on its way to the synthesiser.
      const loose = full.match(ANIM_TAG_LOOSE);
      const m = full.match(ANIM_TAG);

      if (m) {
        anim = m[1].toLowerCase();
        full = full.slice(m.index + m[0].length);
        emitted = Math.max(0, emitted - (m.index + m[0].length));
        tagResolved = true;
        onAnimation?.(anim);
        return;
      }

      if (loose) {
        // Recognised as a tag, but the name is not one we can play. Strip it,
        // report it, and let the turn continue as if no tag was given.
        full = full.slice(loose.index + loose[0].length);
        emitted = Math.max(0, emitted - (loose.index + loose[0].length));
        anim = null;
        unknownTag = loose[1];
        tagResolved = true;
        onAnimation?.(null);
        return;
      }

      if (full.length > 24) {
        // No tag in the opening; stop looking and treat the text as clean.
        anim = null;
        tagResolved = true;
        onAnimation?.(null);
      }
    };

    /**
     * One transport: fetch a reply and feed it into the same sentence and
     * tag machinery the local path uses.
     *
     * The cloud path is deliberately built on the SAME `full` / `consumeTag`
     * / `flush` pipeline as the local one. A reply from a free-tier model
     * needs exactly the same treatment — the animation tag stripped, the
     * sentence boundaries found, the cap applied — and duplicating that
     * logic would be how the two paths would drift apart.
     */
    const readSse = async (body) => {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line.
        const frames = buf.split(/\r?\n\r?\n/);
        buf = frames.pop() ?? '';
        for (const frame of frames) {
          for (const line of frame.split(/\r?\n/)) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const j = JSON.parse(payload);
              if (j.status) {
                onStatus(j.status, j.statusKind || 'working');
              }
              const delta = j.choices?.[0]?.delta?.content;
              if (delta) {
                full += delta;
                consumeTag();
                flush(false);
              }
            } catch { /* partial frame */ }
          }
        }
      }
    };

    const transports = [];

    if (localUsable) {
      transports.push({
        name: 'local',
        run: async () => {
          const r = await fetch(apiUrl(TTS.chatEndpoint), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: text,
              history: this.history,
              system,
              stream: true,
              // Sent explicitly. Without it the proxy used a hardcoded 170, which
              // truncated replies mid-word whenever the model stopped following the
              // persona — see the note on TTS.maxTokens in config.js.
              maxTokens: TTS.maxTokens,
            }),
            signal: ac.signal,
          });

          if (!r.ok || !r.body) {
            let msg = `HTTP ${r.status}`;
            try { msg = (await r.json()).error || msg; } catch { /* not json */ }
            throw new Error(msg);
          }
          await readSse(r.body);
        },
      });
    }

    if (cloudUsable) {
      transports.push({
        name: 'cloud',
        run: async () => {
          const settings = loadCloudSettings();
          // The proxy injects what she remembers into the system message.
          // The cloud path cannot reach the PC's memory file, so the notes
          // the client already fetched at boot are injected here instead —
          // otherwise she would forget everything the moment the PC sleeps.
          const memoryBlock = this.memoryNotes?.length
            ? `\n\nWhat you remember about the user:\n${this.memoryNotes.map((n) => `- ${n}`).join('\n')}`
            : '';
          const messages = [{ role: 'system', content: system + memoryBlock }];
          for (const h of this.history) messages.push({ role: h.role, content: h.content });
          if (text) messages.push({ role: 'user', content: text });

          await streamCloud({
            messages,
            signal: ac.signal,
            onDelta: (delta) => {
              full += delta;
              consumeTag();
              flush(false);
            },
          });
        },
      });
    }

    let via = null;
    let lastError = null;

    for (const t of transports) {
      // A transport that starts streaming and then dies must not leave half a
      // reply in the buffer for the next one to append to.
      full = '';
      emitted = 0;
      spoken = 0;
      anim = null;
      unknownTag = null;
      tagResolved = false;
      try {
        await t.run();
        via = t.name;
        break;
      } catch (e) {
        lastError = e.message;
        this.lastError = e.message;
        // Only an explicit auth rejection is treated as permanent. Transport
        // errors and timeouts are transient - a model that is still loading its
        // weights must not be written off after one failed turn.
        if (t.name === 'local') {
          if (/\b(401|403)\b/.test(e.message)) this.available = false;
          else this.available = null;
        }
      }
    }

    if (!via) {
      clearTimeout(timer);
      const fb = pick();
      onSentence?.(fb);
      return { text: fb, source: 'fallback', error: lastError };
    }

    clearTimeout(timer);
    flush(true);
    full = full.trim();
    if (!full) {
      const fb = pick();
      onSentence?.(fb);
      return { text: fb, source: 'fallback', via };
    }

    // An event-driven reply (petting) has no user message, so only the
    // assistant line is worth remembering; pushing an empty user turn would
    // teach the model to answer nothing.
    if (text) this.history.push({ role: 'user', content: text });
    this.history.push({ role: 'assistant', content: full });
    if (this.history.length > this.maxTurns * 2) {
      this.history.splice(0, this.history.length - this.maxTurns * 2);
    }
    this.lastError = null;
    return { text: full, source: 'model', via, unknownTag };
  }
}

function pick() {
  return FALLBACK_REPLIES[Math.floor(Math.random() * FALLBACK_REPLIES.length)];
}
