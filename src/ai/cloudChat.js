import { CLOUD } from '../utils/config.js';

/**
 * Cloud chat fallback.
 *
 * The local model lives on the PC. When the PC is asleep, the phone cannot
 * reach it at all, so this module calls a hosted model DIRECTLY — bypassing
 * the PC, its proxy, and its API keys.
 *
 * Every provider in `CLOUD.providers` speaks the OpenAI `chat/completions`
 * shape with the same SSE framing, so there is one implementation and one
 * code path rather than one per vendor. The local path uses the identical
 * format, which is why LM Studio, Ollama, llama.cpp and vLLM are all
 * swappable behind the same proxy.
 *
 * The key is held in localStorage on the device. It is never written to the
 * repository, never sent to the PC, and never leaves the device except as
 * an Authorization header to the provider the user chose.
 */

/** @returns {{provider: string, model: string, apiKey: string, base: string}|null} */
export function loadCloudSettings() {
  try {
    const raw = localStorage.getItem(CLOUD.storageKey);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j) return null;
    const provider = CLOUD.providers[j.provider] ? j.provider : null;
    if (!provider) return null;
    const apiKey = String(j.apiKey || '').trim();
    const base = String(j.base || CLOUD.providers[provider].base || '').replace(/\/+$/, '');
    // A key is normally required, but a custom endpoint on your own machine
    // (Ollama, llama.cpp) needs none, so a base URL is enough.
    if (!apiKey && !base) return null;
    return {
      provider,
      model: String(j.model || CLOUD.providers[provider].defaultModel),
      apiKey,
      base,
    };
  } catch {
    // A corrupt entry must not break the app; treat it as "not configured".
    return null;
  }
}

export function saveCloudSettings({ provider, model, apiKey, base } = {}) {
  const p = CLOUD.providers[provider] ? provider : Object.keys(CLOUD.providers)[0];
  const value = {
    provider: p,
    model: String(model || CLOUD.providers[p].defaultModel),
    apiKey: String(apiKey || '').trim(),
    base: String(base || CLOUD.providers[p].base || '').replace(/\/+$/, ''),
  };
  localStorage.setItem(CLOUD.storageKey, JSON.stringify(value));
  return value;
}

export function clearCloudSettings() {
  try { localStorage.removeItem(CLOUD.storageKey); } catch { /* private mode */ }
}

/** Is a cloud provider configured and ready to be used? */
export function cloudConfigured() {
  return Boolean(loadCloudSettings());
}

/**
 * Stream a reply from the configured cloud provider.
 *
 * Calls `onDelta(text)` for each chunk of content as it arrives, so the
 * caller can start speaking on the first completed sentence exactly as it
 * does with the local model.
 *
 * @param {object} opts
 * @param {Array<{role: string, content: string}>} opts.messages
 * @param {(delta: string) => void} opts.onDelta
 * @param {AbortSignal} [opts.signal]
 * @param {object} [opts.settings] overrides the stored settings
 * @returns {Promise<{text: string, model: string, provider: string}>}
 */
export async function streamCloud({ messages, onDelta, signal, settings } = {}) {
  const s = settings || loadCloudSettings();
  if (!s) throw new Error('no cloud provider configured');
  const provider = CLOUD.providers[s.provider];
  if (!provider) throw new Error(`unknown cloud provider "${s.provider}"`);

  const base = (s.base || provider.base || '').replace(/\/+$/, '');
  if (!base) throw new Error('no cloud endpoint configured');

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${s.apiKey}`,
    },
    body: JSON.stringify({
      model: s.model,
      messages,
      stream: true,
      temperature: 0.9,
      // The persona makes replies short, so the budget is generous enough not
      // to cut a reply mid-word. The same reasoning as TTS.maxTokens.
      max_tokens: 400,
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    let detail = `cloud ${s.provider} HTTP ${res.status}`;
    try {
      const j = await res.json();
      detail = j?.error?.message || j?.error || detail;
    } catch { /* not json */ }
    throw new Error(detail);
  }

  let text = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line.
    const frames = buf.split(/\r?\n\r?\n/);
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      for (const line of frame.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          const delta = j.choices?.[0]?.delta?.content;
          if (delta) {
            text += delta;
            onDelta?.(delta);
          }
        } catch { /* partial frame */ }
      }
    }
  }

  return { text: text.trim(), model: s.model, provider: s.provider };
}

/**
 * A short, honest description of the cloud setup, for the status line.
 * @returns {string}
 */
export function describeCloud() {
  const s = loadCloudSettings();
  if (!s) return 'not configured';
  const label = CLOUD.providers[s.provider]?.label || s.provider;
  const where = s.provider === 'custom' ? s.base : '';
  return `${label}${where ? ` (${where})` : ''} · ${s.model}`;
}
