---
id: submodule-server-browser
type: submodule-design
status: active
title: browser — workspace tabs, dev ports, page reads
parent: module-server
depends-on: [module-contracts]
---

## Responsibility

The host-owned state and optional Chrome/Chromium CDP runtime behind the workspace **Browser**
panel and its agent tools. The host remembers tabs and URLs so the person and the agent share one
session, discovers local development listeners, reads a page as text for the agent, and when Chrome/
Chromium is installed on the host runs a shared headless CDP daemon for real-time screencast streaming,
DOM interaction, screenshots, console/network/CORS diagnostics, storage inspection, and element
highlights. When Chrome/Chromium is unavailable, the panel falls back to the embedded iframe view.

## Boundary

- **Owns:** one in-memory session per workspace (bounded to 8 tabs, `about:blank` initial tab), URL
  normalization to `http(s)` (scheme added for host-shaped input, embedded credentials rejected), and a
  `browser.changed` broadcast carrying the complete session after every mutation, plus real-time CDP
  frame/console/network/dialog broadcasts (`browser.frame`, `browser.console`, `browser.network`,
  `browser.dialog`) and 5-minute idle engine shutdown. Sessions are ephemeral and dropped when the
  workspace is removed. `listDevServerPorts` reads the process table (`lsof`, `ss` or Windows
  `netstat`) and never probes a port; privileged and infrastructure ports are filtered out.
  `fetchPageSnapshot` reads at most 2 MiB over a 15 s bound, strips scripts/styles/markup, resolves
  links, and writes nothing to disk.
- **Public surface (barrel):** `browserSession`, `navigateBrowser`, `openBrowserTab`, `closeBrowserTab`,
  `selectBrowserTab`, `activeBrowserUrl`, `forgetBrowserSession`, `setBrowserPublisher`,
  `listDevServerPorts`, `fetchPageSnapshot`, and the CDP engine controls (`browserEngine*`,
  `startBrowserStream`, `stopBrowserStream`, `resizeBrowserEngine`, `setBrowserRealtimePublishers`,
  `stopBrowserEngine`).
- **Allowed deps:** `contracts`, Node `fs`/`crypto`, the subprocess runner, and native `WebSocket` / Chrome CDP.
- **Forbidden:** exposing filesystem paths outside explicit workspace roots; persisting URLs across
  host restarts; polling dev-server ports; importing web or host modules.
