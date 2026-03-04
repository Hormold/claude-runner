import { describe, it, expect } from 'vitest';
import { parseConfig, ContextConfigSchema } from '../src/types.js';
import { DEFAULT_CONFIG, DEFAULT_AGENTS_MD, DEFAULT_MEMORY_MD } from '../src/defaults.js';

describe('parseConfig', () => {
  it('accepts a valid full config', () => {
    const raw = {
      model: 'claude-sonnet-4-20250514',
      maxTurns: 50,
      historyWindow: 20,
      idleTimeoutMs: 300_000,
      mcpServers: {
        myServer: {
          command: 'node',
          args: ['server.js'],
          env: { API_KEY: 'test' },
        },
      },
      env: { NODE_ENV: 'production' },
      tools: { allowedCommands: ['ls', 'cat'] },
    };

    const result = parseConfig(raw);
    expect(result.model).toBe('claude-sonnet-4-20250514');
    expect(result.maxTurns).toBe(50);
    expect(result.historyWindow).toBe(20);
    expect(result.idleTimeoutMs).toBe(300_000);
    expect(result.mcpServers?.myServer.command).toBe('node');
    expect(result.mcpServers?.myServer.args).toEqual(['server.js']);
    expect(result.env?.NODE_ENV).toBe('production');
    expect(result.tools?.allowedCommands).toEqual(['ls', 'cat']);
  });

  it('accepts an empty object (all fields optional)', () => {
    const result = parseConfig({});
    expect(result).toEqual({});
  });

  it('accepts config with only some fields', () => {
    const result = parseConfig({ model: 'claude-opus-4-20250514', maxTurns: 10 });
    expect(result.model).toBe('claude-opus-4-20250514');
    expect(result.maxTurns).toBe(10);
    expect(result.historyWindow).toBeUndefined();
  });

  it('accepts MCP server with url (SSE mode)', () => {
    const result = parseConfig({
      mcpServers: {
        remote: {
          command: 'placeholder',
          url: 'https://example.com/mcp',
        },
      },
    });
    expect(result.mcpServers?.remote.url).toBe('https://example.com/mcp');
  });

  // ── Bad types ──

  it('rejects maxTurns as string', () => {
    expect(() => parseConfig({ maxTurns: '50' })).toThrow();
  });

  it('rejects maxTurns as negative number', () => {
    expect(() => parseConfig({ maxTurns: -1 })).toThrow();
  });

  it('rejects maxTurns as float', () => {
    expect(() => parseConfig({ maxTurns: 3.5 })).toThrow();
  });

  it('rejects historyWindow as negative', () => {
    expect(() => parseConfig({ historyWindow: -5 })).toThrow();
  });

  it('accepts historyWindow as zero', () => {
    const result = parseConfig({ historyWindow: 0 });
    expect(result.historyWindow).toBe(0);
  });

  it('rejects idleTimeoutMs as zero', () => {
    expect(() => parseConfig({ idleTimeoutMs: 0 })).toThrow();
  });

  it('rejects model as empty string', () => {
    expect(() => parseConfig({ model: '' })).toThrow();
  });

  it('rejects model as number', () => {
    expect(() => parseConfig({ model: 123 })).toThrow();
  });

  it('rejects non-object input (string)', () => {
    expect(() => parseConfig('not an object')).toThrow();
  });

  it('rejects non-object input (null)', () => {
    expect(() => parseConfig(null)).toThrow();
  });

  it('rejects non-object input (array)', () => {
    expect(() => parseConfig([1, 2, 3])).toThrow();
  });

  it('rejects mcpServers with empty command', () => {
    expect(() =>
      parseConfig({
        mcpServers: { bad: { command: '' } },
      }),
    ).toThrow();
  });

  it('rejects mcpServers with missing command', () => {
    expect(() =>
      parseConfig({
        mcpServers: { bad: { args: ['foo'] } },
      }),
    ).toThrow();
  });

  it('rejects env with non-string values', () => {
    expect(() =>
      parseConfig({ env: { KEY: 123 } }),
    ).toThrow();
  });

  it('accepts config with secrets field', () => {
    const result = parseConfig({
      secrets: { API_KEY: 'sk-123', DB_PASS: 'secret' },
    });
    expect(result.secrets).toEqual({ API_KEY: 'sk-123', DB_PASS: 'secret' });
  });

  it('keeps env and secrets separate', () => {
    const result = parseConfig({
      env: { NODE_ENV: 'production' },
      secrets: { API_KEY: 'sk-123' },
    });
    expect(result.env).toEqual({ NODE_ENV: 'production' });
    expect(result.secrets).toEqual({ API_KEY: 'sk-123' });
  });

  it('rejects secrets with non-string values', () => {
    expect(() =>
      parseConfig({ secrets: { KEY: 123 } }),
    ).toThrow();
  });

  it('rejects tools.allowedCommands with non-string items', () => {
    expect(() =>
      parseConfig({ tools: { allowedCommands: [123] } }),
    ).toThrow();
  });

  // ── Extra fields ──

  it('strips unknown top-level fields', () => {
    const result = parseConfig({ model: 'test-model', unknownField: true });
    expect((result as any).unknownField).toBeUndefined();
    expect(result.model).toBe('test-model');
  });
});

describe('ContextConfigSchema', () => {
  it('can be used with safeParse for non-throwing validation', () => {
    const bad = ContextConfigSchema.safeParse({ maxTurns: 'not a number' });
    expect(bad.success).toBe(false);

    const good = ContextConfigSchema.safeParse({ maxTurns: 10 });
    expect(good.success).toBe(true);
    if (good.success) {
      expect(good.data.maxTurns).toBe(10);
    }
  });
});

describe('defaults', () => {
  it('DEFAULT_CONFIG has expected shape', () => {
    expect(DEFAULT_CONFIG.model).toBe('claude-sonnet-4-20250514');
    expect(DEFAULT_CONFIG.maxTurns).toBe(50);
    expect(DEFAULT_CONFIG.historyWindow).toBe(20);
    expect(DEFAULT_CONFIG.idleTimeoutMs).toBe(300_000);
  });

  it('DEFAULT_CONFIG validates through parseConfig', () => {
    const result = parseConfig(DEFAULT_CONFIG);
    expect(result).toEqual(DEFAULT_CONFIG);
  });

  it('DEFAULT_AGENTS_MD is a non-empty string', () => {
    expect(typeof DEFAULT_AGENTS_MD).toBe('string');
    expect(DEFAULT_AGENTS_MD.length).toBeGreaterThan(0);
    expect(DEFAULT_AGENTS_MD).toContain('Agent');
  });

  it('DEFAULT_MEMORY_MD is a non-empty string', () => {
    expect(typeof DEFAULT_MEMORY_MD).toBe('string');
    expect(DEFAULT_MEMORY_MD.length).toBeGreaterThan(0);
    expect(DEFAULT_MEMORY_MD).toContain('Memory');
  });
});
