import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { TaskQueue } from './queue.js';
import { ContextManager } from './context.js';
import { SessionManager } from './session-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const CONTEXTS_DIR = path.join(ROOT_DIR, 'contexts');
const DATA_DIR = path.join(ROOT_DIR, '.data');

// Initialize components
const queue = new TaskQueue(DATA_DIR);
const contextManager = new ContextManager(CONTEXTS_DIR);
const sessionManager = new SessionManager(contextManager);

// Task processing loop
let processing = false;

async function processQueue() {
  if (processing) return;
  processing = true;

  try {
    while (true) {
      const runningContexts = sessionManager.getRunningContexts();
      const task = queue.nextAvailable(runningContexts);
      if (!task) break;

      queue.markRunning(task.id);
      console.log(`[queue] Running task ${task.id} for context '${task.contextId}'`);

      // Don't await — run in background so we can process other contexts
      executeTask(task.id, task.contextId, task.prompt, task.webhook).catch(err => {
        console.error(`[queue] Task ${task.id} failed:`, err);
      });
    }
  } finally {
    processing = false;
  }
}

async function executeTask(taskId: string, contextId: string, prompt: string, webhook?: string) {
  try {
    const result = await sessionManager.executeTask(contextId, prompt, taskId);
    queue.markCompleted(taskId, result);
    console.log(`[queue] Task ${taskId} completed`);

    // Webhook callback
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

  // Process next tasks
  processQueue();
}

// Session events
sessionManager.on('session:expired', (contextId: string) => {
  console.log(`[session] Context '${contextId}' idle timeout — session expired`);
});

// Express API
const app = express();
app.use(express.json());

// ── Tasks ──

app.post('/api/task', (req, res) => {
  const { contextId, prompt, webhook, priority } = req.body;

  if (!contextId || !prompt) {
    res.status(400).json({ error: 'contextId and prompt are required' });
    return;
  }

  if (!contextManager.exists(contextId)) {
    res.status(404).json({ error: `Context '${contextId}' not found. Create it first.` });
    return;
  }

  const task = queue.enqueue(contextId, prompt, webhook, priority);
  console.log(`[api] Task ${task.id} queued for context '${contextId}'`);

  // Trigger queue processing
  processQueue();

  res.status(201).json({
    taskId: task.id,
    status: task.status,
    contextId,
  });
});

app.get('/api/task/:id', (req, res) => {
  const task = queue.getTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  res.json(task);
});

// ── Contexts ──

app.post('/api/context', (req, res) => {
  const { contextId, agentsMd, config } = req.body;

  if (!contextId) {
    res.status(400).json({ error: 'contextId is required' });
    return;
  }

  try {
    const dir = contextManager.create(contextId, agentsMd, config);
    console.log(`[api] Context '${contextId}' created at ${dir}`);
    res.status(201).json({ contextId, path: dir });
  } catch (err: any) {
    res.status(409).json({ error: err.message });
  }
});

app.get('/api/context', (_req, res) => {
  const contexts = contextManager.list().map(id =>
    contextManager.getInfo(id, sessionManager.isAlive(id))
  );
  res.json(contexts);
});

app.get('/api/context/:id', (req, res) => {
  const contextId = req.params.id;
  if (!contextManager.exists(contextId)) {
    res.status(404).json({ error: 'Context not found' });
    return;
  }
  const info = contextManager.getInfo(contextId, sessionManager.isAlive(contextId));
  res.json(info);
});

app.delete('/api/context/:id', (req, res) => {
  const contextId = req.params.id;
  if (!contextManager.exists(contextId)) {
    res.status(404).json({ error: 'Context not found' });
    return;
  }

  sessionManager.killSession(contextId);
  contextManager.delete(contextId);
  console.log(`[api] Context '${contextId}' deleted`);
  res.json({ deleted: contextId });
});

// ── Health ──

app.get('/api/health', (_req, res) => {
  const contexts = contextManager.list();
  res.json({
    status: 'ok',
    contexts: contexts.length,
    activeSessions: [...sessionManager.getRunningContexts()],
  });
});

// Start server
const PORT = parseInt(process.env.PORT || '3456');

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║  Claude Runner v0.1.0                ║
║  http://localhost:${PORT}               ║
║                                      ║
║  POST /api/context   Create context  ║
║  POST /api/task      Submit task     ║
║  GET  /api/task/:id  Task status     ║
║  GET  /api/health    Health check    ║
╚══════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[shutdown] Cleaning up...');
  sessionManager.killAll();
  queue.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  sessionManager.killAll();
  queue.close();
  process.exit(0);
});
