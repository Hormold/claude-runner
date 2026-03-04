import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ContextManager } from '../src/context.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

let mgr: ContextManager;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-test-'));
  mgr = new ContextManager(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ContextManager', () => {
  // ── contextId validation ──

  describe('contextId validation', () => {
    it('accepts valid alphanumeric IDs', () => {
      expect(() => mgr.contextPath('my-context')).not.toThrow();
      expect(() => mgr.contextPath('ctx_123')).not.toThrow();
      expect(() => mgr.contextPath('A')).not.toThrow();
      expect(() => mgr.contextPath('a'.repeat(64))).not.toThrow();
    });

    it('rejects empty string', () => {
      expect(() => mgr.contextPath('')).toThrow(/Invalid contextId/);
    });

    it('rejects IDs longer than 64 chars', () => {
      expect(() => mgr.contextPath('a'.repeat(65))).toThrow(/Invalid contextId/);
    });

    it('rejects IDs with dots (path traversal)', () => {
      expect(() => mgr.contextPath('../etc')).toThrow(/Invalid contextId/);
      expect(() => mgr.contextPath('...')).toThrow(/Invalid contextId/);
    });

    it('rejects IDs with slashes', () => {
      expect(() => mgr.contextPath('foo/bar')).toThrow(/Invalid contextId/);
      expect(() => mgr.contextPath('foo\\bar')).toThrow(/Invalid contextId/);
    });

    it('rejects IDs with spaces or special characters', () => {
      expect(() => mgr.contextPath('has space')).toThrow(/Invalid contextId/);
      expect(() => mgr.contextPath('has@symbol')).toThrow(/Invalid contextId/);
      expect(() => mgr.contextPath('has$dollar')).toThrow(/Invalid contextId/);
    });
  });

  // ── create ──

  describe('create', () => {
    it('creates a context with default files', () => {
      const dir = mgr.create('test-ctx');
      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.existsSync(path.join(dir, 'AGENTS.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'MEMORY.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'tools'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'data'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'history'))).toBe(true);
    });

    it('uses default AGENTS.md content when none provided', () => {
      const dir = mgr.create('test-ctx');
      const content = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8');
      expect(content).toContain('# Agent');
    });

    it('uses custom AGENTS.md when provided', () => {
      const custom = '# Custom Agent\nDo custom things.';
      const dir = mgr.create('test-ctx', custom);
      const content = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8');
      expect(content).toBe(custom);
    });

    it('merges custom config with defaults', () => {
      mgr.create('test-ctx', undefined, { maxTurns: 10 });
      const config = mgr.getConfig('test-ctx');
      expect(config.maxTurns).toBe(10);
      expect(config.model).toBeDefined(); // from defaults
    });

    it('validates config on create', () => {
      expect(() =>
        mgr.create('test-ctx', undefined, { maxTurns: -5 } as any),
      ).toThrow();
    });

    it('throws if context already exists', () => {
      mgr.create('test-ctx');
      expect(() => mgr.create('test-ctx')).toThrow(/already exists/);
    });

    it('rejects invalid context IDs on create', () => {
      expect(() => mgr.create('../bad')).toThrow(/Invalid contextId/);
    });
  });

  // ── create from template ──

  describe('create from template', () => {
    beforeEach(() => {
      // Set up a _template directory
      const tplDir = path.join(tmpDir, '_template');
      fs.mkdirSync(tplDir, { recursive: true });
      fs.mkdirSync(path.join(tplDir, 'tools'), { recursive: true });
      fs.mkdirSync(path.join(tplDir, 'data'), { recursive: true });
      fs.mkdirSync(path.join(tplDir, 'history'), { recursive: true });
      fs.writeFileSync(path.join(tplDir, 'AGENTS.md'), '# Template Agent\nFrom template.', 'utf-8');
      fs.writeFileSync(path.join(tplDir, 'MEMORY.md'), '# Template Memory', 'utf-8');
      fs.writeFileSync(
        path.join(tplDir, 'config.json'),
        JSON.stringify({ model: 'claude-opus-4-20250514', maxTurns: 100 }),
        'utf-8',
      );
      fs.writeFileSync(path.join(tplDir, 'tools', 'helper.sh'), '#!/bin/bash\necho hi', 'utf-8');
    });

    it('clones template directory structure', () => {
      const dir = mgr.create('from-tpl');
      expect(fs.existsSync(path.join(dir, 'tools', 'helper.sh'))).toBe(true);
      const helperContent = fs.readFileSync(path.join(dir, 'tools', 'helper.sh'), 'utf-8');
      expect(helperContent).toContain('echo hi');
    });

    it('uses template AGENTS.md when no custom one provided', () => {
      const dir = mgr.create('from-tpl');
      const content = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8');
      expect(content).toContain('# Template Agent');
    });

    it('overrides template AGENTS.md when custom one provided', () => {
      const dir = mgr.create('from-tpl', '# My Custom Agent');
      const content = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8');
      expect(content).toBe('# My Custom Agent');
    });

    it('merges template config with defaults and overrides', () => {
      mgr.create('from-tpl', undefined, { historyWindow: 50 });
      const config = mgr.getConfig('from-tpl');
      expect(config.model).toBe('claude-opus-4-20250514'); // from template
      expect(config.maxTurns).toBe(100); // from template
      expect(config.historyWindow).toBe(50); // from override
    });

    it('uses template MEMORY.md', () => {
      const dir = mgr.create('from-tpl');
      const content = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf-8');
      expect(content).toBe('# Template Memory');
    });
  });

  // ── exists ──

  describe('exists', () => {
    it('returns false for nonexistent context', () => {
      expect(mgr.exists('nope')).toBe(false);
    });

    it('returns true after creating context', () => {
      mgr.create('test-ctx');
      expect(mgr.exists('test-ctx')).toBe(true);
    });
  });

  // ── getConfig ──

  describe('getConfig', () => {
    it('returns config for existing context', () => {
      mgr.create('test-ctx', undefined, { maxTurns: 25 });
      const config = mgr.getConfig('test-ctx');
      expect(config.maxTurns).toBe(25);
    });

    it('validates config read from disk', () => {
      const dir = mgr.create('test-ctx');
      // Write invalid config directly to disk
      fs.writeFileSync(
        path.join(dir, 'config.json'),
        JSON.stringify({ maxTurns: 'not-a-number' }),
        'utf-8',
      );
      expect(() => mgr.getConfig('test-ctx')).toThrow();
    });
  });

  // ── updateConfig ──

  describe('updateConfig', () => {
    it('merges partial config into existing', () => {
      mgr.create('test-ctx', undefined, { maxTurns: 10, historyWindow: 5 });
      const updated = mgr.updateConfig('test-ctx', { maxTurns: 20 });
      expect(updated.maxTurns).toBe(20);
      expect(updated.historyWindow).toBe(5); // unchanged
    });

    it('validates the merged config', () => {
      mgr.create('test-ctx');
      expect(() =>
        mgr.updateConfig('test-ctx', { maxTurns: -1 } as any),
      ).toThrow();
    });

    it('throws for nonexistent context', () => {
      expect(() =>
        mgr.updateConfig('nope', { maxTurns: 10 }),
      ).toThrow(/does not exist/);
    });

    it('persists updated config to disk', () => {
      mgr.create('test-ctx');
      mgr.updateConfig('test-ctx', { maxTurns: 99 });
      // Re-read from disk
      const config = mgr.getConfig('test-ctx');
      expect(config.maxTurns).toBe(99);
    });
  });

  // ── listFiles ──

  describe('listFiles', () => {
    it('lists all files in workspace', () => {
      mgr.create('test-ctx');
      const files = mgr.listFiles('test-ctx');
      expect(files).toContain('AGENTS.md');
      expect(files).toContain('MEMORY.md');
      expect(files).toContain('config.json');
    });

    it('includes nested files with relative paths', () => {
      const dir = mgr.create('test-ctx');
      fs.writeFileSync(path.join(dir, 'tools', 'script.sh'), 'echo test', 'utf-8');
      fs.writeFileSync(path.join(dir, 'data', 'input.txt'), 'data', 'utf-8');
      const files = mgr.listFiles('test-ctx');
      expect(files).toContain('tools/script.sh');
      expect(files).toContain('data/input.txt');
    });

    it('returns sorted file list', () => {
      mgr.create('test-ctx');
      const files = mgr.listFiles('test-ctx');
      const sorted = [...files].sort();
      expect(files).toEqual(sorted);
    });

    it('throws for nonexistent context', () => {
      expect(() => mgr.listFiles('nope')).toThrow(/does not exist/);
    });
  });

  // ── list ──

  describe('list', () => {
    it('returns empty array when no contexts', () => {
      expect(mgr.list()).toEqual([]);
    });

    it('lists created contexts', () => {
      mgr.create('ctx-a');
      mgr.create('ctx-b');
      const list = mgr.list();
      expect(list).toContain('ctx-a');
      expect(list).toContain('ctx-b');
    });

    it('excludes _template from listing', () => {
      // Create a template directory
      const tplDir = path.join(tmpDir, '_template');
      fs.mkdirSync(tplDir, { recursive: true });
      fs.writeFileSync(path.join(tplDir, 'config.json'), '{}', 'utf-8');

      mgr.create('real-ctx');
      const list = mgr.list();
      expect(list).toContain('real-ctx');
      expect(list).not.toContain('_template');
    });
  });

  // ── delete ──

  describe('delete', () => {
    it('removes context directory', () => {
      mgr.create('test-ctx');
      expect(mgr.exists('test-ctx')).toBe(true);
      mgr.delete('test-ctx');
      expect(mgr.exists('test-ctx')).toBe(false);
    });

    it('does not throw when deleting nonexistent context', () => {
      expect(() => mgr.delete('nonexistent')).not.toThrow();
    });

    it('removes all files recursively', () => {
      const dir = mgr.create('test-ctx');
      fs.writeFileSync(path.join(dir, 'data', 'file.txt'), 'content', 'utf-8');
      mgr.delete('test-ctx');
      expect(fs.existsSync(dir)).toBe(false);
    });
  });

  // ── getInfo ──

  describe('getInfo', () => {
    it('returns context info with timestamps', () => {
      mgr.create('test-ctx');
      const info = mgr.getInfo('test-ctx');
      expect(info.contextId).toBe('test-ctx');
      expect(info.createdAt).toBeGreaterThan(0);
      expect(info.lastActive).toBeGreaterThan(0);
      expect(info.sessionAlive).toBe(false);
      expect(info.config).toBeDefined();
    });

    it('reflects sessionAlive parameter', () => {
      mgr.create('test-ctx');
      const info = mgr.getInfo('test-ctx', true);
      expect(info.sessionAlive).toBe(true);
    });
  });

  // ── path traversal prevention ──

  describe('path traversal prevention', () => {
    it('rejects path traversal with ../', () => {
      expect(() => mgr.create('../escape')).toThrow(/Invalid contextId/);
    });

    it('rejects path traversal with embedded dots', () => {
      expect(() => mgr.contextPath('foo..bar')).toThrow(/Invalid contextId/);
    });

    it('rejects null bytes', () => {
      expect(() => mgr.contextPath('foo\0bar')).toThrow(/Invalid contextId/);
    });

    it('context path stays within base directory', () => {
      const ctxPath = mgr.contextPath('safe-id');
      expect(ctxPath.startsWith(tmpDir)).toBe(true);
    });
  });
});
