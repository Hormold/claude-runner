export interface ContextConfig {
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string>;
  tools?: { allowedCommands?: string[] };
  model?: string;
  maxTurns?: number;
  historyWindow?: number;
  idleTimeoutMs?: number;
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface Task {
  id: string;
  contextId: string;
  prompt: string;
  status: TaskStatus;
  result?: string;
  error?: string;
  webhook?: string;
  priority?: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  taskId: string;
}

export interface ContextInfo {
  contextId: string;
  createdAt: number;
  lastActive: number;
  config: ContextConfig;
  sessionAlive: boolean;
}
