import type { ContextConfig } from './types.js';

export const DEFAULT_CONFIG: ContextConfig = {
  model: 'claude-sonnet-4-20250514',
  maxTurns: 50,
  historyWindow: 20,
  idleTimeoutMs: 300_000, // 5 minutes
};

export const DEFAULT_AGENTS_MD = `# Agent

You are a helpful assistant working in this context workspace.

## Memory
- Read MEMORY.md for persistent context
- Update MEMORY.md with important information to remember between tasks
- Use data/ directory for working files

## Tools
- Check tools/ directory for available CLI scripts
- Use them as needed to complete tasks
`;

export const DEFAULT_MEMORY_MD = `# Memory

_No memories yet. This file will be updated as tasks are completed._
`;
