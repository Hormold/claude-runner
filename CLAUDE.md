# CLAUDE.md — Instructions for AI Agents

You are working on **Claude Runner** — a starter template for running AI agents in isolated Docker containers.

## Project Structure

```
server.mjs      — Main HTTP/WebSocket server (task coordinator)
mock-api.mjs    — Example external API (not part of the template, just for testing)
Dockerfile      — Docker image with Claude Agent SDK + curl
test.sh         — Full end-to-end test script
agent/          — Agent configuration (this is what users customize)
  AGENTS.md     — Agent prompt (who it is, what tools it has)
  OUTPUT.md     — Structured output format (JSON schema the agent must return)
  tools/        — Shell scripts the agent can execute
sessions/       — Runtime session data (gitignored, created automatically)
```

## How It Works

1. User sends `POST /task {sessionId, message, env}` to the server
2. Server creates a session directory from `agent/` template (if new)
3. Server spawns a Docker container with the session workspace mounted
4. Inside Docker: Claude Agent SDK reads AGENTS.md + OUTPUT.md, executes the task
5. Agent can run tools from `tools/`, which are shell scripts that call external APIs
6. Container outputs NDJSON events (streamed to WebSocket clients)
7. Final result: structured JSON with `output`, `cost`, `duration`, `tools`
8. Session state persists between tasks (SDK session + workspace files)

## Key Design Decisions

- **Docker per task, not per session**: `docker run --rm` for each task. State persists via volume mounts. This avoids SDK telemetry exit code issues with `docker exec`.
- **CLAUDE_CODE_OAUTH_TOKEN, not ANTHROPIC_API_KEY**: OAuth tokens (sk-ant-oat*) must use this env var. API keys (sk-ant-api*) can use ANTHROPIC_API_KEY.
- **host.docker.internal**: Tools inside Docker call external APIs via `host.docker.internal`. Server adds `--add-host=host.docker.internal:host-gateway`. Mock API must bind `0.0.0.0`.
- **NODE_PATH=/app/node_modules**: Required because SDK is installed in /app but cwd is /workspace.
- **No dependencies on host**: server.mjs uses only Node.js built-ins. No npm install needed for the server itself.
- **WebSocket is native**: No ws/socket.io library. Raw WebSocket handshake + frame encoding.

## When Modifying

### Adding a new API endpoint
Edit `server.mjs` → add route in the `http.createServer` handler.

### Adding a new tool
Create a script in `agent/tools/`. Make it executable. It should:
- Accept arguments via `$1`, `$2`, etc.
- Read env vars for API credentials
- Output JSON to stdout
- Exit 0 on success, non-zero on error

### Changing the output format
Edit `agent/OUTPUT.md`. The agent reads this as part of its system prompt and returns JSON matching your schema.

### Changing the agent behavior
Edit `agent/AGENTS.md`. This is the system prompt — defines personality, rules, available tools.

## Testing

```bash
./test.sh    # Starts mock API + server, runs full cycle, cleans up
```

Tests: health → new session → tools → structured output → isolation → resume → reset → delete → WebSocket streaming → workspace isolation.

## Common Issues

- **"Invalid API key"**: Use `CLAUDE_CODE_OAUTH_TOKEN` for OAuth tokens, not `ANTHROPIC_API_KEY`
- **Tools can't reach API**: Mock API must bind `0.0.0.0`, not just `localhost`
- **`UID` variable conflict**: Don't use `UID` in bash scripts — it's a readonly shell builtin
- **Exit code 1 from SDK**: Often just telemetry 429 errors. Server handles this — if stdout has valid JSON, it's treated as success.
