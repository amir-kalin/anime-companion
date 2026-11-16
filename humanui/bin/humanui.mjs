#!/usr/bin/env node
// CLI entry point.
//
//   node bin/humanui.mjs            start the operator console on http://127.0.0.1:5180
//   node bin/humanui.mjs serve      same, with explicit options
//   node bin/humanui.mjs scenario <name>   run one scenario headless and print the trace
//   node bin/humanui.mjs list       list available scenarios
//   node bin/humanui.mjs check      verify the browser + CDP stack and exit
//
// Model configuration comes from the environment so nothing secret lives in the repo:
//   OPENAI_BASE_URL   (default http://127.0.0.1:1234/v1)
//   OPENAI_API_KEY    (default "local")
//   HUMANUI_MODEL     (default gpt-6-astra)

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HarnessServer, SCENARIOS } from '../src/harness/server.mjs';
import { createStaticServer } from '../src/harness/static.mjs';
import { AgentLoop, StaticPlanner } from '../src/agent/loop.mjs';
import { execTool } from '../src/agent/model.mjs';
import { createRuntime } from '../src/harness/runtime.mjs';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const args = process.argv.slice(2);
const command = args[0] ?? 'serve';

function flag(name, fallback = undefined) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = args[i + 1];
  return value && !value.startsWith('--') ? value : true;
}

const has = (name) => args.includes(`--${name}`);

const HEADED = has('headed');
const PORT = Number(flag('port', 5180));

/**
 * Host allowlist presets.
 *
 * A real site needs more than its own domain: YouTube serves markup from youtube.com but video bytes
 * from googlevideo.com and images from ytimg.com, so a single-host allowlist blocks the very thing the
 * task is about. The guard blocks anything not listed, so a preset is the safe direction to err.
 */
const HOST_PRESETS = {
  local: ['127.0.0.1', 'localhost'],
  web: ['youtube.com', 'google.com', 'gstatic.com', 'googleapis.com', 'googleusercontent.com',
    'googlevideo.com', 'ytimg.com', 'ggpht.com', 'googletagmanager.com', 'doubleclick.net',
    'segment.io', 'cloudflare.com', 'jsdelivr.net', 'unpkg.com'],
};

const preset = String(flag('hosts', 'local')).split(',').map((s) => s.trim()).filter(Boolean);
const allowHosts = flag('preset') === 'web' || preset.includes('web') ? HOST_PRESETS.web : preset;

/** Resolve the running harness, or explain how to start it. */
async function act(args) {
  // Only treat a trailing argument as inline code if it is not a flag. Without this, `act --shot`
// executes the literal string "--shot" as a program, which fails as "-- is not defined" and looks
// like a sandbox bug rather than an argument-parsing one.
const positional = args.slice(1).filter((a) => !a.startsWith('-'));
const code = flag('code') ?? (positional.length ? positional.join(' ') : null);
  const origin = `http://127.0.0.1:${PORT}`;

  let body = null;
  try {
    const res = await fetch(`${origin}/api/state`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) throw new Error('state unavailable');
  } catch {
    console.error(`No harness on ${origin}. Start one with:  node bin/humanui.mjs up --headed`);
    process.exitCode = 1;
    return;
  }

  if (code) {
    body = { code, shot: has('shot'), ax: flag('ax', null) };
  } else {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    body = { code: Buffer.concat(chunks).toString('utf8'), shot: has('shot'), ax: flag('ax', null) };
  }

  if (!String(body.code ?? '').trim()) {
    console.error('No program supplied. Pass --code "..." or pipe one on stdin.');
    process.exitCode = 1;
    return;
  }

  const res = await fetch(`${origin}/api/act`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const out = await res.json();
  if (!res.ok) {
    console.error(out.error ?? res.statusText);
    process.exitCode = 1;
    return;
  }

  // Compact, line-oriented output: what happened, what it touched, what it saw.
  console.log(`ok=${out.ok}${out.error ? `  error=${out.error}` : ''}  ${out.ms}ms  url=${out.url}`);
  if (out.out) console.log(out.out.split('\n').map((l) => `  ${l}`).join('\n'));
  for (const a of out.actions) {
    console.log(`  [${a.ch ?? '-'}] ${a.a}${a.via ? ` via ${a.via}` : ''}${a.at ? ` -> ${a.at}` : ''}`);
  }
  if (out.shot) console.log(`  shot: ${out.shot}`);
  if (out.net?.blocked) {
    console.log(`  net: ${out.net.blocked} blocked`);
    for (const b of out.net.blockedRequests.slice(-3)) console.log(`    blocked ${b.url} (${b.reason})`);
  }
  if (out.ax) console.log(`\n--- accessibility tree ---\n${out.ax}`);
}

async function cmdList() {
  console.log('Scenarios (offline planner, no model required):\n');
  for (const [key, s] of Object.entries(SCENARIOS)) {
    console.log(`  ${key.padEnd(10)} ${s.label}`);
    console.log(`  ${''.padEnd(10)} task: ${s.task}\n`);
  }
}

async function cmdCheck() {
  console.log('Checking browser + CDP stack...');
  const runtime = await createRuntime({ headless: !HEADED, allowHosts: ['127.0.0.1', 'localhost'] });
  try {
    const alive = await runtime.page.isAlive();
    console.log(`  browser:        up`);
    console.log(`  CDP session:    ok`);
    console.log(`  Runtime.evaluate: ${alive ? 'responding' : 'FAILED'}`);
    console.log(`  sandbox globals: ${JSON.stringify(runtime.sandbox.inspectGlobals())}`);

    const outcome = await runtime.sandbox.run(`globalThis.probe = 41 + 1; log('sandbox works, probe=' + globalThis.probe);`);
    console.log(`  sandbox:        ${outcome.ok ? 'ok' : 'FAILED'} -> ${outcome.text}`);
    console.log(`\nAll checks passed.`);
  } finally {
    await runtime.close();
  }
}

async function cmdScenario(name) {
  const scenario = SCENARIOS[name];
  if (!scenario) {
    console.error(`Unknown scenario "${name}". Try: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  // Auto-deny high risk so the run is unattended and deterministic, and print what was blocked.
  const runtime = await createRuntime({
    headless: !HEADED,
    allowHosts: ['127.0.0.1', 'localhost'],
    approvalMode: 'ask',
    autoAllowAfterMs: 300,
    approvalTimeoutMs: 800,
    onApprovalRequest: (req) => {
      console.log(`\n  [approval] ${req.verdict.risk} / ${req.verdict.rule}: ${req.verdict.reason}`);
      console.log('  [approval] auto-denied for this unattended run');
    },
  });

  // Serve the demo target over http rather than file://, so iframes and origins behave normally.
  const statics = createStaticServer(PUBLIC_DIR);
  const { origin } = await statics.listen(0);

  try {
    await runtime.page.goto(`${origin}/target.html`);
    console.log(`Scenario: ${scenario.label}`);
    console.log(`Task:     ${scenario.task}\n`);

    const loop = new AgentLoop({
      page: runtime.page,
      sandbox: runtime.sandbox,
      planner: new StaticPlanner(scenario.programs, { finalText: `Done. ${scenario.task}` }),
      tool: execTool('the demo target page'),
      task: scenario.task,
      maxSteps: 20,
      onEvent: (e) => {
        if (e.type === 'step.start') console.log(`\n--- step ${e.turn} ---\n${e.code}`);
        if (e.type === 'step.end') {
          console.log(`  -> ok=${e.ok} ${e.durationMs}ms${e.error ? ` error=${e.error}` : ''}`);
          if (e.text) console.log(e.text.split('\n').map((l) => `     ${l}`).join('\n'));
        }
        if (e.type === 'model.final') console.log(`\nfinal: ${e.text}`);
        if (e.type === 'run.end') console.log(`\nstop=${e.stopReason} steps=${e.steps} in ${e.durationMs}ms`);
      },
    });

    await loop.run();

    console.log('\nGrounding telemetry (which channel served each action):');
    for (const t of runtime.page.telemetry) {
      if (t.action) console.log(`  ${t.action.padEnd(6)} [${(t.channel ?? '-').padEnd(10)}] via ${t.via} -> ${t.node ?? ''}`);
    }
  } finally {
    await statics.close();
    await runtime.close();
  }
}

async function cmdServe() {
  const server = new HarnessServer({
    headless: !HEADED,
    width: Number(flag('width', 1440)),
    height: Number(flag('height', 900)),
    allowHosts,
    startUrl: flag('url', null),
    model: {
      baseUrl: process.env.OPENAI_BASE_URL ?? 'http://127.0.0.1:1234/v1',
      apiKey: process.env.OPENAI_API_KEY ?? 'local',
      model: process.env.HUMANUI_MODEL ?? 'gpt-6-astra',
      api: String(flag('api', 'auto')),
      vision: !has('no-vision'),
    },
  });

  const { origin } = await server.listen(PORT);
  console.log(`humanui harness listening on ${origin}`);
  console.log(`  operator console  ${origin}/`);
  console.log(`  demo target       ${origin}/target.html`);
  console.log(`  allow hosts       ${allowHosts.join(', ')}`);
  if (String(flag('url', ''))) console.log(`  start url         ${flag('url')}`);
  console.log(`  live model        ${process.env.HUMANUI_MODEL ?? 'gpt-6-astra'} via ${process.env.OPENAI_BASE_URL ?? 'http://127.0.0.1:1234/v1'}`);
  console.log(`\nDrive it with:  node bin/humanui.mjs act --code "log(await page.title())"`);
  console.log(`Scenarios run with no model configured. Ctrl+C to stop.`);

  const shutdown = async () => {
    console.log('\nshutting down...');
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

switch (command) {
  case 'list': await cmdList(); break;
  case 'check': await cmdCheck(); break;
  case 'scenario': await cmdScenario(args[1] ?? 'filter'); break;
  case 'serve': await cmdServe(); break;
  case 'act': await act(args); break;
  default:
    console.error(`Unknown command "${command}". Try: serve | up | act | scenario | list | check`);
    process.exitCode = 1;
}