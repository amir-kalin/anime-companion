// Tab handling.
//
// A click that opens a popup used to leave the harness silently reading the opener, so the agent
// would describe a document the user had already navigated away from. These cases pin the fix: the
// new tab is detected, it can be followed, and following it invalidates handles rather than leaving
// stale ones pointing into the previous document.

import { createServer } from 'node:http';
import { check, section, summary } from './assert.mjs';
import { createRuntime } from '../src/harness/runtime.mjs';

const site = createServer((req, res) => {
  const html = (title, body) =>
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(`<!doctype html><title>${title}</title><body>${body}</body>`);

  if (req.url.startsWith('/popup')) {
    html('popup', `<h1>Popup document</h1>
      <label for="p">Popup field</label><input id="p" aria-label="Popup field">
      <button onclick="window.close()">Close</button>`);
    return;
  }
  if (req.url.startsWith('/slow')) {
    // A slow page, so "attached to" cannot be decided by URL equality alone.
    setTimeout(() => html('slow tab', '<h1>Slow document</h1><button id="sb">Slow button</button>'), 60);
    return;
  }
  html('opener', `<h1>Opener document</h1>
    <button id="openPopup" onclick="window.open('/popup','_blank')">Open popup</button>
    <a id="newTab" href="/slow" target="_blank">Slow link</a>
    <label for="o">Opener field</label><input id="o" aria-label="Opener field">
    <button id="openerBtn">Opener button</button>`);
});
await new Promise((done) => site.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${site.address().port}`;

const runtime = await createRuntime({
  headless: true,
  allowOrigins: [origin],
  approvalMode: 'allow-all',
});
const { page } = runtime;

try {
  await page.goto(`${origin}/`);

  section('tabs: listing');
  let tabs = await page.tabs();
  check('one tab is open', tabs.length === 1, `count=${tabs.length}`);
  check('the attached tab is marked', tabs[0].attached === true, JSON.stringify(tabs[0]));

  section('tabs: a click that spawns a tab is detected');
  page.telemetry.length = 0;
  await page.click({ role: 'button', name: 'Open popup' });
  await new Promise((r) => setTimeout(r, 600));

  tabs = await page.tabs();
  check('a second tab now exists', tabs.length === 2, `count=${tabs.length}`);
  check('the harness is still attached to the opener', tabs.find((t) => t.attached)?.url === `${origin}/`,
    JSON.stringify(tabs.map((t) => ({ u: t.url, a: t.attached }))));

  const tabEvent = page.telemetry.find((t) => t.kind === 'tabs.changed');
  check('a tabs.changed event was emitted', Boolean(tabEvent),
    page.telemetry.map((t) => t.kind).join(','));

  section('tabs: following the new tab');
  const openerRef = (await page.snapshot()).text.match(/textbox "Opener field" \[(ref_\d+)\]/)?.[1];
  check('the opener has a handle before the switch', Boolean(openerRef), String(openerRef));

  const popupIndex = tabs.findIndex((t) => t.url.includes('/popup'));
  const switched = await page.switchTab(popupIndex);
  check('switchTab moved to the popup', switched.url.includes('/popup'), switched.url);
  check('the popup title is read', switched.title === 'popup', switched.title);
  check('the popup content is now visible',
    /Popup document/.test(await page.text()), (await page.text()).slice(0, 60));

  section('tabs: handles do not survive the switch');
  // Docs: refs are "scoped to the tab that produced them and stay valid until that tab navigates or
  // its DOM changes materially". A tab switch is a different document entirely.
  let staleError = '';
  try {
    await page.click({ ref: openerRef });
  } catch (err) {
    staleError = err.message;
  }
  check('a handle from the previous tab is refused',
    /Could not resolve target/.test(staleError), staleError.slice(0, 80));

  const popupSnap = await page.snapshot();
  check('a fresh handle exists in the new tab',
    /textbox "Popup field"/.test(popupSnap.text), popupSnap.text.split('\n')[0]);

  section('tabs: switching back');
  const backIndex = (await page.tabs()).findIndex((t) => t.url === `${origin}/`);
  const back = await page.switchTab(backIndex);
  check('switchTab returns to the opener', back.url === `${origin}/`, back.url);
  check('the opener content is visible again', /Opener document/.test(await page.text()));

  section('tabs: guards against mistakes');

  let noSuch = '';
  try { await page.switchTab(99); } catch (err) { noSuch = err.message; }
  check('an out-of-range index is refused with the available tabs listed',
    /No tab matches/.test(noSuch) && /Open tabs/.test(noSuch), noSuch.slice(0, 90));

  const closeSelf = await page.tabs().then((t) => t.findIndex((x) => x.attached));
  let selfClose = '';
  try { await page.closeTab(closeSelf); } catch (err) { selfClose = err.message; }
  check('closing the attached tab is refused rather than stranding the session',
    /Refusing to close the tab this session is attached to/.test(selfClose), selfClose.slice(0, 70));

  const closed = await page.closeTab(popupIndex);
  check('a background tab can be closed', closed.remaining === 1, JSON.stringify(closed));

  section('tabs: input still works after switching');
  await page.fill({ role: 'textbox', name: 'Opener field' }, 'after-switch');
  check('typing works on the tab we returned to',
    (await page.evaluate("document.getElementById('o').value")) === 'after-switch');
} finally {
  await runtime.close();
  await new Promise((done) => site.close(done));
}

process.exitCode = summary() ? 0 : 1;