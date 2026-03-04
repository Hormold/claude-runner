/**
 * Session Manager — isolated workspaces per session
 *
 * Each session gets its own directory with:
 *   - AGENTS.md (copied from template)
 *   - tools/ (symlinked from template)
 *   - data/ (agent's working files)
 *   - .claude/ (SDK session state)
 *   - state.json (our metadata: SDK session ID, turns, timestamps)
 *
 * Sessions survive restarts. Container dies → next call restores everything.
 */

import { execSync, spawn } from 'child_process';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  cpSync, symlinkSync, readdirSync, rmSync, copyFileSync
} from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ──

const TEMPLATE_DIR = __dirname;                          // Where AGENTS.md + tools/ live
const SESSIONS_DIR = join(__dirname, 'sessions');        // All session workspaces
const DOCKER_IMAGE = 'claude-runner-context';
const MODEL = 'claude-sonnet-4-20250514';
const MAX_TURNS = 10;

// ── Types (via JSDoc) ──

/**
 * @typedef {{ sdkSessionId: string, created: string, lastActive: string, turns: number }} SessionState
 * @typedef {{ response: string, sessionId: string, sdkSessionId: string, cost: number, duration: number, resumed: boolean }} RunResult
 */

// ── Session workspace management ──

function getSessionDir(sessionId) {
  return join(SESSIONS_DIR, sessionId);
}

function initSession(sessionId) {
  const dir = getSessionDir(sessionId);
  const isNew = !existsSync(dir);

  if (isNew) {
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, 'data'), { recursive: true });
    mkdirSync(join(dir, '.claude'), { recursive: true });

    // Copy template files
    cpSync(join(TEMPLATE_DIR, 'AGENTS.md'), join(dir, 'AGENTS.md'));
    const outputSrc = join(TEMPLATE_DIR, 'OUTPUT.md');
    if (existsSync(outputSrc)) {
      cpSync(outputSrc, join(dir, 'OUTPUT.md'));
    }

    // Symlink tools/ so all sessions share the same tools (but can't modify them)
    const toolsSrc = join(TEMPLATE_DIR, 'tools');
    const toolsDst = join(dir, 'tools');
    if (existsSync(toolsSrc) && !existsSync(toolsDst)) {
      symlinkSync(toolsSrc, toolsDst);
    }

    console.log(`[session] Created workspace: ${sessionId}`);
  }

  return { dir, isNew };
}

function loadState(sessionId) {
  const statePath = join(getSessionDir(sessionId), 'state.json');
  if (!existsSync(statePath)) return null;
  return JSON.parse(readFileSync(statePath, 'utf-8'));
}

function saveState(sessionId, state) {
  const statePath = join(getSessionDir(sessionId), 'state.json');
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

// ── Docker execution ──

function getApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  // Try OAuth credentials
  try {
    const home = process.env.HOME || '/root';
    const credPath = join(home, '.claude', '.credentials.json');
    const creds = JSON.parse(readFileSync(credPath, 'utf-8'));
    return creds?.claudeAiOauth?.accessToken;
  } catch { return null; }
}

function buildWorkerScript(prompt, systemPrompt, resumeId) {
  const escapedPrompt = JSON.stringify(prompt);
  const escapedSystem = JSON.stringify(systemPrompt);
  const resumeOpt = resumeId ? `resume: ${JSON.stringify(resumeId)},` : '';

  return `
import { query } from '/app/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';

const stream = query({
  prompt: ${escapedPrompt},
  options: {
    model: '${MODEL}',
    maxTurns: ${MAX_TURNS},
    cwd: '/workspace',
    systemPrompt: ${escapedSystem},
    ${resumeOpt}
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
  }
});

let result = '', sid = '', cost = 0, dur = 0;
for await (const m of stream) {
  if (m.type === 'system' && m.subtype === 'init') sid = m.session_id;
  if (m.type === 'assistant' && m.message?.content) {
    for (const b of m.message.content) {
      if (b.type === 'tool_use') process.stderr.write('tool:' + b.name + ' ');
    }
  }
  if (m.type === 'result' && m.subtype === 'success') {
    result = m.result || '';
    cost = m.total_cost_usd || 0;
    dur = m.duration_ms || 0;
  }
}
console.log(JSON.stringify({ result, sessionId: sid, cost, duration: dur }));
`;
}

function runInDocker({ containerName, workspace, claudeDir, apiKey, script }) {
  return new Promise((resolve, reject) => {
    const args = [
      'run', '--rm',
      '--name', containerName,
      '-v', `${workspace}:/workspace`,
      '-v', `${claudeDir}:/home/runner/.claude`,
      '-e', `ANTHROPIC_API_KEY=${apiKey}`,
      '-e', 'NODE_PATH=/app/node_modules',
      '-w', '/workspace',
      '--entrypoint', 'node',
      DOCKER_IMAGE,
      '--input-type=module', '-e', script,
    ];

    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);

    child.on('close', (code) => {
      // Parse tool calls from stderr
      const toolMatches = stderr.match(/tool:(\S+)/g);
      if (toolMatches) {
        console.log(`[session:${containerName}] Tools: ${toolMatches.map(t => t.replace('tool:', '')).join(', ')}`);
      }

      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`Docker exited ${code}: ${stderr.slice(-200)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(new Error(`Invalid output: ${stdout.slice(0, 200)}`));
      }
    });

    child.on('error', reject);
  });
}

// ── Core: run agent in isolated session ──

/**
 * @param {string} sessionId - Your user/conversation ID
 * @param {string} message - User's message
 * @param {string} [context] - Optional context (user data, metadata)
 * @returns {Promise<RunResult>}
 */
export async function ask(sessionId, message, context) {
  const { dir, isNew } = initSession(sessionId);
  const state = loadState(sessionId);
  const resumed = !!state;

  // System prompt from session's own AGENTS.md + OUTPUT.md
  let systemPrompt = readFileSync(join(dir, 'AGENTS.md'), 'utf-8');

  // Append OUTPUT.md instructions if present
  const outputMdPath = join(dir, 'OUTPUT.md');
  if (existsSync(outputMdPath)) {
    const outputInstructions = readFileSync(outputMdPath, 'utf-8');
    systemPrompt += '\n\n---\n\n' + outputInstructions;
  }

  // Build prompt
  let fullPrompt = '';
  if (context) fullPrompt += `## Context\n${context}\n\n---\n\n`;
  fullPrompt += message;

  // SDK options
  const opts = {
    model: MODEL,
    maxTurns: MAX_TURNS,
    cwd: dir,
    systemPrompt,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
  };

  // Resume existing session
  if (state?.sdkSessionId) {
    opts.resume = state.sdkSessionId;
  }

  let result = '', sdkSessionId = '', cost = 0, duration = 0;
  const tools = [];

  // Get API key
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('No ANTHROPIC_API_KEY or OAuth credentials found');

  // Container name for this session
  const containerName = `agent-${sessionId}`;
  const claudeDir = join(dir, '.claude');
  mkdirSync(claudeDir, { recursive: true });

  // Build worker script
  const workerScript = buildWorkerScript(fullPrompt, systemPrompt, state?.sdkSessionId);

  // Run in Docker container
  const dockerResult = await runInDocker({
    containerName,
    workspace: dir,
    claudeDir,
    apiKey,
    script: workerScript,
  });

  result = dockerResult.result || '';
  sdkSessionId = dockerResult.sessionId || '';
  cost = dockerResult.cost || 0;
  duration = dockerResult.duration || 0;

  // Parse structured output if OUTPUT.md exists
  let output = null;
  if (existsSync(outputMdPath) && result) {
    try {
      // Try to extract JSON from the response
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        output = JSON.parse(jsonMatch[0]);
      }
    } catch {
      // Not valid JSON — will be returned as plain text
    }
  }

  // Save state
  saveState(sessionId, {
    sdkSessionId,
    created: state?.created || new Date().toISOString(),
    lastActive: new Date().toISOString(),
    turns: (state?.turns || 0) + 1,
  });

  if (tools.length > 0) {
    console.log(`[session:${sessionId}] Tools: ${tools.join(', ')}`);
  }

  return { response: result, output, sessionId, sdkSessionId, cost, duration, resumed };
}

/** List all sessions */
export function listSessions() {
  if (!existsSync(SESSIONS_DIR)) return [];
  return readdirSync(SESSIONS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      const state = loadState(d.name);
      return { sessionId: d.name, ...state };
    });
}

/** Delete a session and all its data */
export function deleteSession(sessionId) {
  const dir = getSessionDir(sessionId);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    return true;
  }
  return false;
}
