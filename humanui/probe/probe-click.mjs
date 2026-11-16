// Why does clicking the button by handle not change the banner?
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { launchBrowser, sleep } from '../src/cdp/client.mjs';
import { AccessibilityIndex } from '../src/cdp/snapshot.mjs';
import { Page } from '../src/cdp/page.mjs';
import { createStaticServer } from '../src/harness/static.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const statics = createStaticServer(join(here, '..', 'public'));
const { origin } = await statics.listen(0);
const { session, close } = await launchBrowser({ headless: true });
const ax = new AccessibilityIndex(session);
const page = new Page(session, { accessibility: ax });

// Surface uncaught page errors instead of letting them hide behind a silently dead handler.
const errors = [];
session.on((method, params) => {
  if (method === 'Runtime.exceptionThrown') {
    errors.push(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text);
  }
  if (method === 'Log.entryAdded' && params.entry.level === 'error') {
    errors.push(`${params.entry.source}: ${params.entry.text}`);
  }
});
await session.send('Log.enable');

const state = () => page.evaluate(`JSON.stringify({
  banner: document.getElementById('banner').textContent,
  bannerClass: document.getElementById('banner').className,
  q: document.getElementById('q').value,
  count: document.getElementById('count').textContent,
  rows: document.querySelectorAll('#rows tr').length,
})`).then(JSON.parse);

try {
  await page.goto(`${origin}/target.html`);
  console.log('after load:', JSON.stringify(await state()));

  const snap = await page.snapshot({ filter: 'interactive' });
  const applyRef = /button "Apply filters" \[(ref_\d+)\]/.exec(snap.text)[1];
  const line = snap.text.split('\n').find((l) => l.includes(`[${applyRef}]`));
  console.log(`apply listing line: ${line}`);

  const resolved = await page.resolveTarget({ ref: applyRef });
  console.log(`resolved: channel=${resolved.channel} point=${JSON.stringify(resolved.point)} node=${resolved.node}`);

  // What does the browser think is at that point?
  const at = await page.evaluate(`(() => {
    const el = document.elementFromPoint(${resolved.point.x}, ${resolved.point.y});
    return el ? el.outerHTML.slice(0, 120) : 'nothing';
  })()`);
  console.log(`elementFromPoint at resolved point: ${at}`);

  const clickRec = await page.click({ ref: applyRef });
  console.log(`click record: ${JSON.stringify(clickRec)}`);
  await sleep(200);
  console.log('after click:', JSON.stringify(await state()));

  console.log('\ntelemetry:');
  for (const t of page.telemetry) console.log('  ' + JSON.stringify(t));

  console.log(`\npage errors: ${errors.length ? '\n  ' + errors.join('\n  ') : 'none'}`);
  console.log('listeners attached:', await page.evaluate(
    `JSON.stringify({
      apply: typeof document.getElementById('apply').onclick,
      qEvents: !!document.getElementById('q'),
      rowsRendered: document.querySelectorAll('#rows tr').length,
    })`,
  ));
} finally {
  await close();
  await statics.close();
}