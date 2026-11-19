import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	activeBrowserUrl,
	browserEngineClearConsole,
	browserEngineClearNetwork,
	browserEngineClick,
	browserEngineConsoleLogs,
	browserEngineElements,
	browserEngineEvaluate,
	browserEngineHighlight,
	browserEngineNavigate,
	browserEngineNetworkLogs,
	browserEnginePressKey,
	browserEngineScreenshot,
	browserEngineStatus,
	browserEngineStorage,
	browserEngineType,
	browserSession,
	closeBrowserTab,
	fetchPageSnapshot,
	listDevServerPorts,
	navigateBrowser,
	openBrowserTab,
	resizeBrowserEngine,
	selectBrowserTab,
} from "../browser";
import { workspaceIdAt } from "./workspaceTools";

const NavigateSchema = Type.Object({
	url: Type.String({ minLength: 1, maxLength: 4_096, description: "http(s) URL to open." }),
});
const OpenTabSchema = Type.Object({
	url: Type.Optional(Type.String({ maxLength: 4_096 })),
});
const TabSchema = Type.Object({ tabId: Type.String({ minLength: 1, maxLength: 256 }) });
const ReadSchema = Type.Object({
	url: Type.Optional(
		Type.String({
			maxLength: 4_096,
			description: "Defaults to the workspace browser's active tab.",
		}),
	),
});
const ScreenshotSchema = Type.Object({
	fullPage: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page." })),
});
const ClickSchema = Type.Object({
	selector: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
	x: Type.Optional(Type.Number({ minimum: 0, maximum: 10_000 })),
	y: Type.Optional(Type.Number({ minimum: 0, maximum: 10_000 })),
});
const TypeSchema = Type.Object({
	selector: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
	text: Type.String({ maxLength: 10_000 }),
	clear: Type.Optional(Type.Boolean()),
	submit: Type.Optional(Type.Boolean({ description: "Press Enter after typing." })),
});
const KeySchema = Type.Object({
	key: Type.String({
		minLength: 1,
		maxLength: 64,
		description: "e.g. Enter, Escape, Tab, ArrowDown",
	}),
});
const EvaluateSchema = Type.Object({
	expression: Type.String({ minLength: 1, maxLength: 20_000 }),
});
const ElementsSchema = Type.Object({
	selector: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});
const ConsoleLogsSchema = Type.Object({
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })),
	level: Type.Optional(
		Type.Union([
			Type.Literal("all"),
			Type.Literal("log"),
			Type.Literal("info"),
			Type.Literal("warn"),
			Type.Literal("error"),
			Type.Literal("debug"),
		]),
	),
	clear: Type.Optional(Type.Boolean()),
});
const NetworkLogsSchema = Type.Object({
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })),
	failedOnly: Type.Optional(Type.Boolean()),
	clear: Type.Optional(Type.Boolean()),
});
const ViewportSchema = Type.Object({
	width: Type.Integer({ minimum: 320, maximum: 1_920 }),
	height: Type.Integer({ minimum: 240, maximum: 1_440 }),
	deviceScaleFactor: Type.Optional(Type.Number({ minimum: 1, maximum: 3 })),
});
const HighlightSchema = Type.Object({
	selector: Type.String({ minLength: 1, maxLength: 1_000 }),
	label: Type.Optional(Type.String({ maxLength: 80 })),
	durationMs: Type.Optional(Type.Integer({ minimum: 200, maximum: 10_000 })),
});

function json(value: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
		details: value,
	};
}

export function browserToolsExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "browser_status",
		label: "Browser Status",
		description:
			"Read the workspace browser session: tabs, active URL, CDP engine state, and detected local development ports.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const workspaceId = workspaceIdAt(ctx.cwd);
			return json({
				session: browserSession(workspaceId),
				engine: browserEngineStatus(),
				ports: await listDevServerPorts(),
			});
		},
	});
	pi.registerTool({
		name: "browser_navigate",
		label: "Navigate Browser",
		description:
			"Open an http(s) URL in the active workspace browser tab. The user sees the live page in ThinkRail.",
		parameters: NavigateSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const workspaceId = workspaceIdAt(ctx.cwd);
			const session = navigateBrowser(workspaceId, params.url);
			if (browserEngineStatus().available) {
				await browserEngineNavigate(workspaceId, params.url).catch(() => {});
			}
			return json(session);
		},
	});
	pi.registerTool({
		name: "browser_open_tab",
		label: "Open Browser Tab",
		description: "Open a new workspace browser tab, optionally navigating to an http(s) URL.",
		parameters: OpenTabSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const workspaceId = workspaceIdAt(ctx.cwd);
			const session = openBrowserTab(workspaceId, params.url);
			if (params.url && browserEngineStatus().available) {
				await browserEngineNavigate(workspaceId, params.url).catch(() => {});
			}
			return json(session);
		},
	});
	pi.registerTool({
		name: "browser_close_tab",
		label: "Close Browser Tab",
		description: "Close one tab of the workspace browser by id.",
		parameters: TabSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return json(closeBrowserTab(workspaceIdAt(ctx.cwd), params.tabId));
		},
	});
	pi.registerTool({
		name: "browser_select_tab",
		label: "Select Browser Tab",
		description: "Bring one workspace browser tab to the front by id.",
		parameters: TabSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return json(selectBrowserTab(workspaceIdAt(ctx.cwd), params.tabId));
		},
	});
	pi.registerTool({
		name: "browser_list_ports",
		label: "List Development Ports",
		description:
			"List local development servers currently listening, with their process and framework. Never probes closed ports.",
		parameters: Type.Object({}),
		async execute() {
			return json(await listDevServerPorts());
		},
	});
	pi.registerTool({
		name: "browser_read_page",
		label: "Read Page",
		description:
			"Fetch an http(s) page as text without a browser engine: status, title, visible text, and links.",
		parameters: ReadSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const workspaceId = workspaceIdAt(ctx.cwd);
			const url = params.url ?? activeBrowserUrl(workspaceId);
			if (url === "about:blank") throw new Error("Open a page in the browser first");
			return json(await fetchPageSnapshot(url));
		},
	});
	pi.registerTool({
		name: "browser_screenshot",
		label: "Browser Screenshot",
		description:
			"Capture a real PNG screenshot of the live Chromium page in the workspace browser.",
		parameters: ScreenshotSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const frame = await browserEngineScreenshot(workspaceIdAt(ctx.cwd), params.fullPage);
			return {
				content: [
					{ type: "image" as const, mimeType: frame.mimeType, data: frame.data },
					{
						type: "text" as const,
						text: `Browser screenshot (${frame.width}×${frame.height}).`,
					},
				],
				details: { width: frame.width, height: frame.height },
			};
		},
	});
	pi.registerTool({
		name: "browser_click",
		label: "Browser Click",
		description:
			"Click an element by CSS selector or viewport (x, y) coordinates on the live page.",
		parameters: ClickSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return json(await browserEngineClick(workspaceIdAt(ctx.cwd), params));
		},
	});
	pi.registerTool({
		name: "browser_type",
		label: "Browser Type",
		description:
			"Type text into an input/element (optionally focusing a CSS selector, clearing first, and pressing Enter).",
		parameters: TypeSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			await browserEngineType(workspaceIdAt(ctx.cwd), params);
			return json({ ok: true });
		},
	});
	pi.registerTool({
		name: "browser_press_key",
		label: "Browser Press Key",
		description: "Press a keyboard key (Enter, Escape, Tab, ArrowDown, etc.) in the live browser.",
		parameters: KeySchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			await browserEnginePressKey(workspaceIdAt(ctx.cwd), params.key);
			return json({ ok: true, key: params.key });
		},
	});
	pi.registerTool({
		name: "browser_evaluate",
		label: "Browser Evaluate JS",
		description:
			"Execute a JavaScript expression in the live page (supports Promises) and return its serialized value.",
		parameters: EvaluateSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return json(await browserEngineEvaluate(workspaceIdAt(ctx.cwd), params.expression));
		},
	});
	pi.registerTool({
		name: "browser_get_elements",
		label: "Browser Get Elements",
		description:
			"List visible interactive DOM elements with CSS selectors, text, roles, and bounding boxes.",
		parameters: ElementsSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return json(
				await browserEngineElements(workspaceIdAt(ctx.cwd), params.selector, params.limit),
			);
		},
	});
	pi.registerTool({
		name: "browser_console_logs",
		label: "Browser Console Logs",
		description: "Read recent DevTools console logs and uncaught exceptions from the live browser.",
		parameters: ConsoleLogsSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const workspaceId = workspaceIdAt(ctx.cwd);
			const logs = browserEngineConsoleLogs(workspaceId, params.limit, params.level);
			if (params.clear) browserEngineClearConsole(workspaceId);
			return json(logs);
		},
	});
	pi.registerTool({
		name: "browser_network_requests",
		label: "Browser Network Requests",
		description:
			"Read recent DevTools network requests, HTTP statuses, durations, and CORS/network errors.",
		parameters: NetworkLogsSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const workspaceId = workspaceIdAt(ctx.cwd);
			const requests = browserEngineNetworkLogs(workspaceId, params.limit, params.failedOnly);
			if (params.clear) browserEngineClearNetwork(workspaceId);
			return json(requests);
		},
	});
	pi.registerTool({
		name: "browser_storage",
		label: "Browser Storage",
		description: "Read localStorage and sessionStorage entries of the active browser page.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			return json(await browserEngineStorage(workspaceIdAt(ctx.cwd)));
		},
	});
	pi.registerTool({
		name: "browser_set_viewport",
		label: "Browser Set Viewport",
		description:
			"Resize the live Chromium viewport (e.g. mobile 390×844, tablet, desktop 1280×800).",
		parameters: ViewportSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			await resizeBrowserEngine(
				workspaceIdAt(ctx.cwd),
				params.width,
				params.height,
				params.deviceScaleFactor,
			);
			return json({ ok: true, width: params.width, height: params.height });
		},
	});
	pi.registerTool({
		name: "browser_highlight",
		label: "Browser Highlight Element",
		description:
			"Visually highlight a DOM element by CSS selector on the live page so the user sees what is being inspected.",
		parameters: HighlightSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			await browserEngineHighlight(
				workspaceIdAt(ctx.cwd),
				params.selector,
				params.label,
				params.durationMs,
			);
			return json({ ok: true });
		},
	});
}
