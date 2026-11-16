// Reading a large page in pieces.
//
// The listing caps at 120 nodes, and a truncated document is indistinguishable from a complete one if
// the truncation is silent — the model concludes the control it wants does not exist. So truncation has
// to announce itself, and there has to be a way to descend into the part that was cut off.

import { createServer } from 'node:http';
import { check, section, summary } from './assert.mjs';
import { createRuntime } from '../src/harness/runtime.mjs';

const rows = Array.from({ length: 200 }, (_, i) => `
  <tr>
    <td><label for="cb${i}">Row ${i}</label></td>
    <td><input type="checkbox" id="cb${i}" aria-label="Select row ${i}"></td>
    <td><button id="go${i}" aria-label="Open row ${i}">Open</button></td>
  </tr>`).join('');

const site = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html>
    <title>Large table</title>
    <body>
      <h1>Inventory</h1>
      <table id="t"><tbody>${rows}</tbody></table>
    </body>`);
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

  section('a truncated listing says so, and says how to continue');

  const top = await page.snapshot({ filter: 'interactive', maxNodes: 30 });
  check('the listing is truncated', top.truncated === true, `nodeCount=${top.nodeCount}`);
  check('the total is reported so the gap is visible',
    top.totalNodes > top.nodeCount, `${top.nodeCount} of ${top.totalNodes}`);
  check('the truncation is stated in the text, not only in a flag',
    /more nodes were not shown/.test(top.text), top.text.split('\n').slice(-1)[0]);
  check('the text says how to continue',
    /ref|maxNodes/.test(top.text.split('\n').slice(-1)[0]), top.text.split('\n').slice(-1)[0]);

  section('a complete listing is not falsely marked truncated');
  const small = await page.snapshot({ filter: 'interactive', maxNodes: 5000 });
  check('an untruncated listing is complete', small.truncated === false, `nodeCount=${small.nodeCount}`);
  check('no truncation notice appears', !/more nodes were not shown/.test(small.text));
  // Each row contributes several accessible nodes (row, cells, checkbox, static text), so count the
  // checkboxes rather than rows and assert the last one is present, which is the point of the section.
  check('the final row is reachable at a high limit',
    /checkbox "Select row 199"/.test(small.text),
    `checkboxes=${(small.text.match(/checkbox "Select row \d+"/g) ?? []).length}`);

  section('a subtree read descends into a region');
  const containerLine = (await page.snapshot({ filter: 'all', maxNodes: 5000 })).text
    .split('\n').find((l) => l.startsWith('table'));
  const tableRef = /\[(ref_\d+)\]/.exec(containerLine ?? '')?.[1];
  check('the table has a container handle', Boolean(tableRef), String(containerLine));

  // Raise the limit, or the subtree itself truncates and the tail rows vanish again.
  const subtree = await page.snapshot({ filter: 'interactive', ref: tableRef, maxNodes: 5000 });
  check('an interactive subtree lists the container\'s actions, not the container',
    /^(row|cell|checkbox|button)\b/.test(subtree.text), subtree.text.split('\n')[0]);
  check('the subtree spans the first and last row',
    /Select row 0\b/.test(subtree.text) && /Select row 199\b/.test(subtree.text),
    `${subtree.text.split('\n')[0]} … ${subtree.text.split('\n').slice(-1)[0]}`);
  check('the subtree excludes page furniture outside it',
    !/heading "Inventory"/.test(subtree.text),
    /heading "Inventory"/.test(subtree.text) ? 'heading leaked into the table subtree' : 'clean');
  check('subtree handles are usable',
    Boolean(/\[(ref_\d+)\]/.test(subtree.text)), subtree.text.split('\n')[0]);

  // With filter 'all' the container itself is included, which is how a model confirms it scoped
  // the read to the region it intended.
  const subtreeAll = await page.snapshot({ filter: 'all', ref: tableRef, maxNodes: 5000 });
  check('an all-nodes subtree starts at the container itself',
    /^table\b/.test(subtreeAll.text), subtreeAll.text.split('\n')[0]);
  check('the all-nodes subtree is still scoped',
    !/heading "Inventory"/.test(subtreeAll.text), 'heading leaked');

  section('handles from a subtree actually act');
  const lastRow = subtree.text.split('\n').find((l) => /checkbox "Select row 199"/.test(l));
  const cbRef = /\[(ref_\d+)\]/.exec(lastRow ?? '')?.[1];
  check('the last row has a handle', Boolean(cbRef), String(lastRow));
  await page.click({ ref: cbRef });
  check('clicking a handle found in a subtree works',
    (await page.evaluate("document.getElementById('cb199').checked")) === true,
    await page.evaluate("String(document.getElementById('cb199').checked)"));

  section('a stale subtree request is refused, not silently empty');
  await page.goto(`${origin}/?v=2`);
  const stale = await page.snapshot({ filter: 'interactive', ref: tableRef });
  check('a handle from before the navigation is rejected', stale.error === 'stale_ref',
    `${stale.error}: ${stale.text.slice(0, 60)}`);
  check('the refusal tells the model to re-read',
    /Re-read the page/.test(stale.text), stale.text);
} finally {
  await runtime.close();
  await new Promise((done) => site.close(done));
}

process.exitCode = summary() ? 0 : 1;