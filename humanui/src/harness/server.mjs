// Operator server: static files, a JSON API, and an SSE stream for live run state.
//
// One run at a time. A second request while a run is active is rejected rather than queued, because
// two agents sharing one browser would interleave actions against the same page and produce
// telemetry that cannot be attributed to either.

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createStaticHandler } from './static.mjs';
import { AgentLoop, StaticPlanner } from '../agent/loop.mjs';
import { ModelClient, execTool } from '../agent/model.mjs';
import { createRuntime } from './runtime.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, '..', '..', 'public');

/** Scenarios used by the offline planner, so one click reproduces a full run with no model. */
export const SCENARIOS = {
  filter: {
    label: 'Filter the table, then read the result back',
    task: 'Search the watchlist for "penguin", apply the filters, and tell me how many titles match.',
    programs: [
      `// The semantic channel: read the accessibility tree, then act on a handle.
const snap = await page.snapshot({ filter: 'interactive' });
const line = snap.text.split('\\n').find((l) => l.startsWith('textbox "Search title"'));
const ref = /\\[(ref_\\d+)\\]/.exec(line)[1];
log('search field: ' + line);

await page.fill({ ref }, 'penguin');
await page.click({ role: 'button', name: 'Apply filters' });
log('banner: ' + await page.evaluate("document.getElementById('banner').textContent"));`,
    ],
  },

  channels: {
    label: 'Both channels: handles for the DOM, pixels for the canvas',
    task: 'Report what the page contains, then read the canvas chart by zooming into it.',
    programs: [
      `// Handles cover anything the accessibility tree describes.
const snap = await page.snapshot({ filter: 'all' });
globalThis.nodeCount = snap.text.split('\\n').filter(Boolean).length;
log('a11y nodes: ' + globalThis.nodeCount);

const hasCanvasNode = snap.text.split('\\n').some((l) => /^canvas\\b/.test(l));
log('canvas has an a11y node: ' + hasCanvasNode);

globalThis.chartBox = await page.evaluate(
  '(() => { const r = document.getElementById("chart").getBoundingClientRect();' +
  ' return [r.x, r.y, r.width, r.height]; })()',
);
log('chart box (viewport px): ' + JSON.stringify(globalThis.chartBox));`,
      `// globalThis survived the previous call, so the session persisted across steps.
log('recovered from globalThis: ' + JSON.stringify(globalThis.chartBox));

const [x, y, w, h] = globalThis.chartBox;
const zoom = await page.zoom([x, y, x + w, y + h]);
log('zoomed crop: ' + zoom.describe());
display(zoom, 'watch-time chart, read by pixels');`,
    ],
  },

  blocked: {
    label: 'Attempt a destructive action and get stopped',
    task: 'Delete everything from the watchlist.',
    programs: [
      `const snap = await page.snapshot({ filter: 'interactive' });
log('about to click: ' + snap.text.split('\\n').find((l) => l.includes('Delete everything')));

// Throws from inside the program if the approval is declined, so the loop can report that the click
// never landed instead of the agent assuming it did.
await page.click({ role: 'button', name: 'Delete everything' });
log('unreachable if the approval was declined');`,
      `const rows = await page.evaluate("document.querySelectorAll('#rows tr').length");
log('rows still present: ' + rows);
log('banner: ' + await page.evaluate("document.getElementById('banner').textContent"));`,
    ],
  },

  full: {
    label: 'Full task: filter by status, enable notifications, queue it',
    task: 'Show only airing titles, turn on notifications, and add the first match to the queue.',
    programs: [
      `const snap = await page.snapshot({ filter: 'interactive' });

// A native <select> is the one control where synthetic keystrokes are unreliable, so this uses the
      // semantic primitive instead: click for real focus, then set the value and let the page's own
      // change handlers run. Playwright's selectOption takes the same route for the same reason.
const selectRef = /combobox "Status" \\[(ref_\\d+)\\]/.exec(snap.text)[1];
const chosen = await page.selectOption({ ref: selectRef }, 'airing');
log('select: ' + JSON.stringify(chosen.previous) + ' -> ' + JSON.stringify(chosen.value));
log('status now: ' + await page.evaluate("document.getElementById('status').value"));

await page.click({ role: 'button', name: 'Apply filters' });
log('after filter: ' + await page.evaluate("document.getElementById('count').textContent"));`,
      `// Turn the checkbox on via its handle, then queue the match.
const snap = await page.snapshot({ filter: 'interactive' });
const checkLine = snap.text.split('\\n').find((l) => /^checkbox/.test(l));
log('checkbox: ' + checkLine);
if (checkLine) await page.click({ ref: /\\[(ref_\\d+)\\]/.exec(checkLine)[1] });

await page.click({ role: 'button', name: 'Add to queue' });
log('banner: ' + await page.evaluate("document.getElementById('banner').textContent"));
log('activity: ' + (await page.evaluate("document.getElementById('log').innerText")).split('\\n')[0]);

display(await page.screenshot(), 'final state');`,
    ],
  },
};

const json = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
};

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('body was not valid JSON');
  }
}

/**
 * Compact result for the `/api/act` endpoint.
 *
 * Deliberately small. When a model is driving the loop one step at a time, the observation channel is
 * the context window, and a full-page PNG is ~150KB of base64 per turn. So the default reply is text
 * plus grounding telemetry, and pixels are written to disk on request with only the path returned.
 */
function compactResult({ outcome, page, shotPath, includeAx }) {
  const actions = page.telemetry
    .filter((t) => t.action || t.kind === 'tabs.changed' || t.kind === 'risk-denied')
    .slice(-12)
    .map((t) => ({
      a: t.action ?? t.kind,
      ch: t.channel ?? null,
      via: t.via ?? null,
      at: t.node ? String(t.node).slice(0, 60) : null,
    }));

  return {
    ok: outcome.ok,
    error: outcome.error ?? null,
    out: (outcome.text ?? '').slice(0, 4000),
    images: outcome.images.length,
    ms: outcome.durationMs,
    actions,
    shot: shotPath ?? null,
    net: page.networkReport(),
    url: null,
    ax: includeAx ?? null,
  };
}

export class HarnessServer {
  #clients = new Set();
  #runtime = null;
  #loop = null;
  #running = false;
  #state = { approvalMode: 'ask', plannerMode: 'static', lastResult: null, scenario: null };

  constructor({
    rootDir = PUBLIC_DIR,
    width = 1440,
    height = 900,
    headless = true,
    allowHosts = ['127.0.0.1', 'localhost'],
    startUrl = null,
    model = {},
  } = {}) {
    this.rootDir = rootDir;
    this.width = width;
    this.height = height;
    this.headless = headless;
    this.allowHosts = allowHosts;
    this.startUrl = startUrl;
    this.modelOptions = model;
    this.server = this.#buildServer();
  }

  // ------------------------------------------------------------------ events

  #broadcast(event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.#clients) {
      try { res.write(payload); } catch { this.#clients.delete(res); }
    }
  }

  #emit(event) {
    this.#state.lastEvent = event;
    this.#broadcast(event);
  }

  // ------------------------------------------------------------------ runtime

  async #runtimeInstance() {
    if (this.#runtime) return this.#runtime;
    this.#runtime = await createRuntime({
      width: this.width,
      height: this.height,
      headless: this.headless,
      allowHosts: this.allowHosts,
      // Pin the agent to this server's own origin rather than merely to the loopback host. Every local
      // origin shares the host 127.0.0.1, so a host-only allowlist would permit any other service on
      // any other loopback port, including one that is not ours.
      allowOrigins: this.origin ? [this.origin] : null,
      approvalMode: this.#state.approvalMode,
      onEvent: (e) => this.#emit(e),
      onApprovalRequest: (req) => this.#emit({ type: 'approval.request', ...req }),
    });
    return this.#runtime;
  }

  // ------------------------------------------------------------------ routes

  #buildServer() {
    const serveStatic = createStaticHandler(this.rootDir);

    return createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;

      if (path === '/api/events') return this.#handleEvents(req, res);
      if (path.startsWith('/api/')) {
        try {
          return await this.#handleApi(req, res, path, url);
        } catch (err) {
          if (!res.writableEnded) json(res, 500, { error: err.message });
          return undefined;
        }
      }
      // Everything else is a static asset, including /target.html.
      serveStatic(req, res);
      return undefined;
    });
  }

  #handleEvents(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'hello', state: this.#publicState() })}\n\n`);
    this.#clients.add(res);
    const keepAlive = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* closed */ }
    }, 20_000);
    keepAlive.unref?.();
    req.on('close', () => {
      clearInterval(keepAlive);
      this.#clients.delete(res);
    });
    return undefined;
  }

  #publicState() {
    return {
      running: this.#running,
      approvalMode: this.#state.approvalMode,
      plannerMode: this.#state.plannerMode,
      scenario: this.#state.scenario,
      scenarios: Object.fromEntries(
        Object.entries(SCENARIOS).map(([k, v]) => [k, { label: v.label, task: v.task }]),
      ),
      pendingApprovals: this.#runtime?.broker.pending.map((p) => ({
        id: p.id, action: p.action, verdict: p.verdict,
      })) ?? [],
      lastResult: this.#state.lastResult
        ? {
            stopReason: this.#state.lastResult.stopReason,
            text: this.#state.lastResult.text,
            steps: this.#state.lastResult.steps,
            durationMs: this.#state.lastResult.durationMs,
          }
        : null,
    };
  }

  async #handleApi(req, res, path, url) {
    const method = req.method ?? 'GET';

    if (path === '/api/state' && method === 'GET') {
      return json(res, 200, this.#publicState());
    }

    if (path === '/api/snapshot' && method === 'GET') {
      const runtime = await this.#runtimeInstance();
      const filter = url.searchParams.get('filter') ?? 'interactive';
      const listing = await runtime.accessibility.read({ filter });
      return json(res, 200, listing);
    }

    if (path === '/api/screenshot' && method === 'GET') {
      const runtime = await this.#runtimeInstance();
      const frame = await runtime.page.screenshot();
      const base64 = frame.dataUrl.split(',')[1];
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': Buffer.byteLength(base64, 'base64'),
        'cache-control': 'no-store',
        'x-frame-meta': frame.describe(),
      });
      return res.end(Buffer.from(base64, 'base64'));
    }

    if (path === '/api/approval' && method === 'POST') {
      const body = await readBody(req);
      const runtime = await this.#runtimeInstance();
      const outcome = runtime.broker.respond(body.id, body.allowed, body.reason);
      this.#emit({ type: 'approval.response', id: body.id, allowed: Boolean(body.allowed) });
      return json(res, outcome.ok ? 200 : 404, outcome);
    }

    if (path === '/api/mode' && method === 'POST') {
      const body = await readBody(req);
      const runtime = await this.#runtimeInstance();
      if (body.approvalMode) {
        this.#state.approvalMode = body.approvalMode;
        runtime.broker.setMode(body.approvalMode);
      }
      if (body.plannerMode) this.#state.plannerMode = body.plannerMode;
      this.#emit({ type: 'mode.changed', ...this.#publicState() });
      return json(res, 200, this.#publicState());
    }

    if (path === '/api/navigate' && method === 'POST') {
      const body = await readBody(req);
      const runtime = await this.#runtimeInstance();
      const result = await runtime.page.goto(body.url);
      this.#emit({ type: 'navigated', ...result });
      return json(res, 200, result);
    }

    if (path === '/api/start' && method === 'POST') {
      const body = await readBody(req);
      if (this.#running) return json(res, 409, { error: 'a run is already in progress' });
      if (body.scenario) {
        const scenario = SCENARIOS[body.scenario];
        if (!scenario) return json(res, 400, { error: `unknown scenario ${body.scenario}` });
        this.#startRun({
          planner: new StaticPlanner(scenario.programs, {
            finalText: `Done. ${scenario.task}`,
          }),
          task: scenario.task,
          scenario: body.scenario,
        });
        return json(res, 202, { started: true, mode: 'static' });
      }

      const task = String(body.task ?? '').trim();
      if (!task) return json(res, 400, { error: 'task is required for a live run' });

      const client = new ModelClient(this.modelOptions);
      this.#startRun({ planner: client, task, scenario: null });
      return json(res, 202, { started: true, mode: 'live', model: client.model });
    }

    if (path === '/api/step' && method === 'POST') {
      const body = await readBody(req);
      if (this.#running) return json(res, 409, { error: 'a run is already in progress' });
      const code = String(body.code ?? '');
      if (!code.trim()) return json(res, 400, { error: 'code is required' });
      const runtime = await this.#runtimeInstance();
      const outcome = await runtime.sandbox.run(code);
      this.#emit({ type: 'manual.step', ok: outcome.ok, text: outcome.text, error: outcome.error });
      return json(res, 200, {
        ok: outcome.ok,
        text: outcome.text,
        error: outcome.error,
        images: outcome.images.map((i) => ({ caption: i.caption, url: i.url })),
      });
    }

    if (path === '/api/act' && method === 'POST') {
      // One program, one compact reply. This is the path a model drives when it is acting as the
      // planner itself rather than letting a scripted planner or a server-side loop generate steps.
      const body = await readBody(req);
      if (this.#running) return json(res, 409, { error: 'a run is already in progress' });
      const code = String(body.code ?? '');
      if (!code.trim()) return json(res, 400, { error: 'code is required' });

      const runtime = await this.#runtimeInstance();
      const before = runtime.page.telemetry.length;
      const outcome = await runtime.sandbox.run(code);

      let shotPath = null;
      if (body.shot) {
        const frame = await runtime.page.screenshot({ maxDimension: body.shotMax ?? 900 });
        shotPath = await this.#writeShot(frame.dataUrl, body.shotName ?? 'step');
      }

      const compact = compactResult({ outcome, page: runtime.page, shotPath, includeAx: null });
      compact.url = await runtime.page.url().catch(() => null);

      if (body.ax) {
        const filter = body.ax === true ? 'interactive' : body.ax;
        const listing = await runtime.accessibility.read({ filter, maxNodes: Number(body.axMax) || 120 });
        compact.ax = listing.text;
        compact.axTotal = listing.totalNodes ?? listing.nodeCount;
      }

      void before;
      this.#emit({ type: 'act', ok: outcome.ok, error: outcome.error ?? null, ms: outcome.durationMs });
      return json(res, 200, compact);
    }

    if (path === '/api/cancel' && method === 'POST') {
      this.#loop?.cancel();
      return json(res, 200, { cancelled: true });
    }

    if (path === '/api/globals' && method === 'GET') {
      const runtime = await this.#runtimeInstance();
      return json(res, 200, { globals: runtime.sandbox.inspectGlobals() });
    }

    return json(res, 404, { error: `no route for ${method} ${path}` });
  }

  /** Write a data URL to disk and return the path, so pixels never have to travel as JSON. */
async #writeShot(dataUrl, name) {
    const dir = join(HERE, '..', '..', 'shots');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${name}-${Date.now()}.png`);
    await writeFile(file, Buffer.from(String(dataUrl).split(',')[1], 'base64'));
    return file;
  }

  #startRun({ planner, task, scenario }) {
    this.#running = true;
    const runtime = this.#runtime;

    const loop = new AgentLoop({
      page: runtime.page,
      sandbox: runtime.sandbox,
      planner,
      task,
      maxSteps: 20,
      systemPrompt: null,
      tool: execTool('the demo target page'),
      onEvent: (e) => this.#emit(e),
    });

    this.#loop = loop;
    this.#emit({ type: 'run.queued', task, scenario });

    // Fire and forget: the browser polls SSE. Errors are surfaced as events, never swallowed.
    loop.run()
      .then((result) => {
        this.#state.lastResult = result;
        this.#emit({ type: 'run.finished', result: {
          stopReason: result.stopReason,
          text: result.text,
          steps: result.steps,
          durationMs: result.durationMs,
        } });
      })
      .catch((err) => {
        this.#emit({ type: 'run.error', message: err.message });
      })
      .finally(() => {
        this.#running = false;
        this.#loop = null;
      });
  }

  async listen(port = 0) {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', resolve);
    });
    const address = this.server.address();
    this.port = address.port;
    this.origin = `http://127.0.0.1:${this.port}`;

    const runtime = await this.#runtimeInstance();

    // Put the agent where the task starts. Without this the page is about:blank and every scenario
    // fails on a missing element, which looks like a harness bug rather than a missing step.
    const startUrl = this.startUrl ?? `${this.origin}/target.html`;
    try {
      await runtime.page.goto(startUrl);
      this.#emit({ type: 'runtime.ready', startUrl, ...(await runtime.page.describe()) });
    } catch (err) {
      // The console still has to come up. A start URL that cannot be reached is a condition the
      // operator needs to see and act on, not a reason for the whole server to refuse to start.
      this.#emit({ type: 'runtime.start_failed', startUrl, message: err.message });
      console.warn(`[humanui] could not open the start URL: ${err.message}`);
      console.warn('[humanui] the console is up; navigate from the operator UI or /api/act.');
    }

    return { origin: this.origin, port: this.port };
  }

  async close() {
    this.#loop?.cancel();
    for (const res of this.#clients) {
      try { res.end(); } catch { /* already closed */ }
    }
    this.#clients.clear();
    await this.#runtime?.close();
    this.#runtime = null;
    await new Promise((done) => this.server.close(done));
  }
}

export { execTool };