import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { TaskQueue } from '../src/queue.js';
import { ContextManager } from '../src/context.js';
import { SessionManager } from '../src/session-manager.js';
import { createApp, type AppDeps } from '../src/index.js';

// Mock the Claude Code SDK
vi.mock('@anthropic-ai/claude-code', () => ({
  query: vi.fn(),
}));

import { query } from '@anthropic-ai/claude-code';
const mockQuery = vi.mocked(query);

// ── Mock helpers ──

function createMockStream(messages: any[]): any {
  async function* gen() {
    for (const msg of messages) {
      yield msg;
    }
  }
  const generator = gen();
  (generator as any).interrupt = vi.fn();
  (generator as any).setPermissionMode = vi.fn();
  (generator as any).setModel = vi.fn();
  (generator as any).supportedCommands = vi.fn();
  (generator as any).supportedModels = vi.fn();
  (generator as any).mcpServerStatus = vi.fn();
  return generator;
}

function createBlockingStream(resolvePromise: Promise<void>, sessionId = 'session-123'): any {
  async function* gen() {
    await resolvePromise;
    yield successResult('done', sessionId);
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

// ── Test setup ──

interface TestEnv {
  app: ReturnType<typeof createApp>['app'];
  processQueue: ReturnType<typeof createApp>['processQueue'];
  queue: TaskQueue;
  contextManager: ContextManager;
  sessionManager: SessionManager;
  tmpDir: string;
}

function setup(): TestEnv {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-test-'));
  const contextsDir = path.join(tmpDir, 'contexts');
  const dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(contextsDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const queue = new TaskQueue(dataDir);
  const contextManager = new ContextManager(contextsDir);
  const sessionManager = new SessionManager(contextManager);

  const deps: AppDeps = { queue, contextManager, sessionManager };
  const { app, processQueue } = createApp(deps);

  return { app, processQueue, queue, contextManager, sessionManager, tmpDir };
}

function teardown(env: TestEnv) {
  env.sessionManager.killAll();
  env.queue.close();
  fs.rmSync(env.tmpDir, { recursive: true, force: true });
}

// ── Integration Tests ──

describe('Integration: end-to-end flows', () => {
  let env: TestEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    env = setup();
  });

  afterEach(() => {
    teardown(env);
  });

  // ── Test 1: create context → submit task → poll until complete → verify result ──

  describe('full task lifecycle', () => {
    it('creates context, submits task, completes, and returns result via poll', async () => {
      mockQuery.mockReturnValue(createMockStream([
        successResult('Integration test answer'),
      ]));

      // Step 1: Create context
      const ctxRes = await request(env.app)
        .post('/api/context')
        .send({ contextId: 'e2e-ctx' });
      expect(ctxRes.status).toBe(201);
      expect(ctxRes.body.contextId).toBe('e2e-ctx');

      // Step 2: Submit task
      const taskRes = await request(env.app)
        .post('/api/task')
        .send({ contextId: 'e2e-ctx', prompt: 'What is 2+2?' });
      expect(taskRes.status).toBe(201);
      expect(taskRes.body.status).toBe('queued');
      const taskId = taskRes.body.taskId;

      // Step 3: Wait for task execution to complete
      // The processQueue call in the POST /api/task fires executeTask asynchronously.
      // We need to wait for the async execution to finish.
      await vi.waitFor(async () => {
        const pollRes = await request(env.app).get(`/api/task/${taskId}`);
        expect(pollRes.body.status).toBe('completed');
      }, { timeout: 2000, interval: 50 });

      // Step 4: Verify result
      const finalRes = await request(env.app).get(`/api/task/${taskId}`);
      expect(finalRes.status).toBe(200);
      expect(finalRes.body.status).toBe('completed');
      expect(finalRes.body.result).toBe('Integration test answer');
      expect(finalRes.body.completedAt).toBeDefined();
    });

    it('task appears in context task list after submission', async () => {
      mockQuery.mockReturnValue(createMockStream([
        successResult('done'),
      ]));

      await request(env.app).post('/api/context').send({ contextId: 'list-ctx' });
      const taskRes = await request(env.app)
        .post('/api/task')
        .send({ contextId: 'list-ctx', prompt: 'hello' });

      // Wait for completion
      await vi.waitFor(async () => {
        const poll = await request(env.app).get(`/api/task/${taskRes.body.taskId}`);
        expect(poll.body.status).toBe('completed');
      }, { timeout: 2000, interval: 50 });

      // Check context tasks endpoint
      const tasksRes = await request(env.app).get('/api/context/list-ctx/tasks');
      expect(tasksRes.status).toBe(200);
      expect(tasksRes.body).toHaveLength(1);
      expect(tasksRes.body[0].prompt).toBe('hello');
      expect(tasksRes.body[0].status).toBe('completed');
    });
  });

  // ── Test 2: multiple tasks to same context → sequential execution ──

  describe('sequential execution for same context', () => {
    it('executes tasks for the same context one at a time in order', async () => {
      let resolveFirst!: () => void;
      const firstPromise = new Promise<void>(r => { resolveFirst = r; });

      // First call blocks until we resolve it
      mockQuery.mockReturnValueOnce(createBlockingStream(firstPromise, 'sess-1'));
      // Second call returns immediately
      mockQuery.mockReturnValueOnce(createMockStream([
        successResult('second result', 'sess-2'),
      ]));

      await request(env.app).post('/api/context').send({ contextId: 'seq-ctx' });

      // Submit two tasks
      const task1Res = await request(env.app)
        .post('/api/task')
        .send({ contextId: 'seq-ctx', prompt: 'first task' });
      const task1Id = task1Res.body.taskId;

      const task2Res = await request(env.app)
        .post('/api/task')
        .send({ contextId: 'seq-ctx', prompt: 'second task' });
      const task2Id = task2Res.body.taskId;

      // Wait a tick for first task to start processing
      await new Promise(r => setTimeout(r, 50));

      // Task 1 should be running, task 2 should still be queued
      const t1Status = await request(env.app).get(`/api/task/${task1Id}`);
      expect(t1Status.body.status).toBe('running');

      const t2Status = await request(env.app).get(`/api/task/${task2Id}`);
      expect(t2Status.body.status).toBe('queued');

      // Complete first task
      resolveFirst();

      // Wait for both tasks to complete
      await vi.waitFor(async () => {
        const poll1 = await request(env.app).get(`/api/task/${task1Id}`);
        const poll2 = await request(env.app).get(`/api/task/${task2Id}`);
        expect(poll1.body.status).toBe('completed');
        expect(poll2.body.status).toBe('completed');
      }, { timeout: 3000, interval: 50 });

      // Verify task 1 completed before task 2
      const final1 = await request(env.app).get(`/api/task/${task1Id}`);
      const final2 = await request(env.app).get(`/api/task/${task2Id}`);
      expect(final1.body.completedAt).toBeLessThanOrEqual(final2.body.completedAt);
    });
  });

  // ── Test 3: tasks to different contexts → parallel execution ──

  describe('parallel execution across contexts', () => {
    it('executes tasks for different contexts in parallel', async () => {
      let resolveA!: () => void;
      let resolveB!: () => void;
      const promiseA = new Promise<void>(r => { resolveA = r; });
      const promiseB = new Promise<void>(r => { resolveB = r; });

      mockQuery
        .mockReturnValueOnce(createBlockingStream(promiseA, 'sess-a'))
        .mockReturnValueOnce(createBlockingStream(promiseB, 'sess-b'));

      await request(env.app).post('/api/context').send({ contextId: 'ctx-a' });
      await request(env.app).post('/api/context').send({ contextId: 'ctx-b' });

      // Submit tasks to different contexts
      const taskARes = await request(env.app)
        .post('/api/task')
        .send({ contextId: 'ctx-a', prompt: 'task A' });
      const taskBRes = await request(env.app)
        .post('/api/task')
        .send({ contextId: 'ctx-b', prompt: 'task B' });

      const taskAId = taskARes.body.taskId;
      const taskBId = taskBRes.body.taskId;

      // Wait a tick so both start processing
      await new Promise(r => setTimeout(r, 50));

      // Both tasks should be running simultaneously
      const statusA = await request(env.app).get(`/api/task/${taskAId}`);
      const statusB = await request(env.app).get(`/api/task/${taskBId}`);
      expect(statusA.body.status).toBe('running');
      expect(statusB.body.status).toBe('running');

      // Resolve both
      resolveA();
      resolveB();

      // Wait for both to complete
      await vi.waitFor(async () => {
        const pollA = await request(env.app).get(`/api/task/${taskAId}`);
        const pollB = await request(env.app).get(`/api/task/${taskBId}`);
        expect(pollA.body.status).toBe('completed');
        expect(pollB.body.status).toBe('completed');
      }, { timeout: 2000, interval: 50 });
    });
  });

  // ── Test 4: webhook callback fires on completion ──

  describe('webhook callbacks', () => {
    it('calls webhook on task completion with correct payload', async () => {
      mockQuery.mockReturnValue(createMockStream([
        successResult('webhook test result'),
      ]));

      // Start a tiny HTTP server to receive webhook
      const webhookCalls: any[] = [];
      const webhookServer = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          webhookCalls.push(JSON.parse(body));
          res.writeHead(200);
          res.end();
        });
      });

      await new Promise<void>(resolve => webhookServer.listen(0, resolve));
      const port = (webhookServer.address() as any).port;

      try {
        await request(env.app).post('/api/context').send({ contextId: 'wh-ctx' });

        await request(env.app)
          .post('/api/task')
          .send({
            contextId: 'wh-ctx',
            prompt: 'do work',
            webhook: `http://localhost:${port}/callback`,
          });

        // Wait for webhook to be called
        await vi.waitFor(() => {
          expect(webhookCalls).toHaveLength(1);
        }, { timeout: 2000, interval: 50 });

        expect(webhookCalls[0].status).toBe('completed');
        expect(webhookCalls[0].result).toBe('webhook test result');
        expect(webhookCalls[0].contextId).toBe('wh-ctx');
        expect(webhookCalls[0].taskId).toBeDefined();
      } finally {
        await new Promise<void>(resolve => webhookServer.close(() => resolve()));
      }
    });

    it('calls webhook on task failure with error payload', async () => {
      mockQuery.mockReturnValue(createMockStream([
        errorResult('error_during_execution'),
      ]));

      const webhookCalls: any[] = [];
      const webhookServer = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          webhookCalls.push(JSON.parse(body));
          res.writeHead(200);
          res.end();
        });
      });

      await new Promise<void>(resolve => webhookServer.listen(0, resolve));
      const port = (webhookServer.address() as any).port;

      try {
        await request(env.app).post('/api/context').send({ contextId: 'wh-fail' });

        await request(env.app)
          .post('/api/task')
          .send({
            contextId: 'wh-fail',
            prompt: 'fail task',
            webhook: `http://localhost:${port}/callback`,
          });

        // Wait for webhook
        await vi.waitFor(() => {
          expect(webhookCalls).toHaveLength(1);
        }, { timeout: 2000, interval: 50 });

        expect(webhookCalls[0].status).toBe('failed');
        expect(webhookCalls[0].error).toContain('error_during_execution');
        expect(webhookCalls[0].contextId).toBe('wh-fail');
      } finally {
        await new Promise<void>(resolve => webhookServer.close(() => resolve()));
      }
    });
  });

  // ── Test 5: task failure handling and error reporting ──

  describe('task failure handling', () => {
    it('marks task as failed when SDK returns error result', async () => {
      mockQuery.mockReturnValue(createMockStream([
        errorResult('error_max_turns'),
      ]));

      await request(env.app).post('/api/context').send({ contextId: 'fail-ctx' });

      const taskRes = await request(env.app)
        .post('/api/task')
        .send({ contextId: 'fail-ctx', prompt: 'failing prompt' });
      const taskId = taskRes.body.taskId;

      await vi.waitFor(async () => {
        const poll = await request(env.app).get(`/api/task/${taskId}`);
        expect(poll.body.status).toBe('failed');
      }, { timeout: 2000, interval: 50 });

      const finalRes = await request(env.app).get(`/api/task/${taskId}`);
      expect(finalRes.body.status).toBe('failed');
      expect(finalRes.body.error).toContain('error_max_turns');
      expect(finalRes.body.completedAt).toBeDefined();
    });

    it('marks task as failed when SDK throws', async () => {
      mockQuery.mockImplementation(() => {
        throw new Error('SDK initialization failed');
      });

      await request(env.app).post('/api/context').send({ contextId: 'throw-ctx' });

      const taskRes = await request(env.app)
        .post('/api/task')
        .send({ contextId: 'throw-ctx', prompt: 'throw prompt' });
      const taskId = taskRes.body.taskId;

      await vi.waitFor(async () => {
        const poll = await request(env.app).get(`/api/task/${taskId}`);
        expect(poll.body.status).toBe('failed');
      }, { timeout: 2000, interval: 50 });

      const finalRes = await request(env.app).get(`/api/task/${taskId}`);
      expect(finalRes.body.error).toContain('SDK initialization failed');
    });

    it('marks task as failed when stream throws mid-execution', async () => {
      function createFailingStream(): any {
        async function* gen() {
          yield {
            type: 'assistant' as const,
            session_id: 'sess-1',
            message: { content: [{ type: 'text', text: 'starting...' }] },
          };
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

      await request(env.app).post('/api/context').send({ contextId: 'stream-fail' });

      const taskRes = await request(env.app)
        .post('/api/task')
        .send({ contextId: 'stream-fail', prompt: 'stream fail prompt' });
      const taskId = taskRes.body.taskId;

      await vi.waitFor(async () => {
        const poll = await request(env.app).get(`/api/task/${taskId}`);
        expect(poll.body.status).toBe('failed');
      }, { timeout: 2000, interval: 50 });

      const finalRes = await request(env.app).get(`/api/task/${taskId}`);
      expect(finalRes.body.error).toContain('Stream interrupted');
    });

    it('subsequent tasks can still run after a failure', async () => {
      // First task fails
      mockQuery.mockReturnValueOnce(createMockStream([
        errorResult('error_during_execution'),
      ]));
      // Second task succeeds
      mockQuery.mockReturnValueOnce(createMockStream([
        successResult('recovery success'),
      ]));

      await request(env.app).post('/api/context').send({ contextId: 'recover-ctx' });

      const t1Res = await request(env.app)
        .post('/api/task')
        .send({ contextId: 'recover-ctx', prompt: 'fail first' });

      await vi.waitFor(async () => {
        const poll = await request(env.app).get(`/api/task/${t1Res.body.taskId}`);
        expect(poll.body.status).toBe('failed');
      }, { timeout: 2000, interval: 50 });

      const t2Res = await request(env.app)
        .post('/api/task')
        .send({ contextId: 'recover-ctx', prompt: 'succeed second' });

      await vi.waitFor(async () => {
        const poll = await request(env.app).get(`/api/task/${t2Res.body.taskId}`);
        expect(poll.body.status).toBe('completed');
      }, { timeout: 2000, interval: 50 });

      const final = await request(env.app).get(`/api/task/${t2Res.body.taskId}`);
      expect(final.body.result).toBe('recovery success');
    });
  });

  // ── Test 6: context deletion cleans up sessions and files ──

  describe('context deletion cleanup', () => {
    it('deletes context workspace files', async () => {
      await request(env.app).post('/api/context').send({ contextId: 'del-ctx' });
      const ctxPath = env.contextManager.contextPath('del-ctx');
      expect(fs.existsSync(ctxPath)).toBe(true);

      await request(env.app).delete('/api/context/del-ctx');
      expect(fs.existsSync(ctxPath)).toBe(false);
    });

    it('kills session when context is deleted', async () => {
      mockQuery.mockReturnValue(createMockStream([
        successResult('alive'),
      ]));

      await request(env.app).post('/api/context').send({ contextId: 'kill-ctx' });

      // Execute a task to create a session
      const taskRes = await request(env.app)
        .post('/api/task')
        .send({ contextId: 'kill-ctx', prompt: 'create session' });

      await vi.waitFor(async () => {
        const poll = await request(env.app).get(`/api/task/${taskRes.body.taskId}`);
        expect(poll.body.status).toBe('completed');
      }, { timeout: 2000, interval: 50 });

      // Session should be alive after task
      expect(env.sessionManager.isAlive('kill-ctx')).toBe(true);

      // Delete context
      const delRes = await request(env.app).delete('/api/context/kill-ctx');
      expect(delRes.status).toBe(200);

      // Session should be gone
      expect(env.sessionManager.isAlive('kill-ctx')).toBe(false);
    });

    it('context no longer appears in list after deletion', async () => {
      await request(env.app).post('/api/context').send({ contextId: 'gone-ctx' });
      await request(env.app).delete('/api/context/gone-ctx');

      const listRes = await request(env.app).get('/api/context');
      expect(listRes.body.map((c: any) => c.contextId)).not.toContain('gone-ctx');
    });

    it('tasks remain in queue after context deletion', async () => {
      mockQuery.mockReturnValue(createMockStream([
        successResult('result'),
      ]));

      await request(env.app).post('/api/context').send({ contextId: 'orphan-ctx' });
      const taskRes = await request(env.app)
        .post('/api/task')
        .send({ contextId: 'orphan-ctx', prompt: 'before delete' });

      await vi.waitFor(async () => {
        const poll = await request(env.app).get(`/api/task/${taskRes.body.taskId}`);
        expect(poll.body.status).toBe('completed');
      }, { timeout: 2000, interval: 50 });

      // Delete context
      await request(env.app).delete('/api/context/orphan-ctx');

      // Task record still exists in queue
      const taskPoll = await request(env.app).get(`/api/task/${taskRes.body.taskId}`);
      expect(taskPoll.status).toBe(200);
      expect(taskPoll.body.status).toBe('completed');
    });
  });

  // ── Test 7: graceful shutdown behavior ──

  describe('server graceful shutdown', () => {
    it('health endpoint reflects running sessions and queue state', async () => {
      let resolveTask!: () => void;
      const taskPromise = new Promise<void>(r => { resolveTask = r; });
      mockQuery.mockReturnValue(createBlockingStream(taskPromise));

      await request(env.app).post('/api/context').send({ contextId: 'health-ctx' });
      await request(env.app)
        .post('/api/task')
        .send({ contextId: 'health-ctx', prompt: 'busy work' });

      // Wait for task to start running
      await new Promise(r => setTimeout(r, 50));

      const healthRes = await request(env.app).get('/api/health');
      expect(healthRes.body.status).toBe('ok');
      expect(healthRes.body.contexts).toBe(1);
      expect(healthRes.body.queueStats.counts.running).toBe(1);

      // Cleanup
      resolveTask();
      await new Promise(r => setTimeout(r, 100));
    });

    it('killAll stops all sessions', async () => {
      mockQuery
        .mockReturnValueOnce(createMockStream([successResult('a')]))
        .mockReturnValueOnce(createMockStream([successResult('b')]));

      await request(env.app).post('/api/context').send({ contextId: 'sa' });
      await request(env.app).post('/api/context').send({ contextId: 'sb' });

      const t1 = await request(env.app)
        .post('/api/task')
        .send({ contextId: 'sa', prompt: 'task a' });
      const t2 = await request(env.app)
        .post('/api/task')
        .send({ contextId: 'sb', prompt: 'task b' });

      // Wait for both to complete
      await vi.waitFor(async () => {
        const p1 = await request(env.app).get(`/api/task/${t1.body.taskId}`);
        const p2 = await request(env.app).get(`/api/task/${t2.body.taskId}`);
        expect(p1.body.status).toBe('completed');
        expect(p2.body.status).toBe('completed');
      }, { timeout: 2000, interval: 50 });

      expect(env.sessionManager.isAlive('sa')).toBe(true);
      expect(env.sessionManager.isAlive('sb')).toBe(true);

      // Simulate graceful shutdown
      env.sessionManager.killAll();

      expect(env.sessionManager.isAlive('sa')).toBe(false);
      expect(env.sessionManager.isAlive('sb')).toBe(false);
    });

    it('queue can be closed and stops accepting operations', async () => {
      await request(env.app).post('/api/context').send({ contextId: 'close-ctx' });

      // Close the queue (simulating shutdown)
      env.queue.close();

      // Operations should throw after close
      expect(() => env.queue.enqueue('close-ctx', 'test')).toThrow();

      // Re-create queue for teardown
      const dataDir = path.join(env.tmpDir, 'data');
      env.queue = new TaskQueue(dataDir);
    });
  });
});
