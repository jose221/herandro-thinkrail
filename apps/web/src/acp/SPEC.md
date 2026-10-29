---
id: submodule-web-acp
type: submodule-design
status: active
title: acp — native ACP chats
parent: module-web
depends-on: [module-contracts]
tags: [acp, ui]
---

## Responsibility

Render and operate ACP chat resources as a separate chat kind: create from an explicit configured agent,
hydrate ACP history, display protocol updates and permission requests, and send/cancel/delete through the
typed host transport.

## Boundary

- **Owns:** ACP chat body, ACP-specific session runtime and message projection, permission prompts, and
  ACP creation affordances. The ACP store owns its session summaries, snapshots, streaming drafts and
  generation fences. ACP ids and snapshots remain separate from `sessions`, Pi transcript types,
  Pi model selection, and `ChatView`.
- **Public surface:** ACP chat renderer and creation controls consumed by the shell/workbench.
- **Allowed deps:** contracts, store, transport, components (`QuietScrollArea`), `@thinkrail/ui/*`,
  `@thinkrail/locales`, React, and Remix icons.
- **Forbidden:** server/shared/pi imports, Pi session methods or message renderers, launcher detection, and
  changing the existing Pi new-chat path.

## Get right

- A workspace ACP placement uses a distinct `acp-chat` layout kind and the route carries an opaque ACP id;
  neither may hydrate through `session.list` or `session.getMessages`. All new ACP controls are hidden until
  `ACP_PROTOCOL_VERSION` arrives in the current welcome.
- ACP text, thoughts, tool activity, usage, permission choices, modes, configuration options, and prompt
  state come from ACP events. Options with category `model` appear as a model selector beside the mode
  control, using the agent's live option list and `session/set_config_option`; they do not use Pi's model
  catalog. Rendered user-facing chrome is localized; agent/tool output is never translated.
  catalog. Settings lists those options per ACP client only after an explicit discovery action; results
  remain local to ACP settings and never enter Pi provider/model state. Rendered user-facing chrome is
  localized; agent/tool output is never translated.
  only `acp.session.get`, never Pi session methods.
- A reconnect rehydrates the host's ACP snapshot before applying live updates for the new generation.
  Events received during hydration are buffered with a bound, replayed onto the snapshot, and discarded
  when the request or connection generation becomes stale.
- Only safe raster image MIME types render as inline data images; agent output is never treated as trusted
  markup.
