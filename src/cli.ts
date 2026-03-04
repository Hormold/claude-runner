#!/usr/bin/env node

import fs from 'fs';

function getBaseUrl(): string {
  return process.env.CLAUDE_RUNNER_URL || 'http://localhost:3456';
}

// ── Helpers ──

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const url = `${getBaseUrl()}${path}`;
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(url, opts);
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

class CliError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'CliError';
  }
}

function die(msg: string): never {
  throw new CliError(msg);
}

const BOOLEAN_FLAGS = new Set(['wait', 'help']);

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

// ── Commands ──

async function cmdCreate(args: string[], flags: Record<string, string | true>) {
  const contextId = args[0];
  if (!contextId) die('Usage: claude-runner create <contextId> [--agents-md file] [--config file]');

  const body: Record<string, unknown> = { contextId };

  if (flags['agents-md']) {
    const filePath = flags['agents-md'] as string;
    if (!fs.existsSync(filePath)) die(`File not found: ${filePath}`);
    body.agentsMd = fs.readFileSync(filePath, 'utf-8');
  }

  if (flags['config']) {
    const filePath = flags['config'] as string;
    if (!fs.existsSync(filePath)) die(`File not found: ${filePath}`);
    try {
      body.config = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      die(`Invalid JSON in config file: ${filePath}`);
    }
  }

  const { status, data } = await api('POST', '/api/context', body);
  if (status === 201) {
    console.log(`Context '${contextId}' created.`);
  } else {
    die(data?.error || `Failed to create context (HTTP ${status})`);
  }
}

async function cmdTask(args: string[], flags: Record<string, string | true>) {
  const contextId = args[0];
  const prompt = args.slice(1).join(' ');
  if (!contextId || !prompt) die('Usage: claude-runner task <contextId> <prompt> [--webhook url] [--wait]');

  const body: Record<string, unknown> = { contextId, prompt };
  if (flags['webhook']) body.webhook = flags['webhook'];

  const { status, data } = await api('POST', '/api/task', body);
  if (status !== 201) die(data?.error || `Failed to submit task (HTTP ${status})`);

  const taskId = data.taskId;
  console.log(`Task ${taskId} queued.`);

  if (flags['wait'] !== undefined) {
    await pollUntilDone(taskId);
  }
}

export async function pollUntilDone(taskId: string) {
  const POLL_INTERVAL_MS = parseInt(process.env.CLAUDE_RUNNER_POLL_MS || '2000');
  const MAX_POLLS = 300; // 10 minutes max

  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS);

    const { status, data } = await api('GET', `/api/task/${taskId}`);
    if (status !== 200) die(`Failed to poll task (HTTP ${status})`);

    if (data.status === 'completed') {
      console.log(`\nTask completed.`);
      if (data.result) console.log(data.result);
      return;
    }

    if (data.status === 'failed') {
      console.error(`\nTask failed.`);
      if (data.error) console.error(data.error);
      die('Task execution failed');
    }

    // Still running or queued
    process.stdout.write('.');
  }

  die('Timed out waiting for task to complete');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function cmdStatus(args: string[]) {
  const taskId = args[0];
  if (!taskId) die('Usage: claude-runner status <taskId>');

  const { status, data } = await api('GET', `/api/task/${taskId}`);
  if (status === 404) die('Task not found');
  if (status !== 200) die(`Failed to get status (HTTP ${status})`);

  console.log(JSON.stringify(data, null, 2));
}

async function cmdContexts() {
  const { status, data } = await api('GET', '/api/context');
  if (status !== 200) die(`Failed to list contexts (HTTP ${status})`);

  if (!data || data.length === 0) {
    console.log('No contexts found.');
    return;
  }

  for (const ctx of data) {
    const alive = ctx.sessionAlive ? ' [active]' : '';
    console.log(`  ${ctx.contextId}${alive}`);
  }
}

async function cmdDelete(args: string[]) {
  const contextId = args[0];
  if (!contextId) die('Usage: claude-runner delete <contextId>');

  const { status, data } = await api('DELETE', `/api/context/${contextId}`);
  if (status === 404) die(`Context '${contextId}' not found`);
  if (status !== 200) die(data?.error || `Failed to delete context (HTTP ${status})`);

  console.log(`Context '${contextId}' deleted.`);
}

// ── Main ──

const USAGE = `Usage: claude-runner <command> [options]

Commands:
  create <contextId> [--agents-md file] [--config file]   Create a new context
  task <contextId> <prompt> [--webhook url] [--wait]       Submit a task
  status <taskId>                                          Check task status
  contexts                                                 List all contexts
  delete <contextId>                                       Delete a context

Environment:
  CLAUDE_RUNNER_URL   Server URL (default: http://localhost:3456)`;

export async function main(argv: string[] = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];
  const commandArgs = positional.slice(1);

  if (!command || flags['help']) {
    console.log(USAGE);
    return;
  }

  try {
    switch (command) {
      case 'create':
        await cmdCreate(commandArgs, flags);
        break;
      case 'task':
        await cmdTask(commandArgs, flags);
        break;
      case 'status':
        await cmdStatus(commandArgs);
        break;
      case 'contexts':
        await cmdContexts();
        break;
      case 'delete':
        await cmdDelete(commandArgs);
        break;
      default:
        die(`Unknown command: ${command}\n\n${USAGE}`);
    }
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

// Run when executed directly
const isMain = process.argv[1]?.endsWith('/cli.ts') || process.argv[1]?.endsWith('/cli.js');
if (isMain) {
  main().catch(err => {
    console.error(err.message || err);
    process.exit(1);
  });
}
