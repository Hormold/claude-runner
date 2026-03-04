import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskQueue } from '../src/queue.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

let queue: TaskQueue;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-test-'));
  queue = new TaskQueue(tmpDir);
});

afterEach(() => {
  queue.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('TaskQueue', () => {
  // ── enqueue ──

  describe('enqueue', () => {
    it('creates a task with correct fields', () => {
      const task = queue.enqueue('ctx-1', 'do something');
      expect(task.id).toBeDefined();
      expect(task.contextId).toBe('ctx-1');
      expect(task.prompt).toBe('do something');
      expect(task.status).toBe('queued');
      expect(task.priority).toBe(0);
      expect(task.createdAt).toBeGreaterThan(0);
    });

    it('stores webhook and priority when provided', () => {
      const task = queue.enqueue('ctx-1', 'prompt', 'https://hook.example', 5);
      expect(task.webhook).toBe('https://hook.example');
      expect(task.priority).toBe(5);
    });

    it('persists task to database', () => {
      const task = queue.enqueue('ctx-1', 'persisted prompt');
      const fetched = queue.getTask(task.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.prompt).toBe('persisted prompt');
    });
  });

  // ── dequeue (nextForContext / nextAvailable) ──

  describe('dequeue', () => {
    it('returns null when no tasks exist', () => {
      expect(queue.nextForContext('ctx-1')).toBeNull();
    });

    it('returns queued task for context', () => {
      queue.enqueue('ctx-1', 'task 1');
      const next = queue.nextForContext('ctx-1');
      expect(next).not.toBeNull();
      expect(next!.prompt).toBe('task 1');
    });

    it('does not return tasks from other contexts', () => {
      queue.enqueue('ctx-2', 'other context');
      expect(queue.nextForContext('ctx-1')).toBeNull();
    });

    it('does not return running tasks', () => {
      const task = queue.enqueue('ctx-1', 'will run');
      queue.markRunning(task.id);
      expect(queue.nextForContext('ctx-1')).toBeNull();
    });
  });

  // ── priority ordering ──

  describe('priority ordering', () => {
    it('returns higher priority tasks first', () => {
      queue.enqueue('ctx-1', 'low', undefined, 1);
      queue.enqueue('ctx-1', 'high', undefined, 10);
      queue.enqueue('ctx-1', 'medium', undefined, 5);

      const next = queue.nextForContext('ctx-1');
      expect(next!.prompt).toBe('high');
    });

    it('returns FIFO within same priority', () => {
      queue.enqueue('ctx-1', 'first', undefined, 0);
      queue.enqueue('ctx-1', 'second', undefined, 0);
      queue.enqueue('ctx-1', 'third', undefined, 0);

      const next = queue.nextForContext('ctx-1');
      expect(next!.prompt).toBe('first');
    });
  });

  // ── context isolation ──

  describe('context isolation', () => {
    it('nextAvailable skips contexts with running tasks', () => {
      const t1 = queue.enqueue('ctx-1', 'running context');
      queue.enqueue('ctx-2', 'available context');
      queue.markRunning(t1.id);

      const running = new Set(['ctx-1']);
      const next = queue.nextAvailable(running);
      expect(next).not.toBeNull();
      expect(next!.contextId).toBe('ctx-2');
    });

    it('nextAvailable returns null when all contexts are running', () => {
      const t1 = queue.enqueue('ctx-1', 'task');
      queue.markRunning(t1.id);

      const running = new Set(['ctx-1']);
      expect(queue.nextAvailable(running)).toBeNull();
    });

    it('contextsWithQueuedTasks lists distinct contexts', () => {
      queue.enqueue('ctx-a', 'a1');
      queue.enqueue('ctx-a', 'a2');
      queue.enqueue('ctx-b', 'b1');
      const contexts = queue.contextsWithQueuedTasks();
      expect(contexts.sort()).toEqual(['ctx-a', 'ctx-b']);
    });
  });

  // ── status transitions ──

  describe('status transitions', () => {
    it('markRunning sets status and startedAt', () => {
      const task = queue.enqueue('ctx-1', 'test');
      queue.markRunning(task.id);
      const updated = queue.getTask(task.id)!;
      expect(updated.status).toBe('running');
      expect(updated.startedAt).toBeGreaterThan(0);
    });

    it('markCompleted sets result and completedAt', () => {
      const task = queue.enqueue('ctx-1', 'test');
      queue.markRunning(task.id);
      queue.markCompleted(task.id, 'done!');
      const updated = queue.getTask(task.id)!;
      expect(updated.status).toBe('completed');
      expect(updated.result).toBe('done!');
      expect(updated.completedAt).toBeGreaterThan(0);
    });

    it('markFailed sets error and completedAt', () => {
      const task = queue.enqueue('ctx-1', 'test');
      queue.markRunning(task.id);
      queue.markFailed(task.id, 'something broke');
      const updated = queue.getTask(task.id)!;
      expect(updated.status).toBe('failed');
      expect(updated.error).toBe('something broke');
      expect(updated.completedAt).toBeGreaterThan(0);
    });
  });

  // ── getContextTasks ──

  describe('getContextTasks', () => {
    it('returns tasks for a context ordered by createdAt DESC', () => {
      const t1 = queue.enqueue('ctx-1', 'first');
      const t2 = queue.enqueue('ctx-1', 'second');
      queue.enqueue('ctx-2', 'other');

      // Ensure distinct timestamps for ordering
      queue['db'].prepare('UPDATE tasks SET createdAt = ? WHERE id = ?').run(1000, t1.id);
      queue['db'].prepare('UPDATE tasks SET createdAt = ? WHERE id = ?').run(2000, t2.id);

      const tasks = queue.getContextTasks('ctx-1');
      expect(tasks).toHaveLength(2);
      expect(tasks[0].prompt).toBe('second');
      expect(tasks[1].prompt).toBe('first');
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        queue.enqueue('ctx-1', `task ${i}`);
      }
      const tasks = queue.getContextTasks('ctx-1', 3);
      expect(tasks).toHaveLength(3);
    });
  });

  // ── expiry ──

  describe('expireStuckTasks', () => {
    it('expires tasks stuck in running for too long', () => {
      const task = queue.enqueue('ctx-1', 'will expire');
      queue.markRunning(task.id);

      // Manually backdate startedAt to simulate an old running task
      queue['db'].prepare(
        `UPDATE tasks SET startedAt = ? WHERE id = ?`
      ).run(Date.now() - 31 * 60 * 1000, task.id);

      const expired = queue.expireStuckTasks();
      expect(expired).toBe(1);

      const updated = queue.getTask(task.id)!;
      expect(updated.status).toBe('failed');
      expect(updated.error).toContain('expired');
      expect(updated.completedAt).toBeGreaterThan(0);
    });

    it('does not expire recently started tasks', () => {
      const task = queue.enqueue('ctx-1', 'still running');
      queue.markRunning(task.id);

      const expired = queue.expireStuckTasks();
      expect(expired).toBe(0);

      const updated = queue.getTask(task.id)!;
      expect(updated.status).toBe('running');
    });

    it('supports custom maxAgeMs', () => {
      const task = queue.enqueue('ctx-1', 'short timeout');
      queue.markRunning(task.id);

      // Backdate to 2 seconds ago
      queue['db'].prepare(
        `UPDATE tasks SET startedAt = ? WHERE id = ?`
      ).run(Date.now() - 2000, task.id);

      // 1 second threshold - should expire
      const expired = queue.expireStuckTasks(1000);
      expect(expired).toBe(1);
    });

    it('does not expire queued or completed tasks', () => {
      const queued = queue.enqueue('ctx-1', 'queued');
      const completed = queue.enqueue('ctx-1', 'completed');
      queue.markRunning(completed.id);
      queue.markCompleted(completed.id, 'result');

      // Backdate everything
      queue['db'].prepare(
        `UPDATE tasks SET createdAt = ?, startedAt = ?, completedAt = ? WHERE id IN (?, ?)`
      ).run(0, 0, 0, queued.id, completed.id);

      const expired = queue.expireStuckTasks(1);
      expect(expired).toBe(0);
    });
  });

  // ── listAll ──

  describe('listAll', () => {
    it('returns all tasks ordered by createdAt DESC', () => {
      const t1 = queue.enqueue('ctx-1', 'first');
      const t2 = queue.enqueue('ctx-2', 'second');
      const t3 = queue.enqueue('ctx-1', 'third');

      // Ensure distinct timestamps for ordering
      queue['db'].prepare('UPDATE tasks SET createdAt = ? WHERE id = ?').run(1000, t1.id);
      queue['db'].prepare('UPDATE tasks SET createdAt = ? WHERE id = ?').run(2000, t2.id);
      queue['db'].prepare('UPDATE tasks SET createdAt = ? WHERE id = ?').run(3000, t3.id);

      const all = queue.listAll();
      expect(all).toHaveLength(3);
      expect(all[0].prompt).toBe('third');
      expect(all[2].prompt).toBe('first');
    });

    it('supports pagination with limit and offset', () => {
      for (let i = 0; i < 10; i++) {
        queue.enqueue('ctx-1', `task ${i}`);
      }

      const page1 = queue.listAll(3, 0);
      const page2 = queue.listAll(3, 3);

      expect(page1).toHaveLength(3);
      expect(page2).toHaveLength(3);
      // No overlap
      const ids1 = page1.map(t => t.id);
      const ids2 = page2.map(t => t.id);
      expect(ids1.filter(id => ids2.includes(id))).toHaveLength(0);
    });

    it('returns empty array when offset exceeds count', () => {
      queue.enqueue('ctx-1', 'only one');
      const result = queue.listAll(10, 100);
      expect(result).toHaveLength(0);
    });
  });

  // ── stats ──

  describe('stats', () => {
    it('returns zero counts for empty queue', () => {
      const s = queue.stats();
      expect(s.counts).toEqual({ queued: 0, running: 0, completed: 0, failed: 0 });
      expect(s.oldestQueuedAge).toBeNull();
    });

    it('counts tasks by status', () => {
      queue.enqueue('ctx-1', 'q1');
      queue.enqueue('ctx-1', 'q2');
      const t3 = queue.enqueue('ctx-1', 'running');
      queue.markRunning(t3.id);
      const t4 = queue.enqueue('ctx-1', 'done');
      queue.markRunning(t4.id);
      queue.markCompleted(t4.id, 'ok');
      const t5 = queue.enqueue('ctx-1', 'err');
      queue.markRunning(t5.id);
      queue.markFailed(t5.id, 'fail');

      const s = queue.stats();
      expect(s.counts.queued).toBe(2);
      expect(s.counts.running).toBe(1);
      expect(s.counts.completed).toBe(1);
      expect(s.counts.failed).toBe(1);
    });

    it('reports oldest queued age', () => {
      queue.enqueue('ctx-1', 'old task');
      // Backdate
      queue['db'].prepare(
        `UPDATE tasks SET createdAt = ? WHERE status = 'queued'`
      ).run(Date.now() - 60_000);

      const s = queue.stats();
      expect(s.oldestQueuedAge).not.toBeNull();
      expect(s.oldestQueuedAge!).toBeGreaterThanOrEqual(59_000);
    });
  });

  // ── cleanup ──

  describe('cleanup', () => {
    it('deletes old completed tasks', () => {
      const task = queue.enqueue('ctx-1', 'old done');
      queue.markRunning(task.id);
      queue.markCompleted(task.id, 'result');

      // Backdate completedAt
      queue['db'].prepare(
        `UPDATE tasks SET completedAt = ? WHERE id = ?`
      ).run(Date.now() - 2 * 60 * 60 * 1000, task.id);

      const removed = queue.cleanup(1 * 60 * 60 * 1000); // 1 hour
      expect(removed).toBe(1);
      expect(queue.getTask(task.id)).toBeNull();
    });

    it('deletes old failed tasks', () => {
      const task = queue.enqueue('ctx-1', 'old fail');
      queue.markRunning(task.id);
      queue.markFailed(task.id, 'error');

      queue['db'].prepare(
        `UPDATE tasks SET completedAt = ? WHERE id = ?`
      ).run(Date.now() - 2 * 60 * 60 * 1000, task.id);

      const removed = queue.cleanup(1 * 60 * 60 * 1000);
      expect(removed).toBe(1);
    });

    it('does not delete recent tasks', () => {
      const task = queue.enqueue('ctx-1', 'recent');
      queue.markRunning(task.id);
      queue.markCompleted(task.id, 'result');

      const removed = queue.cleanup(1 * 60 * 60 * 1000);
      expect(removed).toBe(0);
      expect(queue.getTask(task.id)).not.toBeNull();
    });

    it('does not delete queued or running tasks', () => {
      queue.enqueue('ctx-1', 'queued');
      const running = queue.enqueue('ctx-1', 'running');
      queue.markRunning(running.id);

      const removed = queue.cleanup(0); // 0 ms = everything older than now
      expect(removed).toBe(0);
    });
  });

  // ── concurrent operations ──

  describe('concurrent operations', () => {
    it('handles multiple contexts with interleaved operations', () => {
      const t1 = queue.enqueue('ctx-a', 'a-task');
      const t2 = queue.enqueue('ctx-b', 'b-task');
      const t3 = queue.enqueue('ctx-a', 'a-task-2');

      queue.markRunning(t1.id);
      queue.markCompleted(t1.id, 'a-result');

      // ctx-a should return t3 next
      const nextA = queue.nextForContext('ctx-a');
      expect(nextA!.id).toBe(t3.id);

      // ctx-b should return t2
      const nextB = queue.nextForContext('ctx-b');
      expect(nextB!.id).toBe(t2.id);
    });

    it('getTask returns null for nonexistent ID', () => {
      expect(queue.getTask('nonexistent-id')).toBeNull();
    });

    it('handles rapid enqueue and dequeue cycles', () => {
      const ids: string[] = [];
      for (let i = 0; i < 100; i++) {
        const task = queue.enqueue('ctx-1', `task-${i}`);
        ids.push(task.id);
      }

      // Dequeue all
      for (const id of ids) {
        queue.markRunning(id);
        queue.markCompleted(id, 'done');
      }

      const s = queue.stats();
      expect(s.counts.queued).toBe(0);
      expect(s.counts.completed).toBe(100);
    });
  });
});
