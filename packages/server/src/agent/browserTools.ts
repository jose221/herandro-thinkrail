import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	activeBrowserUrl,
	browserSession,
	closeBrowserTab,
	fetchPageSnapshot,
	listDevServerPorts,
	navigateBrowser,
	openBrowserTab,
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
			"Read the workspace browser session: tabs, active URL, and detected local development ports.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const workspaceId = workspaceIdAt(ctx.cwd);
			return json({
				session: browserSession(workspaceId),
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
			return json(navigateBrowser(workspaceIdAt(ctx.cwd), params.url));
		},
	});
	pi.registerTool({
		name: "browser_open_tab",
		label: "Open Browser Tab",
		description: "Open a new workspace browser tab, optionally navigating to an http(s) URL.",
		parameters: OpenTabSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return json(openBrowserTab(workspaceIdAt(ctx.cwd), params.url));
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
			"Fetch an http(s) page as text without a browser engine: status, title, visible text, and links. Use it for documentation or to check a local dev route.",
		parameters: ReadSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const workspaceId = workspaceIdAt(ctx.cwd);
			const url = params.url ?? activeBrowserUrl(workspaceId);
			if (url === "about:blank") throw new Error("Open a page in the browser first");
			return json(await fetchPageSnapshot(url));
		},
	});
}
