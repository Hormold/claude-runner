import { z } from 'zod';

// ── MCP Server Config ──

export const McpServerConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().url().optional(),
});

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

// ── Context Config ──

export const ContextConfigSchema = z.object({
  model: z.string().min(1).optional(),
  maxTurns: z.number().int().positive().optional(),
  historyWindow: z.number().int().nonnegative().optional(),
  idleTimeoutMs: z.number().int().positive().optional(),
  mcpServers: z.record(z.string(), McpServerConfigSchema).optional(),
  env: z.record(z.string(), z.string()).optional(),
  tools: z.object({
    allowedCommands: z.array(z.string()).optional(),
  }).optional(),
});

export type ContextConfig = z.infer<typeof ContextConfigSchema>;

/**
 * Parse and validate a raw config object. Throws ZodError with clear messages on invalid input.
 * Strips unknown fields via passthrough-less parsing.
 */
export function parseConfig(raw: unknown): ContextConfig {
  return ContextConfigSchema.parse(raw);
}

// ── Task ──

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

// ── History ──

export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  taskId: string;
  tokenEstimate: number;
}

export interface HistoryStats {
  totalTurns: number;
  estimatedTokens: number;
  oldestTimestamp: number | null;
  newestTimestamp: number | null;
}

// ── Context Info ──

export interface ContextInfo {
  contextId: string;
  createdAt: number;
  lastActive: number;
  config: ContextConfig;
  sessionAlive: boolean;
}
