import { LIPSYNC } from '../utils/config.js';

/**
 * LipSync
 *
 * Turns the live audio signal driving the character into viseme weights.
 *
 * Method, and its honest limitations:
 *  - Jaw opening (`vrc.v_aa`, or `A` on simpler models) is driven by RMS
 *    loudness, with a fast attack and slow release so the mouth does not
 *    chatter on plosives and does not snap shut mid-word.
 *  - Lip *shaping* (`ih`/`e` for spread, `ou`/`oh` for rounded, `ss` for
 *    sibilants) is inferred from the spectral balance across three bands rather
 *    than from true formants. This is a real-time approximation, not a
 *    phoneme recogniser, but it tracks the difference between an "ee" and an
 *    "oo" well enough to read as speech.
 *  - `sil` is driven inversely to loudness so the resting pose is a closed
 *    mouth rather than a permanently open one.
 */
export class LipSync {
  constructor(audioContext) {
    this.ctx = audioContext;
    this.analyser = null;
    this.source = null;
    this.active = false;

    this.fftSize = 1024;
    this.timeData = null;
    this.freqData = null;

    this.level = 0;        // smoothed 0..1 loudness
    this.rms = 0;          // raw RMS of the latest frame
    this.weights = { sil: 1 };

    // Band edges in Hz; converted to bins once the sample rate is known.
    this.bands = { low: [90, 600], mid: [600, 2000], high: [2000, 4000], sibilant: [4000, 9000] };
    this._binRanges = null;
  }

  /**
   * Route an audio node into the analyser.
   * @param {AudioNode} node
   */
  attachSource(node) {
    this.detachSource();
    if (!this.ctx) return false;
    if (!this.analyser) {
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = this.fftSize;
      // Some smoothing in the node itself; the real envelope logic is below.
      this.analyser.smoothingTimeConstant = 0.35;
      this.timeData = new Float32Array(this.analyser.fftSize);
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
    }
    node.connect(this.analyser);
    this.source = node;
    this.active = true;
    this._computeBinRanges();
    this.reset();
    return true;
  }

  detachSource() {
    if (this.source && this.analyser) {
      try { this.source.disconnect(this.analyser); } catch { /* already gone */ }
    }
    this.source = null;
    this.active = false;
    this.reset();
  }

  _computeBinRanges() {
    if (!this.analyser) return;
    const nyquist = (this.ctx?.sampleRate || 44100) / 2;
    const bins = this.analyser.frequencyBinCount;
    const toBin = (hz) => Math.max(0, Math.min(bins - 1, Math.round((hz / nyquist) * bins)));
    this._binRanges = {};
    for (const [name, [lo, hi]] of Object.entries(this.bands)) {
      this._binRanges[name] = [toBin(lo), toBin(hi)];
    }
  }

  reset() {
    this.level = 0;
    this.rms = 0;
    this.weights = { sil: 1 };
  }

  /** RMS of the current time-domain window. */
  _readRms() {
    if (!this.analyser || !this.active) return 0;
    this.analyser.getFloatTimeDomainData(this.timeData);
    let sum = 0;
    for (let i = 0; i < this.timeData.length; i++) sum += this.timeData[i] * this.timeData[i];
    return Math.sqrt(sum / this.timeData.length);
  }

  /** Mean magnitude 0..1 for a named frequency band. */
  _band(name) {
    const range = this._binRanges?.[name];
    if (!range || !this.analyser) return 0;
    this.analyser.getByteFrequencyData(this.freqData);
    const [lo, hi] = range;
    let sum = 0;
    for (let i = lo; i < hi; i++) sum += this.freqData[i];
    const n = Math.max(1, hi - lo);
    return sum / n / 255;
  }

  /**
   * @param {number} dt seconds
   * @returns {Record<string, number>} viseme weights, always including `sil`
   */
  update(dt) {
    if (!this.active || !this.analyser) {
      this.weights = { sil: 1 };
      return this.weights;
    }

    this.rms = this._readRms();

    // Envelope follower: fast attack, slow release.
    const target = this.rms;
    const rising = target > this.level;
    const k = 1 - Math.pow(1 - (rising ? LIPSYNC.attack : LIPSYNC.release), dt * 60);
    this.level += (target - this.level) * Math.min(1, k * LIPSYNC.smoothing * 2);

    if (this.level < LIPSYNC.silenceRms) {
      // Silence: closed mouth, everything else off.
      const closed = 1 - this.level / LIPSYNC.silenceRms;
      this.weights = { sil: Math.max(0, Math.min(1, closed)) };
      return this.weights;
    }

    const low = this._band('low');
    const mid = this._band('mid');
    const high = this._band('high');
    const sib = this._band('sibilant');

    // Normalised loudness -> jaw aperture.
    const open = Math.min(1, this.level / LIPSYNC.rmsFullScale);

    // Spectral balance. `round` peaks on low-frequency-dominant voiced sounds
    // (oo/oh); `spread` peaks on mid/high (ee/ih); `hiss` on sibilants.
    const voiced = low + mid + high + 1e-6;
    const round = low / voiced;
    const spread = (mid + high) / voiced;
    const hiss = sib / (mid + sib + 1e-6);

    const s = LIPSYNC.shapingScale;
    const w = {
      sil: 0,
      aa: open,
      oh: open * round * s,
      ou: open * round * s * 0.8,
      ih: open * spread * s * 0.7,
      e: open * spread * s * 0.6,
      ss: Math.min(1, hiss * 1.4) * open * s,
      ff: Math.min(1, high / (high + mid + 1e-6)) * open * s * 0.5,
      nn: low * open * s * 0.35,
      kk: low * open * s * 0.3,
      ch: sib * open * s * 0.4,
      th: sib * open * s * 0.25,
      rr: spread * open * s * 0.3,
      dd: low * open * s * 0.3,
      pp: open * s * 0.25,
    };

    this.weights = w;
    return w;
  }

  /**
   * Envelope-driven fallback.
   *
   * The Web Speech API gives no access to its audio, so when the character is
   * speaking through `speechSynthesis` there is nothing for an AnalyserNode to
   * read and the mouth would freeze. This path substitutes a synthetic
   * syllabic envelope, so the lips still move at a conversational rate.
   *
   * It is an approximation: amplitude and a vowel "shape" are inferred from a
   * deterministic per-syllable hash rather than measured from the waveform.
   *
   * @param {number} dt
   * @param {number} level  0..1 loudness for this instant
   * @param {number} shape  0..1, 0 = rounded ("oo"), 1 = spread ("ee")
   */
  updateSynthetic(dt, level, shape = 0.5) {
    this.rms = level;
    const rising = level > this.level;
    const k = 1 - Math.pow(1 - (rising ? LIPSYNC.attack : LIPSYNC.release), dt * 60);
    this.level += (level - this.level) * Math.min(1, Math.max(0, k * LIPSYNC.smoothing * 2));

    if (this.level < LIPSYNC.silenceRms) {
      const closed = 1 - this.level / LIPSYNC.silenceRms;
      this.weights = { sil: Math.max(0, Math.min(1, closed)) };
      return this.weights;
    }

    const open = Math.min(1, this.level / LIPSYNC.rmsFullScale);
    const round = 1 - shape;
    const s = LIPSYNC.shapingScale;
    this.weights = {
      sil: 0,
      aa: open,
      oh: open * round * s,
      ou: open * round * s * 0.8,
      ih: open * shape * s * 0.7,
      e: open * shape * s * 0.6,
      ss: open * s * 0.3,
      nn: open * round * s * 0.3,
      pp: open * s * 0.25,
    };
    return this.weights;
  }
}
