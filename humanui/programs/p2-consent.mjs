// Step 2: clear the consent dialog, then find the search field.
// The dialog is modal, so nothing behind it is clickable until it is gone. Handle, not coordinates.
const before = await page.snapshot({ filter: 'interactive' });
const rejectLine = before.text.split('\n').find((l) => l.startsWith('button "Reject'));
log('consent button: ' + rejectLine);

const consentRef = /\[(ref_\d+)\]/.exec(rejectLine ?? '')?.[1];
if (consentRef) {
  await page.click({ ref: consentRef });
  log('clicked the reject handle');
} else {
  log('no consent button found; assuming none is present');
}

// Confirm it is actually gone rather than assuming the click worked.
const after = await page.snapshot({ filter: 'interactive' });
const stillThere = after.text.includes('Reject the use of cookies');
log(`consent dialog still present: ${stillThere}`);

const searchLine = after.text.split('\n').find((l) => l.startsWith('combobox "Search"'));
log('search field: ' + searchLine);
const searchRef = /\[(ref_\d+)\]/.exec(searchLine ?? '')?.[1];
log('search handle: ' + searchRef);
log('total interactive nodes now: ' + after.nodeCount);

globalThis.searchRef = searchRef;