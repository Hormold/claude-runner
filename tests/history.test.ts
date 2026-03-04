import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HistoryManager, estimateTokens } from '../src/history.js';
import { HistoryTurn } from '../src/types.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

let mgr: HistoryManager;
let tmpDir: string;

function makeTurn(overrides: Partial<HistoryTurn> = {}): HistoryTurn {
  return {
    role: 'user',
    content: 'Hello world',
    timestamp: Date.now(),
    taskId: 'task-1',
    tokenEstimate: estimateTokens('Hello world'),
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-test-'));
  mgr = new HistoryManager(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('HistoryManager', () => {
  // ── estimateTokens ──

  describe('estimateTokens', () => {
    it('estimates tokens from text length', () => {
      expect(estimateTokens('')).toBe(0);
      expect(estimateTokens('abcd')).toBe(1);
      expect(estimateTokens('abcde')).toBe(2);
      expect(estimateTokens('a'.repeat(100))).toBe(25);
    });
  });

  // ── append ──

  describe('append', () => {
    it('creates history file on first append', () => {
      const turn = makeTurn();
      mgr.append(turn);
      const file = path.join(tmpDir, 'history', 'turns.jsonl');
      expect(fs.existsSync(file)).toBe(true);
    });

    it('appends multiple turns as JSONL', () => {
      mgr.append(makeTurn({ content: 'first' }));
      mgr.append(makeTurn({ content: 'second' }));
      mgr.append(makeTurn({ content: 'third' }));

      const file = path.join(tmpDir, 'history', 'turns.jsonl');
      const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(3);

      const parsed = lines.map(l => JSON.parse(l));
      expect(parsed[0].content).toBe('first');
      expect(parsed[1].content).toBe('second');
      expect(parsed[2].content).toBe('third');
    });

    it('stores all fields correctly', () => {
      const turn = makeTurn({
        role: 'assistant',
        content: 'I can help with that.',
        timestamp: 1700000000000,
        taskId: 'task-42',
        tokenEstimate: 6,
      });
      mgr.append(turn);

      const recent = mgr.getRecent(1);
      expect(recent[0]).toEqual(turn);
    });
  });

  // ── getRecent ──

  describe('getRecent', () => {
    it('returns empty array when no history', () => {
      expect(mgr.getRecent()).toEqual([]);
    });

    it('returns all turns when fewer than limit', () => {
      mgr.append(makeTurn({ content: 'a' }));
      mgr.append(makeTurn({ content: 'b' }));
      const recent = mgr.getRecent(10);
      expect(recent).toHaveLength(2);
    });

    it('returns only the most recent N turns', () => {
      for (let i = 0; i < 10; i++) {
        mgr.append(makeTurn({ content: `msg-${i}`, timestamp: 1000 + i }));
      }
      const recent = mgr.getRecent(3);
      expect(recent).toHaveLength(3);
      expect(recent[0].content).toBe('msg-7');
      expect(recent[1].content).toBe('msg-8');
      expect(recent[2].content).toBe('msg-9');
    });

    it('uses default limit of 20', () => {
      for (let i = 0; i < 30; i++) {
        mgr.append(makeTurn({ content: `msg-${i}` }));
      }
      const recent = mgr.getRecent();
      expect(recent).toHaveLength(20);
      expect(recent[0].content).toBe('msg-10');
    });
  });

  // ── formatForSdk ──

  describe('formatForSdk', () => {
    it('returns empty array when no history', () => {
      expect(mgr.formatForSdk()).toEqual([]);
    });

    it('formats turns as role/content pairs', () => {
      mgr.append(makeTurn({ role: 'user', content: 'Hello' }));
      mgr.append(makeTurn({ role: 'assistant', content: 'Hi there!' }));

      const formatted = mgr.formatForSdk();
      expect(formatted).toEqual([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ]);
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        mgr.append(makeTurn({ content: `msg-${i}` }));
      }
      const formatted = mgr.formatForSdk(2);
      expect(formatted).toHaveLength(2);
    });
  });

  // ── formatForPrompt ──

  describe('formatForPrompt', () => {
    it('returns empty string when no history', () => {
      expect(mgr.formatForPrompt()).toBe('');
    });

    it('formats turns as markdown', () => {
      mgr.append(makeTurn({
        role: 'user',
        content: 'What is 2+2?',
        timestamp: 1700000000000,
      }));
      mgr.append(makeTurn({
        role: 'assistant',
        content: '2+2 equals 4.',
        timestamp: 1700000001000,
      }));

      const md = mgr.formatForPrompt();
      expect(md).toContain('## Conversation History');
      expect(md).toContain('### User');
      expect(md).toContain('### Assistant');
      expect(md).toContain('What is 2+2?');
      expect(md).toContain('2+2 equals 4.');
      expect(md).toContain('2023-11-14'); // date from timestamp
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        mgr.append(makeTurn({ content: `msg-${i}`, timestamp: 1700000000000 + i * 1000 }));
      }
      const md = mgr.formatForPrompt(3);
      // Should only have 3 turn headers
      const headers = md.match(/### User/g) || [];
      expect(headers).toHaveLength(3);
    });
  });

  // ── compact ──

  describe('compact', () => {
    it('returns no-op message when history is smaller than keepLast', () => {
      mgr.append(makeTurn({ content: 'a' }));
      mgr.append(makeTurn({ content: 'b' }));
      const result = mgr.compact(5);
      expect(result).toContain('No compaction needed');
      // History unchanged
      expect(mgr.getRecent(10)).toHaveLength(2);
    });

    it('returns no-op message when history equals keepLast', () => {
      mgr.append(makeTurn({ content: 'a' }));
      mgr.append(makeTurn({ content: 'b' }));
      const result = mgr.compact(2);
      expect(result).toContain('No compaction needed');
    });

    it('removes old turns and keeps recent ones', () => {
      for (let i = 0; i < 10; i++) {
        mgr.append(makeTurn({ content: `msg-${i}`, timestamp: 1000 + i }));
      }
      mgr.compact(3);
      const remaining = mgr.getRecent(100);
      expect(remaining).toHaveLength(3);
      expect(remaining[0].content).toBe('msg-7');
      expect(remaining[1].content).toBe('msg-8');
      expect(remaining[2].content).toBe('msg-9');
    });

    it('returns summary with removed turn count and token estimate', () => {
      for (let i = 0; i < 5; i++) {
        mgr.append(makeTurn({
          content: `message ${i}`,
          taskId: `task-${i % 2}`,
          tokenEstimate: 10,
        }));
      }
      const result = mgr.compact(2);
      expect(result).toContain('Compacted 3 turns');
      expect(result).toContain('~30 tokens');
      expect(result).toContain('task-0');
      expect(result).toContain('task-1');
    });

    it('persists compacted history to disk', () => {
      for (let i = 0; i < 5; i++) {
        mgr.append(makeTurn({ content: `msg-${i}` }));
      }
      mgr.compact(2);

      // Create a new manager reading from the same dir
      const mgr2 = new HistoryManager(tmpDir);
      const turns = mgr2.getRecent(100);
      expect(turns).toHaveLength(2);
      expect(turns[0].content).toBe('msg-3');
      expect(turns[1].content).toBe('msg-4');
    });

    it('compact to 0 removes all turns', () => {
      mgr.append(makeTurn({ content: 'a' }));
      mgr.append(makeTurn({ content: 'b' }));
      mgr.compact(0);
      expect(mgr.getRecent(100)).toHaveLength(0);
    });
  });

  // ── getStats ──

  describe('getStats', () => {
    it('returns zeroed stats for empty history', () => {
      const stats = mgr.getStats();
      expect(stats.totalTurns).toBe(0);
      expect(stats.estimatedTokens).toBe(0);
      expect(stats.oldestTimestamp).toBeNull();
      expect(stats.newestTimestamp).toBeNull();
    });

    it('returns correct stats for populated history', () => {
      mgr.append(makeTurn({
        content: 'first',
        timestamp: 1000,
        tokenEstimate: 10,
      }));
      mgr.append(makeTurn({
        content: 'second',
        timestamp: 2000,
        tokenEstimate: 20,
      }));
      mgr.append(makeTurn({
        content: 'third',
        timestamp: 3000,
        tokenEstimate: 30,
      }));

      const stats = mgr.getStats();
      expect(stats.totalTurns).toBe(3);
      expect(stats.estimatedTokens).toBe(60);
      expect(stats.oldestTimestamp).toBe(1000);
      expect(stats.newestTimestamp).toBe(3000);
    });

    it('updates after compaction', () => {
      for (let i = 0; i < 10; i++) {
        mgr.append(makeTurn({
          content: `msg-${i}`,
          timestamp: 1000 + i,
          tokenEstimate: 5,
        }));
      }
      expect(mgr.getStats().totalTurns).toBe(10);
      expect(mgr.getStats().estimatedTokens).toBe(50);

      mgr.compact(3);

      const stats = mgr.getStats();
      expect(stats.totalTurns).toBe(3);
      expect(stats.estimatedTokens).toBe(15);
      expect(stats.oldestTimestamp).toBe(1007);
      expect(stats.newestTimestamp).toBe(1009);
    });
  });

  // ── clear ──

  describe('clear', () => {
    it('removes history file', () => {
      mgr.append(makeTurn({ content: 'test' }));
      mgr.clear();
      expect(mgr.getRecent()).toEqual([]);
    });

    it('does not throw when history already empty', () => {
      expect(() => mgr.clear()).not.toThrow();
    });

    it('stats show zero after clear', () => {
      mgr.append(makeTurn());
      mgr.clear();
      const stats = mgr.getStats();
      expect(stats.totalTurns).toBe(0);
    });
  });

  // ── empty history edge cases ──

  describe('empty history', () => {
    it('getRecent returns empty array', () => {
      expect(mgr.getRecent()).toEqual([]);
    });

    it('formatForPrompt returns empty string', () => {
      expect(mgr.formatForPrompt()).toBe('');
    });

    it('formatForSdk returns empty array', () => {
      expect(mgr.formatForSdk()).toEqual([]);
    });

    it('compact on empty returns no-op', () => {
      const result = mgr.compact(5);
      expect(result).toContain('No compaction needed');
    });

    it('getStats returns zeroed values', () => {
      const stats = mgr.getStats();
      expect(stats.totalTurns).toBe(0);
    });
  });

  // ── large history ──

  describe('large history', () => {
    it('handles 1000 turns', () => {
      for (let i = 0; i < 1000; i++) {
        mgr.append(makeTurn({
          content: `Turn ${i}: ${'x'.repeat(100)}`,
          timestamp: i,
          tokenEstimate: 30,
        }));
      }

      const stats = mgr.getStats();
      expect(stats.totalTurns).toBe(1000);
      expect(stats.estimatedTokens).toBe(30000);
      expect(stats.oldestTimestamp).toBe(0);
      expect(stats.newestTimestamp).toBe(999);

      const recent = mgr.getRecent(5);
      expect(recent).toHaveLength(5);
      expect(recent[0].content).toContain('Turn 995');

      mgr.compact(10);
      expect(mgr.getRecent(100)).toHaveLength(10);
    });

    it('formatForPrompt with large history respects limit', () => {
      for (let i = 0; i < 100; i++) {
        mgr.append(makeTurn({ content: `msg-${i}`, timestamp: 1700000000000 + i }));
      }
      const md = mgr.formatForPrompt(5);
      const headers = md.match(/### User/g) || [];
      expect(headers).toHaveLength(5);
    });
  });

  // ── history directory creation ──

  describe('directory creation', () => {
    it('creates history directory if it does not exist', () => {
      const newDir = path.join(tmpDir, 'sub', 'nested');
      const newMgr = new HistoryManager(newDir);
      expect(fs.existsSync(path.join(newDir, 'history'))).toBe(true);
      newMgr.append(makeTurn({ content: 'test' }));
      expect(newMgr.getRecent()).toHaveLength(1);
    });
  });
});
