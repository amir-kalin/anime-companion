// The persistent execution environment.
//
// This is the piece the vendor docs call the "execution environment" that must outlive a single
// API turn: "Keep the environment available between calls so the model can build on earlier work"
// and "Save reusable variables on globalThis."
//
// Design decisions that follow from that requirement and from the isolation guidance:
//
//  * One `vm` context is created once and reused. Each `run` compiles a fresh async IIFE into that
//    same context, so `globalThis.x = ...` survives but top-level `const` does not — which is why
//    the tool description tells the model to stash state on `globalThis`.
//  * The context is a bare ECMAScript realm. Node's `process`, `require`, and `fetch` are not
//    intrinsics, so they are absent; the model cannot reach the host without going through the
//    allowlisted objects below. `test/sandbox-isolation.mjs` asserts this rather than trusting it.
//  * `log()` and `display()` are the observation channel. They are functions, not tool calls,
//    because a program that takes a screenshot mid-loop must be able to show it without spending
//    a round trip.

import vm from 'node:vm';

const DEFAULT_MAX_TEXT = 8000;
const DEFAULT_MAX_IMAGES = 4;

export class Sandbox {
  /** Globals the harness injects, so `inspectGlobals` reports only model-created state. */
  static INTERNAL_GLOBALS = [
    'page', 'log', 'display', 'console', 'sleep',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
    'performance', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
    'structuredClone', 'atob', 'btoa',
  ];
  #context;
  #page;
  #opts;
  #log = [];
  #images = [];
  #intervals;
  #stepTimeoutMs;
  #wallTimeoutMs;

  constructor({ page, stepTimeoutMs = 15_000, wallTimeoutMs = 30_000, maxText = DEFAULT_MAX_TEXT, maxImages = DEFAULT_MAX_IMAGES } = {}) {
    this.#page = page;
    this.#opts = { maxText, maxImages };
    this.#stepTimeoutMs = stepTimeoutMs;
    this.#wallTimeoutMs = wallTimeoutMs;

    const self = this;

    // Observation channel. Both are callable from inside a running program, which is what lets a
    // model inspect mid-loop state without ending its turn.
    const log = (...args) => {
      const line = args
        .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
        .join(' ');
      self.#log.push(line);
      if (self.#log.join('\n').length > maxText * 4) self.#log.shift();
      return undefined;
    };

    const display = (image, caption = '') => {
      const url = toDataUrl(image);
      if (!url) {
        log(`display() ignored: expected a screenshot frame or data URL, got ${typeof image}`);
        return false;
      }
      self.#images.push({ url, caption: String(caption) });
      if (self.#images.length > maxImages * 3) self.#images.shift();
      return true;
    };

    // Intervals are tracked so they cannot outlive the run and keep the process alive. Timeouts are
    // bounded by the wall-clock budget in run() and left to expire.
    this.#intervals = new Set();

    // Injected surface. Nothing else from the host is reachable.
    this.#context = vm.createContext({
      page,
      log,
      display,
      console: { log, info: log, warn: log, error: log },
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(Number(ms) || 0, 10_000))),
      // Timers, because a program written by a competent model reaches for them constantly. Without
      // these, `await new Promise(r => setTimeout(r, 500))` — the most natural way to wait for a page
      // to render — dies with "setTimeout is not defined", which reads as a sandbox bug rather than a
      // missing builtin.
      setTimeout: (fn, ms = 0, ...args) =>
        setTimeout(fn, Math.min(Math.max(Number(ms) || 0, 0), 60_000), ...args),
      clearTimeout: (id) => clearTimeout(id),
      setInterval: (fn, ms = 0, ...args) => {
        const id = setInterval(fn, Math.max(Number(ms) || 0, 16), ...args);
        this.#intervals.add(id);
        return id;
      },
      clearInterval: (id) => {
        clearInterval(id);
        this.#intervals.delete(id);
      },
      queueMicrotask: (fn) => queueMicrotask(fn),
      performance: { now: () => performance.now() },

      // Web platform globals that Node adds to `globalThis` and a bare vm realm therefore does not
      // have. A model writing ordinary JavaScript reaches for these constantly — `new URL(...)` to
      // parse a link it just read off the page is the obvious example — and "URL is not defined" reads
      // as a sandbox bug rather than a missing builtin.
      //
      // Deliberately limited to pure, side-effect-free constructors. `fetch` stays out (it is an
      // egress hole), as do `Buffer` (host-adjacent) and `crypto` (capability the page API does not
      // need and should not silently grant).
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      structuredClone,
      atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
      btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    });
  }

  /** Persisted variables the model stashed, for the operator UI to show. */
  inspectGlobals() {
    return vm.runInContext(
      `Object.keys(globalThis).filter(k => !${JSON.stringify(Sandbox.INTERNAL_GLOBALS)}.includes(k))`,
      this.#context,
    );
  }

  /** Drop all persisted state and stop any interval the program left running. */
  reset() {
    this.#log = [];
    this.#images = [];
    // An interval the program started would otherwise keep firing — and keep the process alive —
    // long after the step that created it.
    for (const id of this.#intervals) clearInterval(id);
    this.#intervals.clear();
    for (const key of this.inspectGlobals()) {
      try { vm.runInContext(`delete globalThis[${JSON.stringify(key)}]`, this.#context); } catch { /* ignore */ }
    }
  }

  /** Release timers and forget the environment. Call on shutdown. */
  dispose() {
    this.reset();
  }

  /**
   * Execute one program and collect its observations.
   *
   * `timeout` in vm.runInContext bounds synchronous execution only. An `await` on something the
   * host never settles would slip past it, so a wall-clock deadline is enforced here as well and
   * the result is marked timed out rather than silently hanging the run.
   */
  async run(code) {
    this.#log = [];
    this.#images = [];

    const source = typeof code === 'string' ? code : String(code ?? '');
    if (!source.trim()) {
      return { ok: true, text: '', images: [], logs: [], error: null };
    }

    const wrapped = `(async () => {\n${source}\n})()`;
    const started = Date.now();
    let value;
    let error = null;
    let timedOut = false;

    try {
      const result = vm.runInContext(wrapped, this.#context, {
        timeout: this.#stepTimeoutMs,
        filename: 'agent-step.js',
      });
      // Race the async result against a wall clock; vm's timeout does not cover pending promises.
      value = await Promise.race([
        result,
        new Promise((_, reject) => {
          const t = setTimeout(() => {
            timedOut = true;
            reject(new Error(`Step exceeded its ${this.#wallTimeoutMs}ms wall-clock budget.`));
          }, this.#wallTimeoutMs);
          t.unref?.();
        }),
      ]);
    } catch (err) {
      error = err;
    }

    const logs = this.#log.slice();
    const images = this.#images.slice();

    // A program that printed nothing still has to say something, so the returned value is folded
    // into the text channel. This is the difference between a model that can self-correct and one
    // that has to guess whether its step worked.
    let returnedText = '';
    if (value !== undefined && value !== null) {
      returnedText = typeof value === 'string' ? value : safeStringify(value);
    }

    const text = [logs.join('\n'), returnedText].filter((s) => s && s.trim()).join('\n').slice(0, this.#opts.maxText);

    return {
      ok: !error,
      text,
      images,
      logs,
      error: error ? describeError(error, timedOut) : null,
      durationMs: Date.now() - started,
    };
  }
}

function describeError(err, timedOut) {
  const name = err?.name ?? 'Error';
  const message = err?.message ?? String(err);
  if (timedOut) return `${name}: ${message}`;
  // A stack from inside the sandbox is noise; the message is what the model can act on.
  return `${name}: ${message}`;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'function' ? '[fn]' : v), 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Accept a Frame, a data URL, or raw bytes, and normalize to a PNG data URL. */
function toDataUrl(image) {
  if (!image) return null;
  if (typeof image === 'string') {
    return image.startsWith('data:image/') ? image : null;
  }
  if (image.dataUrl && typeof image.dataUrl === 'string') return image.dataUrl;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(image)) {
    return `data:image/png;base64,${image.toString('base64')}`;
  }
  return null;
}