import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { androidEmulatorToolsExtension } from "./androidTools";

test("registers explicit Android emulator tools only for Pi sessions", () => {
	const names: string[] = [];
	const extension = {
		registerTool: (tool: { name: string }) => names.push(tool.name),
	} as unknown as ExtensionAPI;

	androidEmulatorToolsExtension(extension);

	expect(names).toEqual([
		"android_emulator_list_avds",
		"android_emulator_status",
		"android_emulator_start",
		"android_emulator_stop",
		"android_emulator_details",
		"android_emulator_screenshot",
		"android_emulator_tap",
		"android_emulator_type_text",
		"android_emulator_swipe",
		"android_emulator_install_apk",
		"android_emulator_logs",
	]);
});
