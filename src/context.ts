import fs from 'fs';
import path from 'path';
import { ContextConfig, ContextInfo, parseConfig } from './types.js';
import { DEFAULT_CONFIG, DEFAULT_AGENTS_MD, DEFAULT_MEMORY_MD } from './defaults.js';

const CONTEXT_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
const TEMPLATE_DIR = '_template';

export class ContextManager {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }
  }

  /**
   * Validate contextId format: alphanumeric, hyphens, underscores, 1-64 chars.
   * Throws on invalid IDs.
   */
  validateContextId(contextId: string): void {
    if (!CONTEXT_ID_REGEX.test(contextId)) {
      throw new Error(
        `Invalid contextId '${contextId}': must be 1-64 characters, alphanumeric, hyphens, or underscores`,
      );
    }
  }

  contextPath(contextId: string): string {
    this.validateContextId(contextId);
    return path.join(this.baseDir, contextId);
  }

  /**
   * Check if a _template/ directory exists in the base dir.
   */
  private get templateDir(): string {
    return path.join(this.baseDir, TEMPLATE_DIR);
  }

  private hasTemplate(): boolean {
    return fs.existsSync(this.templateDir) && fs.statSync(this.templateDir).isDirectory();
  }

  /**
   * Recursively copy a directory.
   */
  private copyDir(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        this.copyDir(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  create(contextId: string, agentsMd?: string, config?: Partial<ContextConfig>): string {
    const dir = this.contextPath(contextId);

    if (fs.existsSync(dir)) {
      throw new Error(`Context '${contextId}' already exists`);
    }

    // Clone from template if it exists, otherwise create from scratch
    if (this.hasTemplate()) {
      this.copyDir(this.templateDir, dir);
    } else {
      fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'history'), { recursive: true });

      // Write MEMORY.md
      fs.writeFileSync(path.join(dir, 'MEMORY.md'), DEFAULT_MEMORY_MD, 'utf-8');
    }

    // Write AGENTS.md (override template if provided explicitly)
    if (agentsMd) {
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), agentsMd, 'utf-8');
    } else if (!fs.existsSync(path.join(dir, 'AGENTS.md'))) {
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), DEFAULT_AGENTS_MD, 'utf-8');
    }

    // Read template config if it exists, merge with defaults and overrides, validate
    let baseConfig: Record<string, unknown> = { ...DEFAULT_CONFIG };
    const templateConfigPath = path.join(dir, 'config.json');
    if (fs.existsSync(templateConfigPath)) {
      try {
        const templateRaw = JSON.parse(fs.readFileSync(templateConfigPath, 'utf-8'));
        baseConfig = { ...baseConfig, ...templateRaw };
      } catch {
        // Ignore invalid template config, will use defaults
      }
    }

    const finalConfig = parseConfig({ ...baseConfig, ...config });
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

  /**
   * Merge partial config changes into existing config. Validates the merged result.
   */
  updateConfig(contextId: string, partial: Partial<ContextConfig>): ContextConfig {
    const dir = this.contextPath(contextId);
    if (!fs.existsSync(dir)) {
      throw new Error(`Context '${contextId}' does not exist`);
    }

    const current = this.getConfig(contextId);
    const merged = parseConfig({
      ...current,
      ...partial,
      // Deep merge nested objects so partial updates don't wipe existing entries
      env: partial.env ? { ...current.env, ...partial.env } : current.env,
      mcpServers: partial.mcpServers ? { ...current.mcpServers, ...partial.mcpServers } : current.mcpServers,
      tools: partial.tools ? { ...current.tools, ...partial.tools } : current.tools,
    });

    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify(merged, null, 2),
      'utf-8',
    );

    return merged;
  }

  /**
   * List files in a context workspace (recursive, relative paths).
   */
  listFiles(contextId: string): string[] {
    const dir = this.contextPath(contextId);
    if (!fs.existsSync(dir)) {
      throw new Error(`Context '${contextId}' does not exist`);
    }

    const results: string[] = [];
    const walk = (current: string, prefix: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(path.join(current, entry.name), rel);
        } else {
          results.push(rel);
        }
      }
    };
    walk(dir, '');
    return results.sort();
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
      if (f === TEMPLATE_DIR) return false; // exclude template from listing
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
