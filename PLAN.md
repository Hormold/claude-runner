# Claude Runner — Architecture Plan

## What
A starter template for running Claude Code as a service. Orchestrator manages task queue, spins up isolated Claude Code sessions with pre-configured tools, persistent file-based memory per context, and a universal REST API input layer.

## Architecture

```
Connectors (Slack, Web UI, API clients)
         │
         ▼
┌─────────────────────────────────────────┐
│  Orchestrator (Node.js + Express)       │
│                                         │
│  ┌─────────────┐  ┌──────────────────┐  │
│  │ REST API     │  │ Task Queue       │  │
│  │ POST /task   │  │ (SQLite + FIFO)  │  │
│  │ GET /task/:id│  │ per-context lock  │  │
│  │ GET /contexts│  │                  │  │
│  └─────────────┘  └──────────────────┘  │
│                                         │
│  ┌─────────────────────────────────────┐│
│  │ Session Manager                     ││
│  │ - Spawn Claude Code SDK session     ││
│  │ - 5 min idle timeout → stop         ││
│  │ - Reuse warm session if alive       ││
│  │ - Inject context workspace          ││
│  └─────────────────────────────────────┘│
│                                         │
│  ┌─────────────────────────────────────┐│
│  │ History Manager                     ││
│  │ - Stores conversation turns         ││
│  │ - Provides recent context to SDK    ││
│  │ - Per-context history files          ││
│  └─────────────────────────────────────┘│
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│  Context Workspace (per context)        │
│  ./contexts/{context_id}/               │
│                                         │
│  ├── AGENTS.md          (agent persona) │
│  ├── MEMORY.md          (long-term mem) │
│  ├── config.json        (MCP, tools)    │
│  ├── tools/             (CLI scripts)   │
│  ├── history/           (chat turns)    │
│  └── data/              (working files) │
└─────────────────────────────────────────┘
```

## Core Components

### 1. REST API
```
POST /api/task          Submit a task to a context
  body: { contextId, prompt, webhook?, priority? }
  returns: { taskId, status: "queued" }

GET  /api/task/:id      Get task status & result
  returns: { taskId, status, result?, error? }

POST /api/context       Create a new context
  body: { contextId, agents_md?, config? }

GET  /api/context/:id   Get context info
  returns: { contextId, status, files[], lastActive }

DELETE /api/context/:id  Delete context & files
```

### 2. Task Queue (SQLite)
- FIFO per context (tasks for same context run sequentially)
- Cross-context parallelism (different contexts run simultaneously)
- States: queued → running → completed | failed
- Webhook callback on completion (optional)

### 3. Session Manager
- Spawns Claude Code SDK session per context
- Working directory = `./contexts/{contextId}/`
- Injects MCP servers from `config.json`
- CLI tools from `tools/` are available in PATH
- Environment variables from `config.json` secrets
- Idle timeout: 5 min no tasks → kill session
- Warm reuse: if session alive, send next task directly

### 4. Context Workspace
Each context is a directory with:
- `AGENTS.md` — system prompt / persona (Claude Code reads this automatically)
- `MEMORY.md` — persistent memory (agent reads/writes)
- `config.json` — MCP servers, env vars, tools config
- `tools/` — executable scripts available to the agent
- `history/` — conversation history (JSONL)
- `data/` — working files the agent creates

### 5. History Manager
- Saves each task prompt + result as a turn in `history/`
- On new task, loads last N turns as conversation context
- Configurable window (default: 20 turns)

## config.json schema
```json
{
  "mcpServers": {
    "slack": {
      "command": "npx",
      "args": ["-y", "@anthropic/slack-mcp"],
      "env": { "SLACK_TOKEN": "xoxb-..." }
    }
  },
  "env": {
    "API_KEY": "secret123"
  },
  "tools": {
    "allowedCommands": ["node", "python3", "curl"]
  },
  "model": "claude-sonnet-4-20250514",
  "maxTurns": 50,
  "historyWindow": 20,
  "idleTimeoutMs": 300000
}
```

## Tech Stack
- **Runtime:** Node.js + TypeScript
- **API:** Express
- **Queue:** better-sqlite3
- **Claude:** @anthropic-ai/claude-code SDK
- **No Docker initially** — process-based for speed, Docker later

## File Structure
```
claude-runner/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              (entry point + API)
│   ├── queue.ts              (SQLite task queue)
│   ├── session-manager.ts    (Claude Code lifecycle)
│   ├── history.ts            (conversation history)
│   ├── context.ts            (context CRUD)
│   └── types.ts              (shared types)
├── contexts/                  (created at runtime)
│   └── _template/            (default AGENTS.md etc)
└── README.md
```

## Phase 1 (MVP)
1. REST API (Express)
2. SQLite queue
3. Session manager (spawn/reuse/kill Claude Code)
4. Context workspace management
5. History tracking
6. Template context with example AGENTS.md

## Phase 2 (Connectors)
- Slack connector (webhook → REST)
- Web UI (simple chat interface)
- WebSocket for streaming responses

## Phase 3 (Production)
- Docker isolation per context
- Auth (API keys)
- Rate limiting
- Metrics/observability
