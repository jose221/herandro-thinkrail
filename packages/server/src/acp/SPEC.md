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

Manage explicit ACP chats and Settings-owned authentication as a runtime separate from Pi: launch the
configured local command, negotiate stable ACP v1 or experimental draft ACP v2, forward messages and
client-capability requests, and persist a ThinkRail session identity plus a bounded normalized transcript
for reconnect and history. Authentication is explicit and never handled by collecting credentials in the
browser.

## Boundary

- **Owns:** ACP process/session lifetime, transcript persistence, protocol event projection, and publisher
  injection for host broadcast and addressed terminal-auth delivery. One ACP process is owned per live
  ThinkRail ACP chat. Temporary login connections and terminal-auth PTYs are separately owned,
  short-lived, client-addressed, and never persisted. Pi session state,
  `pi.event`, Pi tools, and the Pi session registry are never read or mutated.
- **Public surface (barrel):** list/create/load/prompt/cancel/delete ACP sessions, remove every ACP child and
  stored session owned by an archived workspace, answer a pending ACP
  permission request, explicitly check a configured executable and discover its model options, authenticate
  or cancel a client login, manage an ephemeral terminal-auth PTY, close all child processes, and install
  the ACP event publisher.
- **Allowed deps:** `contracts`, `persistence`, `log`, `@agentclientprotocol/sdk`, `bun-pty`, and Bun/Node. The host
  injects the validated user ACP definition and the owning workspace cwd; the module never resolves
  projects or workspaces through sibling imports.
- **Forbidden:** repo-sourced command definitions, shell-string execution, implicit package installation,
  auto-approval of ACP permission requests, Pi session ids/events, and imports from `agent`, `settings`,
  `host`, `web`, or launchers.

## Get right

- Start chat processes only after an explicit `acp.session.create`; resolve the configured command on the
  live host PATH and spawn the resolved executable with `args` in the selected workspace cwd and host
  environment, never through a shell. Start temporary auth processes
  only after an explicit Settings action. Close streams and terminate children on delete, connection
  close, cancellation, workspace removal, or host shutdown; wait one second after `SIGTERM`, escalate to `SIGKILL`, then
  wait for close with a bounded second grace period. A missing or failing adapter is a visible typed ACP
  failure, not a Pi-session fallback.
- Negotiate v1 first and retry v2 only when v1 initialization fails; reuse the first successful connection
  instead of spawning a second process, and cache the selected protocol by the configured command and
  arguments. The host-wide `acpStartTimeoutMs` bounds process start, initialization, and session setup;
  it defaults to two minutes, is clamped to one second through ten minutes, and is gated for clients at
  `ACP_START_TIMEOUT_PROTOCOL_VERSION` (v104). Timeouts are reported as
  a distinct client-check issue rather than an executable or handshake failure. Preserve ACP-reported text, thoughts, tool-call
  updates, modes, configuration options (including model categories), usage, and session identity as ACP
  data. `session/new` and v1 `session/load` or v2 `session/resume` provide the initial options; option
  updates and config-option responses replace the complete current set. A v2 resume's reported state
  remains authoritative; a prompt settles on idle after either running or requires-action activity.
  Persist normalized allowlisted transcript rows, not arbitrary protocol payloads or stderr. Transcript,
  plan, command-catalog, configuration, and diagnostic data are bounded. Each ACP prompt must fit the
  transcript's 1,000,000-character budget, including image data; an oversized prompt is rejected before
  dispatch. Pending message-id rows flush into the bounded transcript after 128 unique ids. Rapid session
  updates coalesce before a single-flight asynchronous atomic persistence writer, which is flushed on host
  shutdown. A serialized snapshot above 256 MiB is rejected without replacing the last complete file or
  evicting live records.
- A persisted permission request is transient: after restart, clear it, preserve the transcript, and mark
  the session interrupted so the user can resume or inspect its history. Retention evicts only non-live
  sessions; refuse a new chat when all retained slots belong to live ACP processes.
- Advertise only the client capabilities ThinkRail actually implements. ACP v1 file access is contained to
  the selected worktree; resolve existing symlinks to a contained target, reject dangling write symlinks,
  and revalidate write targets and terminal working directories after the permission wait. File writes
  open without following the final symlink where supported, verify the resolved path and opened-file
  identity before truncating, then write through that handle; multiply-linked targets are rejected. V1
  host filesystem and terminal mutations stay behind ACP permission requests; the UI's explicit response is
  required before an operation proceeds. An agent's `allow_always` response never authorizes later host
  callbacks; each host callback requires its own permission decision. A terminal-create approval shows
  JSON-quoted command and arguments, the worktree-relative cwd, and the ACP-provided environment overrides
  before applying them. Command arguments and environment values are bounded, and cwd is revalidated after
  the approval wait. ACP v2 does not expose the
  filesystem and terminal callbacks controlled by ThinkRail. Adapter-owned tools therefore operate
  outside ThinkRail's workspace containment and permission controls; the ACP Settings UI and README must
  disclose this limitation and identify v2 as experimental. Resume a persisted transcript through v1
  `session/load` or v2 `session/resume` only when initialization advertises support; otherwise retain
  readable history and mark the live run interrupted. Never rebuild an ACP prompt from transcript text.
- The user-owned `AppConfig.acpClients` is the only command source. Droid is configured for
  `droid exec --output-format acp`; Antigravity uses the locally installed `antigravity-acp` adapter. The
  adapter is not downloaded or executed during install, Settings save, or status reads. The host-wide
  catalog is included in `server.welcome` for Settings, so all connected web clients can read command
  arguments; credentials must never be placed in `args`.
- `acp.client.check` is an explicit Settings action and returns only bounded auth method labels and types.
  Agent-managed login reopens the adapter, validates the requested method against that process's
  initialization response, then calls `authenticate`. Terminal login repeats that validation and launches
  the adapter's advertised argv/env directly in an ephemeral PTY; none of those argv/env values cross the
  wire. Terminal starts reserve the global PTY limit during their handshake and remain owned by the
  requesting client; `cancelStart` cancels a pending handshake and stops a PTY that became active before
  its start response reached the client. Disconnect cleanup and host shutdown cancel and await in-progress
  starts. Terminal input and output are addressed only to that client, capped, time-limited, and stopped on
  explicit cancellation or shutdown. Authentication errors never include adapter stderr or raw process
  errors.
- `acp.client.models` serves explicit model discovery from Settings and the composer's ACP picker (which
  requests enabled clients when opened). It creates a temporary ACP session in the selected workspace,
  returns only bounded `category: model` options, and closes the child without persisting a session or
  projecting the options into Pi's provider/model catalog. Executable launch errors are
  distinguished from ACP handshake and protocol failures without returning raw OS error details.
- When a disconnected client's replay-retention window expires, cancel its pending login and stop its
  ephemeral auth terminals.
