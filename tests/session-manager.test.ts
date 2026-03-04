import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionManager } from '../src/session-manager.js';
import { ContextManager } from '../src/context.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Mock the Claude Code SDK
vi.mock('@anthropic-ai/claude-code', () => ({
  query: vi.fn(),
}));

import { query } from '@anthropic-ai/claude-code';
const mockQuery = vi.mocked(query);

let tmpDir: string;
let contextManager: ContextManager;
let sessionManager: SessionManager;

/**
 * Create a mock async generator that yields the given messages.
 */
function createMockStream(messages: any[]): any {
  async function* gen() {
    for (const msg of messages) {
      yield msg;
    }
  }
  const generator = gen();
  // Add control methods that Query interface requires
  (generator as any).interrupt = vi.fn();
  (generator as any).setPermissionMode = vi.fn();
  (generator as any).setModel = vi.fn();
  (generator as any).supportedCommands = vi.fn();
  (generator as any).supportedModels = vi.fn();
  (generator as any).mcpServerStatus = vi.fn();
  return generator;
}

/**
 * Create a successful result message.
 */
function successResult(result: string, sessionId = 'session-123') {
  return {
    type: 'result' as const,
    subtype: 'success' as const,
    session_id: sessionId,
    result,
    duration_ms: 100,
    duration_api_ms: 80,
    is_error: false,
    num_turns: 1,
    total_cost_usd: 0.01,
    usage: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    modelUsage: {},
    permission_denials: [],
  };
}

/**
 * Create an error result message.
 */
function errorResult(subtype: string, sessionId = 'session-123') {
  return {
    type: 'result' as const,
    subtype,
    session_id: sessionId,
    duration_ms: 100,
    duration_api_ms: 80,
    is_error: true,
    num_turns: 1,
    total_cost_usd: 0.0,
    usage: { inputTokens: 10, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    modelUsage: {},
    permission_denials: [],
  };
}

/**
 * Create an assistant message.
 */
function assistantMessage(text: string, sessionId = 'session-123') {
  return {
    type: 'assistant' as const,
    session_id: sessionId,
    message: {
      content: [{ type: 'text', text }],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-test-'));
  contextManager = new ContextManager(tmpDir);
  sessionManager = new SessionManager(contextManager);
});

afterEach(() => {
  sessionManager.killAll();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SessionManager', () => {
  // ── constructor ──

  describe('constructor', () => {
    it('uses default max concurrent of 5', () => {
      expect(sessionManager.getMaxConcurrent()).toBe(5);
    });

    it('accepts custom max concurrent', () => {
      const mgr = new SessionManager(contextManager, 3);
      expect(mgr.getMaxConcurrent()).toBe(3);
      mgr.killAll();
    });

    it('starts with no running sessions', () => {
      expect(sessionManager.getRunningCount()).toBe(0);
      expect(sessionManager.getRunningContexts().size).toBe(0);
    });
  });

  // ── executeTask ──

  describe('executeTask', () => {
    it('executes a task and returns the result', async () => {
      contextManager.create('test-ctx');
      mockQuery.mockReturnValue(createMockStream([
        successResult('Hello from Claude!'),
      ]));

      const result = await sessionManager.executeTask('test-ctx', 'Say hello', 'task-1');
      expect(result).toBe('Hello from Claude!');
    });

    it('calls query with correct options', async () => {
      contextManager.create('test-ctx', undefined, { model: 'claude-sonnet-4-20250514', maxTurns: 10 });
      mockQuery.mockReturnValue(createMockStream([
        successResult('ok'),
      ]));

      await sessionManager.executeTask('test-ctx', 'test prompt', 'task-1');

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArgs = mockQuery.mock.calls[0][0];
      expect(callArgs.prompt).toContain('test prompt');
      expect(callArgs.options?.model).toBe('claude-sonnet-4-20250514');
      expect(callArgs.options?.maxTurns).toBe(10);
      expect(callArgs.options?.permissionMode).toBe('bypassPermissions');
    });

    it('extracts text from assistant messages', async () => {
      contextManager.create('test-ctx');
      mockQuery.mockReturnValue(createMockStream([
        assistantMessage('I am thinking...'),
        assistantMessage('Here is the answer'),
        successResult('Final result'),
      ]));

      const result = await sessionManager.executeTask('test-ctx', 'prompt', 'task-1');
      // Result message takes priority
      expect(result).toBe('Final result');
    });

    it('returns (no response) when no text produced', async () => {
      contextManager.create('test-ctx');
      mockQuery.mockReturnValue(createMockStream([
        { type: 'system', subtype: 'init', session_id: 'sess-1' },
      ]));

      const result = await sessionManager.executeTask('test-ctx', 'prompt', 'task-1');
      expect(result).toBe('(no response)');
    });

    it('throws when result is an error', async () => {
      contextManager.create('test-ctx');
      mockQuery.mockReturnValue(createMockStream([
        errorResult('error_max_turns'),
      ]));

      await expect(
        sessionManager.executeTask('test-ctx', 'prompt', 'task-1'),
      ).rejects.toThrow('Claude Code error: error_max_turns');
    });

    it('saves user prompt and assistant result to history', async () => {
      contextManager.create('test-ctx');
      mockQuery.mockReturnValue(createMockStream([
        successResult('The answer is 42'),
      ]));

      await sessionManager.executeTask('test-ctx', 'What is the meaning of life?', 'task-1');

      // Read back the history
      const { HistoryManager } = await import('../src/history.js');
      const history = new HistoryManager(contextManager.contextPath('test-ctx'));
      const turns = history.getRecent(10);

      expect(turns).toHaveLength(2);
      expect(turns[0].role).toBe('user');
      expect(turns[0].content).toBe('What is the meaning of life?');
      expect(turns[0].taskId).toBe('task-1');
      expect(turns[1].role).toBe('assistant');
      expect(turns[1].content).toBe('The answer is 42');
      expect(turns[1].taskId).toBe('task-1');
    });

    it('includes history context in prompt for subsequent tasks', async () => {
      contextManager.create('test-ctx');

      // First task
      mockQuery.mockReturnValue(createMockStream([
        successResult('First answer'),
      ]));
      await sessionManager.executeTask('test-ctx', 'First question', 'task-1');

      // Second task
      mockQuery.mockReturnValue(createMockStream([
        successResult('Second answer'),
      ]));
      await sessionManager.executeTask('test-ctx', 'Second question', 'task-2');

      const secondCall = mockQuery.mock.calls[1][0];
      expect(secondCall.prompt).toContain('Previous conversation context');
      expect(secondCall.prompt).toContain('First question');
      expect(secondCall.prompt).toContain('Second question');
    });

    it('loads AGENTS.md as system prompt', async () => {
      contextManager.create('test-ctx', 'You are a helpful bot.');
      mockQuery.mockReturnValue(createMockStream([
        successResult('ok'),
      ]));

      await sessionManager.executeTask('test-ctx', 'hello', 'task-1');

      const callArgs = mockQuery.mock.calls[0][0];
      expect(callArgs.options?.customSystemPrompt).toBe('You are a helpful bot.');
    });
  });

  // ── session resume ──

  describe('session resume', () => {
    it('stores session ID from first run', async () => {
      contextManager.create('test-ctx');
      mockQuery.mockReturnValue(createMockStream([
        successResult('ok', 'sess-abc-123'),
      ]));

      await sessionManager.executeTask('test-ctx', 'first', 'task-1');
      expect(sessionManager.isAlive('test-ctx')).toBe(true);
    });

    it('passes resume option on subsequent runs', async () => {
      contextManager.create('test-ctx');

      // First run - sets session ID
      mockQuery.mockReturnValue(createMockStream([
        successResult('ok', 'sess-abc-123'),
      ]));
      await sessionManager.executeTask('test-ctx', 'first', 'task-1');

      // Second run - should resume
      mockQuery.mockReturnValue(createMockStream([
        successResult('ok2', 'sess-abc-123'),
      ]));
      await sessionManager.executeTask('test-ctx', 'second', 'task-2');

      const secondCallOpts = mockQuery.mock.calls[1][0].options;
      expect(secondCallOpts?.resume).toBe('sess-abc-123');
    });
  });

  // ── max concurrent sessions ──

  describe('max concurrent sessions', () => {
    it('rejects when max concurrent reached', async () => {
      const mgr = new SessionManager(contextManager, 2);

      contextManager.create('ctx-1');
      contextManager.create('ctx-2');
      contextManager.create('ctx-3');

      // Create streams that never resolve
      let resolve1!: () => void;
      let resolve2!: () => void;
      const promise1 = new Promise<void>(r => { resolve1 = r; });
      const promise2 = new Promise<void>(r => { resolve2 = r; });

      mockQuery
        .mockReturnValueOnce(createMockStream([
          // Slow: will yield after explicit resolve
          { type: 'system', subtype: 'init', session_id: 's1' },
        ]))
        .mockReturnValueOnce(createMockStream([
          { type: 'system', subtype: 'init', session_id: 's2' },
        ]));

      // We need long-running tasks. Use a blocking approach.
      // Instead, let's use a simpler approach: mock query to return a stream that hangs
      mockQuery.mockReset();

      // Create a stream that blocks until we resolve it
      function createBlockingStream(resolvePromise: Promise<void>) {
        async function* gen() {
          await resolvePromise;
          yield successResult('done');
        }
        const g = gen();
        (g as any).interrupt = vi.fn();
        (g as any).setPermissionMode = vi.fn();
        (g as any).setModel = vi.fn();
        (g as any).supportedCommands = vi.fn();
        (g as any).supportedModels = vi.fn();
        (g as any).mcpServerStatus = vi.fn();
        return g;
      }

      mockQuery
        .mockReturnValueOnce(createBlockingStream(promise1))
        .mockReturnValueOnce(createBlockingStream(promise2));

      // Start two tasks (don't await - they'll block)
      const t1 = mgr.executeTask('ctx-1', 'task 1', 'task-1');
      const t2 = mgr.executeTask('ctx-2', 'task 2', 'task-2');

      // Wait a tick so they register as running
      await new Promise(r => setTimeout(r, 10));

      expect(mgr.getRunningCount()).toBe(2);

      // Third should be rejected
      await expect(
        mgr.executeTask('ctx-3', 'task 3', 'task-3'),
      ).rejects.toThrow('Max concurrent sessions reached (2)');

      // Cleanup
      resolve1();
      resolve2();
      await Promise.allSettled([t1, t2]);
      mgr.killAll();
    });

    it('allows new tasks after previous ones complete', async () => {
      const mgr = new SessionManager(contextManager, 1);
      contextManager.create('ctx-1');
      contextManager.create('ctx-2');

      mockQuery
        .mockReturnValueOnce(createMockStream([successResult('done1')]))
        .mockReturnValueOnce(createMockStream([successResult('done2')]));

      await mgr.executeTask('ctx-1', 'first', 'task-1');
      expect(mgr.getRunningCount()).toBe(0);

      // Should succeed since first is done
      const result = await mgr.executeTask('ctx-2', 'second', 'task-2');
      expect(result).toBe('done2');
      mgr.killAll();
    });
  });

  // ── duplicate context ──

  describe('duplicate context running', () => {
    it('rejects second task for same context', async () => {
      contextManager.create('test-ctx');

      let resolveFirst!: () => void;
      const firstPromise = new Promise<void>(r => { resolveFirst = r; });

      function createBlockingStream() {
        async function* gen() {
          await firstPromise;
          yield successResult('done');
        }
        const g = gen();
        (g as any).interrupt = vi.fn();
        (g as any).setPermissionMode = vi.fn();
        (g as any).setModel = vi.fn();
        (g as any).supportedCommands = vi.fn();
        (g as any).supportedModels = vi.fn();
        (g as any).mcpServerStatus = vi.fn();
        return g;
      }

      mockQuery.mockReturnValue(createBlockingStream());

      const t1 = sessionManager.executeTask('test-ctx', 'first', 'task-1');
      await new Promise(r => setTimeout(r, 10));

      await expect(
        sessionManager.executeTask('test-ctx', 'second', 'task-2'),
      ).rejects.toThrow("Context 'test-ctx' is already running a task");

      resolveFirst();
      await t1;
    });
  });

  // ── execution timeout ──

  describe('execution timeout', () => {
    it('times out task after configured timeout', async () => {
      contextManager.create('test-ctx', undefined, { executionTimeoutMs: 50 });

      function createSlowStream() {
        async function* gen() {
          // This will hang until timeout
          await new Promise(r => setTimeout(r, 5000));
          yield successResult('should not get here');
        }
        const g = gen();
        (g as any).interrupt = vi.fn();
        (g as any).setPermissionMode = vi.fn();
        (g as any).setModel = vi.fn();
        (g as any).supportedCommands = vi.fn();
        (g as any).supportedModels = vi.fn();
        (g as any).mcpServerStatus = vi.fn();
        return g;
      }

      mockQuery.mockReturnValue(createSlowStream());

      await expect(
        sessionManager.executeTask('test-ctx', 'slow task', 'task-1'),
      ).rejects.toThrow(/timed out after 50ms/);
    });

    it('passes abortController in options', async () => {
      contextManager.create('test-ctx');
      mockQuery.mockReturnValue(createMockStream([
        successResult('ok'),
      ]));

      await sessionManager.executeTask('test-ctx', 'prompt', 'task-1');

      const callArgs = mockQuery.mock.calls[0][0];
      expect(callArgs.options?.abortController).toBeInstanceOf(AbortController);
    });
  });

  // ── events ──

  describe('events', () => {
    it('emits task:start event', async () => {
      contextManager.create('test-ctx');
      mockQuery.mockReturnValue(createMockStream([successResult('ok')]));

      const events: any[] = [];
      sessionManager.on('task:start', (data) => events.push(data));

      await sessionManager.executeTask('test-ctx', 'hello', 'task-1');

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ contextId: 'test-ctx', taskId: 'task-1' });
    });

    it('emits task:complete event on success', async () => {
      contextManager.create('test-ctx');
      mockQuery.mockReturnValue(createMockStream([successResult('done!')]));

      const events: any[] = [];
      sessionManager.on('task:complete', (data) => events.push(data));

      await sessionManager.executeTask('test-ctx', 'hello', 'task-1');

      expect(events).toHaveLength(1);
      expect(events[0].contextId).toBe('test-ctx');
      expect(events[0].taskId).toBe('task-1');
      expect(events[0].result).toBe('done!');
    });

    it('emits task:failed event on error', async () => {
      contextManager.create('test-ctx');
      mockQuery.mockReturnValue(createMockStream([errorResult('error_during_execution')]));

      const events: any[] = [];
      sessionManager.on('task:failed', (data) => events.push(data));

      await expect(
        sessionManager.executeTask('test-ctx', 'hello', 'task-1'),
      ).rejects.toThrow();

      expect(events).toHaveLength(1);
      expect(events[0].contextId).toBe('test-ctx');
      expect(events[0].taskId).toBe('task-1');
      expect(events[0].error).toContain('error_during_execution');
    });

    it('emits session:created event', async () => {
      contextManager.create('test-ctx');
      mockQuery.mockReturnValue(createMockStream([successResult('ok')]));

      const events: any[] = [];
      sessionManager.on('session:created', (data) => events.push(data));

      await sessionManager.executeTask('test-ctx', 'hello', 'task-1');

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ contextId: 'test-ctx' });
    });

    it('emits session:expired event on idle timeout', async () => {
      contextManager.create('test-ctx', undefined, { idleTimeoutMs: 50 });
      mockQuery.mockReturnValue(createMockStream([successResult('ok')]));

      const events: any[] = [];
      sessionManager.on('session:expired', (contextId) => events.push(contextId));

      await sessionManager.executeTask('test-ctx', 'hello', 'task-1');

      // Wait for idle timeout
      await new Promise(r => setTimeout(r, 100));

      expect(events).toHaveLength(1);
      expect(events[0]).toBe('test-ctx');
    });
  });

  // ── idle timeout ──

  describe('idle timeout', () => {
    it('session becomes alive after task execution', async () => {
      contextManager.create('test-ctx');
      mockQuery.mockReturnValue(createMockStream([successResult('ok')]));

      expect(sessionManager.isAlive('test-ctx')).toBe(false);
      await sessionManager.executeTask('test-ctx', 'hello', 'task-1');
      expect(sessionManager.isAlive('test-ctx')).toBe(true);
    });

    it('session expires after idle timeout', async () => {
      contextManager.create('test-ctx', undefined, { idleTimeoutMs: 30 });
      mockQuery.mockReturnValue(createMockStream([successResult('ok')]));

      await sessionManager.executeTask('test-ctx', 'hello', 'task-1');
      expect(sessionManager.isAlive('test-ctx')).toBe(true);

      await new Promise(r => setTimeout(r, 80));
      expect(sessionManager.isAlive('test-ctx')).toBe(false);
    });
  });

  // ── killSession / killAll ──

  describe('killSession', () => {
    it('removes session', async () => {
      contextManager.create('test-ctx');
      mockQuery.mockReturnValue(createMockStream([successResult('ok')]));

      await sessionManager.executeTask('test-ctx', 'hello', 'task-1');
      expect(sessionManager.isAlive('test-ctx')).toBe(true);

      sessionManager.killSession('test-ctx');
      expect(sessionManager.isAlive('test-ctx')).toBe(false);
    });

    it('does not throw for non-existent session', () => {
      expect(() => sessionManager.killSession('nonexistent')).not.toThrow();
    });
  });

  describe('killAll', () => {
    it('removes all sessions', async () => {
      contextManager.create('ctx-1');
      contextManager.create('ctx-2');

      mockQuery.mockReturnValue(createMockStream([successResult('ok')]));
      await sessionManager.executeTask('ctx-1', 'hello', 'task-1');

      mockQuery.mockReturnValue(createMockStream([successResult('ok')]));
      await sessionManager.executeTask('ctx-2', 'hello', 'task-2');

      expect(sessionManager.isAlive('ctx-1')).toBe(true);
      expect(sessionManager.isAlive('ctx-2')).toBe(true);

      sessionManager.killAll();

      expect(sessionManager.isAlive('ctx-1')).toBe(false);
      expect(sessionManager.isAlive('ctx-2')).toBe(false);
    });
  });

  // ── isRunning ──

  describe('isRunning', () => {
    it('returns true during execution, false after', async () => {
      contextManager.create('test-ctx');

      let checkDuringRun = false;
      let resolveStream!: () => void;
      const streamPromise = new Promise<void>(r => { resolveStream = r; });

      function createBlockingStream() {
        async function* gen() {
          // Check running state mid-execution
          checkDuringRun = sessionManager.isRunning('test-ctx');
          await streamPromise;
          yield successResult('done');
        }
        const g = gen();
        (g as any).interrupt = vi.fn();
        (g as any).setPermissionMode = vi.fn();
        (g as any).setModel = vi.fn();
        (g as any).supportedCommands = vi.fn();
        (g as any).supportedModels = vi.fn();
        (g as any).mcpServerStatus = vi.fn();
        return g;
      }

      mockQuery.mockReturnValue(createBlockingStream());

      const task = sessionManager.executeTask('test-ctx', 'hello', 'task-1');
      await new Promise(r => setTimeout(r, 10));

      expect(sessionManager.isRunning('test-ctx')).toBe(true);

      resolveStream();
      await task;

      expect(sessionManager.isRunning('test-ctx')).toBe(false);
    });
  });

  // ── error handling ──

  describe('error handling', () => {
    it('cleans up running state after error', async () => {
      contextManager.create('test-ctx');
      mockQuery.mockReturnValue(createMockStream([errorResult('error_during_execution')]));

      await expect(
        sessionManager.executeTask('test-ctx', 'hello', 'task-1'),
      ).rejects.toThrow();

      expect(sessionManager.isRunning('test-ctx')).toBe(false);
      expect(sessionManager.getRunningCount()).toBe(0);
    });

    it('cleans up running state after SDK throws', async () => {
      contextManager.create('test-ctx');
      mockQuery.mockImplementation(() => {
        throw new Error('SDK initialization failed');
      });

      await expect(
        sessionManager.executeTask('test-ctx', 'hello', 'task-1'),
      ).rejects.toThrow('SDK initialization failed');

      expect(sessionManager.isRunning('test-ctx')).toBe(false);
    });

    it('cleans up running state after stream error', async () => {
      contextManager.create('test-ctx');

      function createFailingStream() {
        async function* gen() {
          yield assistantMessage('starting...');
          throw new Error('Stream interrupted');
        }
        const g = gen();
        (g as any).interrupt = vi.fn();
        (g as any).setPermissionMode = vi.fn();
        (g as any).setModel = vi.fn();
        (g as any).supportedCommands = vi.fn();
        (g as any).supportedModels = vi.fn();
        (g as any).mcpServerStatus = vi.fn();
        return g;
      }

      mockQuery.mockReturnValue(createFailingStream());

      await expect(
        sessionManager.executeTask('test-ctx', 'hello', 'task-1'),
      ).rejects.toThrow('Stream interrupted');

      expect(sessionManager.isRunning('test-ctx')).toBe(false);
    });
  });

  // ── MCP config building ──

  describe('MCP config', () => {
    it('passes MCP servers to query options', async () => {
      contextManager.create('test-ctx', undefined, {
        mcpServers: {
          'my-server': {
            command: 'node',
            args: ['server.js'],
          },
        },
      });
      mockQuery.mockReturnValue(createMockStream([successResult('ok')]));

      await sessionManager.executeTask('test-ctx', 'hello', 'task-1');

      const callArgs = mockQuery.mock.calls[0][0];
      expect(callArgs.options?.mcpServers).toBeDefined();
      const servers = callArgs.options!.mcpServers!;
      expect(servers['my-server']).toEqual({
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: {},
      });
    });

    it('handles SSE MCP servers', async () => {
      contextManager.create('test-ctx', undefined, {
        mcpServers: {
          'sse-server': {
            command: 'unused',
            url: 'http://localhost:8080/sse',
          },
        },
      });
      mockQuery.mockReturnValue(createMockStream([successResult('ok')]));

      await sessionManager.executeTask('test-ctx', 'hello', 'task-1');

      const servers = mockQuery.mock.calls[0][0].options!.mcpServers!;
      expect(servers['sse-server']).toEqual({
        type: 'sse',
        url: 'http://localhost:8080/sse',
      });
    });
  });
});
