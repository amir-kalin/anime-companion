// Network-layer enforcement.
//
// The URL check in `UrlPolicy` is necessary but nowhere near sufficient. It only sees the address the
// agent asked to navigate to. The vendor guidance is explicit about what that leaves open:
//
//   "Restrict the hosts the browser can reach to a domain allowlist ENFORCED AT THE NETWORK LAYER and
//    re-checked in the navigate handler after redirects, and block loopback, link-local, and private
//    ranges unless the task needs them."
//
// Three concrete escapes exist without this layer, and all three are reachable from ordinary page
// content or from a redirect the harness never sees coming:
//
//   1. Subresources. A page on the allowlist can `<img src>` anything.
//   2. Redirects. `navigate` validated the first hop; the response can 302 anywhere.
//   3. Private ranges. With no allowlist configured, "allow anything http(s)" would happily reach
//      cloud metadata endpoints and anything else on the machine's LAN.
//
// CDP's Fetch domain intercepts every request, including each redirect hop, so a single per-request
// host check closes all three at once. Interception is all-or-nothing though: every paused request
// must be answered exactly once or the page hangs, so the handler is written to never throw.

/**
 * Schemes that cannot reach the network AND cannot read the local filesystem, so they are permitted.
 *
 * `file:` is deliberately absent. It is not a network scheme, so it slips past a "block non-http"
 * rule, but it does read local files: a page could iframe `file:///etc/passwd` and the agent would
 * read the contents straight back out of the accessibility tree. That is the "no access to sensitive
 * filesystems" half of the isolation guidance, and it has nothing to do with the network.
 */
const INERT_SCHEMES = new Set(['data:', 'blob:', 'about:']);

/** Hostnames that always denote the local machine or a local network. */
const LOCAL_NAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback']);

function isPrivateIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 0) return true;                       // "this network"
  if (a === 10) return true;                      // RFC1918
  if (a === 127) return true;                     // loopback
  if (a === 169 && b === 254) return true;        // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true;        // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true;                      // multicast / reserved
  return false;
}

function isPrivateIPv6(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '::1' || h === '::') return true;
  // IPv4-mapped and IPv4-compatible forms inherit the IPv4 rules.
  const mapped = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (mapped) return isPrivateIPv4(mapped[1]);
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;   // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;  // fe80::/10 link-local
  return false;
}

export function isPrivateHost(hostRaw) {
  const host = String(hostRaw ?? '').toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (LOCAL_NAMES.has(host)) return true;
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  return isPrivateIPv4(host) || isPrivateIPv6(host);
}

/** Dot-boundary host match. `eviltrusted.test` must not satisfy an allowlist of `trusted.test`. */
export function hostMatches(hostRaw, allowHosts) {
  const host = String(hostRaw ?? '').toLowerCase().replace(/\.$/, '');
  return allowHosts.some((entry) => {
    const needle = String(entry).toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
    if (!needle) return false;
    return host === needle || host.endsWith(`.${needle}`);
  });
}

/**
 * Origin match: `host:port`, optionally with a scheme.
 *
 * A bare `host:port` entry matches that port on either scheme, which is what a local harness wants.
 * When any entry in the list carries a scheme, the scheme is enforced for all of them, so a
 * mixed list cannot be satisfied by downgrading to http.
 */
export function originMatches(url, allowOrigins) {
  const entries = allowOrigins.map((e) => {
    const raw = String(e).trim();
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    try {
      const parsed = new URL(withScheme);
      return { scheme: parsed.protocol, origin: parsed.origin, hasScheme: /:\/\//i.test(raw) };
    } catch {
      return null;
    }
  }).filter(Boolean);

  if (entries.length === 0) return false;
  const schemeRequired = entries.some((e) => e.hasScheme);
  return entries.some((e) => e.origin === url.origin && (!schemeRequired || e.scheme === url.protocol));
}

export class NetworkGuard {
  #session;
  #off = null;
  #decided = new Set();
  #policy;

  constructor({
    allowHosts = null,
    allowOrigins = null,
    allowPrivate = false,
    allowSchemes = ['http:', 'https:'],
    onDecision = () => {},
  } = {}) {
    this.#policy = { allowHosts, allowOrigins, allowPrivate, allowSchemes, onDecision };
    this.stats = { allowed: 0, blocked: 0, blockedRequests: [], degraded: false, error: null };
  }

  /**
   * Decide a single URL. Exported logic is intentionally separate from the CDP plumbing so it can be
   * tested without a browser.
   *
   * `allowOrigins` exists because a host-only allowlist is nearly useless for a local harness: every
   * origin is `127.0.0.1`, so permitting the host permits every port on the loopback interface,
   * including one an attacker controls. Origin entries carry the port, so a run can be pinned to the
   * single origin it was started against.
   */
  evaluate(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      return { allow: false, reason: 'unparseable url' };
    }

    if (INERT_SCHEMES.has(url.protocol)) {
      return { allow: true, reason: `${url.protocol} cannot reach the network` };
    }
    if (!this.#policy.allowSchemes.includes(url.protocol)) {
      return { allow: false, reason: `scheme ${url.protocol} is not permitted` };
    }

    const { allowHosts, allowOrigins, allowPrivate } = this.#policy;

    // Both lists are allowlists, so they union. Treating one as a replacement is a trap: the harness
    // pins its own origin so a local run cannot reach another service on loopback, and that silently
    // became a *deny* for every external host — which surfaced only as ERR_BLOCKED_BY_CLIENT on the
    // start page, pointing at Chrome rather than at the policy. To pin an origin exclusively, pass
    // allowHosts: null.
    if (allowOrigins || allowHosts) {
      if (allowOrigins && originMatches(url, allowOrigins)) {
        return { allow: true, reason: 'origin is allowlisted' };
      }
      if (allowHosts && hostMatches(url.hostname, allowHosts)) {
        return { allow: true, reason: 'host is in the allowlist' };
      }
      return {
        allow: false,
        reason: `${url.origin} matches neither the origin nor the host allowlist`,
      };
    }

    // No allowlist: open mode. That is exactly when private ranges must be refused, since "allow any
    // http(s)" would otherwise mean "allow any http(s), including the machine's own network".
    if (!allowPrivate && isPrivateHost(url.hostname)) {
      return { allow: false, reason: `private or loopback host ${url.hostname} is blocked in open mode` };
    }
    return { allow: true, reason: 'open mode' };
  }

  /**
   * Intercept every request and apply the policy.
   *
   * The handler must answer each paused request exactly once. A thrown error here would leave the
   * request hanging and stall the page, so every branch is guarded.
   */
  attach(session) {
    this.#session = session;

    const handler = (method, params) => {
      if (method !== 'Fetch.requestPaused') return;
      const { requestId, request } = params;
      if (!requestId || this.#decided.has(requestId)) return;
      this.#decided.add(requestId);

      const verdict = this.evaluate(request?.url ?? '');
      this.#record(verdict, request);

      const action = verdict.allow
        ? session.send('Fetch.continueRequest', { requestId }).catch(() => {})
        : session.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      void action;
    };

    this.#off = session.on(handler);
    // Interception is per-target. Without re-enabling on every session, a tab opened by a click would
    // have no allowlist at all — the control would lapse precisely when an agent is being lured into
    // a new origin, which is when it matters most.
    if (typeof session.onNewSession === 'function') {
      session.onNewSession((s) => this.#enableFetch(s));
    }

    return this.#enableFetch(session);
  }

  async #enableFetch(session) {
    try {
      await session.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      this.stats.degraded = false;
      this.stats.error = null;
    } catch (err) {
      // Never fatal: a missing interception layer should be visible, not fatal to the run.
      this.stats.degraded = true;
      this.stats.error = err.message;
    }
  }

  #record(verdict, request) {
    if (verdict.allow) {
      this.stats.allowed++;
      return;
    }
    this.stats.blocked++;
    if (this.stats.blockedRequests.length < 50) {
      this.stats.blockedRequests.push({
        url: request?.url,
        method: request?.method,
        type: request?.resourceType ?? undefined,
        reason: verdict.reason,
      });
    }
    this.#policy.onDecision({ allowed: false, url: request?.url, reason: verdict.reason });
  }

  async detach() {
    try { this.#off?.(); } catch { /* listener already gone */ }
    this.#off = null;
    try { await this.#session?.send('Fetch.disable'); } catch { /* session already closed */ }
  }
}