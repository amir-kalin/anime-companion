// Pin down CDP's box-model coordinate convention before relying on it.
import { launchBrowser, sleep } from '../src/cdp/client.mjs';

const HTML = `<!doctype html><meta charset=utf-8><body style="margin:0">
<div style="height:1500px"></div>
<button id="b" style="position:absolute;top:900px;left:200px;width:120px;height:40px">Target</button>
</body>`;

const { session, close } = await launchBrowser({ headless: true });
try {
  await session.send('Page.navigate', { url: `data:text/html;charset=utf-8,${encodeURIComponent(HTML)}` });
  await sleep(400);

  for (const scrollY of [0, 500]) {
    await session.send('Runtime.evaluate', { expression: `window.scrollTo(0, ${scrollY})` });
    await sleep(250);

    const { root } = await session.send('DOM.getDocument', { depth: -1 });
    const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#b' });
    const { model } = await session.send('DOM.getBoxModel', { nodeId });
    const quad = model.border;

    const { result } = await session.send('Runtime.evaluate', {
      expression: 'JSON.stringify({r: (()=>{const r=document.getElementById("b").getBoundingClientRect();return [r.x,r.y,r.width,r.height]})(), s: window.scrollY})',
      returnByValue: true,
    });
    const truth = JSON.parse(result.value);

    console.log(`scrollY=${scrollY}`);
    console.log(`  CDP border quad      : [${quad.map((q) => q.toFixed(1)).join(', ')}]  -> origin (${quad[0]}, ${quad[1]}) size ${(quad[2] - quad[0]).toFixed(0)}x${(quad[5] - quad[1]).toFixed(0)}`);
    console.log(`  getBoundingClientRect: [${truth.r.join(', ')}]`);
    const vpMatch = Math.abs(quad[0] - truth.r[0]) < 2 && Math.abs(quad[1] - truth.r[1]) < 2;
    const docMatch = Math.abs(quad[1] - (truth.r[1] + truth.s)) < 2;
    console.log(`  => matches VIEWPORT coords: ${vpMatch} | matches DOCUMENT coords: ${docMatch}`);
  }

  // Backend-node-id path (what the a11y tree hands us) — same question, different entry point.
  const ax = await session.send('Accessibility.getFullAXTree');
  const btn = ax.nodes.find((n) => n.role?.value === 'button');
  console.log(`\na11y button node: "${btn.name.value}" backendDOMNodeId=${btn.backendDOMNodeId}`);
  const bm = await session.send('DOM.getBoxModel', { backendNodeId: btn.backendDOMNodeId });
  console.log(`  border quad origin: (${bm.model.border[0]}, ${bm.model.border[1]})  (scrollY=500)`);
  console.log(`  -> backendDOMNodeId works; scrollY-relative => subtract scroll to get viewport`);
} finally {
  await close();
}