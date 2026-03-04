/**
 * Session manager — maps sessionId to SDK session state.
 *
 * Each session gets:
 * - A workspace directory (sessions/{id}/) with agent files
 * - A persistent SDK session ID for resume
 * - An idle timeout (container stays alive between questions)
 * - History tracking (JSONL)
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { query } from '/app/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import { getApiKey } from './auth.mjs';

const AGENT_DIR = process.env.AGENT_DIR || '/workspace/agent';
const SESSIONS_DIR = process.env.SESSIONS_DIR || '/workspace/sessions';
const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';
const DEFAULT_MAX_TURNS = parseInt(process.env.MAX_TURNS || '15', 10);
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS || '900000', 10); // 15 min

// In-memory session state
const sessions = new Map();

/**
 * Initialize session workspace
 */
function initSession(sessionId) {
  const dir = join(SESSIONS_DIR, sessionId);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, 'data'), { recursive: true });
    mkdirSync(join(dir, 'tools'), { recursive: true });

    // Copy agent files into session workspace
    const agentMd = join(AGENT_DIR, 'AGENTS.md');
    if (existsSync(agentMd)) {
      copyFileSync(agentMd, join(dir, 'AGENTS.md'));
    }

    // Copy MEMORY.md (template)
    const memoryMd = join(AGENT_DIR, 'MEMORY.md');
    if (existsSync(memoryMd)) {
      copyFileSync(memoryMd, join(dir, 'MEMORY.md'));
    }

    // Copy tools
    const toolsDir = join(AGENT_DIR, 'tools');
    if (existsSync(toolsDir)) {
      for (const file of readdirSync(toolsDir)) {
        copyFileSync(join(toolsDir, file), join(dir, 'tools', file));
      }
    }

    // Init git (SDK needs it for file operations)
    try {
      const { execSync } = await import('child_process');
      execSync('git init && git add -A && git commit -m "init" --allow-empty', {
        cwd: dir, stdio: 'ignore',
      });
    } catch {}

    console.log(`[session] Created: ${sessionId}`);
  }

  return dir;
}

/**
 * Get or create session state
 */
function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    const dir = initSession(sessionId);
    sessions.set(sessionId, {
      dir,
      sdkSessionId: null, // Set after first query
      lastActivity: Date.now(),
    });
  }

  const session = sessions.get(sessionId);
  session.lastActivity = Date.now();
  return session;
}

/**
 * Load output schema if it exists
 */
function loadOutputSchema(sessionId) {
  const session = getSession(sessionId);
  const schemaPath = join(session.dir, 'output-schema.json');
  if (existsSync(schemaPath)) {
    try {
      return JSON.parse(readFileSync(schemaPath, 'utf-8'));
    } catch {}
  }

  // Also check agent dir
  const agentSchema = join(AGENT_DIR, 'output-schema.json');
  if (existsSync(agentSchema)) {
    try {
      return JSON.parse(readFileSync(agentSchema, 'utf-8'));
    } catch {}
  }

  return null;
}

/**
 * Append to session history
 */
function appendHistory(sessionId, entry) {
  const session = getSession(sessionId);
  const historyPath = join(session.dir, 'history.jsonl');
  appendFileSync(historyPath, JSON.stringify({ ...entry, ts: Date.now() }) + '\n');
}

/**
 * Get session history
 */
export function getHistory(sessionId) {
  const session = getSession(sessionId);
  const historyPath = join(session.dir, 'history.jsonl');
  if (!existsSync(historyPath)) return [];

  return readFileSync(historyPath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

/**
 * Run a query in a session.
 * Returns { response, output, cost, sessionId, sdkSessionId }
 */
export async function ask(sessionId, message, context) {
  const session = getSession(sessionId);
  const apiKey = await getApiKey();

  // Build prompt with optional context injection
  let prompt = message;
  if (context) {
    prompt = `## Context\n${typeof context === 'string' ? context : JSON.stringify(context, null, 2)}\n\n## User Message\n${message}`;
  }

  // SDK options
  const options = {
    model: DEFAULT_MODEL,
    maxTurns: DEFAULT_MAX_TURNS,
    cwd: session.dir,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    env: { ...process.env, ANTHROPIC_API_KEY: apiKey },
  };

  // Resume existing session if available
  if (session.sdkSessionId) {
    options.resume = session.sdkSessionId;
  }

  // Output format if schema exists
  const outputSchema = loadOutputSchema(sessionId);
  if (outputSchema) {
    options.outputFormat = { type: 'json_schema', schema: outputSchema };
  }

  // MCP servers from config
  if (process.env.MCP_CONFIG) {
    try {
      options.mcpServers = JSON.parse(process.env.MCP_CONFIG);
    } catch {}
  }

  // Log
  appendHistory(sessionId, { role: 'user', content: message, context: context || null });

  // Run query
  const stream = query({ prompt, options });

  let result = '';
  let cost = 0;
  let duration = 0;

  for await (const m of stream) {
    // Capture session ID
    if (m.type === 'system' && m.subtype === 'init' && m.session_id) {
      session.sdkSessionId = m.session_id;
    }

    // Capture result
    if (m.type === 'result') {
      if (m.subtype === 'success') {
        result = m.result || '';
        cost = m.total_cost_usd || 0;
        duration = m.duration_ms || 0;
      } else {
        const err = m.errors?.join(', ') || m.subtype;
        appendHistory(sessionId, { role: 'error', content: err });
        throw new Error(`Agent error: ${err}`);
      }
    }
  }

  // Parse structured output if schema was used
  let output = null;
  if (outputSchema && result) {
    try {
      output = JSON.parse(result);
    } catch {
      output = null; // SDK should enforce schema, but fallback
    }
  }

  // Log response
  appendHistory(sessionId, {
    role: 'assistant',
    content: result,
    output,
    cost,
    duration,
  });

  return {
    response: output ? undefined : result, // If structured output, use output field
    output,
    cost,
    duration,
    sessionId,
    sdkSessionId: session.sdkSessionId,
  };
}

/**
 * Delete a session
 */
export function deleteSession(sessionId) {
  sessions.delete(sessionId);
  // Note: files persist on disk for recovery. Add rm -rf if you want full cleanup.
}

/**
 * List active sessions
 */
export function listSessions() {
  const result = [];
  for (const [id, session] of sessions) {
    result.push({
      sessionId: id,
      sdkSessionId: session.sdkSessionId,
      lastActivity: session.lastActivity,
      idleMs: Date.now() - session.lastActivity,
    });
  }
  return result;
}
