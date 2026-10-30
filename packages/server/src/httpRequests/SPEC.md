---
id: submodule-server-http-requests
type: submodule-design
status: active
title: httpRequests — host-side request client and history
parent: module-server
depends-on: [module-contracts, submodule-server-persistence]
---

## Responsibility

The host side of the workspace **HTTP requests** panel and the `http_request_*` tools: execute one
request from the host (so CORS does not apply and `localhost` means the host), bound the response, and
keep a per-workspace history plus named saved requests.

## Boundary

- **Owns:** method/URL/header/query/body validation (`http(s)` only, bounded counts and lengths), body
  typing (`none`, `json`, `text`, `urlencoded`), a 1–120 s timeout, bounded response reads (1 MiB chars),
  response cookies parsed from `Set-Cookie` without persistence, and one history entry per attempt
  including network failures (`status: 0`). History is capped at 50 entries per workspace (200 globally)
  with 16 KiB of each stored body; saved requests are capped at 200 overall. Persistence is one versioned JSON document under
  the app data dir (mode `0600`), written atomically and serialized in-process. History summaries never
  include bodies, and stored request/response headers redact `Authorization`, `Cookie`/`Set-Cookie` and
  API-key headers; live responses still show them to the caller.
- **Public surface (barrel):** `executeHttpRequest`, `listHttpHistory`, `getHttpHistory`,
  `clearHttpHistory`, `listSavedHttpRequests`, `saveHttpRequest`, `deleteSavedHttpRequest`.
- **Allowed deps:** `contracts`, `persistence.dataDir()`, Node `fs`/`crypto`, global `fetch`.
- **Forbidden:** following `file:`/other schemes, persisting cookies or credentials separately, proxying
  arbitrary WebSocket traffic, or letting one workspace read another workspace's history.
