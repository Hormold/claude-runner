# Plan: Session Isolation

Add proper isolation between context sessions so one context cannot access another's files, secrets, or resources. Critical for multi-tenant deployments.

## Validation Commands
- `npx tsc --noEmit`
- `npx vitest run --reporter=verbose`
- `docker ps` (verify containers)

---

### Task 1: Docker-based session isolation
Replace process-based Claude Code execution with Docker containers per context.

- [x] Create `Dockerfile.context` — minimal image with Claude Code SDK, Node.js
- [x] Add `docker-compose.yml` template for context containers
- [x] Session manager spawns Docker container instead of bare process
- [x] Mount `contexts/{id}/` as the only writable volume
- [x] No access to host filesystem outside the mount
- [x] Container auto-stops after idle timeout
- [x] Container reuse: keep warm containers, reuse for sequential tasks
- [x] Write tests: container lifecycle, filesystem isolation, cleanup

### Task 2: Secret isolation via Docker env injection
Secrets from config.json injected as container env vars, not written to disk.

- [x] Parse `config.json` secrets section
- [x] Pass as `--env` flags to Docker (not in Dockerfile or mounted files)
- [x] Secrets not visible to other contexts (separate containers)
- [x] Add `config.secrets` field (separate from `config.env` for clarity)
- [x] Write tests: secrets available inside container, not on disk, not in other contexts

### Task 3: Network isolation
Restrict container network access per context policy.

- [x] Default: no network access (air-gapped)
- [x] `config.network: "none" | "restricted" | "full"` option
- [x] "restricted": allow only MCP server endpoints (whitelist)
- [x] "full": standard network access
- [x] Use Docker network policies for enforcement
- [x] Write tests: network isolation modes

### Task 4: Resource limits
CPU, memory, and disk limits per context.

- [ ] `config.resources: { cpus, memoryMb, diskMb }` in config.json
- [ ] Map to Docker `--cpus`, `--memory`, `--storage-opt`
- [ ] Default limits: 2 CPUs, 2GB memory, 1GB disk
- [ ] Kill container if limits exceeded
- [ ] Write tests: resource limit enforcement

### Task 5: Fallback mode (no Docker)
Keep process-based execution as fallback for development/trusted environments.

- [ ] `config.isolation: "docker" | "process"` option
- [ ] Process mode: current behavior (cwd-based, no real isolation)
- [ ] Docker mode: full container isolation
- [ ] Auto-detect: use Docker if available, fallback to process
- [ ] Session manager interface stays the same (swap implementation)
- [ ] Write tests: both modes produce same results
