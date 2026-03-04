import { query, type SDKMessage, type SDKResultMessage, type SDKAssistantMessage, type Options, type McpServerConfig as SdkMcpConfig } from '@anthropic-ai/claude-code';
import { ContextConfig } from './types.js';
import { HistoryManager } from './history.js';
import { ContextManager } from './context.js';
import { EventEmitter } from 'events';
import { readFile } from 'fs/promises';
import { join } from 'path';

interface ActiveSession {
  contextId: string;
  workDir: string;
  idleTimer: ReturnType<typeof setTimeout>;
  lastActivity: number;
  sessionId?: string; // Claude Code session ID for --resume
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, ActiveSession>();
  private running = new Set<string>();
  private contextManager: ContextManager;

  constructor(contextManager: ContextManager) {
    super();
    this.contextManager = contextManager;
  }

  isRunning(contextId: string): boolean {
    return this.running.has(contextId);
  }

  isAlive(contextId: string): boolean {
    return this.sessions.has(contextId);
  }

  getRunningContexts(): Set<string> {
    return new Set(this.running);
  }

  async executeTask(
    contextId: string,
    prompt: string,
    taskId: string,
  ): Promise<string> {
    if (this.running.has(contextId)) {
      throw new Error(`Context '${contextId}' is already running a task`);
    }

    this.running.add(contextId);

    try {
      const config = this.contextManager.getConfig(contextId);
      const workDir = this.contextManager.contextPath(contextId);
      const history = new HistoryManager(workDir);

      // Reset idle timer
      this.touchSession(contextId, workDir, config);

      // Save user prompt to history
      history.append({
        role: 'user',
        content: prompt,
        timestamp: Date.now(),
        taskId,
        tokenEstimate: Math.ceil(prompt.length / 4),
      });

      // Build the full prompt with history context
      const historyWindow = config.historyWindow ?? 20;
      const previousTurns = history.getRecent(historyWindow);
      // Remove the last turn (the one we just added)
      previousTurns.pop();

      const fullPrompt = this.buildPromptWithHistory(prompt, previousTurns);

      // Build MCP config
      const mcpServers = this.buildMcpConfig(config);

      // Load system prompt from AGENTS.md
      const systemPrompt = await this.loadAgentsMd(workDir);

      // Build options
      const session = this.sessions.get(contextId);
      const options: Options = {
        model: config.model ?? 'claude-sonnet-4-20250514',
        maxTurns: config.maxTurns ?? 50,
        cwd: workDir,
        permissionMode: 'bypassPermissions',
        env: config.env,
      };

      if (systemPrompt) {
        options.customSystemPrompt = systemPrompt;
      }

      if (Object.keys(mcpServers).length > 0) {
        options.mcpServers = mcpServers;
      }

      // Resume previous session if available
      if (session?.sessionId) {
        options.resume = session.sessionId;
      }

      // Execute Claude Code
      const result = await this.runClaudeCode(fullPrompt, options, contextId);

      // Save assistant response to history
      history.append({
        role: 'assistant',
        content: result,
        timestamp: Date.now(),
        taskId,
        tokenEstimate: Math.ceil(result.length / 4),
      });

      return result;
    } finally {
      this.running.delete(contextId);
    }
  }

  private buildPromptWithHistory(
    currentPrompt: string,
    previousTurns: Array<{ role: string; content: string }>,
  ): string {
    if (previousTurns.length === 0) return currentPrompt;

    const historyBlock = previousTurns
      .map(t => `[${t.role}]: ${t.content}`)
      .join('\n\n');

    return `## Previous conversation context:\n${historyBlock}\n\n## Current task:\n${currentPrompt}`;
  }

  private async runClaudeCode(
    prompt: string,
    options: Options,
    contextId: string,
  ): Promise<string> {
    const stream = query({ prompt, options });

    let resultText = '';
    let sessionId: string | undefined;

    for await (const message of stream) {
      // Capture session ID for resume
      if (!sessionId && message.session_id) {
        sessionId = message.session_id;
      }

      if (message.type === 'result') {
        const resultMsg = message as SDKResultMessage;
        if (resultMsg.subtype === 'success') {
          resultText = resultMsg.result;
        } else {
          resultText = `(error: ${resultMsg.subtype})`;
        }
      } else if (message.type === 'assistant') {
        const assistantMsg = message as SDKAssistantMessage;
        // Extract text blocks from assistant messages
        const textParts = assistantMsg.message.content
          .filter((b: { type: string }) => b.type === 'text')
          .map((b: any) => b.text);
        if (textParts.length > 0) {
          resultText = textParts.join('\n');
        }
      }
    }

    // Store session ID for future resume
    if (sessionId) {
      const session = this.sessions.get(contextId);
      if (session) {
        session.sessionId = sessionId;
      }
    }

    return resultText || '(no response)';
  }

  private async loadAgentsMd(workDir: string): Promise<string | null> {
    try {
      return await readFile(join(workDir, 'AGENTS.md'), 'utf-8');
    } catch {
      return null;
    }
  }

  private buildMcpConfig(config: ContextConfig): Record<string, SdkMcpConfig> {
    const servers: Record<string, SdkMcpConfig> = {};
    if (config.mcpServers) {
      for (const [name, srv] of Object.entries(config.mcpServers)) {
        if (srv.url) {
          servers[name] = {
            type: 'sse',
            url: srv.url,
          };
        } else {
          servers[name] = {
            type: 'stdio',
            command: srv.command,
            args: srv.args,
            env: { ...config.env, ...srv.env },
          };
        }
      }
    }
    return servers;
  }

  private touchSession(contextId: string, workDir: string, config: ContextConfig) {
    const existing = this.sessions.get(contextId);
    if (existing) {
      clearTimeout(existing.idleTimer);
    }

    const timeoutMs = config.idleTimeoutMs ?? 300_000;
    const idleTimer = setTimeout(() => {
      this.sessions.delete(contextId);
      this.emit('session:expired', contextId);
    }, timeoutMs);

    this.sessions.set(contextId, {
      contextId,
      workDir,
      idleTimer,
      lastActivity: Date.now(),
      sessionId: existing?.sessionId,
    });
  }

  killSession(contextId: string) {
    const session = this.sessions.get(contextId);
    if (session) {
      clearTimeout(session.idleTimer);
      this.sessions.delete(contextId);
    }
  }

  killAll() {
    for (const [, session] of this.sessions) {
      clearTimeout(session.idleTimer);
    }
    this.sessions.clear();
  }
}
