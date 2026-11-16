import { INACTIVITY, STATES, SEATED_STATES } from '../utils/config.js';

/**
 * InactivityManager
 *
 * Watches for a sustained stretch of no user speech or input and fires
 * BORED, then lets the controller hand back to IDLE and restarts the clock.
 *
 * Design notes:
 *  - The timer is driven by real elapsed time, not frame count, so a
 *    backgrounded tab does not fast-forward into BORED on return.
 *  - A cooldown after a BORED clip stops the character from immediately
 *    re-entering BORED, which would otherwise look like a seizure.
 *  - `notifyActivity()` is called on speech start, speech end, pointer input
 *    and key presses; the *last* activity time always wins.
 */
export class InactivityManager {
  /**
   * @param {object} opts
   * @param {(state: string) => void} opts.onBored  fired when BORED should start
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.cooldownMs]
   * @param {() => number} [opts.now] injectable clock, for tests
   */
  constructor({ onBored, timeoutMs = INACTIVITY.timeoutMs, cooldownMs = INACTIVITY.cooldownMs, now = () => performance.now() } = {}) {
    this.onBored = onBored || (() => {});
    this.timeoutMs = timeoutMs;
    this.cooldownMs = cooldownMs;
    this.now = now;

    this.lastActivity = this.now();
    this.boredUntil = 0;
    this.boredCount = 0;
    this.enabled = true;
  }

  /** Any user speech or input resets the countdown. */
  notifyActivity() {
    this.lastActivity = this.now();
  }

  /** Called after a BORED clip finishes, so the clock restarts cleanly. */
  notifyBoredComplete() {
    this.boredUntil = this.now() + this.cooldownMs;
    this.lastActivity = this.now();
  }

  reset() {
    this.lastActivity = this.now();
    this.boredUntil = 0;
  }

  /** @returns {number} 0..1, 1 = BORED is about to fire */
  get progress() {
    if (!this.enabled) return 0;
    return Math.min(1, (this.now() - this.lastActivity) / this.timeoutMs);
  }

  get remainingMs() {
    return Math.max(0, this.timeoutMs - (this.now() - this.lastActivity));
  }

  /**
   * @param {number} dt
   * @param {string} currentState
   * @returns {boolean} true on the frame BORED should be entered
   */
  update(dt, currentState) {
    if (!this.enabled) return false;
    const t = this.now();
    if (t < this.boredUntil) return false;
    if (currentState === STATES.BORED) return false;
    // Never interrupt speech.
    if (currentState === STATES.TALKING) {
      // Talking counts as activity, so keep the clock fresh.
      this.lastActivity = t;
      return false;
    }
    // BORED is a standing clip. Firing it while she is seated cross-fades her
    // out of the chair onto her feet, which reads as standing up mid-sulking -
    // and it was happening even on the very first idle tick after sitting down.
    // Sitting is already a resting state, so the timer is simply held.
    if (SEATED_STATES.has(currentState)) {
      this.lastActivity = t;
      return false;
    }
    if (t - this.lastActivity >= this.timeoutMs) {
      this.boredCount++;
      // Consume the elapsed time so it does not immediately re-trigger.
      this.lastActivity = t;
      return true;
    }
    return false;
  }
}
