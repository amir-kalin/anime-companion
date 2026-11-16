// Feasibility probe: drive a real browser with ZERO npm dependencies.
// Uses Node 24's built-in global WebSocket + Chrome DevTools Protocol.
// Verifies the three perception channels the harness needs:
//   1. pixels  -> Page.captureScreenshot
//   2. semantics-> Accessibility.getFullAXTree  (the a11y tree)
//   3. input   -> Input.dispatchMouseEvent / dispatchKeyEvent
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const profile = mkdtempSync(join(tmpdir(), 'hui-probe-'));

console.log('global WebSocket available:', typeof WebSocket);
const proc = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-networking',
  '--window-size=1440,900',
  'about:blank',
], { stdio: 'ignore', env: { ...process.env } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('browser devtools endpoint never came up');
}

try {
  const version = await waitForTarget();
  console.log('CDP endpoint:', version.Browser, version.webSocketDebuggerUrl ? '(browser ws ok)' : '');

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  console.log('page target:', page.url, 'ws:', Boolean(page.webSocketDebuggerUrl));

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });

  console.log('ws connected, roundtrip test:');
  console.log('  ', JSON.stringify(await send('Browser.getVersion')).slice(0, 90));

  // --- channel 2: semantics. load a page with real ARIA, then read the a11y tree
  const HTML = `<!doctype html><meta charset=utf-8><title>probe</title>
    <body style="font:16px system-ui;padding:24px">
      <h1>Probe</h1>
      <label for=q>Search</label><input id=q role=textbox aria-label="Search anime">
      <button aria-label="Apply filters">Apply</button>
      <canvas id=c width=120 height=40 style="border:1px solid #333"></canvas>
      <script>document.getElementById('c').getContext('2d').fillText('canvas px',4,24)</script>
    </body>`;

  await send('Page.enable');
  await send('DOM.enable');
  await send('Accessibility.enable');
  await send('Page.navigate', { url: `data:text/html;charset=utf-8,${encodeURIComponent(HTML)}` });
  await sleep(700);

  // --- channel 1: pixels
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  console.log('screenshot base64 bytes:', shot.data.length);
  console.log('node Buffer decodes it:', Buffer.from(shot.data, 'base64').subarray(0, 8).toString('hex'));

  const ax = await send('Accessibility.getFullAXTree');
  const interesting = ax.nodes
    .filter((n) => ['textbox', 'button', 'heading'].includes(n.role?.value))
    .map((n) => `${n.role.value} "${n.name?.value ?? ''}"`);
  console.log('a11y semantic nodes found:', JSON.stringify(interesting));

  const noA11y = ax.nodes.filter((n) => n.role?.value === 'canvas' || n.role?.value === 'generic').length;
  console.log('canvas/generic (no usable name) nodes -> coordinate-only targets:', noA11y);

  // --- channel 3: input
  const box = await send('DOM.getDocument');
  console.log('DOM.getDocument depth:', box.root.nodeId);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 100, y: 100, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 100, y: 100, button: 'left', clickCount: 1 });
  console.log('synthetic mouse event dispatched: ok');

  ws.close();
  console.log('\nPROBE PASS: pixels + a11y-tree + synthetic input all reachable with zero deps.');
} finally {
  try { proc.kill(); } catch { /* already gone */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
}