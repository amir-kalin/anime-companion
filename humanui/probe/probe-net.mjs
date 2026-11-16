// Why can node reach youtube.com but Chrome cannot?
//
// The harness reported `chrome-error://` for the start URL. That is the shape of a blocked request, a
// DNS failure, and an offline machine alike, so this walks the causes one at a time instead of
// guessing which one it is.

import { launchBrowser } from '../src/cdp/client.mjs';
import { AccessibilityIndex } from '../src/cdp/snapshot.mjs';
import { Page, UrlPolicy } from '../src/cdp/page.mjs';
import { NetworkGuard } from '../src/cdp/network.mjs';

const HOSTS = ['youtube.com', 'google.com', 'gstatic.com', 'googleapis.com',
  'googleusercontent.com', 'googlevideo.com', 'ytimg.com'];

const trial = async (label, { guard, headless, args }) => {
  const browser = await launchBrowser({ headless, extraArgs: args });
  const ax = new AccessibilityIndex(browser.session);
  const net = new NetworkGuard({ allowHosts: HOSTS });
  if (guard) await net.attach(browser.session);
  const page = new Page(browser.session, {
    accessibility: ax,
    urlPolicy: new UrlPolicy({ allowHosts: HOSTS }),
    network: net,
    port: browser.port,
  });
  try {
    await page.goto('https://www.youtube.com/', { timeoutMs: 20000 });
    const title = await page.title();
    const net2 = page.networkReport();
    console.log(`${label.padEnd(34)} OK  title="${title.slice(0, 40)}" allowed=${net2.allowed} blocked=${net2.blocked}`);
    for (const b of net2.blockedRequests.slice(0, 4)) console.log(`${''.padEnd(36)}blocked ${b.url.slice(0, 70)} (${b.reason})`);
    return true;
  } catch (err) {
    const net2 = page.networkReport();
    console.log(`${label.padEnd(34)} FAIL ${err.message.slice(0, 110)}`);
    console.log(`${''.padEnd(36)}allowed=${net2.allowed} blocked=${net2.blocked}`);
    for (const b of net2.blockedRequests.slice(0, 4)) console.log(`${''.padEnd(36)}blocked ${b.url.slice(0, 70)} (${b.reason})`);
    return false;
  } finally {
    await browser.close();
  }
};

console.log('probing the failure, one variable at a time\n');
await trial('headless, guard ON', { guard: true, headless: true, args: [] });
await trial('headless, guard OFF', { guard: false, headless: true, args: [] });
await trial('headed, guard OFF', { guard: false, headless: false, args: [] });
await trial('headless, no-sandbox off', { guard: false, headless: true, args: ['--disable-features=IsolateOrigins,site-per-process'] });
await trial('headless old', { guard: false, headless: true, args: ['--headless=old'] });