import { afterEach, expect, test } from "bun:test";
import type { BrowserSession } from "@thinkrail/contracts";
import {
	browserSession,
	closeBrowserTab,
	forgetBrowserSession,
	navigateBrowser,
	openBrowserTab,
	setBrowserPublisher,
} from "./session";

const workspaceId = "workspace-1";

afterEach(() => {
	forgetBrowserSession(workspaceId);
	setBrowserPublisher(() => {});
});

test("browser URLs accept http(s) and gain a scheme", () => {
	expect(navigateBrowser(workspaceId, "localhost:3000").tabs[0]?.url).toBe(
		"http://localhost:3000/",
	);
	expect(navigateBrowser(workspaceId, "https://example.com/docs").tabs[0]?.url).toBe(
		"https://example.com/docs",
	);
});

test("browser URLs reject other schemes, credentials and empty values", () => {
	expect(() => navigateBrowser(workspaceId, "")).toThrow("http(s)");
	expect(() => navigateBrowser(workspaceId, "file:///etc/passwd")).toThrow("http(s)");
	expect(() => navigateBrowser(workspaceId, "https://user:secret@example.com")).toThrow(
		"credentials",
	);
});

test("browser changes publish a complete session snapshot", () => {
	const published: BrowserSession[] = [];
	setBrowserPublisher((_workspace, session) => published.push(session));
	const next = navigateBrowser(workspaceId, "http://localhost:5173");
	expect(published).toHaveLength(1);
	expect(next).toMatchObject({
		workspaceId,
		tabs: [{ url: "http://localhost:5173/" }],
		revision: 1,
	});
});

test("tabs are bounded and closing the last one resets it", () => {
	for (let index = 0; index < 7; index += 1) openBrowserTab(workspaceId);
	expect(browserSession(workspaceId).tabs).toHaveLength(8);
	expect(() => openBrowserTab(workspaceId)).toThrow("at most 8 tabs");
	const session = browserSession(workspaceId);
	for (const tab of session.tabs.slice(0, -1)) closeBrowserTab(workspaceId, tab.id);
	const last = browserSession(workspaceId).tabs[0];
	if (!last) throw new Error("missing tab");
	const reset = closeBrowserTab(workspaceId, last.id);
	expect(reset.tabs).toHaveLength(1);
	expect(reset.tabs[0]?.url).toBe("about:blank");
});
