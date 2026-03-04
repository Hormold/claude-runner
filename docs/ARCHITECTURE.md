# Claude Runner — Architecture Design

## Overview

Claude Runner is a service that orchestrates Claude Code SDK sessions with persistent, isolated context workspaces. It provides a universal REST API that connectors (Slack, Web UI, webhooks) plug into.

## Core Problem

You have N customers/projects/contexts. Each needs:
- Its own AI agent with custom persona and tools
- Persistent memory across tasks
- Access to specific MCP servers (Slack, CRM, databases)
- CLI scripts and environment secrets
- Conversation history
- Isolation from other contexts

## System Components

```
┌──────────────────────────────────────────────────────────────┐
│                     CONNECTORS LAYER                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────┐ │
│  │  Slack    │  │  Web UI  │  │ Webhook  │  │ CLI Client  │ │
│  │ Adapter   │  │ Adapter  │  │ Adapter  │  │             │ │
│  └─────┬────┘  └────┬─────┘  └────┬─────┘  └──────┬──────┘ │
│        │            │              │               │         │
│        └────────────┴──────┬───────┴───────────────┘         │
└────────────────────────────┼─────────────────────────────────┘
                             ▼
┌──────────────────────────────────────────────────────────────┐
│                      API GATEWAY                             │
│                                                              │
│  POST /api/task          Submit task to context              │
│  GET  /api/task/:id      Poll task status/result             │
│  WS   /api/stream/:id   Stream task output (Phase 2)        │
│  POST /api/context       Create context                      │
│  GET  /api/context       List contexts                       │
│  DELETE /api/context/:id Delete context                      │
│  GET  /api/health        Health check                        │
│                                                              │
│  Auth: API key per request (Phase 2)                         │
└──────────────────────────┬───────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                    ORCHESTRATOR                               │
│                                                              │
│  ┌───────────────────┐  ┌──────────────────────────────────┐ │
│  │   Task Queue       │  │   Session Pool                   │ │
│  │                    │  │                                  │ │
│  │  SQLite-backed     │  │  Active sessions map             │ │
│  │  FIFO per context  │  │  contextId → {session, timer}    │ │
│  │  Priority support  │  │  Idle timeout (5 min default)    │ │
│  │  Cross-ctx parallel│  │  Warm reuse via --resume          │ │
│  │                    │  │  Max concurrent sessions limit   │ │
│  └────────┬───────────┘  └──────────┬───────────────────────┘ │
│           │                         │                         │
│           └─────────┬───────────────┘                         │
│                     ▼                                         │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │   Executor                                                │ │
│  │                                                          │ │
│  │   1. Dequeue task                                        │ │
│  │   2. Load context config + history                       │ │
│  │   3. Build prompt (current + history window)             │ │
│  │   4. Spawn/reuse Claude Code SDK session                 │ │
│  │   5. Stream messages, collect result                     │ │
│  │   6. Save result + history                               │ │
│  │   7. Fire webhook callback                               │ │
│  │   8. Reset idle timer                                     │ │
│  └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                 CONTEXT WORKSPACES                            │
│                                                              │
│  contexts/                                                   │
│  ├── customer-acme/                                          │
│  │   ├── AGENTS.md         ← Agent persona & instructions   │
│  │   ├── MEMORY.md         ← Persistent memory (r/w)        │
│  │   ├── config.json       ← MCP servers, env, model, etc.  │
│  │   ├── tools/            ← CLI scripts (chmod +x)         │
│  │   │   ├── query-crm.sh                                   │
│  │   │   └── check-usage.py                                 │
│  │   ├── history/          ← Conversation JSONL              │
│  │   │   └── turns.jsonl                                     │
│  │   └── data/             ← Working files                   │
│  │       ├── notes.md                                        │
│  │       └── report.csv                                      │
│  ├── customer-beta/                                          │
│  │   └── ...                                                 │
│  └── _template/            ← Default files for new contexts  │
│      ├── AGENTS.md                                           │
│      └── config.json                                         │
└──────────────────────────────────────────────────────────────┘
```

## Data Flow

### Task Execution Flow
```
Client → POST /api/task {contextId, prompt}
  → Queue.enqueue(task)
  → ProcessLoop detects queued task
  → Check: context not already running?
    → Yes: Executor.run(task)
      → Load config.json
      → Load history (last N turns)
      → Build composite prompt
      → Get/create Claude Code session
        → Set cwd = contexts/{id}/
        → Inject MCP servers from config
        → Set env vars from config
        → Set model from config
        → customSystemPrompt from AGENTS.md
        → permissionMode = bypassPermissions
      → Stream SDK messages
      → Collect result text
      → Save to history/turns.jsonl
      → Update task status → completed
      → Fire webhook if configured
      → Reset idle timer
    → No (busy): stay in queue, process next context
```

### Session Lifecycle
```
Task arrives → Session exists?
  → No: Spawn new session (claude code SDK)
  → Yes: Reuse via --resume (same session ID)
  
Session idle > 5 min → Kill session, free resources
  (Session ID preserved for next resume)

Max concurrent sessions reached → Task stays queued
```

### History Management
```
New task:
  1. Append {role: "user", content: prompt} to turns.jsonl
  2. Load last N turns from turns.jsonl
  3. Format as context block prepended to prompt
  4. Claude sees: [history context] + [current task]
  5. Claude executes task, reads/writes MEMORY.md
  6. Append {role: "assistant", content: result} to turns.jsonl
```

## Key Design Decisions

### 1. Process-based, not Docker (Phase 1)
- Docker adds ~2-5s startup overhead per container
- Process isolation is sufficient for trusted contexts
- Claude Code SDK runs as a child process anyway
- Docker isolation planned for Phase 3 (untrusted contexts)

### 2. SQLite over Redis
- Zero external dependencies
- Sufficient for single-node deployment (our target)
- WAL mode for concurrent reads
- Queue state survives restarts
- If scale demands it: swap to Redis later (same interface)

### 3. File-based context (not DB)
- Claude Code natively reads AGENTS.md from cwd
- Files are inspectable, editable, versionable (git)
- MCP servers configured per-context via config.json
- Agent can read/write MEMORY.md directly
- No ORM, no schema migrations, no serialization

### 4. History in prompt, not SDK messages
- Claude Code SDK doesn't support passing message history
- We prepend history as a context block in the prompt
- Session --resume provides native continuation when available
- Fallback: formatted history in prompt preamble

### 5. One task per context at a time
- Prevents race conditions on workspace files
- Queue ensures sequential execution per context
- Parallel execution across different contexts
- Simple, correct, no locking needed

### 6. Webhook-first callbacks
- REST polling for simple clients (GET /api/task/:id)
- Webhooks for event-driven integrations
- WebSocket streaming planned for Phase 2

## config.json Schema

```jsonc
{
  // Claude Code model
  "model": "claude-sonnet-4-20250514",
  
  // Max agentic turns per task
  "maxTurns": 50,
  
  // How many history turns to include in prompt
  "historyWindow": 20,
  
  // Kill session after this idle period (ms)
  "idleTimeoutMs": 300000,
  
  // MCP servers available to the agent
  "mcpServers": {
    "slack": {
      "command": "npx",
      "args": ["-y", "@anthropic/slack-mcp"],
      "env": { "SLACK_TOKEN": "xoxb-..." }
    },
    "postgres": {
      "command": "npx", 
      "args": ["-y", "@anthropic/postgres-mcp"],
      "env": { "DATABASE_URL": "postgres://..." }
    }
  },
  
  // Environment variables injected into session
  "env": {
    "API_KEY": "secret123",
    "REGION": "us-west-2"
  },
  
  // Tool access control
  "tools": {
    "allowedCommands": ["node", "python3", "curl", "jq"]
  }
}
```

## Security Considerations

### Phase 1 (MVP — trusted environments)
- No auth (localhost only)
- permissionMode: bypassPermissions
- File system access scoped to context dir (by convention)
- No network isolation

### Phase 2 (Multi-tenant)
- API key auth per request
- Rate limiting per context
- Audit logging

### Phase 3 (Untrusted contexts)
- Docker container per context
- Network policies (restrict outbound)
- Resource limits (CPU, memory, disk)
- Read-only base filesystem
- Secrets injected as env vars (not on disk)

## Scaling Path

```
Phase 1: Single process, single node
  └→ Good for: 1-10 contexts, dev/staging

Phase 2: Single process, SQLite → Redis
  └→ Good for: 10-50 contexts, production single-node

Phase 3: Multiple workers, Redis queue, shared storage
  └→ Good for: 50+ contexts, distributed
```

## File Structure

```
claude-runner/
├── package.json
├── tsconfig.json
├── PLAN.md                    # Ralphex execution plan
├── docs/
│   └── ARCHITECTURE.md        # This file
├── src/
│   ├── index.ts               # Entry point + Express API
│   ├── types.ts               # Shared type definitions
│   ├── queue.ts               # SQLite task queue
│   ├── session-manager.ts     # Claude Code SDK lifecycle
│   ├── history.ts             # Conversation history (JSONL)
│   ├── context.ts             # Context workspace CRUD
│   └── connectors/            # Phase 2
│       ├── slack.ts
│       └── web.ts
├── contexts/                   # Runtime: per-context workspaces
│   └── _template/             # Default AGENTS.md, config.json
├── .data/                      # Runtime: SQLite DB
└── tests/
    ├── queue.test.ts
    ├── context.test.ts
    ├── session-manager.test.ts
    └── api.test.ts
```
