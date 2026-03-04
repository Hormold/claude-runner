import express, { type Request, type Response, type NextFunction } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { TaskQueue } from './queue.js';
import { ContextManager } from './context.js';
import { SessionManager } from './session-manager.js';
import { McpServerConfigSchema } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const CONTEXTS_DIR = path.join(ROOT_DIR, 'contexts');
const DATA_DIR = path.join(ROOT_DIR, '.data');

// ── Zod request schemas ──

const CreateTaskSchema = z.object({
  contextId: z.string().min(1, 'contextId is required'),
  prompt: z.string().min(1, 'prompt is required'),
  webhook: z.string().url().optional(),
  priority: z.number().int().nonnegative().optional(),
});

const CreateContextSchema = z.object({
  contextId: z.string().min(1, 'contextId is required'),
  agentsMd: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const UpdateConfigSchema = z.object({
  model: z.string().min(1).optional(),
  maxTurns: z.number().int().positive().optional(),
  historyWindow: z.number().int().nonnegative().optional(),
  idleTimeoutMs: z.number().int().positive().optional(),
  maxConcurrentSessions: z.number().int().positive().optional(),
  executionTimeoutMs: z.number().int().positive().optional(),
  mcpServers: z.record(z.string(), McpServerConfigSchema).optional(),
  env: z.record(z.string(), z.string()).optional(),
  tools: z.object({
    allowedCommands: z.array(z.string()).optional(),
  }).optional(),
}).strict();

function paramStr(val: string | string[] | undefined): string {
  return Array.isArray(val) ? val[0] : val ?? '';
}

// ── App factory ──

export interface AppDeps {
  queue: TaskQueue;
  contextManager: ContextManager;
  sessionManager: SessionManager;
  corsOrigins?: string | string[];
}

export function createApp(deps: AppDeps) {
  const { queue, contextManager, sessionManager, corsOrigins } = deps;

  const app = express();
  app.use(express.json());

  // ── CORS middleware ──
  app.use((req: Request, res: Response, next: NextFunction) => {
    let origin: string;
    if (!corsOrigins || corsOrigins === '*') {
      origin = '*';
    } else if (Array.isArray(corsOrigins)) {
      const requestOrigin = req.headers.origin;
      if (requestOrigin && corsOrigins.includes(requestOrigin)) {
        origin = requestOrigin;
        res.setHeader('Vary', 'Origin');
      } else {
        origin = '';
      }
    } else {
      origin = corsOrigins;
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // ── Request logging middleware ──
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      console.log(`[http] ${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    });
    next();
  });

  // ── Task processing ──
  let processing = false;

  let rerunRequested = false;

  async function processQueue() {
    if (processing) { rerunRequested = true; return; }
    processing = true;

    try {
      do {
        rerunRequested = false;
        const dispatched = new Set<string>();
        while (true) {
          const runningContexts = sessionManager.getRunningContexts();
          // Merge in-flight dispatched contexts that haven't registered in SessionManager yet
          for (const ctx of dispatched) runningContexts.add(ctx);

          // Don't dispatch beyond max concurrent sessions — use merged set to avoid double-counting
          if (runningContexts.size >= sessionManager.getMaxConcurrent()) break;

          const task = queue.nextAvailable(runningContexts);
          if (!task) break;

          queue.markRunning(task.id);
          dispatched.add(task.contextId);
          console.log(`[queue] Running task ${task.id} for context '${task.contextId}'`);

          executeTask(task.id, task.contextId, task.prompt, task.webhook).catch(err => {
            console.error(`[queue] Task ${task.id} failed:`, err);
          });
        }
      } while (rerunRequested);
    } finally {
      processing = false;
    }
  }

  async function executeTask(taskId: string, contextId: string, prompt: string, webhook?: string) {
    try {
      const result = await sessionManager.executeTask(contextId, prompt, taskId);
      queue.markCompleted(taskId, result);
      console.log(`[queue] Task ${taskId} completed`);

      if (webhook) {
        try {
          await fetch(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskId, contextId, status: 'completed', result }),
          });
        } catch (e) {
          console.error(`[webhook] Failed to call ${webhook}:`, e);
        }
      }
    } catch (err: any) {
      queue.markFailed(taskId, err.message || String(err));
      console.error(`[queue] Task ${taskId} failed:`, err.message);

      if (webhook) {
        try {
          await fetch(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskId, contextId, status: 'failed', error: err.message }),
          });
        } catch {} // swallow webhook errors
      }
    }

    processQueue();
  }

  // Session events
  sessionManager.on('session:expired', (contextId: string) => {
    console.log(`[session] Context '${contextId}' idle timeout — session expired`);
  });

  // ── API Routes ──

  // -- Tasks --

  app.post('/api/task', (req: Request, res: Response) => {
    const parsed = CreateTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }

    const { contextId, prompt, webhook, priority } = parsed.data;

    if (!contextManager.exists(contextId)) {
      res.status(404).json({ error: `Context '${contextId}' not found. Create it first.` });
      return;
    }

    const task = queue.enqueue(contextId, prompt, webhook, priority);
    console.log(`[api] Task ${task.id} queued for context '${contextId}'`);

    processQueue();

    res.status(201).json({
      taskId: task.id,
      status: task.status,
      contextId,
    });
  });

  app.get('/api/task/:id', (req: Request, res: Response) => {
    const task = queue.getTask(paramStr(req.params.id));
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json(task);
  });

  // -- Contexts --

  app.post('/api/context', (req: Request, res: Response) => {
    const parsed = CreateContextSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }

    const { contextId, agentsMd, config } = parsed.data;

    try {
      const dir = contextManager.create(contextId, agentsMd, config);
      console.log(`[api] Context '${contextId}' created at ${dir}`);
      res.status(201).json({ contextId, path: dir });
    } catch (err: any) {
      if (err.message.includes('already exists')) {
        res.status(409).json({ error: err.message });
      } else if (err.message.includes('Invalid contextId')) {
        res.status(400).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message });
      }
    }
  });

  app.get('/api/context', (_req: Request, res: Response) => {
    const contexts = contextManager.list().map(id =>
      contextManager.getInfo(id, sessionManager.isAlive(id))
    );
    res.json(contexts);
  });

  app.get('/api/context/:id', (req: Request, res: Response) => {
    const contextId = paramStr(req.params.id);
    if (!contextManager.exists(contextId)) {
      res.status(404).json({ error: 'Context not found' });
      return;
    }
    const info = contextManager.getInfo(contextId, sessionManager.isAlive(contextId));
    res.json(info);
  });

  app.delete('/api/context/:id', (req: Request, res: Response) => {
    const contextId = paramStr(req.params.id);
    if (!contextManager.exists(contextId)) {
      res.status(404).json({ error: 'Context not found' });
      return;
    }

    sessionManager.killSession(contextId);
    queue.failContextTasks(contextId, 'Context was deleted');
    contextManager.delete(contextId);
    console.log(`[api] Context '${contextId}' deleted`);
    res.json({ deleted: contextId });
  });

  // -- Context tasks --

  app.get('/api/context/:id/tasks', (req: Request, res: Response) => {
    const contextId = paramStr(req.params.id);
    if (!contextManager.exists(contextId)) {
      res.status(404).json({ error: 'Context not found' });
      return;
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
    const tasks = queue.getContextTasks(contextId, limit);
    res.json(tasks);
  });

  // -- Context files --

  app.get('/api/context/:id/files', (req: Request, res: Response) => {
    const contextId = paramStr(req.params.id);
    if (!contextManager.exists(contextId)) {
      res.status(404).json({ error: 'Context not found' });
      return;
    }

    const files = contextManager.listFiles(contextId);
    res.json({ contextId, files });
  });

  // -- Context config update --

  app.post('/api/context/:id/config', (req: Request, res: Response) => {
    const contextId = paramStr(req.params.id);
    if (!contextManager.exists(contextId)) {
      res.status(404).json({ error: 'Context not found' });
      return;
    }

    const parsed = UpdateConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }

    try {
      const updated = contextManager.updateConfig(contextId, parsed.data);
      res.json({ contextId, config: updated });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Health ──

  app.get('/api/health', (_req: Request, res: Response) => {
    const contexts = contextManager.list();
    res.json({
      status: 'ok',
      contexts: contexts.length,
      activeSessions: [...sessionManager.getRunningContexts()],
      queueStats: queue.stats(),
    });
  });

  // ── Global JSON error handler ──
  // Catches unhandled errors (e.g. validateContextId throws) and returns JSON instead of HTML
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    console.error(`[error] ${req.method} ${req.path}:`, err.message);
    const status = err.message.includes('Invalid contextId') ? 400 : 500;
    res.status(status).json({ error: err.message });
  });

  return { app, processQueue };
}

// ── Server startup (only when run directly) ──

function isMainModule(): boolean {
  try {
    const mainUrl = fileURLToPath(import.meta.url);
    return process.argv[1] === mainUrl || process.argv[1]?.endsWith('/src/index.ts');
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const queue = new TaskQueue(DATA_DIR);
  const contextManager = new ContextManager(CONTEXTS_DIR);
  const sessionManager = new SessionManager(contextManager);
  // Expire any stuck tasks from previous crashes
  queue.expireStuckTasks();

  // Periodic maintenance: expire stuck tasks every 5 minutes, cleanup old tasks every hour
  const expireInterval = setInterval(() => queue.expireStuckTasks(), 5 * 60 * 1000);
  const cleanupInterval = setInterval(() => queue.cleanup(24 * 60 * 60 * 1000), 60 * 60 * 1000);
  expireInterval.unref();
  cleanupInterval.unref();

  const corsOrigins = process.env.CORS_ORIGINS || '*';
  const { app } = createApp({ queue, contextManager, sessionManager, corsOrigins });

  const PORT = parseInt(process.env.PORT || '3456');

  const HOST = process.env.HOST || '127.0.0.1';
  const server = app.listen(PORT, HOST, () => {
    console.log(`
╔══════════════════════════════════════╗
║  Claude Runner v0.1.0                ║
║  http://${HOST}:${PORT}${' '.repeat(Math.max(0, 20 - HOST.length - String(PORT).length))}║
║                                      ║
║  POST /api/context         Create    ║
║  POST /api/task            Submit    ║
║  GET  /api/task/:id        Status    ║
║  GET  /api/context/:id/tasks  List   ║
║  GET  /api/context/:id/files  Files  ║
║  POST /api/context/:id/config Update ║
║  GET  /api/health          Health    ║
╚══════════════════════════════════════╝
    `);
  });

  // Graceful shutdown
  let shuttingDown = false;

  function gracefulShutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[shutdown] ${signal} received. Stopping...`);

    // Stop accepting new connections
    server.close(() => {
      console.log('[shutdown] Server closed');
    });

    // Abort running tasks and kill sessions first
    sessionManager.abortAll();

    // Mark any remaining running tasks as failed so they don't block contexts on restart
    queue.expireStuckTasks(0);

    // Give in-flight error handlers a moment to finish DB writes, then close
    setTimeout(() => {
      queue.close();
      console.log('[shutdown] Done');
      process.exit(0);
    }, 2000);
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}
