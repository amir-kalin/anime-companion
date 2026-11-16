// How does a native <select> respond to synthetic arrow keys, open vs closed?
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createStaticServer } from '../src/harness/static.mjs';
import { createRuntime } from '../src/harness/runtime.mjs';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const statics = createStaticServer(PUBLIC);
const { origin } = await statics.listen(0);
const runtime = await createRuntime({ headless: true, allowHosts: ['127.0.0.1', 'localhost'], approvalMode: 'allow-all' });
const { page } = runtime;

const val = () => page.evaluate("document.getElementById('status').value");
const focused = () => page.evaluate("document.activeElement.id");

try {
  await page.goto(`${origin}/target.html`);
  const snap = await page.snapshot({ filter: 'interactive' });
  const ref = /combobox "Status" \[(ref_\d+)\]/.exec(snap.text)[1];

  console.log('start:', await val(), 'focused:', await focused());

  await page.click({ ref });
  console.log('after click -> value:', await val(), 'focused:', await focused());

  await page.press('ArrowDown');
  console.log('after ArrowDown (popup open?) value:', await val());
  await page.press('ArrowDown');
  console.log('after another ArrowDown value:', await val());
  await page.press('Enter');
  console.log('after Enter value:', await val());

  // Now: close the popup first with Escape, then try arrows on a closed select.
  await page.click({ ref });
  await page.press('Escape');
  console.log('\nafter click+Escape value:', await val(), 'focused:', await focused());
  await page.press('ArrowDown');
  console.log('closed select + ArrowDown value:', await val());
  await page.press('ArrowDown');
  console.log('closed select + ArrowDown value:', await val());
  await page.press('ArrowUp');
  console.log('closed select + ArrowUp   value:', await val());

  // Type-ahead: what a user actually does with a focused, closed select.
  console.log('\n--- type-ahead on a focused select ---');
  await page.click({ ref });
  console.log('on click ->', await val());
  for (const ch of ['a', 'q', 'd']) {
    await page.press(ch);
    console.log(`press '${ch}' ->`, await val());
  }
  await page.press('Home');
  console.log("press 'Home' ->", await val());
} finally {
  await runtime.close();
  await statics.close();
}