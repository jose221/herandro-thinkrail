import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getAndroidEmulatorManager } from "../android";

const EmptySchema = Type.Object({});
const AvdSchema = Type.Object({ avdName: Type.String({ maxLength: 128 }) });
const TapSchema = Type.Object({
	x: Type.Integer({ minimum: 0, maximum: 100_000 }),
	y: Type.Integer({ minimum: 0, maximum: 100_000 }),
});
const TextSchema = Type.Object({ text: Type.String({ minLength: 1, maxLength: 2000 }) });
const SwipeSchema = Type.Object({
	x1: Type.Integer({ minimum: 0, maximum: 100_000 }),
	y1: Type.Integer({ minimum: 0, maximum: 100_000 }),
	x2: Type.Integer({ minimum: 0, maximum: 100_000 }),
	y2: Type.Integer({ minimum: 0, maximum: 100_000 }),
	durationMs: Type.Optional(Type.Integer({ minimum: 50, maximum: 10_000 })),
});
const InstallSchema = Type.Object({
	path: Type.String({ minLength: 1, maxLength: 1000, description: "Workspace-relative APK path." }),
});
const LogsSchema = Type.Object({
	lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
});

function textResult(text: string, details: unknown = null) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function jsonResult(value: unknown) {
	return textResult(JSON.stringify(value, null, 2), value);
}

export function androidEmulatorToolsExtension(pi: ExtensionAPI): void {
	const manager = getAndroidEmulatorManager();
	pi.registerTool({
		name: "android_emulator_list_avds",
		label: "List Android AVDs",
		description: "List Android virtual devices already installed on this host. Does not start one.",
		parameters: EmptySchema,
		async execute() {
			const avds = await manager.listAvds();
			return jsonResult(avds);
		},
	});
	pi.registerTool({
		name: "android_emulator_status",
		label: "Android Emulator Status",
		description: "Read Android SDK availability and the ThinkRail-managed emulator state.",
		parameters: EmptySchema,
		async execute() {
			return jsonResult(await manager.status());
		},
	});
	pi.registerTool({
		name: "android_emulator_start",
		label: "Start Android Emulator",
		description: "Explicitly start one already-installed Android AVD in ThinkRail.",
		parameters: AvdSchema,
		async execute(_id, params) {
			return jsonResult(await manager.start(params.avdName));
		},
	});
	pi.registerTool({
		name: "android_emulator_stop",
		label: "Stop Android Emulator",
		description: "Stop the Android emulator that ThinkRail started.",
		parameters: EmptySchema,
		async execute() {
			return jsonResult(await manager.stop());
		},
	});
	pi.registerTool({
		name: "android_emulator_details",
		label: "Android Emulator Details",
		description: "Read Android version, model, resolution, and density from the managed emulator.",
		parameters: EmptySchema,
		async execute() {
			return jsonResult(await manager.details());
		},
	});
	pi.registerTool({
		name: "android_emulator_screenshot",
		label: "Android Emulator Screenshot",
		description: "Capture the managed emulator screen as a bounded PNG image.",
		parameters: EmptySchema,
		async execute() {
			const screenshot = await manager.screenshot();
			return {
				content: [
					{
						type: "image" as const,
						mimeType: screenshot.mimeType,
						data: screenshot.data,
					},
					{
						type: "text" as const,
						text: `Android emulator screenshot (${screenshot.width}×${screenshot.height}).`,
					},
				],
				details: { width: screenshot.width, height: screenshot.height },
			};
		},
	});
	pi.registerTool({
		name: "android_emulator_tap",
		label: "Tap Android Emulator",
		description: "Tap a screen coordinate on the managed emulator.",
		parameters: TapSchema,
		async execute(_id, params) {
			await manager.tap(params.x, params.y);
			return textResult(`Tapped (${params.x}, ${params.y}).`);
		},
	});
	pi.registerTool({
		name: "android_emulator_type_text",
		label: "Type Into Android Emulator",
		description: "Type bounded text into the focused control on the managed emulator.",
		parameters: TextSchema,
		async execute(_id, params) {
			await manager.typeText(params.text);
			return textResult("Text entered.");
		},
	});
	pi.registerTool({
		name: "android_emulator_swipe",
		label: "Swipe Android Emulator",
		description: "Swipe between screen coordinates on the managed emulator.",
		parameters: SwipeSchema,
		async execute(_id, params) {
			await manager.swipe(params.x1, params.y1, params.x2, params.y2, params.durationMs);
			return textResult("Swipe completed.");
		},
	});
	pi.registerTool({
		name: "android_emulator_install_apk",
		label: "Install Android APK",
		description: "Install a regular APK file from the active workspace onto the managed emulator.",
		parameters: InstallSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			await manager.installApk(ctx.cwd, params.path);
			return textResult("APK installed.");
		},
	});
	pi.registerTool({
		name: "android_emulator_logs",
		label: "Android Emulator Logs",
		description: "Read a bounded number of recent Android logcat lines from the managed emulator.",
		parameters: LogsSchema,
		async execute(_id, params) {
			const logs = await manager.logs(params.lines);
			return textResult(logs.text, { truncated: logs.truncated });
		},
	});
}
