---
id: submodule-server-system
type: submodule-design
status: active
title: system — process sampling, checkpoints, leak analysis
parent: module-server
depends-on: [module-contracts, submodule-server-persistence]
---

## Responsibility

On-demand host telemetry for the workspace **Memory** panel and the `system_memory_*` tools: a process
snapshot classified by role and workspace, bounded checkpoints, and a heuristic growth analysis. There is
no background sampler.

## Boundary

- **Owns:** `ps`-based sampling (macOS/Linux) with a 1 s in-process cache, host memory/load/CPU facts,
  process attribution by workspace worktree path, and role classification (`host`, `terminal`,
  `dev-server`, `android`, `other`). Checkpoints keep the 120 largest processes, are capped at 100 and
  stored atomically in one versioned JSON file. Analysis compares the oldest and newest checkpoints and
  flags a process that grew at least 15 MiB and 20% across at least two samples; one suspect is WARNING,
  two or a 60 MiB delta is LEAK_DETECTED. Command lines are best-effort redacted for secret-looking flags,
  bearer tokens, and token-like query values before they leave the module. Termination accepts only a PID present in the current snapshot
  that is a host/terminal/dev-server/android process or attributed to a workspace; the host and its
  parent are always refused. Windows reports `supported: false` instead of guessing.
- **Public surface (barrel):** `systemResourceSnapshot`, `captureMemoryCheckpoint`,
  `listMemoryCheckpoints`, `analyzeMemory`, `killMonitoredProcess`.
- **Allowed deps:** `contracts`, `persistence.dataDir()`, `projects`/`workspaces` lookup, the subprocess
  runner, Node `fs`/`os`/`crypto`.
- **Forbidden:** a polling timer that outlives a request, shell interpolation, killing arbitrary system
  PIDs, persisting raw command lines with secrets, or inventing memory numbers when sampling fails.
