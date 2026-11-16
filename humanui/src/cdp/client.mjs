// Minimal Chrome DevTools Protocol client.
//
// No dependencies on purpose. Node >= 22 ships a global WebSocket, which is the only
// non-builtin this layer needs; everything else is HTTP against /json and /json/version.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BROWSER_CANDIDATES = [
  process.env.HUMANUI_BROWSER,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export function findBrowser() {
  const found = BROWSER_CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      'No Chrome/Chromium binary found. Set HUMANUI_BROWSER to an explicit path.\nTried:\n  ' +
        BROWSER_CANDIDATES.join('\n  '),
    );
  }
  return found;
}

/** Poll the /json/version endpoint until the browser's debugging port answers. */
async function waitForDevTools(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch (err) {
      lastErr = err;
    }
    await sleep(120);
  }
  throw new Error(`DevTools endpoint on port ${port} never responded. ${lastErr?.message ?? ''}`);
}

/**
 * Resolve the actual debugging port.
 *
 * Passing --remote-debugging-port=0 makes Chromium pick a free port and write it to
 * `DevToolsActivePort` inside the user-data-dir. That avoids the port collisions you get
 * with a hardcoded port when several runs overlap.
 */
async function resolvePort(profileDir, proc) {
  const portFile = join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    // Chromium writes this file while still holding it open, so on Windows the read can fail with
    // EBUSY or return a partial line. Both mean "not ready yet", not "failed" — treating a transient
    // lock as fatal makes the whole harness fail to boot on the machine that is running it.
    try {
      const raw = readFileSync(portFile, 'utf8').split(/\r?\n/);
      const port = Number(raw[0]);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      // locked, missing, or mid-write: fall through and retry
    }
    if (proc.exitCode !== null) {
      throw new Error(`Browser exited early (code ${proc.exitCode}) before opening a debug port.`);
    }
    await sleep(80);
  }
  throw new Error('Browser never wrote DevToolsActivePort.');
}

/**
 * A CDP session multiplexed over one WebSocket.
 *
 * `send` resolves the matching `id`. `on` registers protocol-event listeners. `once` resolves the
 * first time an event matching `predicate` arrives, which is how navigation and load are awaited
 * without racing the network stack.
 */
export class CdpSession {
  #ws;
  #nextId = 0;
  #pending = new Map();
  #listeners = new Set();
  #closed = false;

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => this.#onMessage(ev.data));
    ws.addEventListener('close', () => {
      this.#closed = true;
      for (const { reject } of this.#pending.values()) {
        reject(new Error('CDP connection closed'));
      }
      this.#pending.clear();
    });
  }

  static async connect(wsUrl, timeoutMs = 15_000) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onErr = () => { cleanup(); reject(new Error(`Could not open CDP WebSocket: ${wsUrl}`)); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('CDP WebSocket open timed out')); }, timeoutMs);
      function cleanup() {
        clearTimeout(timer);
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onErr);
      }
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onErr);
    });
    return new CdpSession(ws);
  }

  #onMessage(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.id !== undefined && this.#pending.has(msg.id)) {
      const { resolve, reject } = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? ` — ${msg.error.data}` : ''}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      for (const entry of this.#listeners) {
        try { entry(msg.method, msg.params ?? {}); } catch { /* listener errors must not kill the socket */ }
      }
    }
  }

  send(method, params = {}) {
    if (this.#closed) return Promise.reject(new Error(`CDP closed; cannot send ${method}`));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(handler) {
    this.#listeners.add(handler);
    return () => this.#listeners.delete(handler);
  }

  once(predicate, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const off = this.on((method, params) => {
        if (!predicate(method, params)) return;
        clearTimeout(timer);
        off();
        resolve({ method, params });
      });
      const timer = setTimeout(() => { off(); reject(new Error('CDP event timed out')); }, timeoutMs);
    });
  }

  close() {
    this.#closed = true;
    try { this.#ws.close(); } catch { /* already gone */ }
  }
}

/**
 * A swappable stand-in for a CDP session.
 *
 * Everything downstream — page, accessibility index, screenshot helpers — takes a "session" and only
 * ever calls `send`, `on`, and `once`. If this object implements exactly that surface, a tab switch is
 * one assignment here and zero edits anywhere else, which is the difference between a fix that lands
 * and a refactor that stalls.
 *
 * Swapping is not cosmetic. A click that spawns a popup leaves two page targets, and the agent has to
 * be able to move between them; without that, it keeps reading the document the user has navigated
 * away from.
 */
export class SessionHolder {
  #session;
  #handlers = new Map();   // handler -> unsubscribe, for the live session
  #setup = [];             // per-session initializers, re-run after a swap
  #onSwap = () => {};

  constructor(session) {
    this.#session = session;
  }

  get current() { return this.#session; }

  /** Called after a swap, so owners can drop state tied to the old tab. */
  onSwap(fn) { this.#onSwap = fn; }

  /**
   * Register work that must be redone for every session.
   *
   * Network interception and the pinned viewport are both per-target, not per-browser: a tab opened
   * by a click arrives with neither. A control that silently stops applying to a new tab is worse than
   * one that was never enabled, because it looks like it is working.
   */
  onNewSession(fn) { this.#setup.push(fn); }

  send(method, params) { return this.#session.send(method, params); }

  /**
   * Register a protocol-event listener against the live session.
   *
   * Binding happens here, immediately. Deferring it until the next swap silently drops any listener
   * registered after startup, which is exactly how a network guard ends up enabled on paper and inert
   * in practice.
   */
  on(handler) {
    if (!this.#handlers.has(handler)) {
      this.#handlers.set(handler, this.#session.on(handler));
    }
    return () => this.#unbind(handler);
  }

  #unbind(handler) {
    const off = this.#handlers.get(handler);
    this.#handlers.delete(handler);
    if (off) { try { off(); } catch { /* listener already gone */ } }
  }

  once(predicate, timeoutMs) {
    return this.#session.once(predicate, timeoutMs);
  }

  static async enableDomains(session) {
    for (const method of ['Page.enable', 'Runtime.enable', 'DOM.enable', 'Accessibility.enable', 'Network.enable']) {
      await session.send(method);
    }
    return session;
  }

  /** Wrap a freshly connected raw session, enabling standard domains and per-session setup. */
  static async attach(rawSession) {
    const holder = new SessionHolder(rawSession);
    await SessionHolder.enableDomains(rawSession);
    await holder.#runSetup();
    return holder;
  }

  async #runSetup() {
    for (const fn of this.#setup) {
      try { await fn(this.#session); } catch (err) {
        console.warn(`[humanui] per-session setup failed: ${err.message}`);
      }
    }
  }

  /** Move to a new target: rebind listeners, re-run per-session setup, then notify owners. */
  async replace(rawSession) {
    const handlers = [...this.#handlers.keys()];
    for (const handler of handlers) this.#unbind(handler);

    const old = this.#session;
    this.#session = rawSession;
    for (const handler of handlers) this.#handlers.set(handler, rawSession.on(handler));

    await this.#runSetup();
    this.#onSwap(rawSession, old);
    try { old.close(); } catch { /* already closed */ }
    return rawSession;
  }

  close() {
    for (const handler of [...this.#handlers.keys()]) this.#unbind(handler);
    try { this.#session.close(); } catch { /* already closed */ }
  }
}

/**
 * List the browser's page targets.
 *
 * Uses the HTTP endpoint rather than the browser-level WebSocket: it is a single cheap round trip on
 * loopback, and it does not require a second connection just to enumerate tabs.
 */
export async function listPageTargets(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return targets
    .filter((t) => t.type === 'page')
    .map((t) => ({ id: t.id, url: t.url, title: t.title, wsUrl: t.webSocketDebuggerUrl }));
}

/**
 * Launch an isolated browser and attach a CDP session to its first page target.
 *
 * The isolation flags follow the vendor guidance for local browser automation: a throwaway
 * profile so no credentials or extensions leak in, and extensions disabled.
 */
export async function launchBrowser(options = {}) {
  const {
    width = 1440,
    height = 900,
    headless = true,
    executablePath = findBrowser(),
    extraArgs = [],
  } = options;

  const profileDir = mkdtempSync(join(tmpdir(), 'humanui-profile-'));
  const proc = spawn(
    executablePath,
    [
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-features=Translate,MediaRouter',
      '--no-sandbox',
      '--lang=en-US',
      // Media: a page with a <video> is the canonical "the tree cannot describe this" surface, so the
      // harness has to be able to drive one. Autoplay is permitted because the harness's clicks are
      // real trusted events, but headless has no audio device and no user gesture worth waiting for.
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      // Keeps `navigator.webdriver` from being the only tell. Standard automation hygiene; it does not
      // bypass authentication or any access control.
      '--disable-blink-features=AutomationControlled',
      `--window-size=${width},${height}`,
      ...extraArgs,
      'about:blank',
    ],
    {
      // Keep the browser's own env predictable rather than inheriting ambient host config.
      env: { ...process.env, LANG: 'en-US' },
      stdio: 'ignore',
    },
  );

  let session = null;
  try {
    const port = await resolvePort(profileDir, proc);
    await waitForDevTools(port);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('Browser launched but exposed no page target.');

    const raw = await CdpSession.connect(page.webSocketDebuggerUrl);
    session = await SessionHolder.attach(raw);

    // Pin the layout viewport so screenshot pixels and viewport coordinates share one frame.
    await session.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
    });

    return {
      // The holder, not the raw session: it quacks identically but can be swapped when a click opens
      // a new tab, which a single-target session cannot survive.
      session,
      port,
      async close() {
        try { session.close(); } catch { /* already closed */ }
        try { proc.kill(); } catch { /* already dead */ }
        await sleep(150);
        try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
      },
    };
  } catch (err) {
    try { proc.kill(); } catch { /* already dead */ }
    try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw err;
  }
}

export { sleep };