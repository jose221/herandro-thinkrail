import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { browserToolsExtension } from "./browserTools";
import { gitControlToolsExtension } from "./gitControlTools";
import { httpRequestToolsExtension } from "./httpRequestTools";
import { memoryToolsExtension } from "./memoryTools";

function namesOf(extension: (pi: ExtensionAPI) => void): string[] {
	const names: string[] = [];
	extension({
		registerTool: (tool: { name: string }) => names.push(tool.name),
	} as unknown as ExtensionAPI);
	return names;
}

test("browser tools stay scoped to the workspace browser", () => {
	expect(namesOf(browserToolsExtension)).toEqual([
		"browser_status",
		"browser_navigate",
		"browser_open_tab",
		"browser_close_tab",
		"browser_select_tab",
		"browser_list_ports",
		"browser_read_page",
	]);
});

test("http request tools share the visible request history", () => {
	expect(namesOf(httpRequestToolsExtension)).toEqual([
		"http_request_send",
		"http_request_history",
		"http_request_history_detail",
		"http_request_saved_list",
		"http_request_save",
	]);
});

test("memory tools expose status, checkpoints, analysis and termination", () => {
	expect(namesOf(memoryToolsExtension)).toEqual([
		"system_memory_status",
		"system_memory_checkpoint",
		"system_memory_checkpoints",
		"system_memory_analyze",
		"system_process_kill",
	]);
});

test("git tools cover inspection and explicit commit actions", () => {
	expect(namesOf(gitControlToolsExtension)).toEqual([
		"git_control_status",
		"git_control_branches",
		"git_control_log",
		"git_control_diff",
		"git_control_stage",
		"git_control_unstage",
		"git_control_commit",
		"git_control_fetch",
		"git_control_pull",
		"git_control_push",
		"git_control_create_branch",
		"git_control_switch_branch",
		"git_control_show_commit",
	]);
});
