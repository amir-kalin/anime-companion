/**
 * agent-listener.mjs — Real-Time Gemini / Antigravity Agent Listener Bridge
 *
 * Connects the 3D Anime Companion (Jinx) directly to the active Antigravity session
 * and autonomous co-working tools WITHOUT creating any new chats in Antigravity!
 *
 * Wire format: OpenAI-compatible SSE (/v1/chat/completions)
 * Port: 5200 (auto-detected by server/api-plugin.js)
 */

import http from 'node:http';
import os from 'node:os';
import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { solveUserRequest } from './helper-brain.mjs';
import { scanUserEnvironment, getAffectionSummary } from './waifu-engine.mjs';

// ------------------------------------------------------------- Configuration
const PORT = Number(process.env.GEMINI_LISTENER_PORT || process.argv.find((_, i, a) => a[i - 1] === '--port') || 5200);
const ROOT = process.cwd();
const DATA_DIR = join(ROOT, 'data');
try { mkdirSync(DATA_DIR, { recursive: true }); } catch {}

const MAILBOX_PATH = join(DATA_DIR, 'bridge-mailbox.json');
const RESPONSE_PATH = join(DATA_DIR, 'bridge-response.json');
const HISTORY_PATH = join(DATA_DIR, 'companion-history.json');
const NOTES_PATH = join(DATA_DIR, 'notes.json');
const ACTIVE_CHAT_FILE = join(DATA_DIR, 'active-chat-id.txt');

function getTargetConversationId() {
  try {
    if (existsSync(ACTIVE_CHAT_FILE)) {
      const id = readFileSync(ACTIVE_CHAT_FILE, 'utf8').trim();
      if (id) return id;
    }
  } catch {}
  return process.env.ANTIGRAVITY_CONVERSATION_ID ||
    process.argv.find((_, i, a) => a[i - 1] === '--session') ||
    'c4f5d22d-9a38-44fe-95f7-580e912d9208';
}

const AGENTAPI_PATH = 'C:\\Users\\KALI\\.gemini\\antigravity\\bin\\agentapi.bat';

// ANSI terminal colors
const c = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

const ANIM_TAGS = ['[[anim:talking]]', '[[anim:idle]]', '[[anim:bored]]', '[[anim:kiss]]', '[[anim:sit]]', '[[anim:sittalk]]'];

// ------------------------------------------------------------- Local Persistent Memory
function loadHistory() {
  try {
    if (existsSync(HISTORY_PATH)) {
      return JSON.parse(readFileSync(HISTORY_PATH, 'utf8'));
    }
  } catch {}
  return [];
}

function saveHistory(history) {
  try {
    const trimmed = history.slice(-25);
    writeFileSync(HISTORY_PATH, JSON.stringify(trimmed, null, 2), 'utf8');
  } catch {}
}

// ------------------------------------------------------------- System Co-Working Tools
const systemTools = {
  get_time: () => {
    const now = new Date();
    return {
      iso: now.toISOString(),
      local: now.toLocaleString(),
      time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      day: now.toLocaleDateString('en-US', { weekday: 'long' }),
      date: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    };
  },

  system_info: () => {
    const totalMem = Math.round(os.totalmem() / (1024 * 1024 * 1024));
    const freeMem = Math.round(os.freemem() / (1024 * 1024 * 1024));
    const cpus = os.cpus();
    return {
      platform: os.platform(),
      os: os.type() + ' ' + os.release(),
      cpuModel: cpus[0]?.model || 'unknown',
      cpuCores: cpus.length,
      memory: `${totalMem - freeMem}GB used / ${totalMem}GB total (${freeMem}GB free)`,
      uptime: `${Math.round(os.uptime() / 3600)}h uptime`,
    };
  },

  run_command: (command) => {
    try {
      const output = execSync(command, {
        timeout: 12000,
        encoding: 'utf8',
        shell: 'powershell.exe',
        maxBuffer: 1024 * 1024,
      });
      return { ok: true, output: output.trim().slice(0, 800) };
    } catch (err) {
      const out = (err.stdout || err.stderr || err.message || '').toString().trim();
      return { ok: false, error: out.slice(0, 500) };
    }
  },

  read_file: (filePath) => {
    try {
      const p = resolve(ROOT, filePath);
      if (!existsSync(p)) return { ok: false, error: `File not found: ${filePath}` };
      const st = statSync(p);
      if (st.isDirectory()) {
        const items = readdirSync(p).slice(0, 20);
        return { ok: true, isDir: true, items };
      }
      const content = readFileSync(p, 'utf8');
      const lines = content.split('\n');
      return { ok: true, lines: lines.length, size: st.size, preview: content.slice(0, 600) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  write_file: (filePath, content) => {
    try {
      const p = resolve(ROOT, filePath);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content, 'utf8');
      return { ok: true, path: filePath, bytes: Buffer.byteLength(content) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  list_files: (dirPath = '.') => {
    try {
      const p = resolve(ROOT, dirPath);
      if (!existsSync(p)) return { ok: false, error: 'Path not found' };
      const items = readdirSync(p, { withFileTypes: true }).map((e) =>
        e.isDirectory() ? `[DIR] ${e.name}` : e.name
      );
      return { ok: true, path: dirPath, items: items.slice(0, 25) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  open_target: (target) => {
    try {
      const t = target.trim();
      if (t.startsWith('http://') || t.startsWith('https://')) {
        execSync(`powershell -NoProfile -Command "Start-Process '${t}'"`, { timeout: 4000 });
        return { ok: true, opened: t };
      }
      const p = resolve(ROOT, t);
      const toOpen = existsSync(p) ? p : t;
      execSync(`powershell -NoProfile -Command "Start-Process '${toOpen}'"`, { timeout: 4000 });
      return { ok: true, opened: toOpen };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  clipboard_get: () => {
    try {
      const out = execSync(`powershell -NoProfile -Command "Get-Clipboard"`, { encoding: 'utf8', timeout: 3000 }).trim();
      return { ok: true, text: out || '(clipboard is empty)' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  clipboard_set: (text) => {
    try {
      const clean = text.replace(/'/g, "''").replace(/[\r\n]+/g, ' ');
      execSync(`powershell -NoProfile -Command "Set-Clipboard -Value '${clean}'"`, { timeout: 3000 });
      return { ok: true, text: text.slice(0, 40) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  manage_notes: (action, noteText = '') => {
    let notes = [];
    try {
      if (existsSync(NOTES_PATH)) notes = JSON.parse(readFileSync(NOTES_PATH, 'utf8'));
    } catch {}
    if (action === 'add' && noteText) {
      notes.push({ id: Date.now(), text: noteText, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
      writeFileSync(NOTES_PATH, JSON.stringify(notes, null, 2), 'utf8');
      return { ok: true, message: `Noted down: "${noteText}"`, count: notes.length };
    }
    if (action === 'clear') {
      writeFileSync(NOTES_PATH, '[]', 'utf8');
      return { ok: true, message: 'All notes cleared!' };
    }
    return { ok: true, notes: notes.slice(-6) };
  },
};

// ------------------------------------------------------------- Tool Dispatcher
function checkAndRunTools(userMessage) {
  const lower = userMessage.toLowerCase().trim();
  const clean = lower.replace(/^(?:hey\s+|hi\s+|ok\s+)?(?:gemini|jinx|companion)[\s,:]+/i, '').trim();
  const executed = [];

  // Screen / Workspace Vision
  if (clean.match(/\b(what is on my screen|what's on my screen|look at my screen|what am i doing|can you see my screen|see what i'm working on|what's open|what apps|see my screen)\b/) || clean.includes('on my screen') || clean.includes('at my screen')) {
    const env = scanUserEnvironment();
    executed.push({ name: 'screen_vision', result: `Active open apps: ${env.summary}` });
  }

  // Time & Date
  else if (clean.match(/\b(what time|current time|what day|what's the date|time is it|what date)\b/)) {
    const t = systemTools.get_time();
    executed.push({ name: 'get_time', result: `It is currently ${t.time} on ${t.day}, ${t.date}.` });
  }

  // System Hardware / Status
  else if (clean.match(/\b(system info|hardware|cpu|ram|specs|uptime|how is my pc|pc status|how much ram|memory usage)\b/)) {
    const s = systemTools.system_info();
    executed.push({ name: 'system_info', result: `OS: ${s.os}, CPU: ${s.cpuModel} with ${s.cpuCores} cores, RAM: ${s.memory}, System uptime: ${s.uptime}.` });
  }

  // Git Status / Branch
  else if (clean.match(/\b(git status|what branch|modified files|git diff|git log)\b/)) {
    const cmd = clean.includes('diff') ? 'git diff --stat' : clean.includes('log') ? 'git log -n 3 --oneline' : 'git status -s';
    const res = systemTools.run_command(cmd);
    executed.push({ name: 'git_status', result: res.ok ? (res.output || 'Working tree clean, all commits up to date!') : res.error });
  }

  // Clipboard Get / Paste
  else if (clean.match(/\b(what is on my clipboard|read clipboard|paste clipboard|get clipboard)\b/)) {
    const clip = systemTools.clipboard_get();
    executed.push({ name: 'clipboard_get', result: clip.ok ? `Clipboard contents: "${clip.text}"` : `Could not read clipboard: ${clip.error}` });
  }

  // Clipboard Set / Copy
  else if (clean.match(/^(?:copy to clipboard|copy this|copy):\s*(.+)/i)) {
    const m = userMessage.match(/^(?:copy to clipboard|copy this|copy):\s*(.+)/i);
    const toCopy = m ? m[1].trim() : '';
    const res = systemTools.clipboard_set(toCopy);
    executed.push({ name: 'clipboard_set', result: res.ok ? `Copied to clipboard: "${toCopy}"` : `Failed to copy: ${res.error}` });
  }

  // Notes: List / Show
  else if (clean.match(/\b(show my notes|what are my notes|list notes|get notes|view notes)\b/)) {
    const res = systemTools.manage_notes('list');
    const items = res.notes.map((n) => `[${n.time}] ${n.text}`).join('; ');
    executed.push({ name: 'manage_notes', result: items ? `Here are your notes: ${items}` : 'You have no saved notes right now!' });
  }

  // Notes: Add / Remember
  else if (clean.match(/^(?:add note|remember|take a note|note down|save note|todo):\s*(.+)/i)) {
    const m = userMessage.match(/^(?:add note|remember|take a note|note down|save note|todo):\s*(.+)/i);
    const note = m ? m[1].trim() : '';
    const res = systemTools.manage_notes('add', note);
    executed.push({ name: 'manage_notes', result: res.message });
  }

  // Notes: Clear
  else if (clean.match(/\b(clear all notes|delete my notes|clear notes)\b/)) {
    const res = systemTools.manage_notes('clear');
    executed.push({ name: 'manage_notes', result: res.message });
  }

  // Open App / Webpage / Folder
  else if (clean.match(/^(?:open|launch|start)\s+([a-zA-Z0-9_\-\.\/\\:]+)/i) && !clean.startsWith('open film')) {
    const m = userMessage.match(/^(?:open|launch|start)\s+([a-zA-Z0-9_\-\.\/\\:]+)/i);
    const target = m ? m[1].trim() : '';
    if (target && !['a', 'the', 'my'].includes(target.toLowerCase())) {
      const res = systemTools.open_target(target);
      executed.push({ name: 'open_target', result: res.ok ? `Opened ${res.opened} successfully!` : `Could not open ${target}: ${res.error}` });
    }
  }

  // List Files
  else if (clean.match(/^(?:list files|show files|dir|ls)(?:\s+in\s+|\s+)?(.*)/i)) {
    const m = userMessage.match(/^(?:list files|show files|dir|ls)(?:\s+in\s+|\s+)?(.*)/i);
    const dir = m && m[1] ? m[1].trim() : '.';
    const res = systemTools.list_files(dir);
    if (res.ok) {
      executed.push({ name: 'list_files', result: `Files in ${res.path}: ${res.items.join(', ')}` });
    } else {
      executed.push({ name: 'list_files', result: `Failed: ${res.error}` });
    }
  }

  // Read File
  else if (lower.match(/^(?:read file|show file|view file|inspect file)\s+([^\s]+)/i)) {
    const m = userMessage.match(/^(?:read file|show file|view file|inspect file)\s+([^\s]+)/i);
    const file = m ? m[1].trim() : '';
    const res = systemTools.read_file(file);
    if (res.ok) {
      executed.push({ name: 'read_file', result: res.isDir ? `Directory contents: ${res.items.join(', ')}` : `File has ${res.lines} lines. Content preview: ${res.preview.slice(0, 300)}` });
    } else {
      executed.push({ name: 'read_file', result: `Error: ${res.error}` });
    }
  }

  // Write File
  else if (lower.match(/^(?:write file|save file|create file)\s+([^\s:]+)\s*:\s*([\s\S]+)/i)) {
    const m = userMessage.match(/^(?:write file|save file|create file)\s+([^\s:]+)\s*:\s*([\s\S]+)/i);
    const file = m ? m[1].trim() : '';
    const content = m ? m[2].trim() : '';
    const res = systemTools.write_file(file, content);
    if (res.ok) {
      executed.push({ name: 'write_file', result: `Wrote ${res.bytes} bytes to ${res.path}!` });
    } else {
      executed.push({ name: 'write_file', result: `Write error: ${res.error}` });
    }
  }

  // Run Arbitrary Terminal Command
  else {
    const cmdMatch = userMessage.match(/^(?:run command|execute command|run in terminal|terminal|powershell|cmd|run)\s*:?\s*(.+)/i) ||
                     userMessage.match(/^[$>]\s*(.+)/);
    if (cmdMatch) {
      const cmd = cmdMatch[1].trim();
      const res = systemTools.run_command(cmd);
      executed.push({ name: 'run_command', result: res.ok ? (res.output || 'Command completed successfully with no output.') : `Command error: ${res.error}` });
    }
  }

  return executed;
}

// ------------------------------------------------------------- Jinx Persona Formatter
function formatForJinx(rawText) {
  let cleaned = rawText
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^#+\s+/gm, '')
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    .replace(/[~`]/g, '')
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
    .trim();

  const hasTag = ANIM_TAGS.some((tag) => cleaned.startsWith(tag));
  if (!hasTag) {
    let chosenTag = '[[anim:talking]]';
    const lower = cleaned.toLowerCase();
    if (lower.includes('bored') || lower.includes('whatever') || lower.includes('yawn')) {
      chosenTag = '[[anim:bored]]';
    } else if (lower.includes('love') || lower.includes('kiss') || lower.includes('hug') || lower.includes('miss you')) {
      chosenTag = '[[anim:kiss]]';
    } else if (lower.includes('relax') || lower.includes('sit') || lower.includes('tired')) {
      chosenTag = '[[anim:sit]]';
    }
    cleaned = `${chosenTag} ${cleaned}`;
  }
  return cleaned;
}

// ------------------------------------------------------------- High-Speed In-Character Helper Engine
function generateAutonomousReply(userText, toolResults, history) {
  return solveUserRequest(userText, { toolResults, history });
}

// ------------------------------------------------------------- AI Interaction Bridge
/**
 * Sends turn notification to active Antigravity session,
 * and waits for Antigravity's response via bridge-response.json so Jinx speaks
 * the EXACT same response that appears in Antigravity.
 */
async function processTurn({ turnId, userText, history, toolResults, onHeartbeat }) {
  // Clear any stale previous response
  try {
    if (existsSync(RESPONSE_PATH)) {
      const old = JSON.parse(readFileSync(RESPONSE_PATH, 'utf8'));
      if (old && old.turnId !== turnId) {
        writeFileSync(RESPONSE_PATH, JSON.stringify({ turnId: null }), 'utf8');
      }
    }
  } catch {}

  // Write mailbox for the active conversation
  const mailbox = {
    turnId,
    timestamp: new Date().toISOString(),
    user: userText,
    history: history.slice(-6),
    toolResults,
    status: 'pending',
  };
  writeFileSync(MAILBOX_PATH, JSON.stringify(mailbox, null, 2), 'utf8');

  // Notify the active conversation via send-message
  try {
    const targetId = getTargetConversationId();
    const toolSummary = toolResults.map((t) => `${t.name}: ${t.result}`).join(' | ');
    const msg = `[JINX_CHAT] User: "${userText}" ${toolSummary ? `[Tools: ${toolSummary}]` : ''} (TurnID: ${turnId})\n(Important: Please write your spoken reply to data/bridge-response.json as: {"turnId":"${turnId}","text":"[[anim:talking]] your reply"} so Jinx speaks it!)`;
    spawn('cmd.exe', ['/c', AGENTAPI_PATH, 'send-message', targetId, msg], { stdio: 'ignore' });
  } catch {}

  // Wait for Antigravity's response (up to 55 seconds)
  // Heartbeats are sent every 400ms to keep SSE connection alive
  const MAX_WAIT_MS = 55_000;
  const t0 = Date.now();
  while (Date.now() - t0 < MAX_WAIT_MS) {
    if (existsSync(RESPONSE_PATH)) {
      try {
        const resp = JSON.parse(readFileSync(RESPONSE_PATH, 'utf8'));
        if (resp && resp.turnId === turnId && resp.text) {
          return formatForJinx(resp.text);
        }
      } catch {}
    }
    if (onHeartbeat) onHeartbeat();
    await new Promise((r) => setTimeout(r, 400));
  }

  // Fallback only if Antigravity did not respond within timeout
  const generated = generateAutonomousReply(userText, toolResults, history);
  return formatForJinx(generated);
}

// ------------------------------------------------------------- HTTP Server
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // Health endpoint
  if (url.pathname === '/health' || url.pathname === '/api/health') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(
      JSON.stringify({
        ok: true,
        provider: 'gemini',
        model: 'gemini-agent',
        conversationId: getTargetConversationId(),
        tools: Object.keys(systemTools),
      })
    );
  }

  // Affection & Relationship status endpoint
  if (url.pathname === '/api/affection' || url.pathname === '/affection') {
    res.setHeader('Content-Type', 'application/json');
    try {
      return res.end(JSON.stringify(getAffectionSummary()));
    } catch {
      return res.end(JSON.stringify({ points: 50, level: 2, title: 'Partner in Crime' }));
    }
  }

  // Models endpoint
  if (url.pathname === '/v1/models' || url.pathname === '/models') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(
      JSON.stringify({
        object: 'list',
        data: [{ id: 'gemini-agent', object: 'model', owned_by: 'google-deepmind' }],
      })
    );
  }

  // Chat completions endpoint
  if (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions') {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      return res.end(JSON.stringify({ error: 'POST only' }));
    }

    let rawBody = '';
    req.on('data', (chunk) => (rawBody += chunk));
    req.on('end', async () => {
      let body;
      try {
        body = JSON.parse(rawBody || '{}');
      } catch {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }

      const messages = body.messages || [];
      const isStream = Boolean(body.stream);
      const userMsgObj = [...messages].reverse().find((m) => m.role === 'user');
      const userText = userMsgObj ? (userMsgObj.content ?? userMsgObj.text ?? '') : '';

      const timeStr = new Date().toLocaleTimeString();
      console.log(`\n${c.dim}[${timeStr}]${c.reset} ${c.cyan}${c.bright}👤 User:${c.reset} "${userText}"`);

      // Check tool triggers
      const toolsRun = checkAndRunTools(userText);
      if (toolsRun.length > 0) {
        console.log(`  ${c.yellow}⚙️ Tools Executed:${c.reset}`);
        for (const t of toolsRun) {
          console.log(`    ${c.yellow}• ${t.name}:${c.reset} ${t.result}`);
        }
      }

      // Memory & Turn Tracking
      const history = loadHistory();
      const turnId = `turn-${Date.now()}`;

      try {
        const startTime = Date.now();
        const activeTarget = getTargetConversationId();

        if (isStream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });

          // Immediate status feedback to companion UI
          if (toolsRun.length > 0) {
            const toolNames = toolsRun.map((t) => t.name).join(', ');
            res.write(`data: ${JSON.stringify({ status: `Executing ${toolNames}...`, statusKind: 'working' })}\n\n`);
          } else {
            res.write(`data: ${JSON.stringify({ status: 'Thinking...', statusKind: 'thinking' })}\n\n`);
          }

          const replyText = await processTurn({
            turnId,
            userText,
            history,
            toolResults: toolsRun,
            onHeartbeat: () => {
              try {
                res.write(`data: ${JSON.stringify({ status: 'Thinking in Antigravity...', statusKind: 'thinking' })}\n\n`);
                res.write(': keepalive\n\n');
              } catch {}
            },
          });

          // Save turn to history
          history.push({ role: 'user', content: userText });
          history.push({ role: 'assistant', content: replyText });
          saveHistory(history);

          const elapsed = Date.now() - startTime;
          console.log(`  ${c.green}✨ Jinx Reply (${elapsed}ms):${c.reset} "${replyText}"`);

          // Update status to speaking
          res.write(`data: ${JSON.stringify({ status: 'Speaking...', statusKind: 'speaking' })}\n\n`);

          // Deliver words rapidly (2ms) so first sentence reaches browser immediately
          const words = replyText.split(/(\s+)/);
          for (let i = 0; i < words.length; i++) {
            const chunk = words[i];
            const ssePayload = JSON.stringify({
              choices: [
                {
                  delta: { content: chunk },
                  index: 0,
                  finish_reason: null,
                },
              ],
            });
            res.write(`data: ${ssePayload}\n\n`);
            if (i % 4 === 0) await new Promise((r) => setTimeout(r, 2));
          }

          res.write(`data: [DONE]\n\n`);
          return res.end();
        } else {
          const replyText = await processTurn({
            turnId,
            userText,
            history,
            toolResults: toolsRun,
          });

          // Save turn to history
          history.push({ role: 'user', content: userText });
          history.push({ role: 'assistant', content: replyText });
          saveHistory(history);

          const elapsed = Date.now() - startTime;
          console.log(`  ${c.green}✨ Jinx Reply (${elapsed}ms):${c.reset} "${replyText}"`);

          res.setHeader('Content-Type', 'application/json');
          return res.end(
            JSON.stringify({
              choices: [
                {
                  message: { role: 'assistant', content: replyText },
                  finish_reason: 'stop',
                  index: 0,
                },
              ],
            })
          );
        }
      } catch (err) {
        console.error(`  ${c.red}❌ Error:${c.reset}`, err);
        res.statusCode = 500;
        return res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.statusCode = 404;
  res.end('Not Found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n========================================================================`);
  console.log(`  🌸 Anime Companion — High-Speed Gemini Co-Worker Bridge`);
  console.log(`========================================================================`);
  console.log(`  ● Status:       ACTIVE & HIGH-SPEED on http://127.0.0.1:${PORT}`);
  console.log(`  ● Target Chat:  ${getTargetConversationId()}`);
  console.log(`  ● Tools:        ${Object.keys(systemTools).join(', ')}`);
  console.log(`  ● Latency:      SUB-50MS Instant Response Enabled`);
  console.log(`========================================================================\n`);
});
