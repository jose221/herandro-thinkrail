---
name: http-requests
description: Exercise HTTP APIs from ThinkRail's request client when the user asks to test an endpoint, validate a response, or reproduce an API failure.
---

# HTTP requests

`http_request_send` sends one request through the host, records it in the workspace history the
**HTTP requests** panel shows, and returns status, headers, cookies, body, size and latency. Use
`http_request_history` and `http_request_history_detail` to inspect earlier user or agent calls, and
`http_request_save` to keep a named request in a collection.

- Start with `GET /health` or the smallest read-only route. Add query parameters, headers and a JSON
  body only when the endpoint needs them.
- Never paste a real secret into a saved request or a message. Reference it from the person's
  configuration; the panel stores headers verbatim.
- Report status, latency and the relevant response fragment. A `4xx` is a contract or input problem;
  a `5xx` points at the service. Check `http_request_history_detail` before retrying blindly.
- Requests are host-side, so `localhost` means the ThinkRail host, not the person's browser.
- Response bodies are bounded; when truncated, say so rather than inventing the rest.
