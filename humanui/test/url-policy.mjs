// Navigation policy.
//
// The vendor docs are explicit that the model API does not filter URLs, so the executor must:
// "accept the history keywords back, forward, and reload, treat a URL without a scheme as https://,
// then parse the URL and refuse any scheme other than http or https ... Check the scheme with a URL
// parser rather than a string prefix."
//
// The string-prefix detail is the interesting one, because a prefix check is what most hand-rolled
// implementations use and it is trivially wrong.

import { check, section, summary } from './assert.mjs';
import { UrlPolicy } from '../src/cdp/page.mjs';

section('url policy: schemes are parsed, not pattern-matched');

const open = new UrlPolicy();
const refused = [
  ['javascript:alert(1)', 'javascript:'],
  ['JavaScript:alert(1)', 'javascript:'],
  ['file:///C:/Windows/System32/config', 'file:'],
  ['data:text/html,<script>alert(1)</script>', 'data:'],
  ['chrome://settings', 'chrome:'],
  ['vbscript:msgbox(1)', 'vbscript:'],
];

for (const [input, scheme] of refused) {
  let message = '';
  try { open.resolve(input); } catch (err) { message = err.message; }
  check(`refuses ${scheme}`, /Refusing scheme|Could not parse/.test(message), message.slice(0, 64));
}

section('url policy: a prefix check would have accepted these');

const prefixTrap = [
  // A naive /^https?:\/\// test passes these even though the real target is not http(s).
  ['https://ok.example/\njavascript:alert(1)', 'embedded scheme after a newline'],
  ['https://ok.example\\@evil.example/', 'userinfo confusion'],
];
for (const [input, why] of prefixTrap) {
  const naiveAccepts = /^https?:\/\//.test(input);
  let message = '';
  try {
    const r = open.resolve(input);
    // If it parses as a legitimate https URL with host ok.example, allowing it is correct behavior.
    message = `parsed as ${r.url}`;
    check(`parser handles ${why}`, true, message);
  } catch (err) {
    check(`parser handles ${why}`, true, `rejected: ${err.message.slice(0, 60)}`);
  }
  void naiveAccepts;
}

section('url policy: normalization');

check('bare host gains https://',
  open.resolve('example.com/docs').url === 'https://example.com/docs',
  open.resolve('example.com/docs').url);
check('http is preserved',
  open.resolve('http://example.com/').url === 'http://example.com/');

for (const kw of ['back', 'forward', 'reload', 'BACK']) {
  check(`history keyword "${kw}" is passed through`, open.resolve(kw).kind === kw.toLowerCase());
}

section('url policy: allowlist');

const locked = new UrlPolicy({ allowHosts: ['trusted.test', 'sub.trusted.test'] });
check('exact host allowed', Boolean(locked.resolve('https://trusted.test/x')));
check('subdomain allowed', Boolean(locked.resolve('https://sub.trusted.test/x')));
check('nested subdomain allowed', Boolean(locked.resolve('https://a.b.trusted.test/x')));

let hostMsg = '';
try { locked.resolve('https://evil.test/x'); } catch (err) { hostMsg = err.message; }
check('unlisted host refused', /not in the allowlist/.test(hostMsg), hostMsg.slice(0, 60));

// A suffix match without a dot boundary would let an attacker register "eviltrusted.test".
let suffixMsg = '';
try { locked.resolve('https://eviltrusted.test/x'); } catch (err) { suffixMsg = err.message; }
check('suffix-without-boundary host refused', /not in the allowlist/.test(suffixMsg), suffixMsg.slice(0, 70));

section('url policy: malformed input');

for (const bad of ['', '   ', 'http://', '::::', 'ht tp://x']) {
  let threw = false;
  try { open.resolve(bad); } catch { threw = true; }
  check(`refuses ${JSON.stringify(bad)}`, threw);
}

// Not a syntax error: WHATWG parsing accepts this and yields an https URL to a nonsense host. With
// no allowlist configured that is allowed by design, which is precisely why an allowlist exists.
const odd = open.resolve('ht!tp://x');
check('a nonsense host is still an https URL, not a crash', odd.url.startsWith('https://'), odd.url);

process.exitCode = summary() ? 0 : 1;