// Network-layer enforcement.
//
// `url-policy.mjs` covers the check on the address the agent asked for. This suite covers the layer
// below it, which is the one that actually bounds what the browser can reach. The cases here are
// deliberately hostile: metadata endpoints, redirect chains, suffix-confusion hosts, and the schemes
// that look harmless but are not.

import { check, section, summary } from './assert.mjs';
import { NetworkGuard, isPrivateHost, hostMatches } from '../src/cdp/network.mjs';

section('private and loopback detection');

const PRIVATE = [
  '127.0.0.1', '127.1.2.3', '10.0.0.1', '10.255.255.254', '172.16.0.1', '172.31.255.255',
  '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1',
  'localhost', 'LOCALHOST', 'foo.localhost', 'db.internal', 'printer.local',
  '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '[::1]',
];

for (const host of PRIVATE) {
  check(`${host} is private`, isPrivateHost(host));
}

const PUBLIC = [
  'example.com', '8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '192.169.1.1',
  '169.253.169.254', '11.0.0.1', '93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946',
];
for (const host of PUBLIC) {
  check(`${host} is public`, !isPrivateHost(host));
}

section('allowlist matching is dot-bounded');

check('exact host matches', hostMatches('trusted.test', ['trusted.test']));
check('subdomain matches', hostMatches('a.trusted.test', ['trusted.test']));
check('nested subdomain matches', hostMatches('a.b.trusted.test', ['trusted.test']));
check('suffix confusion is refused', !hostMatches('eviltrusted.test', ['trusted.test']));
check('a deeper confusion is refused', !hostMatches('x.eviltrusted.test', ['trusted.test']));
check('a leading wildcard form matches', hostMatches('cdn.trusted.test', ['*.trusted.test']));
check('case is ignored', hostMatches('TRUSTED.TEST', ['trusted.test']));
check('a trailing dot is normalized', hostMatches('trusted.test.', ['trusted.test']));

section('the two allowlists union, and origin pinning is exclusive when asked for');

const union = new NetworkGuard({ allowHosts: ['trusted.test'], allowOrigins: ['http://127.0.0.1:5180'] });
check('the pinned origin is allowed', union.evaluate('http://127.0.0.1:5180/x').allow);
check('a host from the host list is still allowed alongside a pinned origin',
  union.evaluate('https://trusted.test/x').allow,
  'a pinned origin must not shadow the host list');
check('an unrelated origin is refused',
  !union.evaluate('https://evil.test/x').allow, 'union must not become open');

const exclusive = new NetworkGuard({ allowOrigins: ['http://127.0.0.1:5180'], allowHosts: null });
check('origin-only mode blocks a different port on the same host',
  !exclusive.evaluate('http://127.0.0.1:9999/x').allow,
  'this is what stops another loopback service being reached');
check('origin-only mode allows its own origin',
  exclusive.evaluate('http://127.0.0.1:5180/x').allow);

section('allowlist mode blocks everything else, including subresources');

const locked = new NetworkGuard({ allowHosts: ['trusted.test'] });
for (const url of [
  'https://trusted.test/page',
  'https://cdn.trusted.test/app.js',
  'http://trusted.test/x',
]) {
  check(`allows ${url}`, locked.evaluate(url).allow);
}
for (const url of [
  'https://evil.test/tracker.gif',
  'https://trusted.test.evil.test/x',
  'https://nottrusted.test/x',
  'https://169.254.169.254/latest/meta-data/iam/security-credentials/',
]) {
  const verdict = locked.evaluate(url);
  check(`blocks ${url}`, !verdict.allow, verdict.reason);
}

section('open mode still refuses private ranges');

// With no allowlist, "allow any http(s)" must not become "allow any http(s), including my own LAN".
const open = new NetworkGuard({ allowHosts: null });
check('public host allowed', open.evaluate('https://example.com/x').allow);
const metadata = open.evaluate('http://169.254.169.254/latest/meta-data/');
check('cloud metadata is refused in open mode', !metadata.allow, metadata.reason);
check('loopback is refused in open mode', !open.evaluate('http://127.0.0.1:8080/admin').allow);
check('a LAN host is refused in open mode', !open.evaluate('http://192.168.1.1/').allow);

const openPrivate = new NetworkGuard({ allowHosts: null, allowPrivate: true });
check('opt-in allows loopback', openPrivate.evaluate('http://127.0.0.1:8080/').allow);

section('schemes');

for (const url of [
  'data:image/png;base64,iVBORw0KGgo=',
  'blob:http://trusted.test/1234',
  'about:blank',
]) {
  check(`inert scheme permitted: ${url.slice(0, 28)}`, locked.evaluate(url).allow);
}

for (const url of [
  'ftp://trusted.test/file',
  'ws://trusted.test/socket',
  'chrome://settings',
  'file:///C:/Windows/System32/config',
  'javascript:alert(1)',
]) {
  check(`non-network scheme blocked: ${url.slice(0, 28)}`, !locked.evaluate(url).allow);
}

section('malformed input is refused, not crashed on');

for (const bad of ['', 'not a url', 'http://', '://x', 'ht tp://x']) {
  const verdict = locked.evaluate(bad);
  check(`refuses ${JSON.stringify(bad)}`, verdict.allow === false, verdict.reason);
}

section('every block carries a reason');

for (const url of ['https://evil.test/', 'http://169.254.169.254/', 'ftp://trusted.test/']) {
  const verdict = locked.evaluate(url);
  check(`${url.slice(0, 34)} explains itself`, typeof verdict.reason === 'string' && verdict.reason.length > 8,
    verdict.reason);
}

process.exitCode = summary() ? 0 : 1;