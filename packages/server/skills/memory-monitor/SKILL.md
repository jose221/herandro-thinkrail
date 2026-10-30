---
name: memory-monitor
description: Measure and diagnose workspace memory or CPU growth with ThinkRail's resource monitor when the user mentions a leak, high RAM, or stability.
---

# Memory monitor

`system_memory_status` returns host memory, load average and the workspace processes with RSS, CPU,
role and PID. `system_memory_checkpoint` captures a named baseline, `system_memory_checkpoints` lists
them, and `system_memory_analyze` compares them for sustained growth. `system_process_kill` stops one
detected workspace or development process; it refuses the ThinkRail host and unknown system processes.

- Capture a checkpoint while idle, run the workload, then capture a second one. Three points are
  better when the first pair is ambiguous.
- Treat a single large allocation as a cache until repeated checkpoints keep growing. Report the
  delta, the percentage and the number of samples, not just "high memory".
- Diagnose before killing anything: identify the process and explain the consequence. Prefer SIGTERM.
- Sampling is on demand; it does not keep a background profiler running. On Windows, process sampling
  is unavailable and the snapshot says so.
