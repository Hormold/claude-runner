/**
 * Claude Runner — Agent Task Coordinator
 *
 * Accepts tasks, runs them in isolated Docker containers,
 * returns structured JSON output with cost tracking.
 *
 * HTTP API:
 *   POST   /task              Submit task (queued if session busy)
 *   POST   /task/:id/abort    Abort running task + kill container
 *   GET    /sessions          List all sessions
 *   GET    /session/:id       Session details
 *   DELETE /session/:id       Delete session (kill container + wipe state)
 *   POST   /session/:id/reset Reset to clean state
 *   GET    /health            Health check
 *
 * WebSocket:
 *   GET /stream/:sessionId    Live event stream (upgrade to WS)
 *     Events: init, thinking, text, tool_start, tool_end, result, error
 */

import http from 'http';
import { execSync, spawn } from 'child_process';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  cpSync, readdirSync, rmSync, createReadStream
} from 'fs';
import { join, resolve } from 'path';
import { randomUUID, createHash } from 'crypto';
import { createInterface } from 'readline';

// ── Config ──

const PORT         = parseInt(process.env.PORT || '3456');
const AGENT_DIR    = resolve(process.env.AGENT_DIR || './agent');
const SESSIONS_DIR = resolve(process.env.SESSIONS_DIR || './sessions');
const DOCKER_IMAGE = process.env.DOCKER_IMAGE || 'claude-runner';
const MODEL        = process.env.MODEL || 'claude-sonnet-4-6';
const MAX_TURNS    = parseInt(process.env.MAX_TURNS || '10');
const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT_MS || '300000');

// ── Auth ──

function getOAuthToken() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const p = join(process.env.HOME || '/root', '.claude', '.credentials.json');
    return JSON.parse(readFileSync(p, 'utf-8'))?.claudeAiOauth?.accessToken;
  } catch { return null; }
}

// ══════════════════════════════════════
//  Session Management
// ══════════════════════════════════════

function sessionDir(id)  { return join(SESSIONS_DIR, id); }
function statePath(id)   { return join(sessionDir(id), 'state.json'); }

function initSession(id, env = {}) {
  const dir = sessionDir(id);
  if (!existsSync(dir)) {
    mkdirSync(join(dir, 'data'), { recursive: true });
    mkdirSync(join(dir, '.claude'), { recursive: true });
    cpSync(join(AGENT_DIR, 'AGENTS.md'), join(dir, 'AGENTS.md'));
    const output = join(AGENT_DIR, 'OUTPUT.md');
    if (existsSync(output)) cpSync(output, join(dir, 'OUTPUT.md'));
    const tools = join(AGENT_DIR, 'tools');
    if (existsSync(tools)) cpSync(tools, join(dir, 'tools'), { recursive: true });
    saveState(id, { created: new Date().toISOString(), lastActive: new Date().toISOString(), turns: 0, sdkSessionId: null, env });
    log(`session:create ${id}`);
  }
  return dir;
}

function loadState(id) {
  try { return JSON.parse(readFileSync(statePath(id), 'utf-8')); } catch { return null; }
}

function saveState(id, state) {
  writeFileSync(statePath(id), JSON.stringify(state, null, 2));
}

function resetSession(id) {
  const state = loadState(id);
  const dir = sessionDir(id);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  initSession(id, state?.env || {});
  return true;
}

function listSessions() {
  if (!existsSync(SESSIONS_DIR)) return [];
  return readdirSync(SESSIONS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      const state = loadState(d.name);
      return { sessionId: d.name, ...state, busy: runningTasks.has(d.name), queued: taskQueues.get(d.name)?.length || 0 };
    });
}

function deleteSession(id) {
  abortTask(id);
  const dir = sessionDir(id);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  taskQueues.delete(id);
  idleTimers.delete(id);
}

// ══════════════════════════════════════
//  WebSocket (minimal, no deps)
// ══════════════════════════════════════

const wsClients = new Map(); // sessionId → Set<socket>

function wsAccept(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-5AB5DC525DB3').digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '', ''
  ].join('\r\n'));
  return socket;
}

function wsSend(socket, data) {
  try {
    const payload = Buffer.from(JSON.stringify(data));
    const len = payload.length;
    let frame;
    if (len < 126) {
      frame = Buffer.alloc(2 + len);
      frame[0] = 0x81; frame[1] = len;
      payload.copy(frame, 2);
    } else if (len < 65536) {
      frame = Buffer.alloc(4 + len);
      frame[0] = 0x81; frame[1] = 126;
      frame.writeUInt16BE(len, 2);
      payload.copy(frame, 4);
    } else {
      frame = Buffer.alloc(10 + len);
      frame[0] = 0x81; frame[1] = 127;
      frame.writeBigUInt64BE(BigInt(len), 2);
      payload.copy(frame, 10);
    }
    socket.write(frame);
  } catch {}
}

function wsBroadcast(sessionId, data) {
  const clients = wsClients.get(sessionId);
  if (!clients) return;
  for (const s of clients) wsSend(s, data);
}

// ══════════════════════════════════════
//  Task Queue
// ══════════════════════════════════════

const taskQueues   = new Map();
const runningTasks = new Map();
const idleTimers   = new Map();

function enqueueTask(sessionId, message, context, env) {
  const taskId = randomUUID().slice(0, 8);
  return new Promise((res, rej) => {
    if (!taskQueues.has(sessionId)) taskQueues.set(sessionId, []);
    taskQueues.get(sessionId).push({ taskId, message, context, env, resolve: res, reject: rej });
    log(`queue:add ${sessionId} task=${taskId} depth=${taskQueues.get(sessionId).length}`);
    processQueue(sessionId);
  });
}

async function processQueue(sessionId) {
  if (runningTasks.has(sessionId)) return;
  const queue = taskQueues.get(sessionId);
  if (!queue || queue.length === 0) return;
  const task = queue.shift();
  clearIdleTimer(sessionId);
  try {
    runningTasks.set(sessionId, { taskId: task.taskId, process: null, aborted: false });
    const result = await executeTask(sessionId, task);
    task.resolve(result);
  } catch (err) {
    task.reject(err);
  } finally {
    runningTasks.delete(sessionId);
    resetIdleTimer(sessionId);
    processQueue(sessionId);
  }
}

function abortTask(sessionId) {
  const running = runningTasks.get(sessionId);
  if (!running) return false;
  running.aborted = true;
  if (running.process) {
    try { running.process.kill('SIGTERM'); } catch {}
    const name = `agent-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}-${running.taskId}`;
    try { execSync(`docker kill ${name} 2>/dev/null`); } catch {}
  }
  const queue = taskQueues.get(sessionId) || [];
  for (const t of queue) t.reject(new Error('Session aborted'));
  taskQueues.set(sessionId, []);
  wsBroadcast(sessionId, { type: 'abort', taskId: running.taskId });
  log(`abort ${sessionId} task=${running.taskId}`);
  return true;
}

function resetIdleTimer(sessionId) {
  clearIdleTimer(sessionId);
  idleTimers.set(sessionId, setTimeout(() => { idleTimers.delete(sessionId); }, IDLE_TIMEOUT));
}

function clearIdleTimer(sessionId) {
  if (idleTimers.has(sessionId)) { clearTimeout(idleTimers.get(sessionId)); idleTimers.delete(sessionId); }
}

// ══════════════════════════════════════
//  Docker Execution (with streaming)
// ══════════════════════════════════════

function executeTask(sessionId, task) {
  const dir = resolve(initSession(sessionId, task.env));
  const state = loadState(sessionId);
  const token = getOAuthToken();
  if (!token) throw new Error('No API token configured');

  let systemPrompt = readFileSync(join(dir, 'AGENTS.md'), 'utf-8');
  const outputMd = join(dir, 'OUTPUT.md');
  if (existsSync(outputMd)) systemPrompt += '\n\n---\n\n' + readFileSync(outputMd, 'utf-8');

  let prompt = '';
  if (task.context) prompt += `## Context\n${task.context}\n\n---\n\n`;
  prompt += task.message;

  const script = buildScript(prompt, systemPrompt, state?.sdkSessionId);
  const containerName = `agent-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}-${task.taskId}`;

  const dockerArgs = [
    'run', '--rm', '--name', containerName,
    '--add-host=host.docker.internal:host-gateway',
    '-v', `${dir}:/workspace`,
    '-v', `${join(dir, '.claude')}:/home/runner/.claude`,
    '-e', `CLAUDE_CODE_OAUTH_TOKEN=${token}`,
    '-e', 'NODE_PATH=/app/node_modules',
  ];
  const envVars = { ...state?.env, ...task.env };
  for (const [k, v] of Object.entries(envVars)) {
    if (k && v !== undefined) dockerArgs.push('-e', `${k}=${v}`);
  }
  dockerArgs.push('-w', '/workspace', '--entrypoint', 'node', DOCKER_IMAGE, '--input-type=module', '-e', script);

  const start = Date.now();
  wsBroadcast(sessionId, { type: 'task_start', taskId: task.taskId, sessionId });

  return new Promise((resolve, reject) => {
    const child = spawn('docker', dockerArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    const running = runningTasks.get(sessionId);
    if (running) running.process = child;

    let finalResult = null;

    // Stream stdout line by line (NDJSON from Docker)
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      try {
        const evt = JSON.parse(line);
        if (evt._final) {
          finalResult = evt; // Last line is the final result
        } else {
          wsBroadcast(sessionId, evt); // Forward event to WebSocket clients
        }
      } catch {}
    });

    let stderr = '';
    child.stderr.on('data', d => stderr += d);

    child.on('close', (code) => {
      if (running?.aborted) return reject(new Error('Task aborted'));
      if (!finalResult) return reject(new Error(`Container exit ${code}: ${stderr.slice(-300)}`));

      const tools = (stderr.match(/tool:\S+/g) || []).map(t => t.replace('tool:', ''));

      // Parse structured output
      let output = null;
      if (existsSync(outputMd) && finalResult.result) {
        try {
          const m = finalResult.result.match(/```json\s*([\s\S]*?)```/) || [null, finalResult.result];
          const j = (m[1] || finalResult.result).match(/\{[\s\S]*\}/);
          if (j) output = JSON.parse(j[0]);
        } catch {}
      }

      saveState(sessionId, {
        ...state,
        sdkSessionId: finalResult.sessionId || state?.sdkSessionId,
        lastActive: new Date().toISOString(),
        turns: (state?.turns || 0) + 1,
        env: envVars,
      });

      const response = {
        taskId: task.taskId,
        sessionId,
        output,
        response: output ? undefined : finalResult.result,
        cost: finalResult.cost || 0,
        duration: Date.now() - start,
        tools,
        resumed: !!(state?.sdkSessionId),
      };

      wsBroadcast(sessionId, { type: 'task_complete', ...response });
      resolve(response);
    });

    child.on('error', reject);
  });
}

function buildScript(prompt, systemPrompt, resumeId) {
  const p = JSON.stringify(prompt);
  const s = JSON.stringify(systemPrompt);
  const r = resumeId ? `resume: ${JSON.stringify(resumeId)},` : '';
  // Script outputs NDJSON: one event per line, last line is _final
  return `
import { query } from '/app/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';

function emit(evt) { process.stdout.write(JSON.stringify(evt) + '\\n'); }

const stream = query({
  prompt: ${p},
  options: {
    model: '${MODEL}', maxTurns: ${MAX_TURNS}, cwd: '/workspace',
    systemPrompt: ${s}, ${r}
    permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
  }
});

let result = '', sid = '', cost = 0;

for await (const m of stream) {
  // Init
  if (m.type === 'system' && m.subtype === 'init') {
    sid = m.session_id;
    emit({ type: 'init', sessionId: sid, model: m.model, tools: m.tools });
  }

  // Partial text streaming
  if (m.type === 'stream_event' && m.event) {
    const e = m.event;
    if (e.type === 'content_block_start' && e.content_block?.type === 'thinking') {
      emit({ type: 'thinking_start' });
    }
    if (e.type === 'content_block_delta') {
      if (e.delta?.type === 'thinking_delta') {
        emit({ type: 'thinking', text: e.delta.thinking });
      }
      if (e.delta?.type === 'text_delta') {
        emit({ type: 'text', text: e.delta.text });
      }
    }
    if (e.type === 'content_block_stop') {
      // noop — boundary marker
    }
  }

  // Tool use
  if (m.type === 'assistant' && m.message?.content) {
    for (const b of m.message.content) {
      if (b.type === 'tool_use') {
        emit({ type: 'tool_start', tool: b.name, input: b.input });
        process.stderr.write('tool:' + b.name + ' ');
      }
    }
  }

  // Tool result
  if (m.type === 'user' && m.tool_use_result !== undefined) {
    emit({ type: 'tool_end', result: typeof m.tool_use_result === 'string' ? m.tool_use_result.slice(0, 500) : JSON.stringify(m.tool_use_result).slice(0, 500) });
  }

  // Final result
  if (m.type === 'result' && m.subtype === 'success') {
    result = m.result || ''; cost = m.total_cost_usd || 0;
  }
}

// Last line: final result (marked with _final)
emit({ _final: true, result, sessionId: sid, cost });
`;
}

// ══════════════════════════════════════
//  HTTP Server
// ══════════════════════════════════════

function readBody(req) {
  return new Promise(r => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { r(JSON.parse(b)); } catch { r(null); } });
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function log(msg) { console.log(`[${new Date().toISOString().slice(11,19)}] ${msg}`); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') return json(res, {});

  try {
    if (req.method === 'POST' && path === '/task') {
      const body = await readBody(req);
      if (!body?.sessionId || !body?.message) return json(res, { error: 'sessionId and message required' }, 400);
      const result = await enqueueTask(body.sessionId, body.message, body.context, body.env);
      return json(res, result);
    }

    if (req.method === 'POST' && path.match(/^\/task\/(.+)\/abort$/)) {
      const id = path.split('/')[2];
      return json(res, { sessionId: id, aborted: abortTask(id) });
    }

    if (req.method === 'GET' && path === '/sessions') return json(res, listSessions());

    if (req.method === 'GET' && path.match(/^\/session\/[^/]+$/)) {
      const id = path.split('/')[2];
      const state = loadState(id);
      if (!state) return json(res, { error: 'Session not found' }, 404);
      return json(res, { sessionId: id, ...state, busy: runningTasks.has(id), queued: taskQueues.get(id)?.length || 0 });
    }

    if (req.method === 'DELETE' && path.match(/^\/session\/[^/]+$/)) {
      const id = path.split('/')[2];
      deleteSession(id);
      return json(res, { deleted: id });
    }

    if (req.method === 'POST' && path.match(/^\/session\/(.+)\/reset$/)) {
      const id = path.split('/')[2];
      abortTask(id);
      return json(res, { sessionId: id, reset: resetSession(id) });
    }

    if (req.method === 'GET' && path === '/health') {
      return json(res, { status: 'ok', sessions: existsSync(SESSIONS_DIR) ? readdirSync(SESSIONS_DIR).length : 0, activeTasks: runningTasks.size });
    }

    json(res, { error: 'Not found' }, 404);
  } catch (err) {
    log(`error: ${err.message}`);
    json(res, { error: err.message }, 500);
  }
});

// WebSocket upgrade handler
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const match = url.pathname.match(/^\/stream\/(.+)$/);

  if (!match || !req.headers['sec-websocket-key']) {
    socket.destroy();
    return;
  }

  const sessionId = match[1];
  const ws = wsAccept(req, socket, head);

  if (!wsClients.has(sessionId)) wsClients.set(sessionId, new Set());
  wsClients.get(sessionId).add(ws);
  log(`ws:connect ${sessionId} (${wsClients.get(sessionId).size} clients)`);

  // Send current status
  const state = loadState(sessionId);
  const busy = runningTasks.has(sessionId);
  wsSend(ws, { type: 'connected', sessionId, busy, turns: state?.turns || 0 });

  ws.on('close', () => {
    wsClients.get(sessionId)?.delete(ws);
    if (wsClients.get(sessionId)?.size === 0) wsClients.delete(sessionId);
    log(`ws:disconnect ${sessionId}`);
  });

  ws.on('error', () => {
    wsClients.get(sessionId)?.delete(ws);
  });
});

server.listen(PORT, () => {
  log(`Claude Runner started on http://localhost:${PORT}`);
  log(`Agent: ${AGENT_DIR}`);
  log(`Image: ${DOCKER_IMAGE}`);
  log(`Model: ${MODEL}`);
  console.log(`
  HTTP:
    POST   /task                Submit task {sessionId, message, context?, env?}
    POST   /task/:id/abort      Abort running task
    GET    /sessions             List sessions
    GET    /session/:id          Session details
    DELETE /session/:id          Delete session
    POST   /session/:id/reset    Reset session
    GET    /health               Health check

  WebSocket:
    ws://localhost:${PORT}/stream/:sessionId
    Events: init, thinking, text, tool_start, tool_end, task_complete, abort
`);
});

process.on('SIGTERM', () => { log('shutdown'); server.close(); process.exit(0); });
process.on('SIGINT', () => process.emit('SIGTERM'));
