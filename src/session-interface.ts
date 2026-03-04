import { EventEmitter } from 'events';

/**
 * Common interface for session managers.
 * Both SessionManager (process mode) and DockerSessionManager (Docker mode) implement this.
 */
export interface ISessionManager extends EventEmitter {
  executeTask(contextId: string, prompt: string, taskId: string): Promise<string>;
  isRunning(contextId: string): boolean;
  isAlive(contextId: string): boolean;
  getRunningContexts(): Set<string>;
  getRunningCount(): number;
  getMaxConcurrent(): number;
  abortAll(): void;
  killSession(contextId: string): void;
  killAll(): void;
}
