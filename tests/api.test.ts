import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { TaskQueue } from '../src/queue.js';
import { ContextManager } from '../src/context.js';
import { SessionManager } from '../src/session-manager.js';
import { createApp, type AppDeps } from '../src/index.js';

function setup() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-test-'));
  const contextsDir = path.join(tmpDir, 'contexts');
  const dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(contextsDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const queue = new TaskQueue(dataDir);
  const contextManager = new ContextManager(contextsDir);
  const sessionManager = new SessionManager(contextManager);

  const deps: AppDeps = { queue, contextManager, sessionManager };
  const { app } = createApp(deps);

  return { app, queue, contextManager, sessionManager, tmpDir };
}

function cleanup(tmpDir: string, queue: TaskQueue) {
  queue.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('REST API', () => {
  let app: ReturnType<typeof setup>['app'];
  let queue: TaskQueue;
  let contextManager: ContextManager;
  let sessionManager: SessionManager;
  let tmpDir: string;

  beforeEach(() => {
    const s = setup();
    app = s.app;
    queue = s.queue;
    contextManager = s.contextManager;
    sessionManager = s.sessionManager;
    tmpDir = s.tmpDir;
  });

  afterEach(() => {
    cleanup(tmpDir, queue);
  });

  // ── Health ──

  describe('GET /api/health', () => {
    it('returns ok status', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.contexts).toBe(0);
      expect(res.body.activeSessions).toEqual([]);
      expect(res.body.queueStats).toBeDefined();
    });
  });

  // ── CORS ──

  describe('CORS', () => {
    it('returns CORS headers with default * origin', async () => {
      const res = await request(app).get('/api/health');
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-methods']).toContain('GET');
    });

    it('handles OPTIONS preflight', async () => {
      const res = await request(app).options('/api/health');
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    it('uses configured CORS origin', async () => {
      cleanup(tmpDir, queue);
      const s = setup();
      // Recreate with custom CORS
      const deps: AppDeps = {
        queue: s.queue,
        contextManager: s.contextManager,
        sessionManager: s.sessionManager,
        corsOrigins: 'https://example.com',
      };
      const { app: customApp } = createApp(deps);
      tmpDir = s.tmpDir;
      queue = s.queue;

      const res = await request(customApp).get('/api/health');
      expect(res.headers['access-control-allow-origin']).toBe('https://example.com');
    });
  });

  // ── Context CRUD ──

  describe('POST /api/context', () => {
    it('creates a context', async () => {
      const res = await request(app)
        .post('/api/context')
        .send({ contextId: 'test-ctx' });
      expect(res.status).toBe(201);
      expect(res.body.contextId).toBe('test-ctx');
      expect(res.body.path).toBeDefined();
    });

    it('rejects missing contextId', async () => {
      const res = await request(app)
        .post('/api/context')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('rejects duplicate context', async () => {
      await request(app).post('/api/context').send({ contextId: 'dup' });
      const res = await request(app).post('/api/context').send({ contextId: 'dup' });
      expect(res.status).toBe(409);
    });

    it('rejects invalid contextId', async () => {
      const res = await request(app)
        .post('/api/context')
        .send({ contextId: '../escape' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid contextId');
    });

    it('creates context with custom agentsMd', async () => {
      const res = await request(app)
        .post('/api/context')
        .send({ contextId: 'custom', agentsMd: '# Custom Agent' });
      expect(res.status).toBe(201);

      const agentsPath = path.join(contextManager.contextPath('custom'), 'AGENTS.md');
      expect(fs.readFileSync(agentsPath, 'utf-8')).toBe('# Custom Agent');
    });

    it('creates context with custom config', async () => {
      const res = await request(app)
        .post('/api/context')
        .send({ contextId: 'cfg', config: { maxTurns: 10 } });
      expect(res.status).toBe(201);

      const config = contextManager.getConfig('cfg');
      expect(config.maxTurns).toBe(10);
    });
  });

  describe('GET /api/context', () => {
    it('lists all contexts', async () => {
      await request(app).post('/api/context').send({ contextId: 'a' });
      await request(app).post('/api/context').send({ contextId: 'b' });

      const res = await request(app).get('/api/context');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body.map((c: any) => c.contextId).sort()).toEqual(['a', 'b']);
    });

    it('returns empty array when no contexts', async () => {
      const res = await request(app).get('/api/context');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('GET /api/context/:id', () => {
    it('returns context info', async () => {
      await request(app).post('/api/context').send({ contextId: 'info-ctx' });

      const res = await request(app).get('/api/context/info-ctx');
      expect(res.status).toBe(200);
      expect(res.body.contextId).toBe('info-ctx');
      expect(res.body.config).toBeDefined();
      expect(res.body.sessionAlive).toBe(false);
    });

    it('returns 404 for missing context', async () => {
      const res = await request(app).get('/api/context/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/context/:id', () => {
    it('deletes a context', async () => {
      await request(app).post('/api/context').send({ contextId: 'del-me' });

      const res = await request(app).delete('/api/context/del-me');
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe('del-me');

      const check = await request(app).get('/api/context/del-me');
      expect(check.status).toBe(404);
    });

    it('returns 404 for missing context', async () => {
      const res = await request(app).delete('/api/context/nope');
      expect(res.status).toBe(404);
    });
  });

  // ── Context tasks ──

  describe('GET /api/context/:id/tasks', () => {
    it('lists tasks for a context', async () => {
      await request(app).post('/api/context').send({ contextId: 'task-ctx' });
      queue.enqueue('task-ctx', 'prompt 1');
      queue.enqueue('task-ctx', 'prompt 2');

      const res = await request(app).get('/api/context/task-ctx/tasks');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it('returns empty for context with no tasks', async () => {
      await request(app).post('/api/context').send({ contextId: 'empty-ctx' });

      const res = await request(app).get('/api/context/empty-ctx/tasks');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns 404 for missing context', async () => {
      const res = await request(app).get('/api/context/missing/tasks');
      expect(res.status).toBe(404);
    });

    it('respects limit query parameter', async () => {
      await request(app).post('/api/context').send({ contextId: 'lim-ctx' });
      for (let i = 0; i < 5; i++) {
        queue.enqueue('lim-ctx', `prompt ${i}`);
      }

      const res = await request(app).get('/api/context/lim-ctx/tasks?limit=2');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });
  });

  // ── Context files ──

  describe('GET /api/context/:id/files', () => {
    it('lists files in a context workspace', async () => {
      await request(app).post('/api/context').send({ contextId: 'file-ctx' });

      const res = await request(app).get('/api/context/file-ctx/files');
      expect(res.status).toBe(200);
      expect(res.body.contextId).toBe('file-ctx');
      expect(res.body.files).toBeInstanceOf(Array);
      expect(res.body.files).toContain('config.json');
      expect(res.body.files).toContain('AGENTS.md');
    });

    it('returns 404 for missing context', async () => {
      const res = await request(app).get('/api/context/nope/files');
      expect(res.status).toBe(404);
    });
  });

  // ── Context config ──

  describe('POST /api/context/:id/config', () => {
    it('updates context config', async () => {
      await request(app).post('/api/context').send({ contextId: 'upd-ctx' });

      const res = await request(app)
        .post('/api/context/upd-ctx/config')
        .send({ maxTurns: 100 });
      expect(res.status).toBe(200);
      expect(res.body.contextId).toBe('upd-ctx');
      expect(res.body.config.maxTurns).toBe(100);
    });

    it('returns 404 for missing context', async () => {
      const res = await request(app)
        .post('/api/context/nope/config')
        .send({ maxTurns: 5 });
      expect(res.status).toBe(404);
    });

    it('rejects invalid config values', async () => {
      await request(app).post('/api/context').send({ contextId: 'bad-cfg' });

      const res = await request(app)
        .post('/api/context/bad-cfg/config')
        .send({ maxTurns: -5 });
      expect(res.status).toBe(400);
    });

    it('preserves existing config fields on partial update', async () => {
      await request(app)
        .post('/api/context')
        .send({ contextId: 'merge-ctx', config: { maxTurns: 20, historyWindow: 10 } });

      const res = await request(app)
        .post('/api/context/merge-ctx/config')
        .send({ maxTurns: 99 });
      expect(res.status).toBe(200);
      expect(res.body.config.maxTurns).toBe(99);
      expect(res.body.config.historyWindow).toBe(10);
    });
  });

  // ── Tasks ──

  describe('POST /api/task', () => {
    it('enqueues a task', async () => {
      await request(app).post('/api/context').send({ contextId: 'q-ctx' });

      const res = await request(app)
        .post('/api/task')
        .send({ contextId: 'q-ctx', prompt: 'hello' });
      expect(res.status).toBe(201);
      expect(res.body.taskId).toBeDefined();
      expect(res.body.status).toBe('queued');
      expect(res.body.contextId).toBe('q-ctx');
    });

    it('rejects missing contextId', async () => {
      const res = await request(app)
        .post('/api/task')
        .send({ prompt: 'hello' });
      expect(res.status).toBe(400);
    });

    it('rejects missing prompt', async () => {
      const res = await request(app)
        .post('/api/task')
        .send({ contextId: 'q-ctx' });
      expect(res.status).toBe(400);
    });

    it('rejects empty body', async () => {
      const res = await request(app)
        .post('/api/task')
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns 404 for nonexistent context', async () => {
      const res = await request(app)
        .post('/api/task')
        .send({ contextId: 'ghost', prompt: 'test' });
      expect(res.status).toBe(404);
    });

    it('accepts optional priority', async () => {
      await request(app).post('/api/context').send({ contextId: 'pri-ctx' });

      const res = await request(app)
        .post('/api/task')
        .send({ contextId: 'pri-ctx', prompt: 'hi', priority: 5 });
      expect(res.status).toBe(201);

      const task = queue.getTask(res.body.taskId);
      expect(task?.priority).toBe(5);
    });
  });

  describe('GET /api/task/:id', () => {
    it('returns task by id', async () => {
      await request(app).post('/api/context').send({ contextId: 'gt-ctx' });

      const create = await request(app)
        .post('/api/task')
        .send({ contextId: 'gt-ctx', prompt: 'look up' });

      const res = await request(app).get(`/api/task/${create.body.taskId}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(create.body.taskId);
      expect(res.body.prompt).toBe('look up');
    });

    it('returns 404 for missing task', async () => {
      const res = await request(app).get('/api/task/nonexistent-id');
      expect(res.status).toBe(404);
    });
  });

  // ── Request logging ──

  describe('Request logging', () => {
    it('logs requests to console', async () => {
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => { logs.push(args.join(' ')); };

      try {
        await request(app).get('/api/health');
      } finally {
        console.log = origLog;
      }
      expect(logs.some(l => l.includes('[http]') && l.includes('GET') && l.includes('/api/health'))).toBe(true);
    });
  });

  // ── Validation edge cases ──

  describe('Validation edge cases', () => {
    it('rejects non-JSON content type for POST endpoints', async () => {
      const res = await request(app)
        .post('/api/task')
        .set('Content-Type', 'text/plain')
        .send('not json');
      expect(res.status).toBe(400);
    });

    it('handles webhook URL validation', async () => {
      await request(app).post('/api/context').send({ contextId: 'wh-ctx' });

      const res = await request(app)
        .post('/api/task')
        .send({ contextId: 'wh-ctx', prompt: 'hi', webhook: 'not-a-url' });
      expect(res.status).toBe(400);
    });
  });
});
