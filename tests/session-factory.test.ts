import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ContextManager } from '../src/context.js';
import { SessionManager } from '../src/session-manager.js';
import { DockerSessionManager } from '../src/docker-session-manager.js';
import { createSessionManager, detectIsolationMode } from '../src/session-factory.js';
import type { ISessionManager } from '../src/session-interface.js';
import { parseConfig } from '../src/types.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Mock child_process for DockerSessionManager.isDockerAvailable
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execSync: vi.fn(),
    spawn: vi.fn(),
  };
});

import { execSync } from 'child_process';
const mockExecSync = vi.mocked(execSync);

let tmpDir: string;
let contextManager: ContextManager;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-test-'));
  contextManager = new ContextManager(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('session factory', () => {
  describe('detectIsolationMode', () => {
    it('returns "docker" when Docker is available', () => {
      mockExecSync.mockReturnValue('' as any);
      const mode = detectIsolationMode();
      expect(mode).toBe('docker');
    });

    it('returns "process" when Docker is not available', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('docker not found');
      });
      const mode = detectIsolationMode();
      expect(mode).toBe('process');
    });
  });

  describe('createSessionManager', () => {
    it('creates SessionManager for process mode', () => {
      const manager = createSessionManager(contextManager, 'process');
      expect(manager).toBeInstanceOf(SessionManager);
    });

    it('creates DockerSessionManager for docker mode', () => {
      const manager = createSessionManager(contextManager, 'docker');
      expect(manager).toBeInstanceOf(DockerSessionManager);
    });

    it('auto-detects docker mode when Docker is available', () => {
      mockExecSync.mockReturnValue('' as any);
      const manager = createSessionManager(contextManager);
      expect(manager).toBeInstanceOf(DockerSessionManager);
    });

    it('auto-detects process mode when Docker is not available', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('docker not found');
      });
      const manager = createSessionManager(contextManager);
      expect(manager).toBeInstanceOf(SessionManager);
    });

    it('passes maxConcurrent to process mode', () => {
      const manager = createSessionManager(contextManager, 'process', 10);
      expect(manager.getMaxConcurrent()).toBe(10);
    });

    it('passes maxConcurrent to docker mode', () => {
      const manager = createSessionManager(contextManager, 'docker', 10);
      expect(manager.getMaxConcurrent()).toBe(10);
    });
  });

  describe('ISessionManager interface', () => {
    it('SessionManager implements all required methods', () => {
      const manager: ISessionManager = new SessionManager(contextManager);
      expect(typeof manager.executeTask).toBe('function');
      expect(typeof manager.isRunning).toBe('function');
      expect(typeof manager.isAlive).toBe('function');
      expect(typeof manager.getRunningContexts).toBe('function');
      expect(typeof manager.getRunningCount).toBe('function');
      expect(typeof manager.getMaxConcurrent).toBe('function');
      expect(typeof manager.abortAll).toBe('function');
      expect(typeof manager.killSession).toBe('function');
      expect(typeof manager.killAll).toBe('function');
      expect(typeof manager.on).toBe('function');
      expect(typeof manager.emit).toBe('function');
    });

    it('DockerSessionManager implements all required methods', () => {
      const manager: ISessionManager = new DockerSessionManager(contextManager);
      expect(typeof manager.executeTask).toBe('function');
      expect(typeof manager.isRunning).toBe('function');
      expect(typeof manager.isAlive).toBe('function');
      expect(typeof manager.getRunningContexts).toBe('function');
      expect(typeof manager.getRunningCount).toBe('function');
      expect(typeof manager.getMaxConcurrent).toBe('function');
      expect(typeof manager.abortAll).toBe('function');
      expect(typeof manager.killSession).toBe('function');
      expect(typeof manager.killAll).toBe('function');
      expect(typeof manager.on).toBe('function');
      expect(typeof manager.emit).toBe('function');
    });

    it('both modes return consistent initial state', () => {
      const processManager: ISessionManager = new SessionManager(contextManager);
      const dockerManager: ISessionManager = new DockerSessionManager(contextManager);

      expect(processManager.getRunningCount()).toBe(0);
      expect(dockerManager.getRunningCount()).toBe(0);

      expect(processManager.getRunningContexts().size).toBe(0);
      expect(dockerManager.getRunningContexts().size).toBe(0);

      expect(processManager.isRunning('nonexistent')).toBe(false);
      expect(dockerManager.isRunning('nonexistent')).toBe(false);

      expect(processManager.isAlive('nonexistent')).toBe(false);
      expect(dockerManager.isAlive('nonexistent')).toBe(false);
    });
  });
});

describe('config.isolation field', () => {
  it('accepts "docker" isolation mode', () => {
    const config = parseConfig({ isolation: 'docker' });
    expect(config.isolation).toBe('docker');
  });

  it('accepts "process" isolation mode', () => {
    const config = parseConfig({ isolation: 'process' });
    expect(config.isolation).toBe('process');
  });

  it('accepts undefined isolation (optional field)', () => {
    const config = parseConfig({});
    expect(config.isolation).toBeUndefined();
  });

  it('rejects invalid isolation mode', () => {
    expect(() => parseConfig({ isolation: 'invalid' })).toThrow();
  });

  it('works alongside other config fields', () => {
    const config = parseConfig({
      isolation: 'docker',
      model: 'claude-sonnet-4-20250514',
      maxTurns: 10,
      network: 'none',
    });
    expect(config.isolation).toBe('docker');
    expect(config.model).toBe('claude-sonnet-4-20250514');
    expect(config.maxTurns).toBe(10);
    expect(config.network).toBe('none');
  });
});
