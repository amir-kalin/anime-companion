// The sandbox isolation contract.
//
// The harness runs model-generated code. That only works because the code is confined: the whole
// security story of the tool rests on the sandbox context not exposing the host. Asserting it is
// the difference between "we meant to isolate it" and "isolation is verified".

import vm from 'node:vm';
import { check, section, summary } from './assert.mjs';
import { Sandbox } from '../src/runtime/sandbox.mjs';

const fakePage = {
  goto: async () => {},
  snapshot: async () => ({ text: '' }),
  click: async () => {},
};
const sandbox = new Sandbox({ page: fakePage });

section('sandbox timers');

const timed = await sandbox.run(`
  const started = Date.now();
  await new Promise((r) => setTimeout(r, 60));
  log('waited ' + (Date.now() - started >= 40 ? 'long enough' : 'too short'));
  const id = setInterval(() => {}, 1000);
  clearInterval(id);
  log('interval cleared');
  log('sleep works too: ' + (typeof sleep === 'function'));
`);
check('setTimeout is available', timed.ok && /waited long enough/.test(timed.text), timed.text);
check('clearInterval is available', timed.ok && /interval cleared/.test(timed.text));
check('sleep remains available', timed.ok && /sleep works too: true/.test(timed.text));

section('sandbox web globals');

const globals = await sandbox.run(`
  const u = new URL('https://youtu.be/abc123?t=30');
  log('protocol=' + u.protocol + ' id=' + u.searchParams.get('t'));
  log('btoa=' + btoa('hi'));
  log('atob=' + atob('aGk='));
  log('TextEncoder=' + new TextEncoder().encode('ab').length);
  log('structuredClone=' + (structuredClone({ a: 1 }).a));
  log('now=' + (typeof performance.now() === 'number'));
`);
// `protocol` keeps its colon, and btoa base64-encodes — both are the standard behaviours.
check('URL and URLSearchParams work', /protocol=https: id=30/.test(globals.text), globals.text);
check('btoa encodes and atob round-trips', /btoa=aGk=/.test(globals.text), globals.text);
check('TextEncoder works', /TextEncoder=2/.test(globals.text));
check('structuredClone works', /structuredClone=1/.test(globals.text));
check('performance.now works', /now=true/.test(globals.text));

// Adding the pure constructors is not a licence to become permissive.
const stillBlocked = await sandbox.run('log(typeof crypto, typeof fetch, typeof Buffer);');
check('crypto, fetch and Buffer stay out',
  /undefined undefined undefined/.test(stillBlocked.text), stillBlocked.text);

await sandbox.run('globalThis.mine = 1;');
check('injected globals are not reported as model state',
  !sandbox.inspectGlobals().some((k) => ['setTimeout', 'page', 'URL'].includes(k)),
  sandbox.inspectGlobals().join(','));

section('sandbox isolation');

const probes = [
  ['process is unreachable', 'typeof process'],
  ['require is unreachable', 'typeof require'],
  ['fetch is unreachable', 'typeof fetch'],
  ['Buffer is unreachable', 'typeof Buffer'],
  ['global process is not a key', 'Object.keys(globalThis).includes("process")'],
];

for (const [label, expr] of probes) {
  const outcome = await sandbox.run(`log(${expr});`);
  check(label, outcome.ok && /undefined|false/.test(outcome.text), `-> ${outcome.text}`);
}

// Dynamic import is the remaining escape route, so attempt the real thing rather than inspecting
// `typeof import` (which is a syntax error and would prove nothing).
for (const spec of ['node:fs', 'node:child_process', 'data:text/javascript,export const x=1']) {
  const escape = await sandbox.run(`await import(${JSON.stringify(spec)});`);
  check(`dynamic import of ${spec} is blocked`,
    escape.ok === false, escape.ok ? 'IT SUCCEEDED — sandbox is not isolated' : escape.error);
}

section('sandbox allowlist');

const allowed = await sandbox.run(`log(typeof page, typeof log, typeof display);`);
check('page, log, display are provided',
  allowed.ok && allowed.text === 'object function function', `-> ${allowed.text}`);

section('sandbox persistence');

await sandbox.run(`globalThis.stash = { n: 7 };`);
const recovered = await sandbox.run(`log(globalThis.stash.n);`);
check('globalThis survives between calls', recovered.text === '7', `-> ${recovered.text}`);

const topLevelConst = await sandbox.run(`const notSticky = 1; globalThis.viaGlobal = 2;`);
const viaGlobal = await sandbox.run(`log(globalThis.viaGlobal, typeof globalThis.notSticky);`);
check('globalThis assignment is the documented way to persist',
  topLevelConst.ok && viaGlobal.text === '2 undefined', `-> ${viaGlobal.text}`);

sandbox.reset();
const afterReset = await sandbox.run(`log(typeof globalThis.stash);`);
check('reset clears persisted state', afterReset.text === 'undefined', `-> ${afterReset.text}`);

section('sandbox observation channel');

const obs = await sandbox.run(`
  log('text one');
  log({ structured: true });
  display('data:image/png;base64,iVBORw0KGgo=', 'a label');
  return 'returned value';
`);
check('log() collects text', obs.text.includes('text one'), JSON.stringify(obs.text.slice(0, 60)));
check('returned value is folded into the text channel', obs.text.includes('returned value'));
check('display() collects an image', obs.images.length === 1 && obs.images[0].caption === 'a label');
check('structured log values are serialized, not dropped', obs.text.includes('structured'));

const badDisplay = await sandbox.run(`display(12345);`);
check('display() ignores a non-image instead of crashing', badDisplay.ok && badDisplay.images.length === 0);

section('sandbox failure handling');

const thrown = await sandbox.run(`throw new Error('deliberate');`);
check('a thrown error is captured, not propagated', thrown.ok === false);
check('the error message survives for the model', /deliberate/.test(thrown.error ?? ''), thrown.error);

// The property that matters for code execution: a failure tells the model which prefix of the plan
// actually ran, which a fixed action list cannot express.
const midway = await sandbox.run(`
  log('step one done');
  throw new Error('step two failed');
`);
check('output before a failure is preserved', midway.text.includes('step one done'));
check('the failure is reported alongside it', /step two failed/.test(midway.error ?? ''));

const empty = await sandbox.run('   ');
check('empty code is a no-op, not an error', empty.ok && empty.text === '');

process.exitCode = summary() ? 0 : 1;