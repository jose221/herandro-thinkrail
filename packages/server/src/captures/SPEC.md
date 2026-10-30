---
id: submodule-server-captures
type: submodule-design
status: active
title: captures — bounded screenshots and recordings from workspace tools
parent: module-server
depends-on: [module-contracts]
---

## Responsibility

Persist the screenshots and screen recordings that Browser and Android surface in the chat composer.
The host owns validation, storage, deletion, and expiry; the panels own capture and presentation.

## Boundary

- **Owns:** one bounded file per capture under `~/.thinkrail/captures/<workspace-hash>/`, with PNG,
  JPEG, WebM, or MP4 magic checks, kind/size/duration limits, private file modes, and 24 h pruning on the
  next save. `deleteCapture` removes only a validated UUID under the active workspace.
- **Public surface (barrel):** `saveCapture`, `deleteCapture`.
- **Allowed deps:** `contracts`, Node `crypto`/`fs`/`path`, and `persistence` for the data directory.
- **Forbidden:** accepting arbitrary paths, storing capture bytes in the workspace or session transcript,
  serving captures over HTTP, and inferring workspace ownership from a client-supplied path.
