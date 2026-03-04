import fs from 'fs';
import path from 'path';
import { HistoryTurn } from './types.js';

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

  append(turn: HistoryTurn) {
    const line = JSON.stringify(turn) + '\n';
    fs.appendFileSync(this.historyFile(), line, 'utf-8');
  }

  getRecent(limit = 20): HistoryTurn[] {
    const file = this.historyFile();
    if (!fs.existsSync(file)) return [];

    const content = fs.readFileSync(file, 'utf-8').trim();
    if (!content) return [];

    const lines = content.split('\n');
    const recent = lines.slice(-limit);
    return recent.map(line => JSON.parse(line) as HistoryTurn);
  }

  // Format history as conversation messages for Claude Code SDK
  formatForSdk(limit = 20): Array<{ role: 'user' | 'assistant'; content: string }> {
    return this.getRecent(limit).map(turn => ({
      role: turn.role,
      content: turn.content,
    }));
  }

  clear() {
    const file = this.historyFile();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}
