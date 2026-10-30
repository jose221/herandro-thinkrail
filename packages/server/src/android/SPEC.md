---
id: submodule-server-android
type: submodule-design
status: active
title: android — optional local emulator
parent: module-server
depends-on: [module-contracts, submodule-server-subprocess]
tags: [android, emulator]
---

## Responsibility

Manage one optional, host-local Android SDK emulator for explicit ThinkRail UI and Pi actions. Report
local SDK/AVD readiness, launch a selected AVD, inspect its display/details/logs, perform bounded device
input and install a workspace-contained APK, and stop the emulator after five minutes without activity.

## Boundary

- **Owns:** emulator process lifetime, SDK tool discovery, AVD enumeration, emulator-only ADB targeting,
  bounded screenshots/logs, validated input, and APK path containment.
- **Public surface (barrel):** `AndroidEmulatorManager`, the lazy process-local manager accessors, and the
  default five-minute idle TTL.
- **Allowed deps:** `contracts`, `subprocess`, and Node/Bun APIs.
- **Forbidden:** Pi session state, ACP sessions, physical-device ADB commands, arbitrary shell commands,
  SDK/AVD installation, boot-time emulator launch, and importing the web or host modules.

## Get right

- Construction and status reads never launch a process or install anything. Only an explicit `start`
  action starts an AVD already returned by the local `emulator -list-avds`.
- The service owns only the emulator process it launched and sends every device command through
  `adb -s emulator-<port>`. It never selects a default device, uses `adb -d`, issues `adb kill-server`,
  or forwards arbitrary shell text.
- The AVD starts headless without wiping user data or saving a snapshot. Only explicit device actions
  refresh the inactivity clock; status polling does not. Expiry and host shutdown stop the owned process,
  clear the idle timer, and retain no child or pipe. Status reports the owned process's current CPU and
  resident memory when the host can measure them; measurement never touches the inactivity clock.
- Screenshot and log capture have byte limits while the child pipes continue draining. A truncated
  screenshot is rejected; log output reports truncation. Device input is range-checked, APKs must resolve
  to regular `.apk` files inside the active workspace and are installed from a private snapshot, and every
  process uses argv with `shell: false`.
- Absence of Android SDK tools is a normal unavailable state. ThinkRail does not install the SDK, create
  AVDs, or start an emulator at host boot.
