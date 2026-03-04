# Claude Runner

Run Claude Code as a service. Persistent file-based contexts, task queue, REST API.

## Quick Start

```bash
npm install
npm run dev
```

Server starts at `http://localhost:3456`.

## Usage

### 1. Create a context

```bash
curl -X POST http://localhost:3456/api/context \
  -H "Content-Type: application/json" \
  -d '{
    "contextId": "my-project",
    "agentsMd": "# Agent\nYou are a Python expert.",
    "config": {
      "model": "claude-sonnet-4-20250514",
      "idleTimeoutMs": 300000
    }
  }'
```

### 2. Submit a task

```bash
curl -X POST http://localhost:3456/api/task \
  -H "Content-Type: application/json" \
  -d '{
    "contextId": "my-project",
    "prompt": "Create a hello world FastAPI app in data/app.py"
  }'
```

### 3. Check task status

```bash
curl http://localhost:3456/api/task/{taskId}
```

### 4. Add tools & MCP servers

Edit `contexts/my-project/config.json`:

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
  }
}
```

Add CLI scripts to `contexts/my-project/tools/`.

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

- **Per-context isolation**: each context has its own workspace, history, and config
- **Task queue**: FIFO per context, parallel across contexts
- **Idle timeout**: sessions expire after 5 min (configurable)
- **Webhook callbacks**: optional POST on task completion
- **Persistent memory**: agent reads/writes MEMORY.md between tasks

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/context` | Create a new context |
| `GET` | `/api/context` | List all contexts |
| `GET` | `/api/context/:id` | Get context info |
| `DELETE` | `/api/context/:id` | Delete context |
| `POST` | `/api/task` | Submit a task |
| `GET` | `/api/task/:id` | Get task status/result |
| `GET` | `/api/health` | Health check |

## Connectors

The REST API is the universal input. Build connectors on top:

- **Slack**: Webhook → POST /api/task
- **Web UI**: Chat interface → POST /api/task + poll GET /api/task/:id
- **Cron**: Scheduled tasks → POST /api/task

## License

MIT
