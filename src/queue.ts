import Database from 'better-sqlite3';
import { Task, TaskStatus } from './types.js';
import { v4 as uuid } from 'uuid';
import path from 'path';

export class TaskQueue {
  private db: Database.Database;

  constructor(dataDir: string) {
    this.db = new Database(path.join(dataDir, 'queue.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        contextId TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        result TEXT,
        error TEXT,
        webhook TEXT,
        priority INTEGER DEFAULT 0,
        createdAt INTEGER NOT NULL,
        startedAt INTEGER,
        completedAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_context_status 
        ON tasks(contextId, status);
      CREATE INDEX IF NOT EXISTS idx_tasks_status 
        ON tasks(status);
    `);
  }

  enqueue(contextId: string, prompt: string, webhook?: string, priority?: number): Task {
    const task: Task = {
      id: uuid(),
      contextId,
      prompt,
      status: 'queued',
      webhook,
      priority: priority ?? 0,
      createdAt: Date.now(),
    };

    this.db.prepare(`
      INSERT INTO tasks (id, contextId, prompt, status, webhook, priority, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(task.id, task.contextId, task.prompt, task.status, task.webhook, task.priority, task.createdAt);

    return task;
  }

  // Get next queued task for a context (FIFO, priority-aware)
  nextForContext(contextId: string): Task | null {
    const row = this.db.prepare(`
      SELECT * FROM tasks 
      WHERE contextId = ? AND status = 'queued'
      ORDER BY priority DESC, createdAt ASC
      LIMIT 1
    `).get(contextId) as Task | undefined;
    return row ?? null;
  }

  // Get all contexts that have queued tasks
  contextsWithQueuedTasks(): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT contextId FROM tasks WHERE status = 'queued'
    `).all() as { contextId: string }[];
    return rows.map(r => r.contextId);
  }

  // Get next task from any context that isn't currently running
  nextAvailable(runningContexts: Set<string>): Task | null {
    const contexts = this.contextsWithQueuedTasks();
    for (const ctx of contexts) {
      if (!runningContexts.has(ctx)) {
        return this.nextForContext(ctx);
      }
    }
    return null;
  }

  markRunning(taskId: string) {
    this.db.prepare(`
      UPDATE tasks SET status = 'running', startedAt = ? WHERE id = ?
    `).run(Date.now(), taskId);
  }

  markCompleted(taskId: string, result: string) {
    this.db.prepare(`
      UPDATE tasks SET status = 'completed', result = ?, completedAt = ? WHERE id = ?
    `).run(result, Date.now(), taskId);
  }

  markFailed(taskId: string, error: string) {
    this.db.prepare(`
      UPDATE tasks SET status = 'failed', error = ?, completedAt = ? WHERE id = ?
    `).run(error, Date.now(), taskId);
  }

  getTask(taskId: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined;
    return row ?? null;
  }

  getContextTasks(contextId: string, limit = 20): Task[] {
    return this.db.prepare(`
      SELECT * FROM tasks WHERE contextId = ? ORDER BY createdAt DESC LIMIT ?
    `).all(contextId, limit) as Task[];
  }

  close() {
    this.db.close();
  }
}
