# Claude Runner

Run Claude Code as a service. Persistent file-based contexts, SQLite task queue, REST API.

Each context gets its own isolated workspace with a custom persona (AGENTS.md), persistent memory (MEMORY.md), tools, MCP server integrations, and conversation history. Tasks are queued per-context (FIFO), executed sequentially within a context, and parallelized across contexts.

## Quick Start

```bash
npm install
npm run dev
```

Server starts at `http://localhost:3456`.

## CLI

A built-in CLI client is available for quick interaction:

```bash
# Create a context
npx tsx src/cli.ts create my-project

# Create with custom persona and config
npx tsx src/cli.ts create my-project --agents-md ./my-agents.md --config ./my-config.json

# Submit a task
npx tsx src/cli.ts task my-project "Create a hello world app in data/app.py"

# Submit and wait for result
npx tsx src/cli.ts task my-project "Analyze the CSV in data/" --wait

# Check task status
npx tsx src/cli.ts status <task-id>

# List all contexts
npx tsx src/cli.ts contexts

# Delete a context
npx tsx src/cli.ts delete my-project
```

Environment variables:
- `CLAUDE_RUNNER_URL` — Server URL (default: `http://localhost:3456`)
- `CLAUDE_RUNNER_POLL_MS` — Poll interval for `--wait` (default: `2000`)

## Context Workspaces

Each context is an isolated directory under `contexts/`:

```
contexts/my-project/
├── AGENTS.md      # Agent persona and instructions
├── MEMORY.md      # Persistent memory (read/written by agent)
├── config.json    # Model, MCP servers, env vars, tools config
├── tools/         # CLI scripts available to the agent
├── history/       # Conversation history (JSONL)
└── data/          # Working files (reports, outputs, etc.)
```

### Template

New contexts are cloned from `contexts/_template/` if it exists. The template ships with sensible defaults. Customize it to set your organization's baseline.

### AGENTS.md

The agent persona file. Controls how the agent behaves, what tools it uses, and how it handles tasks. See `contexts/_template/AGENTS.md` for the default.

### config.json

Context configuration. All fields are optional — defaults are applied automatically.

```json
{
  "model": "claude-sonnet-4-20250514",
  "maxTurns": 50,
  "historyWindow": 20,
  "idleTimeoutMs": 300000,
  "maxConcurrentSessions": 5,
  "executionTimeoutMs": 600000,
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
    "allowedCommands": ["node", "python3", "curl", "jq"]
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | string | `claude-sonnet-4-20250514` | Claude model to use |
| `maxTurns` | number | `50` | Max agentic turns per task |
| `historyWindow` | number | `20` | Number of history turns to include in prompt |
| `idleTimeoutMs` | number | `300000` | Kill session after idle period (ms) |
| `maxConcurrentSessions` | number | `5` | Max parallel sessions across all contexts |
| `executionTimeoutMs` | number | `600000` | Per-task execution timeout (ms) |
| `mcpServers` | object | `{}` | MCP server configurations |
| `env` | object | `{}` | Environment variables injected into session |
| `tools.allowedCommands` | string[] | `[]` | Allowed CLI commands |

### MEMORY.md

Persistent memory file. The agent reads it at the start of each task and can update it with findings, decisions, and state that should persist across tasks.

## API Reference

Base URL: `http://localhost:3456`

### Health

```
GET /api/health
```

Returns server status, context count, active sessions, and queue statistics.

```json
{
  "status": "ok",
  "contexts": 3,
  "activeSessions": ["my-project"],
  "queueStats": { "queued": 2, "running": 1, "completed": 15, "failed": 0 }
}
```

### Contexts

#### Create context

```
POST /api/context
Content-Type: application/json

{
  "contextId": "my-project",
  "agentsMd": "# Agent\nYou are a Python expert.",
  "config": {
    "model": "claude-sonnet-4-20250514",
    "idleTimeoutMs": 300000
  }
}
```

- `contextId` (required): Alphanumeric, hyphens, underscores, 1-64 chars
- `agentsMd` (optional): Custom AGENTS.md content. If omitted, uses template or default
- `config` (optional): Partial config to merge with defaults

Response: `201 Created`
```json
{ "contextId": "my-project", "path": "/path/to/contexts/my-project" }
```

#### List contexts

```
GET /api/context
```

Response: `200 OK` — Array of context info objects.

#### Get context info

```
GET /api/context/:id
```

Response: `200 OK`
```json
{
  "contextId": "my-project",
  "createdAt": 1704067200000,
  "lastActive": 1704070800000,
  "config": { "model": "claude-sonnet-4-20250514", "maxTurns": 50 },
  "sessionAlive": true
}
```

#### Update context config

```
POST /api/context/:id/config
Content-Type: application/json

{ "maxTurns": 100, "idleTimeoutMs": 600000 }
```

Merges partial config into existing config. Validates the result.

Response: `200 OK`
```json
{ "contextId": "my-project", "config": { "...merged config..." } }
```

#### List context files

```
GET /api/context/:id/files
```

Response: `200 OK`
```json
{ "contextId": "my-project", "files": ["AGENTS.md", "MEMORY.md", "config.json", "data/report.csv"] }
```

#### List context tasks

```
GET /api/context/:id/tasks?limit=20
```

Response: `200 OK` — Array of task objects for this context.

#### Delete context

```
DELETE /api/context/:id
```

Kills any active session and removes the workspace directory.

Response: `200 OK`
```json
{ "deleted": "my-project" }
```

### Tasks

#### Submit task

```
POST /api/task
Content-Type: application/json

{
  "contextId": "my-project",
  "prompt": "Create a hello world FastAPI app in data/app.py",
  "webhook": "https://example.com/callback",
  "priority": 0
}
```

- `contextId` (required): Target context
- `prompt` (required): Task instruction
- `webhook` (optional): URL to POST result on completion/failure
- `priority` (optional): Higher number = higher priority (default: 0)

Response: `201 Created`
```json
{ "taskId": "abc-123", "status": "queued", "contextId": "my-project" }
```

#### Get task status

```
GET /api/task/:id
```

Response: `200 OK`
```json
{
  "id": "abc-123",
  "contextId": "my-project",
  "prompt": "Create a hello world FastAPI app",
  "status": "completed",
  "result": "Created data/app.py with a FastAPI hello world app.",
  "createdAt": 1704067200000,
  "startedAt": 1704067201000,
  "completedAt": 1704067210000
}
```

Task statuses: `queued`, `running`, `completed`, `failed`

### Webhook Callbacks

When a task completes or fails, if a `webhook` URL was provided, the server POSTs:

```json
{
  "taskId": "abc-123",
  "contextId": "my-project",
  "status": "completed",
  "result": "Task output here"
}
```

On failure:
```json
{
  "taskId": "abc-123",
  "contextId": "my-project",
  "status": "failed",
  "error": "Error message"
}
```

## Examples

### Customer Support Bot

See `examples/customer-support/` for a complete example showing:
- Custom AGENTS.md with support-specific persona and escalation rules
- MCP server config for CRM integration (mock)
- CLI tools for customer lookup and order status
- Sample FAQ and policy data files

To try it:

```bash
# Start the server
npm run dev

# Create the context from the example
curl -X POST http://localhost:3456/api/context \
  -H "Content-Type: application/json" \
  -d "{
    \"contextId\": \"support\",
    \"agentsMd\": $(cat examples/customer-support/AGENTS.md | jq -Rs .),
    \"config\": $(cat examples/customer-support/config.json)
  }"

# Submit a support task
npx tsx src/cli.ts task support "Customer jane@example.com says her order ORD-789 hasn't arrived" --wait
```

## Architecture

```
POST /api/task → Queue (SQLite) → Session Manager → Claude Code SDK
                                        ↓
                              contexts/{id}/
                              ├── AGENTS.md     (persona)
                              ├── MEMORY.md     (persistent memory)
                              ├── config.json   (MCP, env, model)
                              ├── tools/        (CLI scripts)
                              ├── history/      (conversation)
                              └── data/         (working files)
```

Key design decisions:
- Per-context isolation: each context has its own workspace, history, and config
- SQLite task queue: durable, zero external dependencies, survives restarts
- One task per context at a time: prevents race conditions on workspace files
- Parallel across contexts: different contexts execute simultaneously
- Session reuse: idle sessions are kept warm and resumed via SDK
- File-based context: inspectable, editable, versionable with git

## Connectors

The REST API is the universal input. Build connectors on top:

- Slack: Webhook -> POST /api/task
- Web UI: Chat interface -> POST /api/task + poll GET /api/task/:id
- Cron: Scheduled tasks -> POST /api/task
- GitHub: Issue/PR events -> POST /api/task with webhook callback

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3456` | Server port |
| `CORS_ORIGINS` | `*` | Allowed CORS origins |

### Server Startup

```bash
# Development (auto-reload)
npm run dev

# Production
npm run build
npm start

# Custom port
PORT=8080 npm run dev
```

## License

MIT
