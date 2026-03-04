import fs from 'fs';
import path from 'path';
import { HistoryTurn, HistoryStats } from './types.js';

/**
 * Estimate token count from text content.
 * Uses a rough heuristic of ~4 characters per token.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class HistoryManager {
  private contextDir: string;

  constructor(contextDir: string) {
    this.contextDir = contextDir;
    const histDir = path.join(contextDir, 'history');
    if (!fs.existsSync(histDir)) {
      fs.mkdirSync(histDir, { recursive: true });
    }
  }

  private historyFile(): string {
    return path.join(this.contextDir, 'history', 'turns.jsonl');
  }

  /**
   * Append a turn to the history JSONL file.
   */
  append(turn: HistoryTurn): void {
    const line = JSON.stringify(turn) + '\n';
    fs.appendFileSync(this.historyFile(), line, 'utf-8');
  }

  /**
   * Read all turns from the JSONL file.
   */
  private readAll(): HistoryTurn[] {
    const file = this.historyFile();
    if (!fs.existsSync(file)) return [];

    const content = fs.readFileSync(file, 'utf-8').trim();
    if (!content) return [];

    return content.split('\n').reduce<HistoryTurn[]>((turns, line) => {
      try {
        turns.push(JSON.parse(line) as HistoryTurn);
      } catch {
        // Skip corrupted lines to prevent total history loss
      }
      return turns;
    }, []);
  }

  /**
   * Get the most recent N turns.
   */
  getRecent(limit = 20): HistoryTurn[] {
    if (limit === 0) return [];
    const all = this.readAll();
    return all.slice(-limit);
  }

  /**
   * Format history as conversation messages for Claude Code SDK.
   */
  formatForSdk(limit = 20): Array<{ role: 'user' | 'assistant'; content: string }> {
    return this.getRecent(limit).map(turn => ({
      role: turn.role,
      content: turn.content,
    }));
  }

  /**
   * Format history as a markdown context block for prompt injection.
   */
  formatForPrompt(limit = 20): string {
    const turns = this.getRecent(limit);
    if (turns.length === 0) return '';

    const lines: string[] = ['## Conversation History', ''];
    for (const turn of turns) {
      const date = new Date(turn.timestamp).toISOString();
      const roleLabel = turn.role === 'user' ? 'User' : 'Assistant';
      lines.push(`### ${roleLabel} (${date})`);
      lines.push(turn.content);
      lines.push('');
    }

    return lines.join('\n').trimEnd();
  }

  /**
   * Compact history by keeping only the most recent N turns.
   * Returns a summary string describing the compacted turns.
   */
  compact(keepLast: number): string {
    const all = this.readAll();

    if (all.length <= keepLast) {
      return `No compaction needed (${all.length} turns, keeping ${keepLast})`;
    }

    const removed = all.slice(0, all.length - keepLast);
    const kept = keepLast === 0 ? [] : all.slice(-keepLast);

    // Build summary of removed turns
    const removedTokens = removed.reduce((sum, t) => sum + t.tokenEstimate, 0);
    const taskIds = [...new Set(removed.map(t => t.taskId))];
    const summary = `Compacted ${removed.length} turns (~${removedTokens} tokens) from ${taskIds.length} task(s): ${taskIds.join(', ')}`;

    // Rewrite the file with only the kept turns
    const file = this.historyFile();
    const content = kept.length === 0 ? '' : kept.map(t => JSON.stringify(t)).join('\n') + '\n';
    fs.writeFileSync(file, content, 'utf-8');

    return summary;
  }

  /**
   * Get statistics about the history.
   */
  getStats(): HistoryStats {
    const all = this.readAll();

    if (all.length === 0) {
      return {
        totalTurns: 0,
        estimatedTokens: 0,
        oldestTimestamp: null,
        newestTimestamp: null,
      };
    }

    return {
      totalTurns: all.length,
      estimatedTokens: all.reduce((sum, t) => sum + t.tokenEstimate, 0),
      oldestTimestamp: all[0].timestamp,
      newestTimestamp: all[all.length - 1].timestamp,
    };
  }

  /**
   * Clear all history.
   */
  clear(): void {
    const file = this.historyFile();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}
