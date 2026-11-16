/**
 * Where the local stack lives.
 *
 * In the browser, the app is served BY the dev server, so a relative
 * '/api/chat' IS the dev server and the request is same-origin. That is
 * simple and it is what the whole project was built around.
 *
 * In the Android app, the app is served from the WebView's own local
 * origin while the stack — LM Studio, Piper, the memory file — is on the
 * PC, reached over Tailscale. A relative URL there would hit the WebView
 * and 404, so the base has to be absolute.
 *
 * So the base is resolved rather than hardcoded:
 *   - the native app uses the tailnet hostname (overridable, because a
 *     tailnet hostname can change and the stack may not be on this PC)
 *   - the browser uses the empty base, which leaves the paths relative
 *
 * An absolute URL passed in is always left alone.
 */

const STORAGE_KEY = 'companion.apiBase';

/**
 * The PC, as seen from the phone.
 *
 * This is the tailnet hostname `tailscale serve` publishes. It is a
 * convenience default, not a hardcoded requirement: the setting can be
 * changed at runtime, and the whole point of the tailnet is that this
 * address is stable on your own devices.
 */
export const DEFAULT_API_BASE = 'https://cyborg-kali.tailffab08.ts.net';

/** Is this running inside the native (Capacitor) app? */
function isNativeApp() {
  try {
    return Boolean(window.Capacitor?.isNativePlatform?.());
  } catch {
    return false;
  }
}

function readStored() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v ? v.replace(/\/+$/, '') : '';
  } catch {
    // Private mode, or storage disabled.
    return '';
  }
}

/**
 * The base URL for API calls.
 * @returns {string} '' means "same origin"
 */
export function getApiBase() {
  const stored = readStored();
  if (stored) return stored;
  return isNativeApp() ? DEFAULT_API_BASE : '';
}

/** @param {string} url new base; '' clears the override */
export function setApiBase(url) {
  const clean = String(url || '').trim().replace(/\/+$/, '');
  try {
    if (clean) localStorage.setItem(STORAGE_KEY, clean);
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* private mode */ }
  return clean || (isNativeApp() ? DEFAULT_API_BASE : '');
}

/**
 * Resolve an API path against the configured base.
 *
 * @param {string} path e.g. '/api/chat'
 * @returns {string}
 */
export function apiUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  const base = getApiBase();
  if (!base) return path;   // same-origin: the browser case
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

/** A human description of where the stack is, for the status line. */
export function describeConnection() {
  const base = getApiBase();
  if (!base) return 'same origin (browser)';
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}
