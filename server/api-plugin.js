import { Buffer } from 'node:buffer';
import { memoryStore } from './memory.js';

/**
 * Vite dev-server middleware for the fully local stack.
 *
 * Why a server at all, when everything is on localhost:
 *  - The browser talks to one origin, so the voice service does not need CORS.
 *  - STT requires an AudioBuffer of a specific format; converting it here keeps
 *    that detail in one place.
 *  - It gives one place to swap local for a cloud provider later.
 *
 * Nothing secret passes through: the LLM is LM Studio on 127.0.0.1 and the
 * voice service is on 127.0.0.1, so no API keys exist anywhere in this project.
 *
 * Chat is proxied to LM Studio's OpenAI-compatible endpoint and the SSE stream
 * is passed straight through, which is what lets speech start on the first
 * completed sentence instead of after the whole reply.
 */

const MAX_TEXT = 2000;
const CHAT_TIMEOUT_MS = 120_000;
const TTS_TIMEOUT_MS = 30_000;
const STT_TIMEOUT_MS = 60_000;

/**
 * Clamp the chat token budget.
 *
 * Module scope on purpose: defined inside the plugin factory it was not visible
 * to the chat route at all, which failed every request with
 * "clampTokens is not defined" - a good reminder that hoisting only reaches the
 * enclosing block.
 *
 * The value arrives from the client, so it is bounded rather than trusted. The
 * FLOOR is the important part: too small a budget truncates a reply mid-word,
 * which reads as a broken model rather than a short one. Length is controlled on
 * a sentence boundary instead, via TTS.maxSpokenSentences.
 */
const MAX_TOKENS_MIN = 200;
const MAX_TOKENS_MAX = 800;
const MAX_TOKENS_DEFAULT = 400;
function clampTokens(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return MAX_TOKENS_DEFAULT;
  return Math.round(Math.min(MAX_TOKENS_MAX, Math.max(MAX_TOKENS_MIN, n)));
}

function readBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

/** Only loopback, so nothing local is reachable from the network. */
function requireLocal(req, res) {
  const ip = req.socket.remoteAddress || '';
  const local = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!local) {
    sendJson(res, 403, { error: 'local requests only' });
    return false;
  }
  return true;
}

export function companionApi(env) {
  const geminiListenerUrl = (env.GEMINI_LISTENER_URL || 'http://127.0.0.1:5200').replace(/\/+$/, '');
  const lmBase = (env.LMSTUDIO_URL || 'http://127.0.0.1:1234/v1').replace(/\/+$/, '');
  const lmModel = env.LM_MODEL || 'qwen/qwen3.5-9b';
  const lmKey = env.LMSTUDIO_API_KEY || 'lm-studio';
  const voiceUrl = (env.VOICE_URL || 'http://127.0.0.1:4123').replace(/\/+$/, '');

  // Persistent memory, owned by the server so there is exactly one writer.
  const memory = memoryStore({
    root: process.cwd(),
    lmBase,
    lmKey,
    lmModel,
    log: (m) => console.warn(m),
  });

  return {
    name: 'companion-api',

    configureServer(server) {
      /**
       * CORS, for the native Android app.
       *
       * The app on the phone is served from the WebView's own origin
       * (https://localhost on Android) while the stack — LM Studio, Piper,
       * the memory file — is on the PC. Every /api call is therefore
       * cross-origin.
       *
       * The browser build never needs this: it is served by the same server
       * that hosts the API, so the requests are same-origin.
       *
       * The allowed list is explicit rather than a wildcard. A wildcard
       * would let any page the phone happens to be visiting make requests to
       * the memory file and the model, which is exactly the thing this
       * server is not supposed to expose to a network.
       */
      const CORS_ORIGINS = new Set([
        'https://localhost',
        'http://localhost',
        'capacitor://localhost',
        'capacitor://127.0.0.1',
      ]);

      server.middlewares.use((req, res, next) => {
        const origin = req.headers.origin;
        if (origin && CORS_ORIGINS.has(origin)) {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Vary', 'Origin');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
          res.setHeader('Access-Control-Max-Age', '600');
        }
        if (req.method === 'OPTIONS') {
          // Preflight, answered here so it never reaches a route handler.
          res.statusCode = 204;
          res.end();
          return;
        }
        next();
      });

      /**
       * Cached upstream status.
       *
       * The upstreams can each take seconds to answer: the voice service is a
       * FastAPI app whose threadpool backs up while Piper holds the TTS lock,
       * and LM Studio can stall when several models are resident on a small
       * GPU. Probing them on every request meant /api/health was only as fast
       * as the slowest thing it watches, so a health check taken during normal
       * use looked like a dead server - and a supervisor that trusts it will
       * restart a healthy app.
       *
       * So: a short TTL, an in-flight guard so N concurrent probes share one
       * upstream round trip, and a stale-but-valid answer if a refresh fails.
       * The result is that /api/health answers fast and never reports a service
       * as down purely because it was busy.
       */
      const UPSTREAM_TTL_MS = 3000;
      let upstreamCache = null;   // { at, voice, llm }
      let upstreamInFlight = null;

      const probeUpstreams = async () => {
        if (upstreamCache && Date.now() - upstreamCache.at < UPSTREAM_TTL_MS) {
          return upstreamCache;
        }
        if (upstreamInFlight) return upstreamInFlight;

        upstreamInFlight = (async () => {
          const timeout = { signal: AbortSignal.timeout(2000) };
          let voice = { ok: false };
          let llm = { ok: false, isGemini: false, models: [] };

          // 1. Probe Gemini listener first (fast local bridge)
          try {
            const geminiProbe = await fetch(`${geminiListenerUrl}/health`, { signal: AbortSignal.timeout(1000) })
              .then((r) => r.json())
              .catch(() => null);
            if (geminiProbe?.ok) {
              llm = { ok: true, isGemini: true, models: ['gemini-agent', 'gemini-2.0-flash'] };
            }
          } catch { /* listener not running */ }

          // Concurrently probe voice and (if Gemini is not active) LM Studio
          const probes = [fetch(`${voiceUrl}/health`, timeout).then((r) => r.json()).catch(() => ({ ok: false }))];
          if (!llm.ok) {
            probes.push(
              fetch(`${lmBase}/models`, {
                headers: { Authorization: `Bearer ${lmKey}` },
                ...timeout,
              })
                .then((r) => r.json())
                .catch(() => ({ ok: false }))
            );
          }

          const [voiceRes, lmRes] = await Promise.allSettled(probes);
          if (voiceRes.status === 'fulfilled' && voiceRes.value?.ok) voice = voiceRes.value;
          if (!llm.ok && lmRes?.status === 'fulfilled' && lmRes.value?.data) {
            llm = { ok: true, isGemini: false, models: (lmRes.value.data || []).map((m) => m.id) };
          }

          // A failed refresh keeps the previous answer rather than declaring
          // everything down: "busy" and "dead" are not the same thing.
          if ((voice.ok || llm.ok) && upstreamCache) {
            voice = voice.ok ? voice : upstreamCache.voice;
            llm = llm.ok ? llm : upstreamCache.llm;
          }
          upstreamCache = { at: Date.now(), voice, llm };
          return upstreamCache;
        })().finally(() => { upstreamInFlight = null; });

        return upstreamInFlight;
      };

      server.middlewares.use('/api/health', async (_req, res) => {
        const { voice, llm } = await probeUpstreams();
        const activeModel = llm.isGemini ? 'gemini-agent' : lmModel;
        sendJson(res, 200, {
          ok: true,
          llm: llm.ok && (llm.isGemini || llm.models.includes(lmModel)),
          llmModel: activeModel,
          llmModels: llm.models,
          isGemini: Boolean(llm.isGemini),
          voice: voice.ok,
          stt: !!voice.stt,
          sttDevice: voice.stt_device || null,
        });
      });

      // ---------------------------------------------------------- persona
      // The prompt the app actually sends, for tools that used to keep their
      // own copy and drift from it. Read-only, and it carries no user data.
      server.middlewares.use('/api/persona', async (req, res) => {
        if (!requireLocal(req, res)) return;
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' });
        // Resolved at request time so an edit to config.js is picked up on the
        // next request without a restart.
        const { TTS, ANIMATION_CHOICE } = await import('../src/utils/config.js');
        sendJson(res, 200, { system: `${TTS.system}\n\n${ANIMATION_CHOICE}` });
      });

      // ---------------------------------------------------------- affection
      server.middlewares.use('/api/affection', async (req, res) => {
        if (!requireLocal(req, res)) return;
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' });
        try {
          const { getAffectionSummary } = await import('../tools/waifu-engine.mjs');
          sendJson(res, 200, getAffectionSummary());
        } catch {
          sendJson(res, 200, { points: 50, level: 2, title: 'Partner in Crime' });
        }
      });

      // ------------------------------------------------------------ memory
      server.middlewares.use('/api/memory', async (req, res) => {
        if (!requireLocal(req, res)) return;
        if (req.method === 'DELETE') {
          sendJson(res, 200, { cleared: true, doc: await memory.clear() });
          return;
        }
        if (req.method === 'POST') {
          let body;
          try {
            body = await readBody(req);
          } catch (e) {
            return sendJson(res, 400, { error: e.message });
          }
          // A memory write must never be able to take the server down. This
          // handler is a bare async fn handed to `middlewares.use`, so Connect
          // does not catch a rejection from it and Node exits on the unhandled
          // one - which is how a failed rename took the whole dev server down
          // while the app looked fine.
          try {
            if (body.event) {
              await memory.recordEvent(body.event);
            } else if (body.note) {
              const d = await memory.load();
              d.notes.push(String(body.note).slice(0, 200));
              if (d.notes.length > 40) d.notes = d.notes.slice(-40);
              await memory.save();
            } else {
              // Recording an exchange also persists immediately, so a reboot
              // mid-session keeps everything already said.
              await memory.recordTurn(body.user, body.mika);
            }
          } catch (e) {
            console.error('[memory] write failed:', e);
            return sendJson(res, 500, { error: 'Could not save to memory.' });
          }
          const d = await memory.load();
          return sendJson(res, 200, {
            turns: d.turns || 0,
            notes: d.notes,
            events: d.events,
            updated: d.updated,
          });
        }
        const d = await memory.load();
        sendJson(res, 200, {
          turns: d.turns || 0,
          notes: d.notes,
          events: d.events,
          transcriptCount: d.transcript.length,
          created: d.created,
          updated: d.updated,
        });
      });

      // ------------------------------------------------------------- chat (SSE)
      server.middlewares.use('/api/chat', async (req, res) => {
        if (!requireLocal(req, res)) return;
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });

        let body;
        try {
          body = await readBody(req);
        } catch (e) {
          return sendJson(res, 400, { error: e.message });
        }

        const message = String(body.message || '').trim().slice(0, MAX_TEXT);
        const systemOverride = String(body.system || '').trim();
        // An empty message is allowed when a system override is supplied: that
        // is how a non-verbal event (being petted) drives a reply on its own.
        if (!message && !systemOverride) {
          return sendJson(res, 400, { error: 'message or system required' });
        }

        // OpenAI chat-completions shape: LM Studio, Ollama, llama.cpp and
        // vLLM all speak it, so the backend stays portable.
        //
        // The fallback is deliberately generic, NOT a copy of the persona. An
        // earlier copy drifted: it kept a stale version of the prompt, so a
        // request without an explicit `system` got different instructions from
        // the app, and nothing reported the difference. The real persona lives
        // in src/utils/config.js and the client always sends it.
        const system = systemOverride || String(
          body.system ||
            'You are Jinx, a chaotic and warm anime companion chatting face to face. ' +
            'Reply in one or two short sentences, because your replies are spoken aloud. ' +
            'Never use markdown, bullet points, code blocks, emoji or raw JSON.'
        );
        // Accept `content` (what the OpenAI shape and the client both use) and
        // `text` (the shape used elsewhere in this file). Filtering on only one
        // of them silently dropped the entire conversation history, which made
        // her forget everything said in the previous message.
        const history = Array.isArray(body.history)
          ? body.history
              .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && (typeof m.content === 'string' || typeof m.text === 'string'))
              .slice(-10)
              .map((m) => ({ role: m.role, content: String(m.content ?? m.text).slice(0, MAX_TEXT) }))
          : [];

        // With no user message, the system line carries the whole instruction.
        let messages = message
          ? [{ role: 'system', content: system }, ...history, { role: 'user', content: message }]
          : [{ role: 'system', content: system }, ...history];

        // Inject what she remembers, server-side, so the client cannot forget to
        // and every caller gets it consistently.
        if (body.useMemory !== false) {
          const d = await memory.load();
          const block = memory.memoryBlock(d);
          if (block) messages[0] = { role: 'system', content: `${messages[0].content}${block}` };
        }

        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), CHAT_TIMEOUT_MS);

        try {
          const upstreams = await probeUpstreams();
          const isGemini = Boolean(upstreams?.llm?.isGemini);
          const targetUrl = isGemini ? `${geminiListenerUrl}/v1/chat/completions` : `${lmBase}/chat/completions`;
          const targetModel = isGemini ? 'gemini-agent' : lmModel;
          const targetKey = isGemini ? 'gemini' : lmKey;

          const r = await fetch(targetUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${targetKey}`,
            },
            body: JSON.stringify({
              model: targetModel,
              stream: Boolean(body.stream),
              temperature: 0.9,
              max_tokens: clampTokens(body.maxTokens),
              reasoning_effort: 'none',
              chat_template_kwargs: { enable_thinking: false },
              messages,
            }),
            signal: ac.signal,
          });

          if (!r.ok) {
            const detail = (await r.text().catch(() => '')).slice(0, 400);
            return sendJson(res, r.status, { error: `${isGemini ? 'gemini listener' : 'lm studio'}: ${detail}` });
          }

          // Streamed: pipe SSE straight to the client so the browser can start
          // speaking on the first sentence.
          if (body.stream && r.body) {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            const reader = r.body.getReader();
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(Buffer.from(value));
              }
            } catch { /* client disconnected */ }
            res.end();
            return;
          }

          const j = await r.json();
          const text = j?.choices?.[0]?.message?.content?.trim();
          if (!text) return sendJson(res, 502, { error: 'lm studio: empty response' });
          sendJson(res, 200, { text });
        } catch (e) {
          sendJson(res, 502, { error: `lm studio request failed: ${e.message}` });
        } finally {
          clearTimeout(timer);
        }
      });

      // ---------------------------------------------------------------- TTS
      server.middlewares.use('/api/tts', async (req, res) => {
        if (!requireLocal(req, res)) return;
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });

        let body;
        try {
          body = await readBody(req);
        } catch (e) {
          return sendJson(res, 400, { error: e.message });
        }
        const text = String(body.text || '').trim().slice(0, MAX_TEXT);
        if (!text) return sendJson(res, 400, { error: 'text required' });
        // Optional delivery: a Piper length_scale derived from the emotional
        // cue in the model's reply, so pacing varies with feeling.
        const speed = Number.isFinite(body.speed) ? body.speed : null;

        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), TTS_TIMEOUT_MS);
        try {
          const r = await fetch(`${voiceUrl}/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(speed ? { text, speed } : { text }),
            signal: ac.signal,
          });
          if (!r.ok) {
            const detail = (await r.text().catch(() => '')).slice(0, 300);
            let msg = detail;
            try { msg = JSON.parse(detail).error || detail; } catch { /* not json */ }
            console.warn(`[companion-api] tts ${r.status}: ${msg}`);
            return sendJson(res, r.status, { error: `voice: ${msg}` });
          }
          const audio = Buffer.from(await r.arrayBuffer());
          res.statusCode = 200;
          res.setHeader('Content-Type', r.headers.get('content-type') || 'audio/wav');
          res.setHeader('Content-Length', audio.length);
          res.end(audio);
        } catch (e) {
          sendJson(res, 502, { error: `voice service unreachable: ${e.message}` });
        } finally {
          clearTimeout(timer);
        }
      });

      // ---------------------------------------------------------------- STT
      server.middlewares.use('/api/stt', async (req, res) => {
        if (!requireLocal(req, res)) return;
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });

        const chunks = [];
        let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > 25 * 1024 * 1024) return sendJson(res, 413, { error: 'audio too large' });
          chunks.push(c);
        }
        const audio = Buffer.concat(chunks);
        if (audio.length < 500) return sendJson(res, 200, { text: '' });

        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), STT_TIMEOUT_MS);
        try {
          const r = await fetch(`${voiceUrl}/stt`, {
            method: 'POST',
            headers: { 'Content-Type': 'audio/wav' },
            body: audio,
            signal: ac.signal,
          });
          const raw = await r.text();
          if (!r.ok) {
            let msg = raw;
            try { msg = JSON.parse(raw).error || raw; } catch { /* not json */ }
            return sendJson(res, r.status, { error: `voice: ${msg}` });
          }
          sendJson(res, 200, JSON.parse(raw));
        } catch (e) {
          sendJson(res, 502, { error: `voice service unreachable: ${e.message}` });
        } finally {
          clearTimeout(timer);
        }
      });
    },
  };
}
