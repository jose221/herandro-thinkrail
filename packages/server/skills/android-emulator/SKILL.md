---
name: android-emulator
description: Control ThinkRail's optional local Android emulator for requested Android testing.
---

# Android emulator

Use the `android_emulator_*` tools only when the user asks to inspect or operate an Android emulator.
They control the ThinkRail-managed AVD and never expose a general shell or arbitrary ADB command.

- Check `android_emulator_status` and `android_emulator_list_avds` first. If the Android SDK or emulator
  executable is unavailable, report that clearly. Do not install the SDK, create an AVD, or start an
  emulator unless the task calls for it.
- Start only an AVD returned by `android_emulator_list_avds`, and only to fulfill the user's request.
  Startup returns promptly; check status again until it reports `running`.
- Use `android_emulator_screenshot` to inspect the screen, `android_emulator_tap`,
  `android_emulator_type_text`, and `android_emulator_swipe` for bounded input. Use device details and
  logs only when relevant to the requested test.
- Install only a workspace-relative `.apk` through `android_emulator_install_apk`. The host rejects
  paths outside the active workspace and files larger than 256 MiB.
- The emulator stops after five minutes without an inspection or control action. Status checks do not
  extend the idle timer. Stop it when testing is complete.
- Never target a physical device, use an implicit/default ADB target, run arbitrary `adb shell`, wipe
  emulator data, or install packages outside the workspace.
