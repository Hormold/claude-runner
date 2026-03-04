# Plan: Claude Runner MVP

Implement a production-quality Claude Code orchestration service. The service manages isolated context workspaces with persistent file-based memory, a SQLite task queue, and a REST API for universal input.

**Repository:** Already initialized with skeleton code in `src/`. Architecture docs in `docs/ARCHITECTURE.md`.
**Branch:** This plan creates `feat/mvp` from current state.

## Validation Commands
- `npx tsc --noEmit`
- `npx vitest run --reporter=verbose`
- `curl -s http://localhost:3456/api/health | jq .status` (manual, after `npx tsx src/index.ts`)

---

### Task 1: Core types and config schema validation
Refactor `src/types.ts` to be comprehensive. Add Zod schema validation for `config.json` so invalid configs fail early with clear errors. Add a `defaults.ts` with sensible defaults.

- [x] Add Zod dependency, define `ContextConfigSchema` with all fields validated
- [x] Export validated `parseConfig(raw: unknown): ContextConfig` function
- [x] Add `defaults.ts` with `DEFAULT_CONFIG`, `DEFAULT_AGENTS_MD`, `DEFAULT_MEMORY_MD`
- [x] Add unit tests for config validation (valid, missing fields, extra fields, bad types)

### Task 2: Task queue with full test coverage  
Rewrite `src/queue.ts` to be robust. Add proper error handling, task expiry (stuck tasks), and comprehensive tests.

- [x] Add task expiry: tasks stuck in `running` for >30 min auto-fail
- [x] Add `listAll(limit, offset)` for pagination
- [x] Add `stats()` method: counts by status, oldest queued age
- [x] Add `cleanup(olderThanMs)` to purge old completed/failed tasks
- [x] Write tests: enqueue, dequeue, priority ordering, FIFO within same priority, context isolation, expiry, cleanup, concurrent operations

### Task 3: Context manager with template support
Rewrite `src/context.ts` with template support, validation, and proper file operations.

- [ ] Add `_template/` directory support: new contexts clone from template
- [ ] Validate contextId format (alphanumeric, hyphens, underscores, 1-64 chars)
- [ ] Add `updateConfig(contextId, partial)` for merging config changes
- [ ] Add `listFiles(contextId)` to show workspace contents
- [ ] Use Zod config validation from Task 1 when reading/writing config
- [ ] Write tests: create, create from template, delete, list, update config, path traversal prevention, invalid IDs

### Task 4: History manager with compaction
Rewrite `src/history.ts` with proper structure, compaction for long-running contexts, and tests.

- [ ] Store turns as `{role, content, timestamp, taskId, tokenEstimate}` in JSONL
- [ ] Add `compact(keepLast: number)` — summarize old turns, keep recent ones
- [ ] Add `getStats()` — total turns, estimated tokens, oldest/newest timestamps
- [ ] Add `formatForPrompt(limit)` — format history as markdown context block
- [ ] Write tests: append, getRecent, formatForPrompt, compaction, empty history, large history

### Task 5: Session manager with proper SDK integration
Rewrite `src/session-manager.ts` with correct Claude Code SDK usage, session resume, error handling, and resource management.

- [ ] Properly use `query()` async generator — iterate all messages, handle errors
- [ ] Implement session resume via SDK `resume` option with stored session IDs
- [ ] Add `maxConcurrentSessions` config (default: 5) — reject tasks when full
- [ ] Add proper cleanup on SIGINT/SIGTERM
- [ ] Add execution timeout per task (from config, default 10 min)
- [ ] Emit events: `task:start`, `task:complete`, `task:failed`, `session:created`, `session:expired`
- [ ] Write tests: execute task (mock SDK), session reuse, idle timeout, max concurrent limit, error handling

### Task 6: REST API with proper error handling and validation
Rewrite `src/index.ts` with input validation, proper HTTP status codes, CORS, request logging, and graceful shutdown.

- [ ] Add Zod validation for all request bodies
- [ ] Add request logging middleware (method, path, status, duration)
- [ ] Add CORS support (configurable origins)
- [ ] Add graceful shutdown: stop accepting requests, drain queue, kill sessions
- [ ] Add `GET /api/context/:id/tasks` endpoint (list tasks for context)
- [ ] Add `GET /api/context/:id/files` endpoint (list workspace files)
- [ ] Add `POST /api/context/:id/config` endpoint (update config)
- [ ] Write API integration tests with supertest

### Task 7: CLI client for quick testing
Create a simple CLI client `src/cli.ts` for interacting with the server from terminal.

- [ ] `claude-runner create <contextId> [--agents-md file] [--config file]`
- [ ] `claude-runner task <contextId> <prompt> [--webhook url] [--wait]`
- [ ] `claude-runner status <taskId>`
- [ ] `claude-runner contexts`
- [ ] `claude-runner delete <contextId>`
- [ ] Add `"bin"` entry in package.json
- [ ] `--wait` flag polls until task completes and prints result

### Task 8: Default template and example context
Create a useful default template and an example context showing MCP + tools integration.

- [ ] Create `contexts/_template/AGENTS.md` with good default persona
- [ ] Create `contexts/_template/config.json` with documented defaults
- [ ] Create `contexts/_template/MEMORY.md` with starter content
- [ ] Create `examples/customer-support/` showing: custom AGENTS.md, MCP server config (mock), CLI tool in tools/, sample data files
- [ ] Update README.md with complete documentation, examples, and API reference

### Task 9: Integration tests — end-to-end flow
Write integration tests that verify the full flow: create context → submit task → poll → get result.

- [ ] Test: create context, submit task, poll until complete, verify result
- [ ] Test: submit multiple tasks to same context — sequential execution
- [ ] Test: submit tasks to different contexts — parallel execution  
- [ ] Test: webhook callback fires on completion
- [ ] Test: task failure handling and error reporting
- [ ] Test: context deletion cleans up sessions and files
- [ ] Test: server graceful shutdown with pending tasks
