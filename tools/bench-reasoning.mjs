/**
 * Is thinking actually off, and does it matter?
 *
 * The proxy already sends `reasoning_effort: 'none'`, so this is a check rather
 * than a hypothesis. It matters because a reasoning model that thinks anyway
 * spends its whole token budget on `reasoning_content` and returns an EMPTY
 * reply with `finish_reason: "length"` - which looks exactly like the AI being
 * broken, and costs 12-19s per turn.
 *
 * Reported per variant:
 *   - wall time
 *   - empty content
 *   - reasoning tokens actually produced
 *   - what a real turn costs
 *
 *   node tools/bench-reasoning.mjs
 */
const URL = 'http://127.0.0.1:1234/v1/chat/completions';
const MODEL = 'prism-ml/bonsai-27b';
const INPUTS = ['i miss you', 'what should i do about my boss', 'tell me something interesting'];

const VARIANTS = [
  { name: 'reasoning_effort:none (what the app sends)', body: { reasoning_effort: 'none' } },
  { name: 'no reasoning field at all', body: {} },
  { name: 'reasoning_effort:low', body: { reasoning_effort: 'low' } },
  { name: 'chat_template_kwargs.enable_thinking:false', body: { chat_template_kwargs: { enable_thinking: false } } },
  { name: 'none + enable_thinking:false (belt and braces)', body: { reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } } },
];

async function call(input, extra) {
  const t0 = Date.now();
  const r = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: input }],
      temperature: 0.7,
      max_tokens: 170,
      ...extra,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const ms = Date.now() - t0;
  if (!r.ok) return { ms, error: `HTTP ${r.status}`, text: '' };
  const j = await r.json();
  const msg = j.choices?.[0]?.message || {};
  const usage = j.usage || {};
  return {
    ms,
    text: (msg.content || '').trim(),
    reasoning: (msg.reasoning_content || msg.reasoning || '').trim(),
    finish: j.choices?.[0]?.finish_reason,
    completionTokens: usage.completion_tokens,
  };
}

console.log(`model: ${MODEL}\n`);
for (const v of VARIANTS) {
  console.log(`--- ${v.name}`);
  let empties = 0, reasoningTurns = 0;
  let total = 0, totalTokens = 0;
  for (const input of INPUTS) {
    const r = await call(input, v.body);
    if (r.error) { console.log(`    "${input}" -> ${r.error}`); continue; }
    const empty = !r.text;
    if (empty) empties++;
    if (r.reasoning) reasoningTurns++;
    total += r.ms;
    totalTokens += r.completionTokens || 0;
    console.log(
      `    ${String(r.ms).padStart(6)}ms  tokens=${String(r.completionTokens ?? '?').padStart(4)}  ` +
      `finish=${String(r.finish).padEnd(7)} ${empty ? 'EMPTY ' : ''}` +
      `${r.reasoning ? `REASONED(${r.reasoning.length} ch) ` : ''}` +
      `"${(r.text || r.reasoning || '').slice(0, 52).replace(/\s+/g, ' ')}"`
    );
  }
  console.log(`    avg ${Math.round(total / INPUTS.length)}ms, ${empties}/${INPUTS.length} empty, ` +
    `${reasoningTurns}/${INPUTS.length} reasoned, ${totalTokens} completion tokens\n`);
}
