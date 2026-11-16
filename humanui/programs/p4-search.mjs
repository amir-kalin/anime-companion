// Step 4: search, then inspect the results.
// Fresh handle first: the page re-rendered after the dialog closed, and handles are invalidated by
// navigation but I want to be sure I am acting on the current tree.
const snap = await page.snapshot({ filter: 'interactive' });
const searchLine = snap.text.split('\n').find((l) => /^combobox "Search"/.test(l));
log('search field: ' + searchLine);
const ref = /\[(ref_\d+)\]/.exec(searchLine ?? '')[1];

await page.fill({ ref }, 'big buck bunny');
await page.press('Enter');
log('submitted the search');

// Wait for the results to arrive rather than assuming they did.
let results = null;
for (let i = 0; i < 40; i++) {
  results = await page.evaluate(`(() => {
    const links = [...document.querySelectorAll('a#video-title-link, a#thumbnail')];
    return {
      url: location.href,
      count: links.length,
      first: links.slice(0, 5).map((a) => ({
        title: (a.getAttribute('title') || a.textContent || '').trim().slice(0, 60),
        href: a.getAttribute('href'),
      })),
    };
  })()`);
  if (results.count > 0) break;
  await new Promise((r) => setTimeout(r, 400));
}
log('url: ' + results.url);
log(`result links: ${results.count}`);
for (const r of results.first) log(`  ${r.href}  "${r.title}"`);

globalThis.firstHref = results.first[0]?.href;