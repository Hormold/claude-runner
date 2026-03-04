import { execSync, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { readFile } from 'fs/promises';
import { join, resolve } from 'path';
import type { ContextConfig } from './types.js';
import type { ContextManager } from './context.js';
import { HistoryManager } from './history.js';
import type { McpServerConfig as SdkMcpConfig } from '@anthropic-ai/claude-code';

const CONTAINER_PREFIX = 'claude-ctx-';
const DOCKER_IMAGE = 'claude-runner-context';
const DEFAULT_MAX_CONCURRENT = 5;
const DEFAULT_EXECUTION_TIMEOUT_MS = 10 * 60 * 1000;

interface DockerContainer {
  contextId: string;
  containerId: string;
  containerName: string;
  workDir: string;
  idleTimer: ReturnType<typeof setTimeout>;
  lastActivity: number;
  sessionId?: string;
}

interface WorkerOutput {
  result?: string;
  sessionId?: string;
  error?: string;
}

export class DockerSessionManager extends EventEmitter {
  private containers = new Map<string, DockerContainer>();
  private running = new Set<string>();
  private contextManager: ContextManager;
  private maxConcurrent: number;
  private abortControllers = new Map<string, AbortController>();

  constructor(contextManager: ContextManager, maxConcurrent?: number) {
    super();
    this.contextManager = contextManager;
    this.maxConcurrent = maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  }

  // ── Public API (same interface as SessionManager) ──

  isRunning(contextId: string): boolean {
    return this.running.has(contextId);
  }

  isAlive(contextId: string): boolean {
    return this.containers.has(contextId);
  }

  getRunningContexts(): Set<string> {
    return new Set(this.running);
  }

  getRunningCount(): number {
    return this.running.size;
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  abortAll(): void {
    for (const [, controller] of this.abortControllers) {
      controller.abort();
    }
    this.abortControllers.clear();
    this.killAll();
  }

  async executeTask(
    contextId: string,
    prompt: string,
    taskId: string,
  ): Promise<string> {
    if (this.running.has(contextId)) {
      throw new Error(`Context '${contextId}' is already running a task`);
    }

    if (this.running.size >= this.maxConcurrent) {
      throw new Error(
        `Max concurrent sessions reached (${this.maxConcurrent}). Try again later.`,
      );
    }

    this.running.add(contextId);
    this.emit('task:start', { contextId, taskId });

    const config = this.contextManager.getConfig(contextId);
    const workDir = this.contextManager.contextPath(contextId);

    try {
      const history = new HistoryManager(workDir);

      // Ensure container is running (reuse warm container or start new one)
      await this.ensureContainer(contextId, workDir, config);
      this.emit('session:created', { contextId });

      const container = this.containers.get(contextId)!;
      clearTimeout(container.idleTimer);

      // Save user prompt to history
      history.append({
        role: 'user',
        content: prompt,
        timestamp: Date.now(),
        taskId,
        tokenEstimate: Math.ceil(prompt.length / 4),
      });

      // Build full prompt with history context
      let fullPrompt: string;
      if (container.sessionId) {
        fullPrompt = prompt;
      } else {
        const historyWindow = config.historyWindow ?? 20;
        const previousTurns = history.getRecent(historyWindow);
        previousTurns.pop();
        fullPrompt = this.buildPromptWithHistory(prompt, previousTurns);
      }

      // Build worker input
      const mcpServers = this.buildMcpConfig(config);
      const systemPrompt = await this.loadAgentsMd(workDir);

      const workerInput = {
        prompt: fullPrompt,
        model: config.model ?? 'claude-sonnet-4-20250514',
        maxTurns: config.maxTurns ?? 50,
        systemPrompt: systemPrompt ?? undefined,
        resume: container.sessionId,
        mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
        env: config.env,
      };

      // Create abort controller for timeout
      const abortController = new AbortController();
      this.abortControllers.set(contextId, abortController);

      // Execute inside container with timeout
      const timeoutMs = config.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
      const output = await this.runWithTimeout(
        () => this.execInContainer(container.containerName, workerInput, abortController.signal),
        timeoutMs,
        abortController,
        contextId,
        taskId,
      );

      // Store session ID for future resume
      if (output.sessionId) {
        container.sessionId = output.sessionId;
      }

      const result = output.result ?? '(no response)';

      // Restart idle timer
      this.touchContainer(contextId, workDir, config);

      // Save assistant response to history
      history.append({
        role: 'assistant',
        content: result,
        timestamp: Date.now(),
        taskId,
        tokenEstimate: Math.ceil(result.length / 4),
      });

      this.emit('task:complete', { contextId, taskId, result });
      return result;
    } catch (err: any) {
      this.emit('task:failed', { contextId, taskId, error: err.message || String(err) });
      throw err;
    } finally {
      this.running.delete(contextId);
      this.abortControllers.delete(contextId);
      if (this.containers.has(contextId)) {
        this.touchContainer(contextId, workDir, config);
      }
    }
  }

  killSession(contextId: string): void {
    const container = this.containers.get(contextId);
    if (container) {
      clearTimeout(container.idleTimer);
      this.stopContainer(container.containerName);
      this.containers.delete(contextId);
    }
    this.running.delete(contextId);
    const controller = this.abortControllers.get(contextId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(contextId);
    }
  }

  killAll(): void {
    for (const [, container] of this.containers) {
      clearTimeout(container.idleTimer);
      this.stopContainer(container.containerName);
    }
    this.containers.clear();
    for (const [, controller] of this.abortControllers) {
      controller.abort();
    }
    this.abortControllers.clear();
  }

  // ── Docker operations ──

  /**
   * Check if Docker is available on the system.
   */
  static isDockerAvailable(): boolean {
    try {
      execSync('docker info', { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Build the context Docker image if not already built.
   */
  static buildImage(dockerfilePath: string): void {
    execSync(`docker build -t ${DOCKER_IMAGE} -f ${dockerfilePath} .`, {
      stdio: 'inherit',
      timeout: 300_000,
    });
  }

  private async ensureContainer(
    contextId: string,
    workDir: string,
    config: ContextConfig,
  ): Promise<void> {
    const existing = this.containers.get(contextId);
    if (existing && this.isContainerRunning(existing.containerName)) {
      return; // Reuse warm container
    }

    const containerName = `${CONTAINER_PREFIX}${contextId}`;
    const absWorkDir = resolve(workDir);

    // Stop any stale container with same name
    this.stopContainer(containerName);

    // Start new container with context directory mounted as the only writable volume
    const containerId = this.startContainer(containerName, absWorkDir, config);

    this.containers.set(contextId, {
      contextId,
      containerId,
      containerName,
      workDir,
      idleTimer: setTimeout(() => {}, 0),
      lastActivity: Date.now(),
      sessionId: existing?.sessionId,
    });

    this.touchContainer(contextId, workDir, config);
  }

  private startContainer(
    containerName: string,
    absWorkDir: string,
    _config: ContextConfig,
  ): string {
    const args = [
      'run', '-d',
      '--name', containerName,
      '--read-only',
      '--tmpfs', '/tmp:size=256m',
      '--security-opt', 'no-new-privileges:true',
      '--network', 'none',
      '-v', `${absWorkDir}:/workspace`,
      DOCKER_IMAGE,
    ];

    const output = execSync(`docker ${args.join(' ')}`, {
      encoding: 'utf-8',
      timeout: 30_000,
    });

    return output.trim();
  }

  private isContainerRunning(containerName: string): boolean {
    try {
      const output = execSync(
        `docker inspect -f '{{.State.Running}}' ${containerName}`,
        { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'] },
      );
      return output.trim() === 'true';
    } catch {
      return false;
    }
  }

  private stopContainer(containerName: string): void {
    try {
      execSync(`docker rm -f ${containerName}`, {
        stdio: 'ignore',
        timeout: 10_000,
      });
    } catch {
      // Container may not exist, that's fine
    }
  }

  /**
   * Execute the worker script inside the container via docker exec.
   * Sends task JSON via stdin and reads result JSON from stdout.
   */
  private execInContainer(
    containerName: string,
    workerInput: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<WorkerOutput> {
    return new Promise<WorkerOutput>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('Task aborted'));
        return;
      }

      const child = spawn('docker', [
        'exec', '-i', containerName,
        'node', '--input-type=module',
        '-e', WORKER_SCRIPT,
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => { stdout += data; });
      child.stderr.on('data', (data) => { stderr += data; });

      const onAbort = () => {
        child.kill('SIGTERM');
        reject(new Error('Task aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });

      child.on('close', (code) => {
        signal.removeEventListener('abort', onAbort);

        if (signal.aborted) return;

        if (code !== 0 && !stdout.trim()) {
          reject(new Error(`Worker exited with code ${code}: ${stderr.trim()}`));
          return;
        }

        try {
          const output: WorkerOutput = JSON.parse(stdout.trim());
          if (output.error) {
            reject(new Error(output.error));
          } else {
            resolve(output);
          }
        } catch {
          reject(new Error(`Invalid worker output: ${stdout.trim()}`));
        }
      });

      child.on('error', (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      });

      // Send input and close stdin
      child.stdin.write(JSON.stringify(workerInput));
      child.stdin.end();
    });
  }

  // ── Helpers ──

  private touchContainer(contextId: string, workDir: string, config: ContextConfig): void {
    const existing = this.containers.get(contextId);
    if (existing) {
      clearTimeout(existing.idleTimer);
    }

    const timeoutMs = config.idleTimeoutMs ?? 300_000;
    const idleTimer = setTimeout(() => {
      const container = this.containers.get(contextId);
      if (container) {
        this.stopContainer(container.containerName);
        this.containers.delete(contextId);
      }
      this.emit('session:expired', contextId);
    }, timeoutMs);

    if (existing) {
      existing.idleTimer = idleTimer;
      existing.lastActivity = Date.now();
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
          servers[name] = { type: 'sse', url: srv.url };
        } else {
          servers[name] = {
            type: 'stdio',
            command: srv.command!,
            args: srv.args,
            env: { ...config.env, ...srv.env },
          };
        }
      }
    }
    return servers;
  }

  private async runWithTimeout(
    fn: () => Promise<WorkerOutput>,
    timeoutMs: number,
    abortController: AbortController,
    contextId: string,
    taskId: string,
  ): Promise<WorkerOutput> {
    return new Promise<WorkerOutput>((resolve, reject) => {
      const timer = setTimeout(() => {
        abortController.abort();
        reject(new Error(`Task '${taskId}' in context '${contextId}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      fn().then(
        (result) => { clearTimeout(timer); resolve(result); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }
}

/**
 * Inline worker script executed inside the container via `node -e`.
 * Reads JSON from stdin, calls the Claude Code SDK, writes JSON to stdout.
 */
const WORKER_SCRIPT = `
import { query } from '@anthropic-ai/claude-code';

let data = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', c => data += c);
process.stdin.on('end', async () => {
  try {
    const input = JSON.parse(data);
    const options = {
      model: input.model,
      maxTurns: input.maxTurns,
      cwd: '/workspace',
      permissionMode: 'bypassPermissions',
      env: input.env,
    };
    if (input.systemPrompt) options.customSystemPrompt = input.systemPrompt;
    if (input.resume) options.resume = input.resume;
    if (input.mcpServers) options.mcpServers = input.mcpServers;

    const stream = query({ prompt: input.prompt, options });
    let resultText = '';
    let hasResult = false;
    let sessionId;

    for await (const msg of stream) {
      if (!sessionId && msg.session_id) sessionId = msg.session_id;
      if (msg.type === 'result') {
        if (msg.subtype === 'success') { resultText = msg.result; hasResult = true; }
        else { process.stdout.write(JSON.stringify({ error: 'Claude Code error: ' + msg.subtype }) + '\\n'); process.exit(1); }
      } else if (msg.type === 'assistant' && !hasResult) {
        const parts = msg.message.content.filter(b => b.type === 'text').map(b => b.text);
        if (parts.length > 0) resultText = parts.join('\\n');
      }
    }
    process.stdout.write(JSON.stringify({ result: resultText || '(no response)', sessionId }) + '\\n');
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err.message || String(err) }) + '\\n');
    process.exit(1);
  }
});
`;
