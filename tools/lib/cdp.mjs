import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Shared Chrome DevTools Protocol plumbing for the headless tools.
 *
 * Everything here is about one problem: driving a real browser from Node
 * with no browser-automation dependency, so the tools work the same on every
 * machine that has Chrome installed.
 */

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export function findChrome() {
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  throw new Error('No Chrome or Edge found on this machine.');
}

/** Minimal CDP client over the DevTools WebSocket. */
export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} ${JSON.stringify(msg.error.data ?? '')}`));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 60000);
    });
  }

  /** Evaluate an expression in the page and return its value. */
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`page threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`);
    }
    return r.result.value;
  }
}

async function waitForEndpoint(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Chrome DevTools endpoint never came up.');
}

async function findPageTarget(port) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) return page;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('No page target found.');
}

/**
 * Launch a headless Chrome and attach to it.
 *
 * @param {object} [opts]
 * @param {number} [opts.port]      DevTools port.
 * @param {object} [opts.metrics]   device metrics override (width/height/dpr/mobile).
 * @param {boolean} [opts.touch]    emulate touch events.
 * @returns {Promise<{cdp: CDP, close: () => Promise<void>}>}
 */
export async function launchChrome({ port = 9333, metrics = null, touch = false, extraArgs = [] } = {}) {
  const chrome = findChrome();
  const profile = mkdtempSync(join(tmpdir(), 'cdp-profile-'));
  const child = spawn(chrome, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--hide-scrollbars',
    ...extraArgs,
    'about:blank',
  ], { stdio: 'ignore' });

  let cdp = null;
  try {
    await waitForEndpoint(port);
    const page = await findPageTarget(port);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    cdp = new CDP(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');

    if (metrics) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: metrics.width,
        height: metrics.height,
        deviceScaleFactor: metrics.dpr ?? 3,
        mobile: metrics.mobile ?? true,
        screenWidth: metrics.width,
        screenHeight: metrics.height,
      });
    }
    if (touch) {
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await cdp.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
    }
  } catch (e) {
    child.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
    throw e;
  }

  return {
    cdp,
    async close() {
      try { cdp?.ws.close(); } catch { /* already closed */ }
      child.kill();
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}
