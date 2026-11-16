import { TTS } from '../utils/config.js';

/**
 * SpeechSource
 *
 * Produces the audio that the character "speaks", and reports the playback
 * lifecycle events the animation state machine reacts to:
 *
 *     onstart()  ->  transitionTo(TALKING)
 *     onend()    ->  transitionTo(IDLE)
 *
 * Three tiers, tried in order, so the companion is always able to talk:
 *
 *  1. A local TTS HTTP endpoint (Piper, etc.) returning WAV bytes. Full
 *     lip-sync, because the real waveform reaches the analyser.
 *  2. The browser's speechSynthesis. Plays real speech, but the Web Speech API
 *     exposes no audio node, so it cannot be analysed - lip-sync is driven by a
 *     synthetic envelope instead.
 *  3. A procedurally synthesised formant voice. Not intelligible, but it is a
 *     real audio signal built from a vowel sequence, so it exercises the exact
 *     same RMS/spectral lip-sync path as tier 1. This is what makes the
 *     viseme system verifiable with no TTS installed at all.
 */
export class SpeechSource {
  /**
   * @param {{onstart:Function, onend:Function, onerror:Function, onmode:Function}} handlers
   */
  constructor({ onstart = () => {}, onend = () => {}, onerror = () => {}, onmode = () => {} } = {}) {
    this.handlers = { onstart, onend, onerror, onmode };
    this.ctx = null;
    this.analyserNode = null;
    this.current = null;      // active AudioBufferSourceNode
    this.mode = null;         // 'fish-audio' | 'speechSynthesis' | 'synthetic'
    this.speaking = false;
    this._utterance = null;
    this._ttsAvailable = null; // cached health check
    this.lastTtsError = null;
  }

  /**
   * Create the AudioContext. Must be called from a user gesture the first
   * time, or the browser will leave it suspended.
   * @returns {AudioContext|null}
   */
  ensureContext() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    this.ctx = new AC();
    this.analyserNode = this.ctx.createGain(); // pass-through tap for LipSync
    this.analyserNode.connect(this.ctx.destination);
    return this.ctx;
  }

  /**
   * Speak text, resolving once playback has finished.
   * @param {string} text
   * @returns {Promise<{mode: string}|null>}
   */
  async speak(text) {
    if (this.speaking) this.stop();
    const clean = String(text || '').trim();
    if (!clean) return null;

    this.speaking = true;
    this._startedAt = performance.now();
    this.handlers.onstart(clean);

    try {
      if (await this._tryTts(clean)) return { mode: 'tts' };
      if (await this._trySpeechSynthesis(clean)) return { mode: 'speechSynthesis' };
      await this._playSynthetic(clean);
      return { mode: 'synthetic' };
    } catch (err) {
      this.handlers.onerror(err);
      return null;
    } finally {
      this.speaking = false;
      this.handlers.onend();
    }
  }

  stop() {
    try {
      this.current?.stop();
    } catch { /* not started */ }
    this.current = null;
    if (window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
    }
    this._utterance = null;
    this.speaking = false;
    this._startedAt = 0;
  }

  /**
   * Synthetic syllabic envelope for the speechSynthesis path.
   *
   * Returns a deterministic pseudo-random loudness and vowel shape for the
   * current instant, at a conversational ~4.6 syllables/second. Deterministic
   * (hashed off the syllable index) rather than random so the envelope is
   * smooth and reproducible within one utterance.
   *
   * @returns {{level: number, shape: number}|null} null unless speaking via
   *   speechSynthesis, which is the only mode with no analysable audio.
   */
  envelope() {
    if (!this.speaking || this.mode !== 'speechSynthesis' || !this._startedAt) return null;
    const t = (performance.now() - this._startedAt) / 1000;

    const syl = 1 / 4.6;
    const i = Math.floor(t / syl);
    const frac = (t % syl) / syl;

    const hash = (n) => {
      const x = Math.sin(n * 12.9898) * 43758.5453;
      return x - Math.floor(x);
    };

    // Fast attack, short sustain, slower release - the shape of a spoken syllable.
    let level;
    if (frac < 0.14) level = frac / 0.14;
    else if (frac < 0.58) level = 1;
    else level = Math.max(0, 1 - (frac - 0.58) / 0.42);

    const amp = 0.3 + hash(i) * 0.7;
    // Stressed syllables land every few beats.
    const stressed = i % 5 === 0 ? 1.25 : 1;
    // Scaled to a speech-like RMS peak. The viseme mapper treats
    // LIPSYNC.rmsFullScale (0.32) as "mouth wide open", so a 0..1 envelope
    // would peg `aa` at full aperture and read as a permanently open mouth.
    return {
      level: Math.min(0.3, level * amp * stressed * 0.3),
      shape: hash(i + 7),
    };
  }

  // ------------------------------------------------------------------- tier 1

  /**
   * Tier 1: the local TTS proxy, which forwards to Fish Audio with the key kept
   * server-side. This is the only tier with a real recorded voice, and the only
   * one that reaches an analyser, so it gives true spectrum-driven lip-sync.
   */
  async _tryTts(text) {
    const ctx = this.ensureContext();
    if (!ctx) return false;
    // Do not hammer a server that has already told us it is unconfigured or
    // out of credit.
    if (this._ttsAvailable === false) return false;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TTS.timeoutMs);
    try {
      const res = await fetch(TTS.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.slice(0, 2000) }),
        signal: ac.signal,
      });
      if (!res.ok) {
        // Pull the upstream reason out so the log can say *why* (402 no credit,
        // 503 no voice id, ...) instead of a useless "HTTP 402".
        let detail = `TTS HTTP ${res.status}`;
        try {
          const j = await res.json();
          if (j?.error) detail = j.error;
        } catch { /* not json */ }
        this.lastTtsError = detail;
        if (res.status === 400 || res.status === 401 || res.status === 402 || res.status === 503) {
          this._ttsAvailable = false;
        }
        throw new Error(detail);
      }

      const bytes = await res.arrayBuffer();
      if (bytes.byteLength < 128) throw new Error('TTS returned no audio');

      const buffer = await ctx.decodeAudioData(bytes.slice(0));
      this._ttsAvailable = true;
      this.mode = 'tts';
      this.handlers.onmode('fish-audio');
      await this._playBuffer(buffer);
      return true;
    } catch (err) {
      if (!this.lastTtsError) this.lastTtsError = err.message;
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Play an already-decoded buffer through the analysable tap.
   *
   * Exposed so SentenceQueue can feed pre-synthesised audio, which is what lets
   * synthesis of the next sentence overlap playback of the current one.
   */
  async playBuffer(buffer) {
    this.ensureContext();
    return this._playBuffer(buffer);
  }

  /** Play an AudioBuffer through the analysable tap. */
  _playBuffer(buffer) {
    const ctx = this.ctx;
    return new Promise((resolve, reject) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.analyserNode);
      src.onended = () => {
        this.current = null;
        resolve();
      };
      src.onerror = (e) => reject(e);
      this.current = src;
      src.start();
    });
  }

  // ------------------------------------------------------------------- tier 2

  /**
   * Tier 2. Resolves true once the utterance ends (or immediately on error),
   * so the caller's `finally` block fires `onend` at the right moment.
   * @returns {Promise<boolean>}
   */
  _trySpeechSynthesis(text) {
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        this._utterance = null;
        resolve(ok);
      };
      try {
        const u = new SpeechSynthesisUtterance(text.slice(0, 600));
        u.rate = 1.02;
        u.pitch = 1.08;
        u.onend = () => finish(true);
        u.onerror = () => finish(false);
        this._utterance = u;
        this.mode = 'speechSynthesis';
        this.handlers.onmode('speechSynthesis');
        window.speechSynthesis.speak(u);
        // If the platform never fires onend (known on some Linux/WSL setups),
        // fall through to the synthetic voice after a bounded wait.
        const guardMs = Math.min(20_000, 2000 + text.length * 90);
        setTimeout(() => {
          if (!settled && !window.speechSynthesis.speaking) finish(true);
          else if (!settled) {
            try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
            finish(false);
          }
        }, guardMs);
      } catch {
        finish(false);
      }
    });
  }

  // ------------------------------------------------------------------- tier 3

  /**
   * Procedural formant voice.
   *
   * A sawtooth glottal source through three bandpass "formants" (F1/F2/F3),
   * with one vowel per syllable. Because it is a genuine audio signal, the
   * LipSync analyser sees real spectral energy and drives `aa`/`ih`/`ou` from
   * it exactly as it would for TTS output.
   */
  async _playSynthetic(text) {
    const ctx = this.ensureContext();
    if (!ctx) return;

    // ~1 syllable per 2.4 characters, roughly conversational.
    const syllables = Math.max(1, Math.min(60, Math.round(text.length / 2.4)));
    const rate = 4.6;                              // syllables per second
    const syllableLen = 1 / rate;
    const duration = Math.min(20, syllables * syllableLen + 0.35);
    const sr = 22050;

    const VOWELS = [
      { f1: 730, f2: 1090, f3: 2440 }, // "ah"
      { f1: 270, f2: 2290, f3: 3010 }, // "ee"
      { f1: 300, f2: 870, f3: 2240 },  // "oo"
      { f1: 530, f2: 1840, f3: 2480 }, // "eh"
      { f1: 570, f2: 840, f3: 2410 },  // "oh"
      { f1: 440, f2: 1020, f3: 2240 }, // "uh"
    ];

    const offline = new OfflineAudioContext(1, Math.ceil(duration * sr), sr);

    // Glottal source with a little pitch drift so it is not a flat tone.
    const osc = offline.createOscillator();
    osc.type = 'sawtooth';
    const basePitch = 168;
    osc.frequency.setValueAtTime(basePitch, 0);
    const vibrato = offline.createOscillator();
    vibrato.frequency.value = 4.8;
    const vibratoGain = offline.createGain();
    vibratoGain.gain.value = 5.5;
    vibrato.connect(vibratoGain).connect(osc.frequency);

    // Three formants in parallel.
    const formantGains = [];
    const mix = offline.createGain();
    mix.gain.value = 0;
    for (let i = 0; i < 3; i++) {
      const bp = offline.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = VOWELS[0][`f${i + 1}`];
      bp.Q.value = [7, 9, 11][i];
      const g = offline.createGain();
      g.gain.value = [1, 0.55, 0.22][i];
      osc.connect(bp).connect(g).connect(mix);
      formantGains.push({ bp, g, key: `f${i + 1}` });
    }
    mix.connect(offline.destination);

    // Syllabic amplitude envelope; the gaps are what make `sil` fire.
    for (let s = 0; s < syllables; s++) {
      const t0 = 0.05 + s * syllableLen;
      const t1 = Math.min(duration - 0.05, t0 + syllableLen * 0.82);
      if (t0 >= duration - 0.05) break;

      const vowel = VOWELS[Math.floor(Math.random() * VOWELS.length)];
      for (const fg of formantGains) {
        const target = vowel[fg.key];
        fg.bp.frequency.setTargetAtTime(target * (0.94 + Math.random() * 0.12), t0, 0.02);
      }
      // Slight pitch fall across each syllable, like real prosody.
      osc.frequency.setTargetAtTime(basePitch * (0.95 + Math.random() * 0.12), t0, 0.03);

      const peak = 0.26 + Math.random() * 0.2;
      mix.gain.setTargetAtTime(peak, t0, 0.018);        // quick onset
      mix.gain.setTargetAtTime(peak * 0.5, t0 + syllableLen * 0.4, 0.04);
      mix.gain.setTargetAtTime(0.0001, t1, 0.03);      // release into the gap
    }

    osc.start(0);
    vibrato.start(0);
    const rendered = await offline.startRendering();

    this.mode = 'synthetic';
    this.handlers.onmode('synthetic');
    await this._playBuffer(rendered);
  }
}
