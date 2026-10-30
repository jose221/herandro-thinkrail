---
name: browser
description: Inspect local dev servers and pages in ThinkRail's embedded browser when the user asks to open, preview, or check a web UI.
---

# Embedded browser

The workspace **Browser** panel renders pages in an iframe; the host owns the tab list and URL so the
agent and the person see the same session. `browser_navigate` opens a page, `browser_open_tab`,
`browser_close_tab` and `browser_select_tab` manage tabs, and `browser_status` reports tabs plus
detected local ports. `browser_read_page` fetches the page from the host and returns its status, title,
visible text and links without executing scripts.

- Prefer `browser_list_ports` or `browser_status` before guessing a local URL. Development servers are
  usually on `:3000`, `:5173`, `:8000` or the port the person already mentioned.
- Navigate only `http`/`https` URLs. Use `browser_read_page` for documentation or to confirm a route;
  it is text-only and never runs the page's JavaScript.
- The browser does not run when the panel is hidden; a suspended panel is resumed by the person.
  Do not claim to have viewed pixels or console output: this build has no screenshot or DevTools stream.
- Defer to the person for clicking, typing, or filling forms. If a page refuses framing, say so and
  offer the equivalent HTTP request instead.
