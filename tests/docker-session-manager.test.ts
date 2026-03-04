import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DockerSessionManager } from '../src/docker-session-manager.js';
import { ContextManager } from '../src/context.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync, spawn, type ChildProcess } from 'child_process';

// Mock child_process
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execSync: vi.fn(),
    spawn: vi.fn(),
  };
});

const mockExecSync = vi.mocked(execSync);
const mockSpawn = vi.mocked(spawn);

let tmpDir: string;
let contextManager: ContextManager;
let dockerManager: DockerSessionManager;

/**
 * Create a mock child process that writes given stdout and exits with given code.
 */
function createMockChildProcess(
  stdoutData: string,
  stderrData = '',
  exitCode = 0,
): Partial<ChildProcess> {
  const stdout = new (require('stream').Readable)();
  stdout._read = () => {};
  const stderr = new (require('stream').Readable)();
  stderr._read = () => {};
  const stdin = new (require('stream').Writable)();
  stdin._write = (_chunk: any, _enc: string, cb: () => void) => cb();

  const child: any = {
    stdout,
    stderr,
    stdin,
    kill: vi.fn(),
    on: vi.fn((event: string, cb: (...args: any[]) => void) => {
      if (event === 'close') {
        // Schedule the close event after data
        setTimeout(() => {
          stdout.push(stdoutData);
          stdout.push(null);
          stderr.push(stderrData);
          stderr.push(null);
          setTimeout(() => cb(exitCode), 5);
        }, 5);
      }
      return child;
    }),
    pid: 12345,
  };

  return child;
}

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-session-test-'));
  contextManager = new ContextManager(tmpDir);
  dockerManager = new DockerSessionManager(contextManager);

  // Default: all docker commands succeed (return string since encoding: 'utf-8' is used)
  mockExecSync.mockReturnValue('container-id-123\n');
});

afterEach(() => {
  dockerManager.killAll();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('DockerSessionManager', () => {
  // ── constructor ──

  describe('constructor', () => {
    it('uses default max concurrent of 5', () => {
      expect(dockerManager.getMaxConcurrent()).toBe(5);
    });

    it('accepts custom max concurrent', () => {
      const mgr = new DockerSessionManager(contextManager, 3);
      expect(mgr.getMaxConcurrent()).toBe(3);
      mgr.killAll();
    });

    it('starts with no running sessions', () => {
      expect(dockerManager.getRunningCount()).toBe(0);
      expect(dockerManager.getRunningContexts().size).toBe(0);
    });
  });

  // ── isDockerAvailable ──

  describe('isDockerAvailable', () => {
    it('returns true when docker info succeeds', () => {
      mockExecSync.mockReturnValueOnce('');
      expect(DockerSessionManager.isDockerAvailable()).toBe(true);
    });

    it('returns false when docker info fails', () => {
      mockExecSync.mockImplementationOnce(() => {
        throw new Error('docker not found');
      });
      expect(DockerSessionManager.isDockerAvailable()).toBe(false);
    });
  });

  // ── container lifecycle ──

  describe('container lifecycle', () => {
    it('starts a Docker container when executing a task', async () => {
      contextManager.create('test-ctx');

      const workerOutput = JSON.stringify({ result: 'Hello from container!', sessionId: 'sess-1' });
      mockSpawn.mockReturnValue(createMockChildProcess(workerOutput + '\n') as any);

      const result = await dockerManager.executeTask('test-ctx', 'Say hello', 'task-1');
      expect(result).toBe('Hello from container!');

      // Verify docker run was called
      const runCalls = mockExecSync.mock.calls.filter(
        call => typeof call[0] === 'string' && call[0].includes('docker run'),
      );
      expect(runCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('mounts context directory as /workspace volume', async () => {
      contextManager.create('test-ctx');

      const workerOutput = JSON.stringify({ result: 'ok' });
      mockSpawn.mockReturnValue(createMockChildProcess(workerOutput + '\n') as any);

      await dockerManager.executeTask('test-ctx', 'test', 'task-1');

      // Find the docker run call
      const runCall = mockExecSync.mock.calls.find(
        call => typeof call[0] === 'string' && call[0].includes('docker run'),
      );
      expect(runCall).toBeDefined();
      const cmd = runCall![0] as string;

      // Check that volume mount includes context path and /workspace
      expect(cmd).toContain('/workspace');
      expect(cmd).toContain('-v');
    });

    it('uses read-only filesystem with tmpfs', async () => {
      contextManager.create('test-ctx');

      const workerOutput = JSON.stringify({ result: 'ok' });
      mockSpawn.mockReturnValue(createMockChildProcess(workerOutput + '\n') as any);

      await dockerManager.executeTask('test-ctx', 'test', 'task-1');

      const runCall = mockExecSync.mock.calls.find(
        call => typeof call[0] === 'string' && call[0].includes('docker run'),
      );
      const cmd = runCall![0] as string;
      expect(cmd).toContain('--read-only');
      expect(cmd).toContain('--tmpfs');
    });

    it('uses network none for isolation', async () => {
      contextManager.create('test-ctx');

      const workerOutput = JSON.stringify({ result: 'ok' });
      mockSpawn.mockReturnValue(createMockChildProcess(workerOutput + '\n') as any);

      await dockerManager.executeTask('test-ctx', 'test', 'task-1');

      const runCall = mockExecSync.mock.calls.find(
        call => typeof call[0] === 'string' && call[0].includes('docker run'),
      );
      const cmd = runCall![0] as string;
      expect(cmd).toContain('--network');
      expect(cmd).toContain('none');
    });

    it('reuses warm container for sequential tasks', async () => {
      contextManager.create('test-ctx');

      // First task
      const output1 = JSON.stringify({ result: 'first', sessionId: 'sess-1' });
      mockSpawn.mockReturnValueOnce(createMockChildProcess(output1 + '\n') as any);

      // Make isContainerRunning return true for the reuse check
      mockExecSync.mockImplementation((cmd: any) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('docker inspect')) {
          return 'true\n';
        }
        if (cmdStr.includes('docker rm -f')) {
          return '';
        }
        return 'container-id-123\n';
      });

      await dockerManager.executeTask('test-ctx', 'first', 'task-1');

      // Second task - should reuse container (no new docker run)
      const output2 = JSON.stringify({ result: 'second', sessionId: 'sess-1' });
      mockSpawn.mockReturnValueOnce(createMockChildProcess(output2 + '\n') as any);

      const runCallsBefore = mockExecSync.mock.calls.filter(
        call => typeof call[0] === 'string' && String(call[0]).includes('docker run'),
      ).length;

      const result = await dockerManager.executeTask('test-ctx', 'second', 'task-2');
      expect(result).toBe('second');

      // No additional docker run call because container was reused
      const runCallsAfter = mockExecSync.mock.calls.filter(
        call => typeof call[0] === 'string' && String(call[0]).includes('docker run'),
      ).length;
      expect(runCallsAfter).toBe(runCallsBefore);
    });

    it('stops container on killSession', async () => {
      contextManager.create('test-ctx');

      const workerOutput = JSON.stringify({ result: 'ok' });
      mockSpawn.mockReturnValue(createMockChildProcess(workerOutput + '\n') as any);

      await dockerManager.executeTask('test-ctx', 'hello', 'task-1');
      expect(dockerManager.isAlive('test-ctx')).toBe(true);

      dockerManager.killSession('test-ctx');
      expect(dockerManager.isAlive('test-ctx')).toBe(false);

      // Verify docker rm -f was called
      const rmCalls = mockExecSync.mock.calls.filter(
        call => typeof call[0] === 'string' && String(call[0]).includes('docker rm -f'),
      );
      expect(rmCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('stops all containers on killAll', async () => {
      contextManager.create('ctx-1');
      contextManager.create('ctx-2');

      const output = JSON.stringify({ result: 'ok' });
      mockSpawn
        .mockReturnValueOnce(createMockChildProcess(output + '\n') as any)
        .mockReturnValueOnce(createMockChildProcess(output + '\n') as any);

      await dockerManager.executeTask('ctx-1', 'hello', 'task-1');
      await dockerManager.executeTask('ctx-2', 'hello', 'task-2');

      expect(dockerManager.isAlive('ctx-1')).toBe(true);
      expect(dockerManager.isAlive('ctx-2')).toBe(true);

      dockerManager.killAll();

      expect(dockerManager.isAlive('ctx-1')).toBe(false);
      expect(dockerManager.isAlive('ctx-2')).toBe(false);
    });
  });

  // ── container auto-stop on idle ──

  describe('container auto-stop on idle', () => {
    it('container expires after idle timeout', async () => {
      contextManager.create('test-ctx', undefined, { idleTimeoutMs: 30 });

      const workerOutput = JSON.stringify({ result: 'ok' });
      mockSpawn.mockReturnValue(createMockChildProcess(workerOutput + '\n') as any);

      await dockerManager.executeTask('test-ctx', 'hello', 'task-1');
      expect(dockerManager.isAlive('test-ctx')).toBe(true);

      await new Promise(r => setTimeout(r, 80));
      expect(dockerManager.isAlive('test-ctx')).toBe(false);
    });

    it('emits session:expired event on idle timeout', async () => {
      contextManager.create('test-ctx', undefined, { idleTimeoutMs: 30 });

      const workerOutput = JSON.stringify({ result: 'ok' });
      mockSpawn.mockReturnValue(createMockChildProcess(workerOutput + '\n') as any);

      const events: any[] = [];
      dockerManager.on('session:expired', (contextId) => events.push(contextId));

      await dockerManager.executeTask('test-ctx', 'hello', 'task-1');

      await new Promise(r => setTimeout(r, 80));
      expect(events).toHaveLength(1);
      expect(events[0]).toBe('test-ctx');
    });
  });

  // ── filesystem isolation ──

  describe('filesystem isolation', () => {
    it('container name follows naming convention', async () => {
      contextManager.create('my-context');

      const workerOutput = JSON.stringify({ result: 'ok' });
      mockSpawn.mockReturnValue(createMockChildProcess(workerOutput + '\n') as any);

      await dockerManager.executeTask('my-context', 'test', 'task-1');

      const runCall = mockExecSync.mock.calls.find(
        call => typeof call[0] === 'string' && String(call[0]).includes('docker run'),
      );
      const cmd = runCall![0] as string;
      expect(cmd).toContain('claude-ctx-my-context');
    });

    it('applies no-new-privileges security option', async () => {
      contextManager.create('test-ctx');

      const workerOutput = JSON.stringify({ result: 'ok' });
      mockSpawn.mockReturnValue(createMockChildProcess(workerOutput + '\n') as any);

      await dockerManager.executeTask('test-ctx', 'test', 'task-1');

      const runCall = mockExecSync.mock.calls.find(
        call => typeof call[0] === 'string' && String(call[0]).includes('docker run'),
      );
      const cmd = runCall![0] as string;
      expect(cmd).toContain('no-new-privileges');
    });
  });

  // ── concurrent task limits ──

  describe('max concurrent sessions', () => {
    it('rejects when max concurrent reached', async () => {
      const mgr = new DockerSessionManager(contextManager, 2);
      contextManager.create('ctx-1');
      contextManager.create('ctx-2');
      contextManager.create('ctx-3');

      // Create mock child processes that never close
      function createHangingChild(): Partial<ChildProcess> {
        const stdout = new (require('stream').Readable)();
        stdout._read = () => {};
        const stderr = new (require('stream').Readable)();
        stderr._read = () => {};
        const stdin = new (require('stream').Writable)();
        stdin._write = (_chunk: any, _enc: string, cb: () => void) => cb();

        const handlers: Record<string, ((...args: any[]) => void)[]> = {};
        const child: any = {
          stdout, stderr, stdin,
          kill: vi.fn(() => {
            // Trigger close on kill
            (handlers['close'] || []).forEach(cb => cb(1));
          }),
          on: vi.fn((event: string, cb: (...args: any[]) => void) => {
            if (!handlers[event]) handlers[event] = [];
            handlers[event].push(cb);
            return child;
          }),
          pid: Math.random() * 10000,
        };
        return child;
      }

      mockSpawn
        .mockReturnValueOnce(createHangingChild() as any)
        .mockReturnValueOnce(createHangingChild() as any);

      const t1 = mgr.executeTask('ctx-1', 'task 1', 'task-1');
      const t2 = mgr.executeTask('ctx-2', 'task 2', 'task-2');
      await new Promise(r => setTimeout(r, 10));

      expect(mgr.getRunningCount()).toBe(2);

      await expect(
        mgr.executeTask('ctx-3', 'task 3', 'task-3'),
      ).rejects.toThrow('Max concurrent sessions reached (2)');

      mgr.killAll();
      await Promise.allSettled([t1, t2]);
    });

    it('rejects second task for same context', async () => {
      contextManager.create('test-ctx');

      function createHangingChild(): Partial<ChildProcess> {
        const stdout = new (require('stream').Readable)();
        stdout._read = () => {};
        const stderr = new (require('stream').Readable)();
        stderr._read = () => {};
        const stdin = new (require('stream').Writable)();
        stdin._write = (_chunk: any, _enc: string, cb: () => void) => cb();

        const handlers: Record<string, ((...args: any[]) => void)[]> = {};
        const child: any = {
          stdout, stderr, stdin,
          kill: vi.fn(() => {
            (handlers['close'] || []).forEach(cb => cb(1));
          }),
          on: vi.fn((event: string, cb: (...args: any[]) => void) => {
            if (!handlers[event]) handlers[event] = [];
            handlers[event].push(cb);
            return child;
          }),
          pid: 12345,
        };
        return child;
      }

      mockSpawn.mockReturnValue(createHangingChild() as any);

      const t1 = dockerManager.executeTask('test-ctx', 'first', 'task-1');
      await new Promise(r => setTimeout(r, 10));

      await expect(
        dockerManager.executeTask('test-ctx', 'second', 'task-2'),
      ).rejects.toThrow("Context 'test-ctx' is already running a task");

      dockerManager.killAll();
      await Promise.allSettled([t1]);
    });
  });

  // ── events ──

  describe('events', () => {
    it('emits task:start event', async () => {
      contextManager.create('test-ctx');
      const output = JSON.stringify({ result: 'ok' });
      mockSpawn.mockReturnValue(createMockChildProcess(output + '\n') as any);

      const events: any[] = [];
      dockerManager.on('task:start', (data) => events.push(data));

      await dockerManager.executeTask('test-ctx', 'hello', 'task-1');

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ contextId: 'test-ctx', taskId: 'task-1' });
    });

    it('emits task:complete event on success', async () => {
      contextManager.create('test-ctx');
      const output = JSON.stringify({ result: 'done!' });
      mockSpawn.mockReturnValue(createMockChildProcess(output + '\n') as any);

      const events: any[] = [];
      dockerManager.on('task:complete', (data) => events.push(data));

      await dockerManager.executeTask('test-ctx', 'hello', 'task-1');

      expect(events).toHaveLength(1);
      expect(events[0].contextId).toBe('test-ctx');
      expect(events[0].taskId).toBe('task-1');
      expect(events[0].result).toBe('done!');
    });

    it('emits task:failed event on error', async () => {
      contextManager.create('test-ctx');
      const output = JSON.stringify({ error: 'something broke' });
      mockSpawn.mockReturnValue(createMockChildProcess(output + '\n') as any);

      const events: any[] = [];
      dockerManager.on('task:failed', (data) => events.push(data));

      await expect(
        dockerManager.executeTask('test-ctx', 'hello', 'task-1'),
      ).rejects.toThrow('something broke');

      expect(events).toHaveLength(1);
      expect(events[0].contextId).toBe('test-ctx');
      expect(events[0].taskId).toBe('task-1');
    });

    it('emits session:created event', async () => {
      contextManager.create('test-ctx');
      const output = JSON.stringify({ result: 'ok' });
      mockSpawn.mockReturnValue(createMockChildProcess(output + '\n') as any);

      const events: any[] = [];
      dockerManager.on('session:created', (data) => events.push(data));

      await dockerManager.executeTask('test-ctx', 'hello', 'task-1');

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ contextId: 'test-ctx' });
    });
  });

  // ── session resume ──

  describe('session resume', () => {
    it('stores session ID from first run', async () => {
      contextManager.create('test-ctx');
      const output = JSON.stringify({ result: 'ok', sessionId: 'sess-abc' });
      mockSpawn.mockReturnValue(createMockChildProcess(output + '\n') as any);

      await dockerManager.executeTask('test-ctx', 'first', 'task-1');
      expect(dockerManager.isAlive('test-ctx')).toBe(true);
    });

    it('passes resume session ID in worker input for subsequent tasks', async () => {
      contextManager.create('test-ctx');

      // First task - sets session ID
      const output1 = JSON.stringify({ result: 'ok', sessionId: 'sess-abc' });
      mockSpawn.mockReturnValueOnce(createMockChildProcess(output1 + '\n') as any);

      // Make container appear running for reuse
      mockExecSync.mockImplementation((cmd: any) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('docker inspect')) return 'true\n';
        if (cmdStr.includes('docker rm -f')) return '';
        return 'container-id-123\n';
      });

      await dockerManager.executeTask('test-ctx', 'first', 'task-1');

      // Second task - should include resume
      let capturedInput: any;
      const secondChild = createMockChildProcess('') as any;
      const originalWrite = secondChild.stdin._write;
      secondChild.stdin._write = (chunk: any, enc: string, cb: () => void) => {
        capturedInput = JSON.parse(chunk.toString());
        originalWrite.call(secondChild.stdin, chunk, enc, cb);
      };

      // Override the child's on handler to emit output after we capture input
      const output2 = JSON.stringify({ result: 'ok2', sessionId: 'sess-abc' });
      const handlers: Record<string, ((...args: any[]) => void)[]> = {};
      secondChild.on = vi.fn((event: string, cb: (...args: any[]) => void) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(cb);
        if (event === 'close') {
          setTimeout(() => {
            secondChild.stdout.push(output2 + '\n');
            secondChild.stdout.push(null);
            secondChild.stderr.push(null);
            setTimeout(() => cb(0), 5);
          }, 10);
        }
        return secondChild;
      });

      mockSpawn.mockReturnValueOnce(secondChild as any);

      await dockerManager.executeTask('test-ctx', 'second', 'task-2');

      expect(capturedInput).toBeDefined();
      expect(capturedInput.resume).toBe('sess-abc');
    });
  });

  // ── error handling ──

  describe('error handling', () => {
    it('cleans up running state after worker error', async () => {
      contextManager.create('test-ctx');
      const output = JSON.stringify({ error: 'worker crashed' });
      mockSpawn.mockReturnValue(createMockChildProcess(output + '\n') as any);

      await expect(
        dockerManager.executeTask('test-ctx', 'hello', 'task-1'),
      ).rejects.toThrow('worker crashed');

      expect(dockerManager.isRunning('test-ctx')).toBe(false);
      expect(dockerManager.getRunningCount()).toBe(0);
    });

    it('cleans up running state after spawn error', async () => {
      contextManager.create('test-ctx');

      const child = createMockChildProcess('') as any;
      child.on = vi.fn((event: string, cb: (...args: any[]) => void) => {
        if (event === 'error') {
          setTimeout(() => cb(new Error('spawn failed')), 5);
        }
        return child;
      });
      mockSpawn.mockReturnValue(child as any);

      await expect(
        dockerManager.executeTask('test-ctx', 'hello', 'task-1'),
      ).rejects.toThrow('spawn failed');

      expect(dockerManager.isRunning('test-ctx')).toBe(false);
    });

    it('handles worker non-zero exit code', async () => {
      contextManager.create('test-ctx');
      mockSpawn.mockReturnValue(
        createMockChildProcess('', 'segfault', 139) as any,
      );

      await expect(
        dockerManager.executeTask('test-ctx', 'hello', 'task-1'),
      ).rejects.toThrow(/Worker exited with code 139/);

      expect(dockerManager.isRunning('test-ctx')).toBe(false);
    });
  });

  // ── history ──

  describe('history', () => {
    it('saves user prompt and assistant result to history', async () => {
      contextManager.create('test-ctx');
      const output = JSON.stringify({ result: 'The answer is 42' });
      mockSpawn.mockReturnValue(createMockChildProcess(output + '\n') as any);

      await dockerManager.executeTask('test-ctx', 'What is the meaning of life?', 'task-1');

      const { HistoryManager } = await import('../src/history.js');
      const history = new HistoryManager(contextManager.contextPath('test-ctx'));
      const turns = history.getRecent(10);

      expect(turns).toHaveLength(2);
      expect(turns[0].role).toBe('user');
      expect(turns[0].content).toBe('What is the meaning of life?');
      expect(turns[1].role).toBe('assistant');
      expect(turns[1].content).toBe('The answer is 42');
    });
  });

  // ── abortAll ──

  describe('abortAll', () => {
    it('aborts all running tasks and cleans up', async () => {
      contextManager.create('test-ctx');
      const output = JSON.stringify({ result: 'ok' });
      mockSpawn.mockReturnValue(createMockChildProcess(output + '\n') as any);

      await dockerManager.executeTask('test-ctx', 'hello', 'task-1');
      dockerManager.abortAll();

      expect(dockerManager.isAlive('test-ctx')).toBe(false);
    });
  });
});
