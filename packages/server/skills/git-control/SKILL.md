---
name: git-control
description: Inspect and operate the workspace Git repository through ThinkRail's Git panel and git_control tools.
---

# Git control

The **Git** panel and `git_control_*` tools share one repository view: status, branches, log, diffs,
staging, commit, fetch, pull, push and branch switches. All paths are workspace-relative and Git runs
inside the workspace worktree, never the project root.

- Read `git_control_status` and `git_control_diff` before changing anything. Preserve unrelated work.
- Stage only the paths the task touches; `git_control_commit` commits the staged index and refuses an
  empty message.
- Commit or push only when the person explicitly asks. Never rewrite history, force-push, or revert
  someone else's changes from a tool call.
- `git_control_pull` is fast-forward only; if it refuses, report the divergence instead of forcing it.
- Branch names and commit SHAs are validated. Keep commit messages factual and conventional.
