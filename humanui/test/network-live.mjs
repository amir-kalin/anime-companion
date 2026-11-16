// Interception in a real browser.
//
// `network-policy.mjs` proves the policy function returns the right verdict. That is not the same as
// proving the guard is actually attached and actually intercepting, which is the failure mode that
// hides: a misconfigured Fetch domain is indistinguishable from a page with no network.
//
// So this suite loads a page that attempts three escapes and asserts each is stopped at the network.
// The escape server is on a different loopback port, which is exactly the case a host-only allowlist
// cannot catch and origin pinning can.

import { createServer } from 'node:http';
import { check, section, summary } from './assert.mjs';
import { createRuntime } from '../src/harness/runtime.mjs';

/** Records whether the guarded origin was ever actually reached. */
let escapeHits = 0;

const escape = createServer((_req, res) => {
  escapeHits++;
  res.writeHead(200, { 'content-type': 'text/plain' }).end('SECRET');
});
await new Promise((done) => escape.listen(0, '127.0.0.1', done));
const escapeOrigin = `http://127.0.0.1:${escape.address().port}`;

const probe = createServer((req, res) => {
  if (req.url.startsWith('/redirect')) {
    // A redirect hop is a separate request, so the guard sees and judges it independently.
    res.writeHead(302, { location: `${escapeOrigin}/escaped-by-redirect` }).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html>
    <title>escape attempts</title>
    <body>
      <h1>Probe</h1>
      <img id="direct" src="${escapeOrigin}/direct-escape.png" alt="direct">
      <img id="viaRedirect" src="/redirect" alt="redirected">
      <p id="results">pending</p>
      <script>
        const verdict = (id) => {
          const el = document.getElementById(id);
          return el.complete && el.naturalWidth > 0 ? 'LOADED' : 'blocked';
        };
        // Poll rather than waiting for load: a blocked image errors quickly, but the load event's
        // timing is not something this page should depend on. Always publish the latest reading.
        let tries = 0;
        const timer = setInterval(() => {
          document.getElementById('results').textContent =
            'direct=' + verdict('direct') + ' redirect=' + verdict('viaRedirect');
          if (++tries > 25) clearInterval(timer);
        }, 100);
      </script>
    </body>`);
});
await new Promise((done) => probe.listen(0, '127.0.0.1', done));
const probeOrigin = `http://127.0.0.1:${probe.address().port}`;

const runtime = await createRuntime({
  headless: true,
  allowOrigins: [probeOrigin],
  approvalMode: 'allow-all',
});

const waitFor = async (expr, timeoutMs = 12_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await runtime.page.evaluate(expr).catch(() => null);
    if (v !== null && v !== 'pending') return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  return 'pending';
};

try {
  section('network guard: interception is live');
  check('the guard attached without degrading', runtime.guard.stats.degraded === false,
    runtime.guard.stats.error ?? 'ok');

  await runtime.page.goto(`${probeOrigin}/probe`);

  const report = runtime.page.networkReport();
  check('the guard recorded decisions', report.allowed + report.blocked > 0,
    `allowed=${report.allowed} blocked=${report.blocked}`);

  section('network guard: escapes are stopped at the network');

  const results = await waitFor("document.getElementById('results').textContent");
  check('the direct subresource escape was blocked', results.includes('direct=blocked'), results);
  check('the redirect escape was blocked', results.includes('redirect=blocked'), results);

  section('network guard: the escape origin is never actually reached');
  check('the escape server received zero requests', escapeHits === 0, `hits=${escapeHits}`);

  section('network guard: decisions are attributable');
  const blockedUrls = report.blockedRequests.map((b) => b.url);
  check('blocked requests are recorded with a reason',
    report.blockedRequests.every((b) => typeof b.reason === 'string' && b.reason.length > 0));
  check('both escapes appear in the blocked list', blockedUrls.length >= 2, blockedUrls.join(' | '));
  check('the redirect target is named',
    blockedUrls.some((u) => String(u).includes('escaped-by-redirect')), blockedUrls.join(' | '));

  section('network guard: allowed traffic still works');
  check('the page itself loaded from the allowlisted origin',
    (await runtime.page.url()).startsWith(probeOrigin), await runtime.page.url());
  check('the heading rendered', /Probe/.test(await runtime.page.text()));
} finally {
  await runtime.close();
  await new Promise((done) => probe.close(done));
  await new Promise((done) => escape.close(done));
}

console.log(`\nescape origin hits: ${escapeHits}`);
process.exitCode = summary() ? 0 : 1;