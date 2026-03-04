/**
 * HTTP Server — manages Docker containers per session
 *
 * POST /ask        { sessionId, message, context? }  → structured output
 * GET  /sessions   → list all sessions
 * DELETE /session/:id → delete session
 * GET  /health     → status
 */

import http from 'http';
import { execSync, spawn } from 'child_process';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  cpSync, symlinkSync, readdirSync, rmSync
} from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ──

const PORT = process.env.PORT || 3456;
const TEMPLATE_DIR = __dirname;
const SESSIONS_DIR = join(__dirname, 'sessions');
const DOCKER_IMAGE = 'claude-runner-context';
const MODEL = process.env.MODEL || 'claude-sonnet-4-20250514';
const MAX_TURNS = parseInt(process.env.MAX_TURNS || '10');
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS || '300000'); // 5 min

// ── API Key ──

function getApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const credPath = join(process.env.HOME || '/root', '.claude', '.credentials.json');
    const creds = JSON.parse(readFileSync(credPath, 'utf-8'));
    return creds?.claudeAiOauth?.accessToken;
  } catch { return null; }
}

// ── Session workspace ──

function getSessionDir(sessionId) { return join(SESSIONS_DIR, sessionId); }

function initSession(sessionId) {
  const dir = getSessionDir(sessionId);
  if (!existsSync(dir)) {
    mkdirSync(join(dir, 'data'), { recursive: true });
    mkdirSync(join(dir, '.claude'), { recursive: true });
    cpSync(join(TEMPLATE_DIR, 'AGENTS.md'), join(dir, 'AGENTS.md'));
    const outputSrc = join(TEMPLATE_DIR, 'OUTPUT.md');
    if (existsSync(outputSrc)) cpSync(outputSrc, join(dir, 'OUTPUT.md'));
    const toolsSrc = join(TEMPLATE_DIR, 'tools');
    if (existsSync(toolsSrc)) cpSync(toolsSrc, join(dir, 'tools'), { recursive: true });
    console.log(`[session] Created: ${sessionId}`);
  }
  return dir;
}

function loadState(sessionId) {
  const p = join(getSessionDir(sessionId), 'state.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null;
}

function saveState(sessionId, state) {
  writeFileSync(join(getSessionDir(sessionId), 'state.json'), JSON.stringify(state, null, 2));
}

// ── Container lifecycle ──

function containerName(sessionId) { return `agent-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}`; }

function stopContainer(sessionId) {
  const name = containerName(sessionId);
  try {
    execSync(`docker rm -f ${name} 2>/dev/null`);
    console.log(`[docker] Stopped: ${name}`);
  } catch {}
}

// ── Execute task in container (docker run per task, state in volumes) ──

function runInContainer(sessionId, script) {
  const dir = resolve(getSessionDir(sessionId));
  const apiKey = getApiKey();
  const name = containerName(sessionId) + '-' + Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn('docker', [
      'run', '--rm',
      '--name', name,
      '-v', `${dir}:/workspace`,
      '-v', `${join(dir, '.claude')}:/home/runner/.claude`,
      '-e', `CLAUDE_CODE_OAUTH_TOKEN=${apiKey}`,
      '-e', 'NODE_PATH=/app/node_modules',
      '-w', '/workspace',
      '--entrypoint', 'node',
      DOCKER_IMAGE,
      '--input-type=module', '-e', script,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);

    child.on('close', (code) => {
      // SDK may exit 1 due to telemetry failures — check if we got valid output
      if (!stdout.trim()) {
        reject(new Error(`Exit ${code}: ${stderr.slice(-300)}`));
        return;
      }
      try {
        const tools = (stderr.match(/tool:\S+/g) || []).map(t => t.replace('tool:', ''));
        resolve({ ...JSON.parse(stdout.trim()), tools });
      } catch {
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
let result = '', sid = '', cost = 0, dur = 0;
for await (const m of stream) {
  if (m.type === 'system' && m.subtype === 'init') sid = m.session_id;
  if (m.type === 'assistant' && m.message?.content)
    for (const b of m.message.content) if (b.type === 'tool_use') process.stderr.write('tool:' + b.name + ' ');
  if (m.type === 'result' && m.subtype === 'success') {
    result = m.result || ''; cost = m.total_cost_usd || 0; dur = m.duration_ms || 0;
  }
}
console.log(JSON.stringify({ result, sessionId: sid, cost, duration: dur }));
`;
}

// ── Main handler ──

async function handleAsk(sessionId, message, context) {
  const dir = initSession(sessionId);
  const state = loadState(sessionId);

  // Build system prompt
  let systemPrompt = readFileSync(join(dir, 'AGENTS.md'), 'utf-8');
  const outputMd = join(dir, 'OUTPUT.md');
  if (existsSync(outputMd)) systemPrompt += '\n\n---\n\n' + readFileSync(outputMd, 'utf-8');

  let fullPrompt = '';
  if (context) fullPrompt += `## Context\n${context}\n\n---\n\n`;
  fullPrompt += message;

  // Run in isolated container (docker run, state persisted via volumes)
  const script = buildScript(fullPrompt, systemPrompt, state?.sdkSessionId);
  const raw = await runInContainer(sessionId, script);

  // Parse structured output
  let output = null;
  if (existsSync(outputMd) && raw.result) {
    try {
      const m = raw.result.match(/\{[\s\S]*\}/);
      if (m) output = JSON.parse(m[0]);
    } catch {}
  }

  // Save state
  saveState(sessionId, {
    sdkSessionId: raw.sessionId,
    created: state?.created || new Date().toISOString(),
    lastActive: new Date().toISOString(),
    turns: (state?.turns || 0) + 1,
  });

  return {
    sessionId,
    output,
    response: output ? undefined : raw.result,
    cost: raw.cost,
    duration: raw.duration,
    tools: raw.tools,
    resumed: !!state,
  };
}

// ── HTTP Server ──

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    // POST /ask
    if (req.method === 'POST' && url.pathname === '/ask') {
      const body = await readBody(req);
      if (!body?.sessionId || !body?.message) return json(res, { error: 'sessionId and message required' }, 400);
      const result = await handleAsk(body.sessionId, body.message, body.context);
      return json(res, result);
    }

    // GET /sessions
    if (req.method === 'GET' && url.pathname === '/sessions') {
      if (!existsSync(SESSIONS_DIR)) return json(res, []);
      const sessions = readdirSync(SESSIONS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => ({ sessionId: d.name, ...loadState(d.name) }));
      return json(res, sessions);
    }

    // DELETE /session/:id
    if (req.method === 'DELETE' && url.pathname.startsWith('/session/')) {
      const id = url.pathname.split('/')[2];
      stopContainer(id);
      const dir = getSessionDir(id);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      return json(res, { deleted: id });
    }

    // GET /health
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, { status: 'ok', sessions: existsSync(SESSIONS_DIR) ? readdirSync(SESSIONS_DIR).length : 0 });
    }

    json(res, { error: 'Not found' }, 404);
  } catch (err) {
    console.error(`[error] ${err.message}`);
    json(res, { error: err.message }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║  Agent Server v1.0                       ║
║  http://localhost:${PORT}                    ║
║                                          ║
║  POST /ask          Run task in session  ║
║  GET  /sessions     List sessions        ║
║  DELETE /session/:id  Delete session     ║
║  GET  /health       Health check         ║
║                                          ║
║  Idle timeout: ${IDLE_TIMEOUT_MS / 1000}s                       ║
║  Docker image: ${DOCKER_IMAGE}    ║
╚══════════════════════════════════════════╝
`);
});

// Cleanup on exit
process.on('SIGTERM', () => {
  console.log('[shutdown] Shutting down...');
  server.close();
  process.exit(0);
});
process.on('SIGINT', () => process.emit('SIGTERM'));
