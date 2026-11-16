// Human-in-the-loop approval, enforced inside the executor.
//
// Both vendors place the check in the same spot and give the same reason for it:
//
//   "Have a human confirm consequential actions ... and make that check in your executor before
//    each block runs, because one turn can carry several."            — Anthropic
//   "Confirm consequential actions. Keep users in control of purchases, data transmission,
//    destructive changes, and other actions that are hard to reverse." — OpenAI
//
// The clause "because one turn can carry several" is the whole design constraint. A confirmation
// wrapped around the model turn is both too coarse and too late, because with batching (or with
// code execution, which is strictly more powerful) the agent can reach a purchase and the delete
// that follows it inside one turn. So this module is wired into `page`'s gate, per side effect.
//
// Default posture is fail-closed: if no operator answers in time, the action is denied.

/** Destructive or irreversible verbs. Matched against an accessible name or a node descriptor. */
const DESTRUCTIVE = /\b(delete|deleting|remove|removing|wipe|erase|purge|clear all|destroy|drop|revoke|terminate|reset all|empty)\b/i;

/** Spend, commitment, or agreement. */
const COMMITMENT = /\b(buy|purchase|pay|checkout|check out|subscribe|order|place order|confirm order|upgrade|donate|send money|transfer)\b/i;

/** Anything that needs affirmative consent. */
const CONSENT = /\b(accept|agree|authorize|grant|allow|enable|confirm|approve|sign|verify)\b/i;

/**
 * Sensitive field types, where typing is itself a transmission.
 *
 * The alternation must be REQUIRED. Written with an optional group — `(...)?` — this collapses to
 * matching a bare `type=`, which flags every form field on the page as sensitive and makes the
 * interlock fire constantly. Getting this right is what keeps operators actually reading the prompts.
 */
const SENSITIVE_INPUT = /type="?(password|email|tel|number)"?/i;

/** Where sensitive data is headed. A submit to one of these is a transmission. */
const TRANSMIT = /\b(submit|send|post|share|upload|invite|register|sign up|checkout)\b/i;

export const RISK = { NONE: 'none', LOW: 'low', HIGH: 'high' };

/**
 * Classify a single gated action.
 *
 * Deliberately conservative and explainable: every verdict carries the rule that produced it, so the
 * operator sees *why* they are being asked rather than a generic "are you sure?".
 */
export function classifyRisk(action, { elementHtml = '' } = {}) {
  // Prefer the browser-computed accessible name; fall back to the node descriptor for cases where
  // there is no name (a bare coordinate click, for instance).
  const name = String(action.name ?? action.node ?? action.via ?? action.sample ?? '');

  if (action.kind === 'type' || action.kind === 'fill') {
    if (SENSITIVE_INPUT.test(elementHtml)) {
      return {
        risk: RISK.HIGH,
        rule: 'sensitive-field',
        reason: 'Typing into a password, email, or payment field counts as transmitting data.',
      };
    }
    // A long literal into a form is worth a glance even when the field is ordinary.
    if (Number(action.length ?? 0) > 80) {
      return { risk: RISK.LOW, rule: 'long-input', reason: 'A long value is about to be typed into the page.' };
    }
    return { risk: RISK.NONE };
  }

  if (action.kind === 'click' || action.kind === 'fill') {
    if (DESTRUCTIVE.test(name)) {
      return { risk: RISK.HIGH, rule: 'destructive', reason: `"${trim(name)}" looks destructive or irreversible.` };
    }
    if (COMMITMENT.test(name)) {
      return { risk: RISK.HIGH, rule: 'commitment', reason: `"${trim(name)}" looks like spending money or creating a commitment.` };
    }
    if (TRANSMIT.test(name) && SENSITIVE_INPUT.test(elementHtml)) {
      return { risk: RISK.HIGH, rule: 'transmission', reason: `"${trim(name)}" would transmit sensitive data.` };
    }
    if (CONSENT.test(name)) {
      return { risk: RISK.LOW, rule: 'consent', reason: `"${trim(name)}" looks like accepting terms or granting access.` };
    }
  }

  return { risk: RISK.NONE };
}

function trim(s) {
  const m = /"([^"]*)"/.exec(s);
  return (m ? m[1] : s).replace(/[<>\s]+/g, ' ').trim().slice(0, 60);
}

/**
 * Awaits an operator decision.
 *
 * High risk blocks until answered. Low risk resolves after `autoAllowAfterMs`, which is the
 * "pre-approval can be enough" case: the operator is given a window to intervene without the run
 * stalling forever if they are away.
 */
export class ApprovalBroker {
  #pending = new Map();
  #nextId = 1;
  #onRequest;
  #timeoutMs;

  constructor({ onRequest = () => {}, timeoutMs = 120_000, autoAllowAfterMs = 15_000, policy = {} } = {}) {
    this.#onRequest = onRequest;
    this.#timeoutMs = timeoutMs;
    this.autoAllowAfterMs = autoAllowAfterMs;
    this.policy = { mode: 'ask', ...policy };  // 'ask' | 'allow-all' | 'deny-all'
    this.decisions = [];
  }

  setMode(mode) {
    this.policy.mode = mode;
  }

  get pending() {
    return [...this.#pending.values()];
  }

  /**
   * Build the `onRisk` callback for `Page`.
   *
   * Returns a verdict object rather than throwing so the caller decides how to react; a denial still
   * surfaces as an exception from `page`, which is what stops the program mid-plan.
   */
  handler() {
    return async (action) => {
      const verdict = classifyRisk(action, this.policy);

      if (this.policy.mode === 'allow-all') return { allowed: true, risk: RISK.NONE, rule: 'allow-all' };
      if (this.policy.mode === 'deny-all' && verdict.risk !== RISK.NONE) {
        return { allowed: false, reason: `deny-all mode blocked this action (${verdict.rule}).` };
      }
      if (verdict.risk === RISK.NONE) return { allowed: true, risk: RISK.NONE };

      if (verdict.risk === RISK.LOW) {
        const decision = await this.#ask(action, verdict, this.autoAllowAfterMs);
        this.decisions.push({ ...decision, auto: decision.auto });
        return decision.allowed
          ? { allowed: true, risk: verdict.risk, rule: verdict.rule }
          : { allowed: false, reason: decision.reason ?? 'operator declined' };
      }

      const decision = await this.#ask(action, verdict, this.#timeoutMs);
      this.decisions.push({ ...decision, auto: decision.auto });
      return decision.allowed
        ? { allowed: true, risk: verdict.risk, rule: verdict.rule }
        : { allowed: false, reason: decision.reason ?? 'operator declined' };
    };
  }

  #ask(action, verdict, timeoutMs) {
    const id = `ap_${this.#nextId++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        // Fail closed. An unanswered prompt for a destructive action must not proceed.
        resolve({ allowed: false, auto: true, reason: `no operator response within ${timeoutMs}ms; denied by default.` });
      }, timeoutMs);
      timer.unref?.();

      this.#pending.set(id, {
        id,
        action,
        verdict,
        resolve: (allowed, reason) => {
          clearTimeout(timer);
          this.#pending.delete(id);
          resolve({ allowed, reason, auto: false });
        },
      });

      this.#onRequest({ id, action, verdict });
    });
  }

  /** Called by the operator UI. */
  respond(id, allowed, reason) {
    const entry = this.#pending.get(id);
    if (!entry) return { ok: false, error: `no pending approval with id ${id}` };
    entry.resolve(Boolean(allowed), reason);
    return { ok: true };
  }
}