---
id: submodule-server-browser
type: submodule-design
status: active
title: browser — workspace tabs, dev ports, page reads
parent: module-server
depends-on: [module-contracts]
---

## Responsibility

The host-owned state behind the workspace **Browser** panel and its agent tools. It never launches a
browser engine: the panel renders the active URL in an iframe, while the host remembers tabs and URLs so
the person and the agent share one session, discovers local development listeners, and reads a page as
text for the agent.

## Boundary

- **Owns:** one in-memory session per workspace (bounded to 8 tabs, `about:blank` initial tab), URL
  normalization to `http(s)` (scheme added for host-shaped input, embedded credentials rejected), and a
  `browser.changed` broadcast carrying the complete session after every mutation. Sessions are ephemeral
  and dropped when the workspace is removed. `listDevServerPorts` reads the process table (`lsof`, `ss`
  or Windows `netstat`) and never probes a port; privileged and infrastructure ports are filtered out.
  `fetchPageSnapshot` reads at most 2 MiB over a 15 s bound, strips scripts/styles/markup, resolves
  links, and writes nothing to disk.
- **Public surface (barrel):** `browserSession`, `navigateBrowser`, `openBrowserTab`, `closeBrowserTab`,
  `selectBrowserTab`, `activeBrowserUrl`, `forgetBrowserSession`, `setBrowserPublisher`,
  `listDevServerPorts`, `fetchPageSnapshot`.
- **Allowed deps:** `contracts`, Node `fs`/`crypto`, the subprocess runner.
- **Forbidden:** spawning Chrome, Chromium, Playwright, or any headless engine; reading page cookies or
  credentials; exposing filesystem paths; persisting URLs across host restarts; treating the iframe as
  observable (no console/network capture, screenshots, clicks, or script execution).
