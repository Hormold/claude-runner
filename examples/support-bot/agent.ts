/**
 * Agent Runner — programmatic session manager for Claude Agent SDK
 *
 * Handles: session creation, resume, structured output, file persistence.
 * Everything is file-based: workspace/ for agent files, .sessions/ for SDK state.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

// ── Types ──

interface RunOptions {
  /** Unique session identifier (your user ID, conversation ID, etc.) */
  sessionId: string;
  /** User's message */
  message: string;
  /** Additional context injected before the message (user data, etc.) */
  context?: string;
  /** Path to workspace (where AGENTS.md, tools/, data/ live) */
  workspace: string;
  /** Model to use */
  model?: string;
  /** Max turns for the agent */
  maxTurns?: number;
  /** JSON schema for structured output */
  outputSchema?: Record<string, unknown>;
}

interface RunResult {
  /** Agent's text response */
  response: string;
  /** Parsed structured output (if outputSchema provided) */
  output?: Record<string, unknown>;
  /** SDK session ID (for resume) */
  sdkSessionId: string;
  /** Cost in USD */
  costUsd: number;
  /** Duration in ms */
  durationMs: number;
}

// ── Session State (file-based) ──

interface SessionState {
  sdkSessionId: string;
  created: string;
  lastActive: string;
  turns: number;
}

function getSessionsDir(workspace: string): string {
  const dir = join(workspace, '.sessions');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function getSessionStatePath(workspace: string, sessionId: string): string {
  return join(getSessionsDir(workspace), `${sessionId}.json`);
}

function loadSessionState(workspace: string, sessionId: string): SessionState | null {
  const path = getSessionStatePath(workspace, sessionId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function saveSessionState(workspace: string, sessionId: string, state: SessionState): void {
  writeFileSync(getSessionStatePath(workspace, sessionId), JSON.stringify(state, null, 2));
}

// ── Main Runner ──

export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const {
    sessionId,
    message,
    context,
    workspace,
    model = 'claude-sonnet-4-20250514',
    maxTurns = 10,
    outputSchema,
  } = opts;

  const absWorkspace = resolve(workspace);

  // Load AGENTS.md as system prompt
  const agentsPath = join(absWorkspace, 'AGENTS.md');
  const systemPrompt = existsSync(agentsPath)
    ? readFileSync(agentsPath, 'utf-8')
    : '';

  // Check for existing session (resume)
  const existingState = loadSessionState(absWorkspace, sessionId);
  const isResume = !!existingState;

  // Build the full prompt
  let fullPrompt = '';
  if (context) {
    fullPrompt += `## User Context\n${context}\n\n---\n\n`;
  }
  fullPrompt += message;

  // SDK session dir — persisted per workspace
  const sdkSessionDir = join(absWorkspace, '.claude-sdk');
  mkdirSync(sdkSessionDir, { recursive: true });

  // Set HOME to workspace so SDK stores sessions there
  const originalHome = process.env.HOME;
  process.env.HOME = sdkSessionDir;

  try {
    // Build query options
    const queryOpts: Record<string, unknown> = {
      model,
      maxTurns,
      cwd: absWorkspace,
      systemPrompt,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    };

    // Resume if we have a previous session
    if (isResume && existingState) {
      queryOpts.resume = existingState.sdkSessionId;
      console.log(`[agent] Resuming session ${sessionId} (SDK: ${existingState.sdkSessionId})`);
    } else {
      console.log(`[agent] New session ${sessionId}`);
    }

    // Add structured output schema
    if (outputSchema) {
      queryOpts.outputFormat = { type: 'json_schema', schema: outputSchema };
    }

    // Run the agent
    const stream = query({ prompt: fullPrompt, options: queryOpts as any });

    let response = '';
    let sdkSessionId = '';
    let costUsd = 0;
    let durationMs = 0;

    for await (const msg of stream) {
      // Capture session ID
      if (msg.type === 'system' && (msg as any).subtype === 'init') {
        sdkSessionId = (msg as any).session_id;
      }

      // Capture assistant messages
      if (msg.type === 'assistant') {
        const content = (msg as any).message?.content;
        if (content) {
          for (const block of content) {
            if (block.type === 'text') response = block.text;
            if (block.type === 'tool_use') {
              console.log(`[agent] Tool: ${block.name}(${JSON.stringify(block.input).slice(0, 80)})`);
            }
          }
        }
      }

      // Capture result
      if (msg.type === 'result') {
        const r = msg as any;
        if (r.subtype === 'success') {
          if (r.result) response = r.result;
          costUsd = r.total_cost_usd || 0;
          durationMs = r.duration_ms || 0;
        }
      }
    }

    // Save session state
    const state: SessionState = {
      sdkSessionId,
      created: existingState?.created || new Date().toISOString(),
      lastActive: new Date().toISOString(),
      turns: (existingState?.turns || 0) + 1,
    };
    saveSessionState(absWorkspace, sessionId, state);

    // Parse structured output if schema was provided
    let output: Record<string, unknown> | undefined;
    if (outputSchema && response) {
      try {
        output = JSON.parse(response);
      } catch {
        // Response wasn't valid JSON — return as text
      }
    }

    return { response, output, sdkSessionId, costUsd, durationMs };
  } finally {
    process.env.HOME = originalHome;
  }
}
