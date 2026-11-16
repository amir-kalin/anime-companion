// Model client and transcript handling.
//
// This is the recommended production path (Responses API, for gpt-6-astra) and until now nothing
// exercised it: the scripted planner reports `transcriptStyle: 'chat'`, so the Responses branch in the
// loop — including the `function_call_output` that must carry the previous step's result — was dead
// code. A wire format nobody runs is a wire format nobody has verified.
//
// So this suite stands up a stub endpoint that records every request body and replies with scripted
// payloads, then asserts the exact shape of what the loop sends. The critical assertion is that each
// tool call is answered with the matching call_id: the docs are explicit that an unanswered call
// makes the *next* request fail, which is the kind of bug that only appears against a live API.

import { createServer } from 'node:http';
import { check, section, summary } from './assert.mjs';
import { ModelClient, execTool } from '../src/agent/model.mjs';
import { AgentLoop, StaticPlanner } from '../src/agent/loop.mjs';

/** Record every request body and reply with scripted payloads in order. */
function createStub(responses) {
  const requests = [];
  let index = 0;
  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = JSON.parse(raw); } catch { /* leave null */ }

    const script = responses[Math.min(index, responses.length - 1)];
    index++;

    requests.push({ path: req.url, method: req.method, body, headers: req.headers });

    const payload = typeof script === 'function' ? script(body) : script;
    if (payload?.__status && payload.__status >= 400) {
      res.writeHead(payload.__status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
  });

  return {
    requests,
    get count() { return index; },
    async listen() {
      await new Promise((done) => server.listen(0, '127.0.0.1', done));
      return `http://127.0.0.1:${server.address().port}/v1`;
    },
    close: () => new Promise((done) => server.close(done)),
  };
}

const responsesTurn = (id, callId, code) => ({
  id,
  status: 'completed',
  output: [
    { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'thinking about it' }] },
    { type: 'function_call', call_id: callId, name: 'exec_js', arguments: JSON.stringify({ code }) },
  ],
  usage: { input_tokens: 10, output_tokens: 5 },
});

const responsesFinal = (id, text) => ({
  id,
  status: 'completed',
  output: [{ type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text }] }],
});

const chatTurn = (id, callId, code) => ({
  id,
  choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: callId, type: 'function', function: { name: 'exec_js', arguments: JSON.stringify({ code }) } }] } }],
});

const chatFinal = (text) => ({ choices: [{ message: { role: 'assistant', content: text } }] });

// A minimal page stub: the loop only needs isAlive() and the sandbox needs a real page object, so
// the model-facing assertions are isolated from the browser by using a fake page.
const fakePage = {
  isAlive: async () => true,
  telemetry: [],
  goto: async () => {},
  snapshot: async () => ({ text: '' }),
  title: async () => 'stub',
};
fakePage.telemetry = [];

let failed = 0;
const openStubs = [];

/** Register a stub for cleanup, so a thrown assertion cannot leave a listener holding the loop open. */
const stub = (responses) => {
  const s = createStub(responses);
  openStubs.push(s);
  return s;
};

const cleanup = async () => {
  await Promise.all(openStubs.map((s) => s.close().catch(() => {})));
  openStubs.length = 0;
};

process.on('exit', () => { for (const s of openStubs) s.close().catch(() => {}); });

try {
  // ------------------------------------------------------------------ tool schema
  section('exec tool schema matches the documented shape');

  const tool = execTool('a page');
  check('declared as a function tool', tool.type === 'function', tool.type);
  check('named exec_js', tool.name === 'exec_js', tool.name);
  check('strict is set', tool.strict === true);
  check('parameters are an object schema', tool.parameters.type === 'object');
  check('code is the only property', Object.keys(tool.parameters.properties).join() === 'code');
  check('code is required', tool.parameters.required.join() === 'code');
  check('additionalProperties is false', tool.parameters.additionalProperties === false);
  check('the description names the observation functions',
    tool.description.includes('log(') && tool.description.includes('display('));
  check('the description states the persistence requirement',
    /survive between calls/i.test(tool.description));
  check('the description explains the coordinate frame',
    /screenshot pixels/i.test(tool.description), '(agents get this wrong constantly)');

  // ------------------------------------------------------------------ responses path
  section('responses path: request shape');

  const stubA = stub([
    responsesTurn('resp_1', 'call_alpha', "log('one');"),
    responsesFinal('resp_2', 'finished'),
  ]);
  const baseA = await stubA.listen();
  const clientA = new ModelClient({ baseUrl: baseA, apiKey: 'k', model: 'test-responses', api: 'responses' });
  check('client reports the responses transcript style', clientA.transcriptStyle === 'responses');

  const first = await clientA.step({
    tool,
    instruction: 'do the thing',
    previousResponseId: null,
  });
  check('the tool call is parsed out of the output array',
    first.toolCall?.name === 'exec_js' && first.toolCall.id === 'call_alpha',
    JSON.stringify(first.toolCall));
  check('arguments are carried as a string', typeof first.toolCall.args === 'string');
  check('a commentary-phase message is surfaced separately, not as the answer',
    first.commentary.includes('thinking about it') && first.text === '',
    `commentary=${first.commentary} text=${first.text}`);
  check('the response id is returned for the next turn', first.responseId === 'resp_1');
  check('usage is captured', first.usage?.input_tokens === 10);

  const reqA = stubA.requests[0];
  check('the request goes to the responses endpoint', reqA.path.endsWith('/responses'), reqA.path);
  check('the tool is declared in the tools array', reqA.body.tools[0].name === 'exec_js');
  check('the instruction is an input_text block',
    reqA.body.input[0].content[0].type === 'input_text', JSON.stringify(reqA.body.input[0].content[0]));
  check('no previous_response_id on the first turn', !('previous_response_id' in reqA.body));
  check('the bearer token is sent', reqA.headers.authorization === 'Bearer k');

  section('responses path: the second turn answers the first tool call');

  const second = await clientA.step({
    tool,
    instruction: 'continue',
    previousResponseId: first.responseId,
    toolOutput: { callId: 'call_alpha', output: [{ type: 'input_text', text: 'one' }] },
  });
  const reqB = stubA.requests[1];
  check('previous_response_id threads the conversation', reqB.body.previous_response_id === 'resp_1');
  check('the tool result is sent as a function_call_output',
    reqB.body.input[0].type === 'function_call_output', JSON.stringify(reqB.body.input[0].type));
  check('it carries the matching call_id', reqB.body.input[0].call_id === 'call_alpha',
    reqB.body.input[0].call_id);
  check('the tool result carries its text', reqB.body.input[0].output[0].text === 'one');
  check('the new instruction follows it', reqB.body.input[1].role === 'user');
  check('the final message is parsed', second.text === 'finished' && second.toolCall === null);
  await stubA.close();

  // ------------------------------------------------------------------ images
  section('responses path: image observations');

  const stubB = stub([responsesFinal('resp_i', 'ok')]);
  const baseB = await stubB.listen();
  const clientB = new ModelClient({ baseUrl: baseB, apiKey: 'k', model: 'm', api: 'responses', vision: true });
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  await clientB.step({ tool, instruction: 'look', images: [{ url: png }] });
  const content = stubB.requests[0].body.input[0].content;
  check('instruction text precedes the image', content[0].type === 'input_text' && content[1].type === 'input_image',
    content.map((c) => c.type).join(','));
  check('the image requests original detail', content[1].detail === 'original', content[1].detail);
  await stubB.close();

  section('vision failure degrades to text-only exactly once');

  const stubC = stub([
    { __status: 400, error: { message: 'image input not supported by this model' } },
    responsesFinal('resp_v', 'recovered'),
  ]);
  const baseC = await stubC.listen();
  const clientC = new ModelClient({ baseUrl: baseC, apiKey: 'k', model: 'm', api: 'responses', vision: true });
  const degradedReply = await clientC.step({ tool, instruction: 'look', images: [{ url: png }] });
  check('the retry succeeded', degradedReply.text === 'recovered', degradedReply.text);
  check('the client is marked degraded', clientC.degraded === true);
  check('exactly two requests were made', stubC.count === 2, `count=${stubC.count}`);
  const retryContent = stubC.requests[1].body.input[0].content;
  check('the retry carried no image', retryContent.every((c) => c.type === 'input_text'),
    retryContent.map((c) => c.type).join(','));
  await stubC.close();

  // ------------------------------------------------------------------ chat path
  section('chat path: request shape');

  const stubD = stub([chatTurn('c1', 'call_chat', "log('x');"), chatFinal('chat done')]);
  const baseD = await stubD.listen();
  const clientD = new ModelClient({ baseUrl: baseD, apiKey: 'k', model: 'm', api: 'chat' });
  check('client reports the chat transcript style', clientD.transcriptStyle === 'chat');

  const chatOne = await clientD.step({ tool, instruction: 'hello', history: [] });
  check('the tool call is parsed from choices', chatOne.toolCall?.id === 'call_chat', JSON.stringify(chatOne.toolCall));
  check('no response id is threaded', chatOne.responseId === null);
  check('the request goes to the chat completions endpoint',
    stubD.requests[0].path.endsWith('/chat/completions'), stubD.requests[0].path);
  const chatBody = stubD.requests[0].body;
  check('the tool is nested under function for this API',
    chatBody.tools[0].type === 'function' && chatBody.tools[0].function.name === 'exec_js',
    JSON.stringify(chatBody.tools[0]).slice(0, 80));
  check('tool_choice is auto', chatBody.tool_choice === 'auto');
  await clientD.step({
    tool,
    instruction: 'again',
    history: [
      { role: 'assistant', tool_calls: [{ id: 'call_chat', type: 'function', function: { name: 'exec_js', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_chat', content: [{ type: 'text', text: 'ok' }] },
    ],
  });
  const secondBody = stubD.requests[1].body;
  check('the local transcript is replayed', secondBody.messages.length === 3, `len=${secondBody.messages.length}`);
  check('the tool result keeps its tool_call_id', secondBody.messages[1].tool_call_id === 'call_chat');
  await stubD.close();

  // ------------------------------------------------------------------ loop integration
  section('loop drives the responses path end to end');

  const stubE = stub([
    responsesTurn('resp_e1', 'call_e1', "log('ran');"),
    responsesTurn('resp_e2', 'call_e2', "throw new Error('boom');"),
    responsesFinal('resp_e3', 'all done'),
  ]);
  const baseE = await stubE.listen();
  const clientE = new ModelClient({ baseUrl: baseE, apiKey: 'k', model: 'm', api: 'responses' });

  const loop = new AgentLoop({
    page: fakePage,
    sandbox: {
      run: async (code) => (code.includes('boom')
        ? { ok: false, text: '', images: [], error: 'Error: boom', durationMs: 1 }
        : { ok: true, text: 'ran', images: [], durationMs: 1 }),
    },
    planner: clientE,
    tool,
    task: 'exercise the wire format',
    maxSteps: 6,
  });
  const result = await loop.run();

  check('the run completed', result.stopReason === 'completed', result.stopReason);
  check('two steps executed', result.steps.length === 2, `steps=${result.steps.length}`);
  check('the final text came through', result.text === 'all done', result.text);

  const calls = stubE.requests.map((r) => r.body.input[0]);
  // Turn 1 opens with a plain user message; there is nothing to answer yet.
  check('turn 1 has no tool output', calls[0].type !== 'function_call_output' && calls[0].role === 'user',
    `${calls[0].type}/${calls[0].role}`);
  check('turn 2 answers call_e1', calls[1].type === 'function_call_output' && calls[1].call_id === 'call_e1',
    `${calls[1].type}/${calls[1].call_id}`);
  check('turn 2 reports the step output', calls[1].output[0].text === 'ran', calls[1].output[0].text);
  check('turn 3 answers call_e2 with the error', calls[2].call_id === 'call_e2');
  check('the failure reached the model with exactly one Error: prefix',
    /^Error: boom$/.test(calls[2].output[0].text), calls[2].output[0].text);
  check('every turn threads the previous response id',
    stubE.requests[1].body.previous_response_id === 'resp_e1' &&
    stubE.requests[2].body.previous_response_id === 'resp_e2',
    `${stubE.requests[1].body.previous_response_id} / ${stubE.requests[2].body.previous_response_id}`);
  check('no turn leaves a tool call unanswered',
    stubE.requests.every((r, i) => i === 0 || r.body.input[0].type === 'function_call_output'));
  await stubE.close();

  section('errors from the endpoint surface, not swallow');

  const stubF = stub([{ __status: 500, error: { message: 'upstream exploded' } }]);
  const baseF = await stubF.listen();
  const clientF = new ModelClient({ baseUrl: baseF, apiKey: 'k', model: 'm', api: 'responses' });
  let errorText = '';
  try {
    await clientF.step({ tool, instruction: 'x' });
  } catch (err) {
    errorText = err.message;
  }
  check('a 500 becomes an exception', /upstream exploded/.test(errorText), errorText.slice(0, 60));
  await stubF.close();
} catch (err) {
  failed++;
  console.log(`\nSUITE ERROR: ${err.stack}`);
}

// Always tear down: a listener left open keeps the event loop alive and turns a real failure into a
// silent hang, which is worse than a crash because it looks like progress.
await cleanup();

process.exitCode = summary() ? 0 : 1;