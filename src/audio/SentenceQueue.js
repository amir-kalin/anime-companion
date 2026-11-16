/**
 * SentenceQueue
 *
 * Serialises a pipeline where sentences arrive faster than they can be spoken:
 *
 *     model streams sentence -> POST /tts -> queue -> play in order
 *
 * Synthesis for sentence N+1 starts while sentence N is still playing, so the
 * only silence is the small gap between clips. Without this the mouth would
 * stutter, and without overlapping, generation latency would be paid up front.
 */
export class SentenceQueue {
  /**
   * @param {object} opts
   * @param {(text: string) => Promise<AudioBuffer>} opts.synthesise
   * @param {(buffer: AudioBuffer) => Promise<void>} opts.play
   * @param {() => void} [opts.onFirstAudio] fired once, when playback actually starts
   */
  constructor({ synthesise, play, onFirstAudio }) {
    this.synthesise = synthesise;
    this.play = play;
    this.onFirstAudio = onFirstAudio;
    this.queue = [];
    this.synthTasks = [];
    this.busy = false;
    this.started = false;
    this.cancelled = false;
  }

  get pending() {
    return this.queue.length;
  }

  /** Enqueue a completed sentence and immediately start synthesis in parallel. */
  push(text) {
    const t = String(text || '').trim();
    if (!t || this.cancelled) return;
    this.queue.push(t);
    // Start synthesis immediately so sentence N+1 generates while sentence N is playing!
    const task = Promise.resolve().then(() => this.synthesise(t)).catch(() => null);
    this.synthTasks.push(task);
    this._drain();
  }

  /** Resolve once everything queued has been spoken. */
  async waitForDrain() {
    while (this.busy || this.queue.length || this.synthTasks.length) {
      await new Promise((r) => setTimeout(r, 30));
      if (this.cancelled) return;
    }
  }

  cancel() {
    this.cancelled = true;
    this.queue.length = 0;
    this.synthTasks.length = 0;
  }

  reset() {
    this.cancelled = false;
    this.queue.length = 0;
    this.synthTasks.length = 0;
    this.busy = false;
    this.started = false;
  }

  async _drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length && !this.cancelled) {
        this.queue.shift();
        const task = this.synthTasks.shift();
        let buffer = null;
        try {
          buffer = task ? await task : null;
        } catch {
          buffer = null; // skip unspeakable sentence rather than stall
        }
        if (this.cancelled) return;
        if (buffer) {
          if (!this.started) {
            this.started = true;
            // TALKING begins on real audio, not on the request.
            this.onFirstAudio?.();
          }
          await this.play(buffer);
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
