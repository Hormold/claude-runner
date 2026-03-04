import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { TaskQueue } from '../src/queue.js';
import { ContextManager } from '../src/context.js';
import { SessionManager } from '../src/session-manager.js';
import { createApp } from '../src/index.js';
import { main } from '../src/cli.js';

function createTestEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-'));
  const contextsDir = path.join(tmpDir, 'contexts');
  const dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(contextsDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const queue = new TaskQueue(dataDir);
  const contextManager = new ContextManager(contextsDir);
  const sessionManager = new SessionManager(contextManager);

  const { app } = createApp({ queue, contextManager, sessionManager });

  return { app, queue, contextManager, sessionManager, tmpDir };
}

function startServer(app: ReturnType<typeof createApp>['app']): Promise<{ server: http.Server; port: number }> {
  return new Promise(resolve => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

function stopServer(server: http.Server): Promise<void> {
  return new Promise(resolve => {
    server.close(() => resolve());
  });
}

describe('CLI', () => {
  let queue: TaskQueue;
  let contextManager: ContextManager;
  let tmpDir: string;
  let server: http.Server;
  let port: number;
  let savedEnv: Record<string, string | undefined>;
  let consoleLogs: string[];
  let consoleErrors: string[];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let originalExit: typeof process.exit;

  beforeEach(async () => {
    const s = createTestEnv();
    queue = s.queue;
    contextManager = s.contextManager;
    tmpDir = s.tmpDir;

    const started = await startServer(s.app);
    server = started.server;
    port = started.port;

    savedEnv = {
      CLAUDE_RUNNER_URL: process.env.CLAUDE_RUNNER_URL,
      CLAUDE_RUNNER_POLL_MS: process.env.CLAUDE_RUNNER_POLL_MS,
    };
    process.env.CLAUDE_RUNNER_URL = `http://localhost:${port}`;
    process.env.CLAUDE_RUNNER_POLL_MS = '100';

    consoleLogs = [];
    consoleErrors = [];
    originalLog = console.log;
    originalError = console.error;
    console.log = (...args: any[]) => consoleLogs.push(args.join(' '));
    console.error = (...args: any[]) => consoleErrors.push(args.join(' '));

    originalExit = process.exit;
    process.exit = vi.fn() as any;
  });

  afterEach(async () => {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;

    for (const [key, val] of Object.entries(savedEnv)) {
      if (val !== undefined) {
        process.env[key] = val;
      } else {
        delete process.env[key];
      }
    }

    await stopServer(server);
    queue.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('create command', () => {
    it('creates a context', async () => {
      await main(['create', 'test-ctx']);
      expect(consoleLogs.some(l => l.includes("'test-ctx' created"))).toBe(true);
      expect(contextManager.exists('test-ctx')).toBe(true);
    });

    it('creates a context with --agents-md file', async () => {
      const mdFile = path.join(tmpDir, 'agents.md');
      fs.writeFileSync(mdFile, '# Custom Agent\nYou are helpful.');

      await main(['create', 'test-md', '--agents-md', mdFile]);
      expect(consoleLogs.some(l => l.includes("'test-md' created"))).toBe(true);
      expect(contextManager.exists('test-md')).toBe(true);
    });

    it('creates a context with --config file', async () => {
      const configFile = path.join(tmpDir, 'config.json');
      fs.writeFileSync(configFile, JSON.stringify({ model: 'claude-sonnet-4-20250514' }));

      await main(['create', 'test-cfg', '--config', configFile]);
      expect(consoleLogs.some(l => l.includes("'test-cfg' created"))).toBe(true);

      const config = contextManager.getConfig('test-cfg');
      expect(config.model).toBe('claude-sonnet-4-20250514');
    });

    it('errors on duplicate context', async () => {
      contextManager.create('existing');
      await main(['create', 'existing']);
      expect(consoleErrors.some(e => e.includes('already exists'))).toBe(true);
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('shows error for missing contextId', async () => {
      await main(['create']);
      expect(consoleErrors.some(e => e.includes('Usage'))).toBe(true);
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('errors on missing agents-md file', async () => {
      await main(['create', 'test-no-file', '--agents-md', '/nonexistent/file.md']);
      expect(consoleErrors.some(e => e.includes('File not found'))).toBe(true);
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('errors on invalid config JSON', async () => {
      const badFile = path.join(tmpDir, 'bad.json');
      fs.writeFileSync(badFile, 'not json');

      await main(['create', 'test-bad', '--config', badFile]);
      expect(consoleErrors.some(e => e.includes('Invalid JSON'))).toBe(true);
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });

  describe('task command', () => {
    it('submits a task', async () => {
      contextManager.create('work-ctx');
      await main(['task', 'work-ctx', 'do', 'something']);
      expect(consoleLogs.some(l => l.includes('queued'))).toBe(true);
    });

    it('errors when context does not exist', async () => {
      await main(['task', 'no-ctx', 'hello']);
      expect(consoleErrors.some(e => e.includes('not found'))).toBe(true);
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('shows error for missing arguments', async () => {
      await main(['task']);
      expect(consoleErrors.some(e => e.includes('Usage'))).toBe(true);
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('submits a task with --webhook', async () => {
      contextManager.create('hook-ctx');
      await main(['task', 'hook-ctx', 'do thing', '--webhook', 'http://example.com/hook']);
      expect(consoleLogs.some(l => l.includes('queued'))).toBe(true);
    });
  });

  describe('status command', () => {
    it('shows task status', async () => {
      contextManager.create('s-ctx');
      const task = queue.enqueue('s-ctx', 'test prompt');

      await main(['status', task.id]);
      const output = consoleLogs.join('\n');
      expect(output).toContain(task.id);
      expect(output).toContain('queued');
    });

    it('errors on unknown task', async () => {
      await main(['status', 'nonexistent-id']);
      expect(consoleErrors.some(e => e.includes('not found'))).toBe(true);
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('shows error for missing taskId', async () => {
      await main(['status']);
      expect(consoleErrors.some(e => e.includes('Usage'))).toBe(true);
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });

  describe('contexts command', () => {
    it('lists contexts', async () => {
      contextManager.create('ctx-a');
      contextManager.create('ctx-b');

      await main(['contexts']);
      const output = consoleLogs.join('\n');
      expect(output).toContain('ctx-a');
      expect(output).toContain('ctx-b');
    });

    it('shows message when no contexts', async () => {
      await main(['contexts']);
      expect(consoleLogs.some(l => l.includes('No contexts'))).toBe(true);
    });
  });

  describe('delete command', () => {
    it('deletes a context', async () => {
      contextManager.create('del-ctx');
      await main(['delete', 'del-ctx']);
      expect(consoleLogs.some(l => l.includes("'del-ctx' deleted"))).toBe(true);
      expect(contextManager.exists('del-ctx')).toBe(false);
    });

    it('errors on nonexistent context', async () => {
      await main(['delete', 'ghost']);
      expect(consoleErrors.some(e => e.includes('not found'))).toBe(true);
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('shows error for missing contextId', async () => {
      await main(['delete']);
      expect(consoleErrors.some(e => e.includes('Usage'))).toBe(true);
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });

  describe('help and unknown commands', () => {
    it('shows usage with --help', async () => {
      await main(['--help']);
      expect(consoleLogs.some(l => l.includes('Usage: claude-runner'))).toBe(true);
    });

    it('shows usage with no arguments', async () => {
      await main([]);
      expect(consoleLogs.some(l => l.includes('Usage: claude-runner'))).toBe(true);
    });

    it('errors on unknown command', async () => {
      await main(['foobar']);
      expect(consoleErrors.some(e => e.includes('Unknown command: foobar'))).toBe(true);
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });

  describe('--wait flag', () => {
    it('polls until task completes', async () => {
      contextManager.create('wait-ctx');

      // Start the CLI task submit + wait in parallel
      const pollPromise = main(['task', 'wait-ctx', 'test prompt', '--wait']);

      // Wait a bit for the task to be submitted, then find and complete it
      await new Promise(r => setTimeout(r, 200));

      const allTasks = queue.listAll(10, 0);
      const cliTask = allTasks.find(t => t.prompt === 'test prompt');
      if (cliTask) {
        queue.markRunning(cliTask.id);
        queue.markCompleted(cliTask.id, 'Done waiting!');
      }

      await pollPromise;
      const output = consoleLogs.join('\n');
      expect(output).toContain('queued');
      expect(output).toContain('Task completed');
    });

    it('polls until task fails', async () => {
      contextManager.create('fail-ctx');

      const pollPromise = main(['task', 'fail-ctx', 'fail prompt', '--wait']);

      await new Promise(r => setTimeout(r, 200));

      const allTasks = queue.listAll(10, 0);
      const cliTask = allTasks.find(t => t.prompt === 'fail prompt');
      if (cliTask) {
        queue.markRunning(cliTask.id);
        queue.markFailed(cliTask.id, 'Something went wrong');
      }

      await pollPromise;
      const errors = consoleErrors.join('\n');
      expect(errors).toContain('failed');
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });
});
