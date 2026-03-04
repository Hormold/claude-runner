/**
 * Claude Runner — Agent Task Coordinator
 *
 * Accepts tasks, runs them in isolated Docker containers,
 * returns structured JSON output with cost tracking.
 *
 * API:
 *   POST   /task             Submit task (queued if session busy)
 *   POST   /task/:id/abort   Abort running task + kill container
 *   GET    /sessions         List all sessions
 *   GET    /session/:id      Session details
 *   DELETE /session/:id      Delete session (kill container + wipe state)
 *   POST   /session/:id/reset  Reset to clean state (keep session)
 *   GET    /health           Health check
 */

import http from 'http';
import { execSync, spawn } from 'child_process';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  cpSync, readdirSync, rmSync
} from 'fs';
import { join, resolve } from 'path';
import { randomUUID } from 'crypto';

// ── Config ──

const PORT         = parseInt(process.env.PORT || '3456');
const AGENT_DIR    = resolve(process.env.AGENT_DIR || './agent');
const SESSIONS_DIR = resolve(process.env.SESSIONS_DIR || './sessions');
const DOCKER_IMAGE = process.env.DOCKER_IMAGE || 'claude-runner';
const MODEL        = process.env.MODEL || 'claude-sonnet-4-20250514';
const MAX_TURNS    = parseInt(process.env.MAX_TURNS || '10');
const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT_MS || '300000'); // 5 min

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

    // Copy agent files into session workspace
    cpSync(join(AGENT_DIR, 'AGENTS.md'), join(dir, 'AGENTS.md'));
    const output = join(AGENT_DIR, 'OUTPUT.md');
    if (existsSync(output)) cpSync(output, join(dir, 'OUTPUT.md'));
    const tools = join(AGENT_DIR, 'tools');
    if (existsSync(tools)) cpSync(tools, join(dir, 'tools'), { recursive: true });

    saveState(id, {
      created: new Date().toISOString(),
      lastActive: new Date().toISOString(),
      turns: 0,
      sdkSessionId: null,
      env, // custom env vars stored for container
    });
    log(`session:create ${id}`);
  }
  return dir;
}

function loadState(id) {
  try { return JSON.parse(readFileSync(statePath(id), 'utf-8')); }
  catch { return null; }
}

function saveState(id, state) {
  writeFileSync(statePath(id), JSON.stringify(state, null, 2));
}

function resetSession(id) {
  const state = loadState(id);
  const dir = sessionDir(id);
  if (!existsSync(dir)) return false;

  // Wipe entire session directory
  rmSync(dir, { recursive: true, force: true });

  // Re-initialize from agent template
  initSession(id, state?.env || {});
  return true;
}

function listSessions() {
  if (!existsSync(SESSIONS_DIR)) return [];
  return readdirSync(SESSIONS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      const state = loadState(d.name);
      const busy = runningTasks.has(d.name);
      const queued = taskQueues.get(d.name)?.length || 0;
      return { sessionId: d.name, ...state, busy, queued };
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
//  Task Queue (one task at a time per session)
// ══════════════════════════════════════

const taskQueues   = new Map();  // sessionId → [{taskId, message, context, resolve, reject}]
const runningTasks = new Map();  // sessionId → {taskId, process, aborted}
const idleTimers   = new Map();  // sessionId → timeout

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
  if (runningTasks.has(sessionId)) return; // already running
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
    processQueue(sessionId); // next task
  }
}

function abortTask(sessionId) {
  const running = runningTasks.get(sessionId);
  if (!running) return false;
  running.aborted = true;
  if (running.process) {
    try { running.process.kill('SIGTERM'); } catch {}
    // Also force-kill the docker container
    const name = `agent-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}-${running.taskId}`;
    try { execSync(`docker kill ${name} 2>/dev/null`); } catch {}
  }
  // Reject all queued tasks too
  const queue = taskQueues.get(sessionId) || [];
  for (const t of queue) t.reject(new Error('Session aborted'));
  taskQueues.set(sessionId, []);
  log(`abort ${sessionId} task=${running.taskId}`);
  return true;
}

// ── Idle timeout ──

function resetIdleTimer(sessionId) {
  clearIdleTimer(sessionId);
  idleTimers.set(sessionId, setTimeout(() => {
    log(`idle:timeout ${sessionId}`);
    idleTimers.delete(sessionId);
  }, IDLE_TIMEOUT));
}

function clearIdleTimer(sessionId) {
  if (idleTimers.has(sessionId)) {
    clearTimeout(idleTimers.get(sessionId));
    idleTimers.delete(sessionId);
  }
}

// ══════════════════════════════════════
//  Docker Execution
// ══════════════════════════════════════

function executeTask(sessionId, task) {
  const dir = resolve(initSession(sessionId, task.env));
  const state = loadState(sessionId);
  const token = getOAuthToken();
  if (!token) throw new Error('No API token configured');

  // Build prompts
  let systemPrompt = readFileSync(join(dir, 'AGENTS.md'), 'utf-8');
  const outputMd = join(dir, 'OUTPUT.md');
  if (existsSync(outputMd)) systemPrompt += '\n\n---\n\n' + readFileSync(outputMd, 'utf-8');

  let prompt = '';
  if (task.context) prompt += `## Context\n${task.context}\n\n---\n\n`;
  prompt += task.message;

  const script = buildScript(prompt, systemPrompt, state?.sdkSessionId);
  const containerName = `agent-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}-${task.taskId}`;

  // Build docker args
  const dockerArgs = [
    'run', '--rm',
    '--name', containerName,
    '-v', `${dir}:/workspace`,
    '-v', `${join(dir, '.claude')}:/home/runner/.claude`,
    '-e', `CLAUDE_CODE_OAUTH_TOKEN=${token}`,
    '-e', 'NODE_PATH=/app/node_modules',
  ];

  // Pass through custom env vars from session
  const envVars = { ...state?.env, ...task.env };
  for (const [k, v] of Object.entries(envVars)) {
    if (k && v !== undefined) dockerArgs.push('-e', `${k}=${v}`);
  }

  dockerArgs.push('-w', '/workspace', '--entrypoint', 'node', DOCKER_IMAGE, '--input-type=module', '-e', script);

  const start = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn('docker', dockerArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    // Store process reference for abort
    const running = runningTasks.get(sessionId);
    if (running) running.process = child;

    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);

    child.on('close', (code) => {
      if (running?.aborted) return reject(new Error('Task aborted'));

      if (!stdout.trim()) return reject(new Error(`Container exit ${code}: ${stderr.slice(-300)}`));

      try {
        const raw = JSON.parse(stdout.trim());
        const tools = (stderr.match(/tool:\S+/g) || []).map(t => t.replace('tool:', ''));

        // Parse structured output if OUTPUT.md exists
        let output = null;
        if (existsSync(outputMd) && raw.result) {
          try {
            const m = raw.result.match(/```json\s*([\s\S]*?)```/) || [null, raw.result];
            const jsonStr = m[1] || raw.result;
            const j = jsonStr.match(/\{[\s\S]*\}/);
            if (j) output = JSON.parse(j[0]);
          } catch {}
        }

        // Update state
        saveState(sessionId, {
          ...state,
          sdkSessionId: raw.sessionId || state?.sdkSessionId,
          lastActive: new Date().toISOString(),
          turns: (state?.turns || 0) + 1,
          env: envVars,
        });

        resolve({
          taskId: task.taskId,
          sessionId,
          output,
          response: output ? undefined : raw.result,
          cost: raw.cost || 0,
          duration: Date.now() - start,
          tools,
          resumed: !!(state?.sdkSessionId),
        });

      } catch (e) {
        reject(new Error(`Bad output: ${stdout.slice(0, 200)}`));
      }
    });

    child.on('error', reject);
  });
}

function buildScript(prompt, systemPrompt, resumeId) {
  const p = JSON.stringify(prompt);
  const s = JSON.stringify(systemPrompt);
  const r = resumeId ? `resume: ${JSON.stringify(resumeId)},` : '';
  return `
import { query } from '/app/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
const stream = query({
  prompt: ${p},
  options: {
    model: '${MODEL}', maxTurns: ${MAX_TURNS}, cwd: '/workspace',
    systemPrompt: ${s}, ${r}
    permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
  }
});
let result = '', sid = '', cost = 0;
for await (const m of stream) {
  if (m.type === 'system' && m.subtype === 'init') sid = m.session_id;
  if (m.type === 'assistant' && m.message?.content)
    for (const b of m.message.content) if (b.type === 'tool_use') process.stderr.write('tool:' + b.name + ' ');
  if (m.type === 'result' && m.subtype === 'success') {
    result = m.result || ''; cost = m.total_cost_usd || 0;
  }
}
console.log(JSON.stringify({ result, sessionId: sid, cost }));
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

  // CORS preflight
  if (req.method === 'OPTIONS') return json(res, {});

  try {
    // POST /task — submit task
    if (req.method === 'POST' && path === '/task') {
      const body = await readBody(req);
      if (!body?.sessionId || !body?.message)
        return json(res, { error: 'sessionId and message required' }, 400);

      const result = await enqueueTask(body.sessionId, body.message, body.context, body.env);
      return json(res, result);
    }

    // POST /task/:id/abort — abort running task
    if (req.method === 'POST' && path.match(/^\/task\/(.+)\/abort$/)) {
      const id = path.split('/')[2];
      const aborted = abortTask(id);
      return json(res, { sessionId: id, aborted });
    }

    // GET /sessions — list all
    if (req.method === 'GET' && path === '/sessions') {
      return json(res, listSessions());
    }

    // GET /session/:id — details
    if (req.method === 'GET' && path.match(/^\/session\/[^/]+$/)) {
      const id = path.split('/')[2];
      const state = loadState(id);
      if (!state) return json(res, { error: 'Session not found' }, 404);
      const busy = runningTasks.has(id);
      const queued = taskQueues.get(id)?.length || 0;
      return json(res, { sessionId: id, ...state, busy, queued });
    }

    // DELETE /session/:id — delete
    if (req.method === 'DELETE' && path.match(/^\/session\/[^/]+$/)) {
      const id = path.split('/')[2];
      deleteSession(id);
      return json(res, { deleted: id });
    }

    // POST /session/:id/reset — reset to clean state
    if (req.method === 'POST' && path.match(/^\/session\/(.+)\/reset$/)) {
      const id = path.split('/')[2];
      abortTask(id);
      const ok = resetSession(id);
      return json(res, { sessionId: id, reset: ok });
    }

    // GET /health
    if (req.method === 'GET' && path === '/health') {
      return json(res, {
        status: 'ok',
        sessions: existsSync(SESSIONS_DIR) ? readdirSync(SESSIONS_DIR).length : 0,
        activeTasks: runningTasks.size,
      });
    }

    json(res, { error: 'Not found' }, 404);
  } catch (err) {
    log(`error: ${err.message}`);
    json(res, { error: err.message }, 500);
  }
});

server.listen(PORT, () => {
  log(`Claude Runner started on http://localhost:${PORT}`);
  log(`Agent: ${AGENT_DIR}`);
  log(`Image: ${DOCKER_IMAGE}`);
  log(`Model: ${MODEL}`);
  console.log(`
  POST   /task                Submit task {sessionId, message, context?, env?}
  POST   /task/:id/abort      Abort running task
  GET    /sessions             List sessions
  GET    /session/:id          Session details
  DELETE /session/:id          Delete session
  POST   /session/:id/reset    Reset session to clean state
  GET    /health               Health check
`);
});

process.on('SIGTERM', () => { log('shutdown'); server.close(); process.exit(0); });
process.on('SIGINT', () => process.emit('SIGTERM'));
