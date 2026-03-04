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

import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  cpSync, symlinkSync, readdirSync, rmSync
} from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ──

const TEMPLATE_DIR = __dirname;                          // Where AGENTS.md + tools/ live
const SESSIONS_DIR = join(__dirname, 'sessions');        // All session workspaces
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

    // Copy AGENTS.md from template
    cpSync(join(TEMPLATE_DIR, 'AGENTS.md'), join(dir, 'AGENTS.md'));

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

  // System prompt from session's own AGENTS.md
  const systemPrompt = readFileSync(join(dir, 'AGENTS.md'), 'utf-8');

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

  const stream = query({ prompt: fullPrompt, options: opts });

  for await (const m of stream) {
    if (m.type === 'system' && m.subtype === 'init') {
      sdkSessionId = m.session_id;
    }
    if (m.type === 'assistant' && m.message?.content) {
      for (const b of m.message.content) {
        if (b.type === 'tool_use') tools.push(b.name);
      }
    }
    if (m.type === 'result' && m.subtype === 'success') {
      result = m.result || '';
      cost = m.total_cost_usd || 0;
      duration = m.duration_ms || 0;
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

  return { response: result, sessionId, sdkSessionId, cost, duration, resumed };
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
