// Where does a synthesized click and a synthesized keystroke actually land?
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { launchBrowser } from '../src/cdp/client.mjs';
import { AccessibilityIndex } from '../src/cdp/snapshot.mjs';
import { Page } from '../src/cdp/page.mjs';
import { createStaticServer } from '../src/harness/static.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const statics = createStaticServer(join(here, '..', 'public'));
const { origin } = await statics.listen(0);
const { session, close } = await launchBrowser({ headless: true });
const page = new Page(session, { accessibility: new AccessibilityIndex(session) });

const active = () => page.evaluate(
  `(() => { const a = document.activeElement; return a ? (a.id || a.tagName) : 'none'; })()`,
);
const valueOf = (id) => page.evaluate(`document.getElementById('${id}').value`);

try {
  await page.goto(`${origin}/target.html`);
  const snap = await page.snapshot({ filter: 'interactive' });
  const ref = /textbox "Search title" \[(ref_\d+)\]/.exec(snap.text)[1];
  const resolved = await page.resolveTarget({ ref });
  console.log(`ref ${ref} -> channel=${resolved.channel} point=${JSON.stringify(resolved.point)} node=${resolved.node}`);

  console.log(`activeElement before: ${await active()}`);
  await page.click({ ref });
  console.log(`activeElement after click: ${await active()}`);

  // Typing one char at a time, checking where each lands.
  await page.type('ab');
  console.log(`after type('ab'): active=${await active()} q=${JSON.stringify(await valueOf('q'))} season=${JSON.stringify(await valueOf('season'))}`);

  // Now the suspect: a chord built only from a modifier bitmask.
  await page.evaluate(`document.getElementById('q').focus(); document.getElementById('q').value='xy'`);
  console.log(`\nset q='xy', active=${await active()}`);
  await page.press('ctrl+a');
  console.log(`after press('ctrl+a'): q=${JSON.stringify(await valueOf('q'))} selection=${await page.evaluate('String(document.getSelection().toString())')} selRange=${await page.evaluate('String(document.activeElement.selectionStart)+","+String(document.activeElement.selectionEnd)')}`);
  await page.press('Delete');
  console.log(`after press('Delete'): q=${JSON.stringify(await valueOf('q'))}`);
  await page.type('zz');
  console.log(`after type('zz'): q=${JSON.stringify(await valueOf('q'))}`);

  // Does a leaked modifier state break later plain typing?
  await page.evaluate(`document.getElementById('q').value=''`);
  await page.type('penguin');
  console.log(`\nplain type('penguin'): q=${JSON.stringify(await valueOf('q'))}`);
  console.log(`count text: ${await page.evaluate(`document.getElementById('count').textContent`)}`);
} finally {
  await close();
  await statics.close();
}