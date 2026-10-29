---
id: submodule-server-acp
type: submodule-design
status: active
title: acp — external ACP chat sessions
parent: module-server
depends-on: [module-contracts]
tags: [acp]
---

## Responsibility

Manage explicit ACP chats as a runtime separate from Pi: launch the configured local command, negotiate
the stable ACP wire protocol, forward messages and client-capability requests, and persist a ThinkRail
session identity plus a bounded normalized transcript for reconnect and history.

## Boundary

- **Owns:** ACP process/session lifetime, transcript persistence, protocol event projection, and publisher
  injection for host broadcast. One ACP process is owned per live ThinkRail ACP chat. Pi session state,
  `pi.event`, Pi tools, and the Pi session registry are never read or mutated.
- **Public surface (barrel):** list/create/load/prompt/cancel/delete ACP sessions, answer a pending ACP
  permission request, explicitly check a configured executable, explicitly discover its model options,
  close all child processes, and install the ACP event publisher.
- **Allowed deps:** `contracts`, `persistence`, `log`, `@agentclientprotocol/sdk`, and Bun/Node. The host
  injects the validated user ACP definition and the owning workspace cwd; the module never resolves
  projects or workspaces through sibling imports.
- **Forbidden:** repo-sourced command definitions, shell-string execution, implicit package installation,
  auto-approval of ACP permission requests, Pi session ids/events, and imports from `agent`, `settings`,
  `host`, `web`, or launchers.

## Get right

- Start only after an explicit `acp.session.create`; spawn `[command, ...args]` with the selected
  workspace cwd and host environment, never through a shell. Close the streams and kill the child on
  delete, process exit, or host shutdown. A missing or failing adapter is a visible typed ACP failure,
  not a Pi-session fallback.
- Negotiate ACP once, then preserve ACP-reported text, thoughts, tool-call updates, modes, configuration
  options (including model categories), usage, and session identity as ACP data. `session/new` and
  `session/load` provide the initial options; option updates and `session/set_config_option` responses
  replace the complete current set. Persist normalized allowlisted transcript rows, not arbitrary protocol
  payloads or stderr. Bounds apply to frame size, retained transcript, and captured diagnostics.
- Advertise only the client capabilities ThinkRail actually implements. ACP file access is contained to
  the selected worktree; resolve existing symlinks to a contained target, reject dangling write symlinks,
  and revalidate write targets and terminal working directories after the permission wait. Tool/terminal
  mutations stay behind ACP permission requests; the UI's explicit response is required before an
  mutations stay behind ACP permission requests; the UI's explicit response is required before an
  operation proceeds. An agent's `allow_always` response never authorizes later host file or terminal
  callbacks; each host callback requires its own permission decision.
  transcript and call `session/load` only when the agent advertised it; otherwise retain readable history
  and mark the live run interrupted. Never rebuild an ACP prompt from transcript text.
- The user-owned `AppConfig.acpClients` is the only command source. Droid is configured for
  `droid exec --output-format acp`; Antigravity uses the locally installed `antigravity-acp` adapter. The
  adapter is not downloaded or executed during install, Settings save, or status reads.
- `acp.client.models` is an explicit Settings action. It creates a temporary ACP session in the selected
  workspace, returns only bounded `category: model` options, and closes the child without persisting a
  session or projecting the options into Pi's provider/model catalog. Executable launch errors are
  distinguished from ACP handshake and protocol failures without returning raw OS error details.
