// What does a subtree read actually return?
import { createServer } from 'node:http';
import { createRuntime } from '../src/harness/runtime.mjs';

const rows = Array.from({ length: 6 }, (_, i) => `
  <tr><td><label for="cb${i}">Row ${i}</label></td>
      <td><input type="checkbox" id="cb${i}" aria-label="Select row ${i}"></td></tr>`).join('');

const site = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html>
    <title>Probe</title><body><h1>Inventory</h1>
    <p id="lead">Leading paragraph</p>
    <table id="t"><caption>Stock</caption><thead><tr><th>Name</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p id="trail">Trailing paragraph</p></body>`);
});
await new Promise((d) => site.listen(0, '127.0.0.1', d));
const origin = `http://127.0.0.1:${site.address().port}`;

const runtime = await createRuntime({ headless: true, allowOrigins: [origin], approvalMode: 'allow-all' });
const { page } = runtime;

try {
  await page.goto(`${origin}/`);
  const all = await page.snapshot({ filter: 'all', maxNodes: 500 });
  console.log('--- top-level listing ---');
  console.log(all.text.split('\n').slice(0, 12).join('\n'));

  const tableLine = all.text.split('\n').find((l) => l.startsWith('table'));
  console.log(`\ntable line: ${JSON.stringify(tableLine)}`);
  const ref = /\[(ref_\d+)\]/.exec(tableLine ?? '')?.[1];

  const subtree = await page.snapshot({ filter: 'all', ref, maxNodes: 500 });
  console.log(`\n--- subtree under ${ref} (${subtree.nodeCount} nodes, truncated=${subtree.truncated}) ---`);
  console.log(subtree.text.split('\n').join('\n'));

  console.log('\nleak check:');
  console.log('  contains heading "Inventory":', /heading "Inventory"/.test(subtree.text));
  console.log('  contains "Leading paragraph":', /Leading paragraph/.test(subtree.text));
  console.log('  contains "Trailing paragraph":', /Trailing paragraph/.test(subtree.text));
} finally {
  await runtime.close();
  await new Promise((d) => site.close(d));
}