# Quick Start — Build Your Own Agent in 5 Minutes

## 1. Fork & Clone

```bash
# Fork on GitHub, then:
git clone https://github.com/YOUR_USERNAME/claude-runner
cd claude-runner
```

## 2. Build Docker Image

```bash
docker build -t claude-runner .
```

This installs the Claude Agent SDK + curl inside a slim Node.js container.

## 3. Set Your API Token

```bash
# Option A: OAuth token (from Claude.ai subscription)
export CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat..."

# Option B: API key (from console.anthropic.com)
export ANTHROPIC_API_KEY="sk-ant-api..."
```

## 4. Write Your Agent

### Define who it is (`agent/AGENTS.md`)

```markdown
# My Agent

You are a deployment assistant for our web platform.

## Tools
- `tools/deploy.sh <environment>` — deploy to staging or production
- `tools/status.sh` — check current deployment status
- `tools/rollback.sh <version>` — rollback to a previous version

## Rules
- Always check status before deploying
- Never deploy to production without explicit confirmation
- Keep responses concise
```

### Define what it returns (`agent/OUTPUT.md`)

```markdown
# Output Format

Return a JSON object as your final message:

{
  "action": "deploy | rollback | status | error",
  "environment": "staging | production",
  "summary": "What you did or found",
  "requires_confirmation": true/false
}
```

### Add your tools (`agent/tools/`)

```bash
#!/bin/bash
# agent/tools/deploy.sh
ENV="${1:?Usage: deploy.sh <environment>}"
curl -s -X POST -H "Authorization: Bearer $DEPLOY_TOKEN" \
  "$PLATFORM_API/deploy" -d "{\"env\":\"$ENV\"}"
```

```bash
#!/bin/bash
# agent/tools/status.sh
curl -s -H "Authorization: Bearer $DEPLOY_TOKEN" \
  "$PLATFORM_API/status"
```

Make them executable: `chmod +x agent/tools/*.sh`

## 5. Start the Server

```bash
node server.mjs
```

## 6. Send a Task

```bash
curl -X POST http://localhost:3456/task \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "user-42",
    "message": "Deploy the latest version to staging",
    "env": {
      "DEPLOY_TOKEN": "your-deploy-token",
      "PLATFORM_API": "http://host.docker.internal:8080"
    }
  }'
```

Response:
```json
{
  "taskId": "a1b2c3d4",
  "sessionId": "user-42",
  "output": {
    "action": "deploy",
    "environment": "staging",
    "summary": "Deployed v2.1.0 to staging successfully",
    "requires_confirmation": false
  },
  "cost": 0.03,
  "duration": 15000,
  "tools": ["Bash"],
  "resumed": false
}
```

## 7. Add Real-Time Streaming (Optional)

```javascript
// Connect WebSocket BEFORE sending task
const ws = new WebSocket('ws://localhost:3456/stream/user-42');

ws.onmessage = ({ data }) => {
  const event = JSON.parse(data);
  
  if (event.type === 'thinking') console.log('💭', event.text);
  if (event.type === 'text') process.stdout.write(event.text);
  if (event.type === 'tool_start') console.log('🔧', event.tool);
  if (event.type === 'task_complete') console.log('✅ Done!', event.output);
};
```

## 8. Run the Example Test

```bash
./test.sh
```

This starts a mock API server, creates sessions, tests tools + structured output + resume + WebSocket streaming, and verifies everything works.

---

## Key Concepts

| Concept | Where | What |
|---------|-------|------|
| Agent prompt | `agent/AGENTS.md` | Who the agent is, what it can do |
| Output format | `agent/OUTPUT.md` | JSON schema the agent must return |
| Tools | `agent/tools/*.sh` | Shell scripts that call your APIs |
| Env vars | `POST /task → env` | Secrets passed to the container |
| Sessions | `sessions/<id>/` | Auto-created, persist between tasks |
| WebSocket | `ws://server/stream/<id>` | Real-time events from the agent |

## Tips

- **Tools should call APIs, not hardcode data** — the agent can read your scripts, so don't put mock data in them
- **Use `host.docker.internal`** for APIs running on the host machine
- **One tool = one script** — keep them focused and composable
- **Test your tools manually first** before letting the agent use them:
  ```bash
  DEPLOY_TOKEN=test PLATFORM_API=http://localhost:8080 ./agent/tools/status.sh
  ```
- **Check `sessions/<id>/state.json`** to see session metadata (turns, cost, timestamps)
