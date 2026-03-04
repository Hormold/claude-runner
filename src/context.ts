import fs from 'fs';
import path from 'path';
import { ContextConfig, ContextInfo, parseConfig } from './types.js';
import { DEFAULT_CONFIG, DEFAULT_AGENTS_MD, DEFAULT_MEMORY_MD } from './defaults.js';

export class ContextManager {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }
  }

  contextPath(contextId: string): string {
    // Sanitize contextId to prevent path traversal
    const safe = contextId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.baseDir, safe);
  }

  create(contextId: string, agentsMd?: string, config?: Partial<ContextConfig>): string {
    const dir = this.contextPath(contextId);

    if (fs.existsSync(dir)) {
      throw new Error(`Context '${contextId}' already exists`);
    }

    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'history'), { recursive: true });

    // Write AGENTS.md
    fs.writeFileSync(
      path.join(dir, 'AGENTS.md'),
      agentsMd || DEFAULT_AGENTS_MD,
      'utf-8',
    );

    // Write MEMORY.md
    fs.writeFileSync(
      path.join(dir, 'MEMORY.md'),
      DEFAULT_MEMORY_MD,
      'utf-8',
    );

    // Write config.json (validate merged config)
    const finalConfig = parseConfig({ ...DEFAULT_CONFIG, ...config });
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify(finalConfig, null, 2),
      'utf-8',
    );

    return dir;
  }

  exists(contextId: string): boolean {
    return fs.existsSync(this.contextPath(contextId));
  }

  getConfig(contextId: string): ContextConfig {
    const configPath = path.join(this.contextPath(contextId), 'config.json');
    if (!fs.existsSync(configPath)) return DEFAULT_CONFIG;
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return parseConfig(raw);
  }

  getInfo(contextId: string, sessionAlive = false): ContextInfo {
    const dir = this.contextPath(contextId);
    const stat = fs.statSync(dir);
    const config = this.getConfig(contextId);

    return {
      contextId,
      createdAt: stat.birthtimeMs,
      lastActive: stat.mtimeMs,
      config,
      sessionAlive,
    };
  }

  list(): string[] {
    if (!fs.existsSync(this.baseDir)) return [];
    return fs.readdirSync(this.baseDir).filter(f => {
      const full = path.join(this.baseDir, f);
      return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'config.json'));
    });
  }

  delete(contextId: string) {
    const dir = this.contextPath(contextId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
