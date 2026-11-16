// Step 5: pick a result from the accessibility tree and click it by handle.
// The DOM gave me duration overlays; the tree carries the real accessible names, which is the whole
// reason to prefer handles over scraping selectors.
const snap = await page.snapshot({ filter: 'interactive', maxNodes: 200 });
log(`interactive nodes: ${snap.nodeCount} of ${snap.totalNodes}`);

const linkLines = snap.text.split('\n').filter((l) => /^link /.test(l));
log(`links in the tree: ${linkLines.length}`);
for (const l of linkLines.slice(0, 12)) log('  ' + l);

const chrome = /^(Home|Shorts|Subscriptions|You|History|Explore|Music|Trending|Library|Show more|Sign in|Report history|YouTube Premium|YouTube Music|YouTube Kids|Germany|English|Privacy|Terms|Accessibility|Advertise|Developers|About|Skip navigation|Language)/;
const watchLinks = linkLines.filter((l) => !chrome.test(l.replace(/^link "/, '')));
log(`candidate result links: ${watchLinks.length}`);

const chosen = watchLinks.find((l) => /buck|bunny/i.test(l)) ?? watchLinks[0];
log('chosen: ' + chosen);

if (!chosen) {
  log('no result link found; falling back to a coordinate-free navigation');
} else {
  const ref = /\[(ref_\d+)\]/.exec(chosen)[1];
  await page.click({ ref });
  log(`clicked ${ref}`);
}

// Confirm where we ended up rather than assuming.
await new Promise((r) => setTimeout(r, 1500));
log('url now: ' + await page.url());
log('title now: ' + await page.title());