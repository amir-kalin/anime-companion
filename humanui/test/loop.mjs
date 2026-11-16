// Agent loop behavior, end to end against a real browser.
//
// StaticPlanner stands in for the model. That is deliberate: these tests are about the loop, the
// sandbox, the gate, and the telemetry — not about model quality — and a scripted planner makes all
// four deterministic and fast.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { check, section, summary } from './assert.mjs';
import { createStaticServer } from '../src/harness/static.mjs';
import { createRuntime } from '../src/harness/runtime.mjs';
import { AgentLoop, StaticPlanner } from '../src/agent/loop.mjs';
import { execTool } from '../src/agent/model.mjs';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const statics = createStaticServer(PUBLIC);
const { origin } = await statics.listen(0);

const runtime = await createRuntime({
  headless: true,
  allowHosts: ['127.0.0.1', 'localhost'],
  approvalMode: 'ask',
  approvalTimeoutMs: 400,
  autoAllowAfterMs: 300,
});
const { page, sandbox } = runtime;

const runLoop = (programs, opts = {}) => new AgentLoop({
  page,
  sandbox,
  planner: new StaticPlanner(programs, { finalText: opts.finalText ?? 'all done' }),
  tool: execTool('the demo target page'),
  task: opts.task ?? 'test task',
  maxSteps: opts.maxSteps ?? 20,
  deadlineMs: opts.deadlineMs ?? 60_000,
});

const fresh = async () => {
  await page.goto(`${origin}/target.html`);
};

try {
  // -------------------------------------------------------------- persistence
  section('loop: the environment outlives a step');
  await fresh();

  const persisted = await runLoop([
    `globalThis.marker = 'kept'; log('set');`,
    `log('read back: ' + globalThis.marker);`,
  ]).run();

  check('both steps ran', persisted.steps.length === 2, `stop=${persisted.stopReason}`);
  check('globalThis persisted across steps',
    persisted.steps[1].text.includes('read back: kept'), persisted.steps[1].text);

  // -------------------------------------------------------------- completion
  section('loop: stops when the planner answers in prose');
  const done = await runLoop([`log('did a thing');`]).run();
  check('stopReason is completed', done.stopReason === 'completed', done.stopReason);
  check('final text is returned', done.text === 'all done', done.text);
  check('events were emitted', done.events.some((e) => e.type === 'step.end'));

  // -------------------------------------------------------------- step budget
  section('loop: the step budget is enforced');
  const runaway = new AgentLoop({
    page,
    sandbox,
    // A planner that never stops asking for tool calls.
    planner: { transcriptStyle: 'chat', degraded: false, step: async () => ({
      responseId: null, commentary: '', text: '',
      toolCall: { id: `c${Math.random()}`, name: 'exec_js', args: JSON.stringify({ code: `log('again');` }) },
    }) },
    tool: execTool('the demo target page'),
    task: 'never finishes',
    maxSteps: 3,
    deadlineMs: 30_000,
  });
  const bounded = await runaway.run();
  check('stops at maxSteps', bounded.steps.length === 3, `ran ${bounded.steps.length}`);
  check('stopReason is max_steps', bounded.stopReason === 'max_steps', bounded.stopReason);

  // -------------------------------------------------------------- cancellation
  section('loop: cancellation');
  const cancellable = new AgentLoop({
    page, sandbox,
    planner: new StaticPlanner([`log('a');`, `log('b');`, `log('c');`], {}),
    tool: execTool('the demo target page'),
    task: 'cancel me', maxSteps: 10,
  });
  const cancelPromise = cancellable.run();
  cancellable.cancel();
  const cancelled = await cancelPromise;
  check('cancel is honoured', cancelled.stopReason === 'cancelled', cancelled.stopReason);
  check('cancellation is reported as an event', cancelled.events.some((e) => e.type === 'cancelled'));

  // -------------------------------------------------------------- failures
  section('loop: a failed step is reported, not fatal');
  await fresh();
  const recovered = await runLoop([
    `throw new Error('deliberate failure');`,
    // No bare `document` here: the sandbox is a bare realm, so the page is reachable only through
    // the allowlisted `page` object.
    `log('still alive, page title: ' + await page.title());`,
  ]).run();

  check('step 1 is marked failed', recovered.steps[0].ok === false);
  check('the error text reaches the transcript',
    /deliberate failure/.test(recovered.steps[0].error ?? ''), recovered.steps[0].error);
  check('the loop continued after the failure', recovered.steps.length === 2);
  check('step 2 ran and could still reach the page',
    recovered.steps[1].ok === true && /Watchlist Console/.test(recovered.steps[1].text),
    recovered.steps[1].text);

  section('loop: the page is reachable only through page');
  const leaked = await sandbox.run('log(typeof document);');
  check('document is not in the sandbox', leaked.text === 'undefined', `-> ${leaked.text}`);

  // -------------------------------------------------------------- approvals
  section('loop: a denied action stops the program but not the run');
  await fresh();
  const denied = await runLoop([
    `await page.click({ role: 'button', name: 'Delete everything' }); log('clicked');`,
    `log('rows: ' + await page.evaluate("document.querySelectorAll('#rows tr').length"));`,
  ]).run();

  check('the gated step failed', denied.steps[0].ok === false);
  check('the denial is visible to the model', /Blocked/.test(denied.steps[0].error ?? ''), denied.steps[0].error);
  check('code after the denied call did not run', !denied.steps[0].text.includes('clicked'));
  check('the destructive action never took effect',
    denied.steps[1].text.includes('rows: 7'), denied.steps[1].text);

  // -------------------------------------------------------------- unknown tool
  section('loop: an unknown tool is answered, not ignored');
  const unknown = new AgentLoop({
    page, sandbox,
    planner: {
      transcriptStyle: 'chat', degraded: false,
      step: async (n) => (n.turn === 1
        ? { responseId: null, commentary: '', text: '', toolCall: { id: 'x1', name: 'rm_rf', args: '{}' } }
        : { responseId: null, commentary: '', text: 'recovered', toolCall: null }),
    },
    tool: execTool('the demo target page'),
    task: 'call a bogus tool', maxSteps: 5,
  });
  const bogus = await unknown.run();
  check('the bogus call is reported as an error', /only tool is exec_js/.test(bogus.steps[0].error ?? ''),
    bogus.steps[0].error);
  check('the loop still completes', bogus.stopReason === 'completed' && bogus.text === 'recovered');

  // -------------------------------------------------------------- telemetry
  section('loop: grounding telemetry attributes every action to a channel');
  await fresh();
  page.telemetry.length = 0;
  await runLoop([
    `await page.click({ role: 'button', name: 'Apply filters' });
     await page.mouse.click(700, 120);`,
  ]).run();

  const channels = page.telemetry.filter((t) => t.action).map((t) => t.channel);
  check('a handle-based click is recorded as semantic', channels.includes('semantic'), channels.join(','));
  check('a coordinate click is recorded as perceptual', channels.includes('perceptual'), channels.join(','));
  check('coordinate clicks report what they hit',
    page.telemetry.some((t) => t.channel === 'perceptual' && Boolean(t.node)),
    page.telemetry.filter((t) => t.channel === 'perceptual').map((t) => t.node).join(' | '));

  // -------------------------------------------------------------- observations
  section('loop: observations travel back to the operator');
  await fresh();
  const observed = await runLoop([
    `display(await page.screenshot(), 'the page'); log('sent one image');`,
  ]).run();
  check('an image observation is produced', observed.steps[0].images === 1);
  check('the event carries the image for the operator UI',
    observed.events.some((e) => e.type === 'step.end' && e.imageData?.length === 1));
} finally {
  await runtime.close();
  await statics.close();
}

process.exitCode = summary() ? 0 : 1;