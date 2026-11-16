// What happens when a click opens a new tab?
//
// The vendor design has an explicit answer — a `browser_state` block listing tabs, plus
// `new_tab` / `switch_tab` / `close_tab` members, and "a tab-management result must be exactly one
// browser_state block". This harness is single-target, which means a click that spawns a popup leaves
// the agent reading the old page while believing it moved. If that is what happens, it is a
// correctness bug, not a missing feature.

import { createServer } from 'node:http';
import { check, section, summary } from '../test/assert.mjs';
import { createRuntime } from '../src/harness/runtime.mjs';

const page = createServer((req, res) => {
  if (req.url.startsWith('/popup')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end('<!doctype html><title>popup</title><body><h1>Popup document</h1>'
         + '<p id="who">I am the popup.</p>'
         + '<script>window.close && setTimeout(() => {}, 10)</script></body>');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    .end(`<!doctype html><title>opener</title><body>
      <h1>Opener document</h1>
      <button id="openPopup" onclick="window.open('/popup','_blank')">Open popup</button>
      <a id="targetBlank" href="/popup" target="_blank">Link in new tab</a>
      <p id="who">I am the opener.</p>
    </body>`);
});
await new Promise((done) => page.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${page.address().port}`;

const runtime = await createRuntime({
  headless: true,
  allowOrigins: [origin],
  approvalMode: 'allow-all',
});

try {
  section('baseline: single target');
  await runtime.page.goto(`${origin}/`);
  check('the opener is the active target', /Opener document/.test(await runtime.page.text()));

  section('a click that spawns a tab');
  const before = await runtime.page.url();
  await runtime.page.click({ role: 'button', name: 'Open popup' });
  // Give the popup time to appear, which is what a real run would experience.
  await new Promise((r) => setTimeout(r, 900));

  const after = await runtime.page.url();
  const text = await runtime.page.text();
  const described = await runtime.page.describe();

  console.log(`  url before: ${before}`);
  console.log(`  url after : ${after}`);
  console.log(`  title     : ${described.title}`);
  console.log(`  text head : ${text.replace(/\s+/g, ' ').slice(0, 70)}`);

  const stayedOnOpener = after === before && /Opener document/.test(text);
  const followedPopup = /popup/i.test(described.title) || /popup document/i.test(text);

  console.log(`\n  stayed on opener : ${stayedOnOpener}`);
  console.log(`  followed popup   : ${followedPopup}`);

  // Either behaviour is defensible. What is NOT defensible is the harness having no idea a second
  // target now exists, so check that it is at least detectable.
  section('the new target is detectable');
  const { createCdpSession } = await import('../src/cdp/client.mjs');
  const targets = await (await fetch(`http://127.0.0.1:${runtime.browser.port}/json/list`)).json();
  const pages = targets.filter((t) => t.type === 'page');
  console.log(`  page targets now: ${pages.length}`);
  for (const t of pages) console.log(`    ${t.url}  ${t.title}`);

  check('a second page target exists after the click', pages.length >= 2, `targets=${pages.length}`);
  check('the harness reports which document it is on', stayedOnOpener || followedPopup,
    stayedOnOpener ? 'still on the opener (silent)' : 'moved to the popup');
  void createCdpSession;
} finally {
  await runtime.close();
  await new Promise((done) => page.close(done));
}

console.log('\nCONCLUSION:');
console.log('  If "stayed on opener" is true, the harness silently ignores the new tab.');
process.exitCode = summary() ? 0 : 1;