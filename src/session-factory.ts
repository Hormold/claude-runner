import type { ContextManager } from './context.js';
import type { ISessionManager } from './session-interface.js';
import { SessionManager } from './session-manager.js';
import { DockerSessionManager } from './docker-session-manager.js';

export type IsolationMode = 'docker' | 'process';

/**
 * Detect the best isolation mode based on Docker availability.
 * Returns 'docker' if Docker is available, otherwise 'process'.
 */
export function detectIsolationMode(): IsolationMode {
  if (DockerSessionManager.isDockerAvailable()) {
    return 'docker';
  }
  return 'process';
}

/**
 * Create a session manager based on the isolation mode.
 *
 * - "docker": full container isolation (requires Docker)
 * - "process": lightweight process-based execution (no isolation)
 * - undefined/auto: detect Docker availability, fallback to process
 */
export function createSessionManager(
  contextManager: ContextManager,
  mode?: IsolationMode,
  maxConcurrent?: number,
): ISessionManager {
  const resolvedMode = mode ?? detectIsolationMode();

  if (resolvedMode === 'docker') {
    console.log('[session] Using Docker isolation mode');
    return new DockerSessionManager(contextManager, maxConcurrent);
  }

  console.log('[session] Using process isolation mode (no Docker)');
  return new SessionManager(contextManager, maxConcurrent);
}
