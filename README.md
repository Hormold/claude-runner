# Claude Runner

Run AI agents in isolated Docker containers. Fork → customize → deploy.

```
Your app  →  POST /task  →  Claude Runner  →  Docker container  →  Structured JSON
```

## What It Does

You give it a task. It spins up an isolated Docker container, runs a Claude agent with your custom prompts and tools, and returns structured JSON with the result and cost.

- **One container per session** — full isolation between users
- **Session persistence** — agent remembers previous interactions
- **Task queue** — one task at a time per session, rest queued
- **Abort** — kill any running task instantly
- **Structured output** — define your JSON schema in `OUTPUT.md`
- **Custom tools** — drop shell scripts in `agent/tools/`
- **Env passthrough** — pass secrets per session (API keys, tokens)
- **Cost tracking** — every response includes `cost` in USD

## Quick Start

```bash
# 1. Clone and build
git clone https://github.com/Hormold/claude-runner
cd claude-runner
docker build -t claude-runner .

# 2. Set your token
export CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat..."
# or: export ANTHROPIC_API_KEY="sk-ant-api..."

# 3. Start
node server.mjs

# 4. Send a task
curl -X POST http://localhost:3456/task \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "user-1", "message": "Hello, what can you do?"}'
```

## API

### `POST /task` — Submit Task

```json
{
  "sessionId": "user-123",
  "message": "Look up my account, email is jane@example.com",
  "context": "Channel: web-chat",
  "env": { "MY_API_TOKEN": "secret-123" }
}
```

Response:
```json
{
  "taskId": "a1b2c3d4",
  "sessionId": "user-123",
  "output": {
    "action": "reply",
    "response": "You have 1 API call remaining on your free plan.",
    "user": { "name": "Jane Doe", "email": "jane@example.com", "plan": "free" },
    "confidence": 1.0
  },
  "cost": 0.021,
  "duration": 11608,
  "tools": ["Bash"],
  "resumed": false
}
```

### `POST /task/:sessionId/abort` — Abort Task
Kills the container and rejects queued tasks.

### `GET /sessions` — List Sessions
### `GET /session/:id` — Session Details
### `DELETE /session/:id` — Delete Session
### `POST /session/:id/reset` — Reset to Clean State

### `GET /health`

### `WS /stream/:sessionId` — Live Event Stream

Connect via WebSocket to receive real-time events from a session:

```javascript
const ws = new WebSocket('ws://localhost:3456/stream/user-123');

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);

  switch (data.type) {
    case 'connected':    // Session connected, {busy, turns}
    case 'init':         // Agent started, {model, tools}
    case 'thinking':     // Agent thinking, {text} (partial)
    case 'text':         // Agent text output, {text} (partial)
    case 'tool_start':   // Tool called, {tool, input}
    case 'tool_end':     // Tool finished, {result}
    case 'task_complete': // Task done, {output, cost, duration, tools}
    case 'abort':        // Task aborted, {taskId}
  }
};
```

Connect BEFORE sending `/task` to catch all events. Events stream in real-time as the agent works.

## Customization

### 1. Agent Prompt (`agent/AGENTS.md`)

Defines who the agent is and what it can do:

```markdown
# My Agent

You are a website builder assistant.

## Tools
- `tools/update-page.sh <page> <content>` — update a page
- `tools/deploy.sh` — deploy the site

## Rules
- Always confirm changes before deploying
```

### 2. Output Format (`agent/OUTPUT.md`)

Defines the structured JSON the agent must return:

```markdown
# Output Format

Return a JSON object:
{
  "action": "update | deploy | error",
  "changes": ["list of changes made"],
  "summary": "What you did"
}
```

### 3. Tools (`agent/tools/`)

Shell scripts the agent can execute. They receive arguments and should output JSON:

```bash
#!/bin/bash
# tools/update-page.sh <page> <content>
echo "{\"updated\": \"$1\", \"status\": \"ok\"}"
```

### 4. Environment Variables

Pass secrets when creating tasks — they're available inside the container:

```json
{
  "sessionId": "user-1",
  "message": "Deploy my site",
  "env": { "DEPLOY_TOKEN": "abc123", "SITE_ID": "my-site" }
}
```

Your tools access them normally: `$DEPLOY_TOKEN`, `$SITE_ID`.

## How It Works

```
POST /task {sessionId: "alice", message: "..."}
    │
    ▼
┌─────────────────────────┐
│  Task Queue (per session)│  ← one at a time, rest wait
└─────────────┬───────────┘
              │
              ▼
┌─────────────────────────┐
│  Docker Container       │
│                         │
│  /workspace/            │
│    AGENTS.md            │  ← your prompt
│    OUTPUT.md            │  ← output schema
│    tools/               │  ← your scripts
│    data/                │  ← agent workspace
│                         │
│  Claude Agent SDK       │
│    → reads prompts      │
│    → runs tools         │
│    → returns JSON       │
└─────────────┬───────────┘
              │
              ▼
┌─────────────────────────┐
│  Response               │
│  {output, cost, tools}  │
└─────────────────────────┘
```

**Session persistence**: Each session gets its own directory under `sessions/`. The SDK session history is stored in `.claude/` — when you send another task to the same session, the agent picks up where it left off.

**Isolation**: Sessions are fully independent. Different users get different containers, different workspaces, different histories.

## Run Tests

```bash
./test.sh
```

Runs a full cycle: create session → tools → structured output → independent session → resume → reset → delete.

## Use Cases

- **Customer support bot** — tools call your CRM, returns structured responses
- **Website builder** — user says what to change, agent modifies files, returns diff
- **Code review** — agent reads PRs, runs linters, returns structured feedback
- **Data pipeline** — agent processes files, calls APIs, returns results

## License

MIT
