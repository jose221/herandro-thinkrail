import { randomUUID } from "node:crypto";
import { BROWSER_LIMITS, type BrowserSession, type BrowserTab } from "@thinkrail/contracts";

interface StoredSession {
	workspaceId: string;
	tabs: BrowserTab[];
	activeTabId: string;
	revision: number;
}

const sessions = new Map<string, StoredSession>();
let publish: (workspaceId: string, session: BrowserSession) => void = () => {};

export function setBrowserPublisher(
	next: (workspaceId: string, session: BrowserSession) => void,
): void {
	publish = next;
}

function assertWorkspaceId(workspaceId: string): void {
	if (
		typeof workspaceId !== "string" ||
		workspaceId.length === 0 ||
		workspaceId.length > 256 ||
		workspaceId.includes("\0")
	) {
		throw new Error("Unknown workspace");
	}
}

export function normalizeBrowserUrl(value: string): string {
	const raw = typeof value === "string" ? value.trim() : "";
	if (raw.length === 0 || raw.length > BROWSER_LIMITS.urlLength) {
		throw new Error("Enter an http(s) URL");
	}
	if (raw.includes("\0")) throw new Error("Enter an http(s) URL");
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		throw new Error("Enter an http(s) URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Enter an http(s) URL");
	}
	if (url.username || url.password) throw new Error("Browser URLs cannot embed credentials");
	return url.toString();
}

function snapshot(session: StoredSession): BrowserSession {
	return {
		workspaceId: session.workspaceId,
		tabs: session.tabs.map((tab) => ({ ...tab })),
		activeTabId: session.activeTabId,
		revision: session.revision,
	};
}

function changed(session: StoredSession): BrowserSession {
	session.revision += 1;
	const value = snapshot(session);
	publish(session.workspaceId, value);
	return value;
}

function newTab(url: string): BrowserTab {
	return { id: randomUUID(), url };
}

function sessionFor(workspaceId: string): StoredSession {
	assertWorkspaceId(workspaceId);
	let session = sessions.get(workspaceId);
	if (!session) {
		const tab = newTab("about:blank");
		session = { workspaceId, tabs: [tab], activeTabId: tab.id, revision: 0 };
		sessions.set(workspaceId, session);
	}
	return session;
}

export function browserSession(workspaceId: string): BrowserSession {
	return snapshot(sessionFor(workspaceId));
}

export function navigateBrowser(workspaceId: string, value: string): BrowserSession {
	const url = normalizeBrowserUrl(value);
	const session = sessionFor(workspaceId);
	const tab = session.tabs.find((candidate) => candidate.id === session.activeTabId);
	if (!tab) throw new Error("Browser tab not found");
	tab.url = url;
	delete tab.title;
	return changed(session);
}

export function openBrowserTab(workspaceId: string, value?: string): BrowserSession {
	const session = sessionFor(workspaceId);
	if (session.tabs.length >= BROWSER_LIMITS.tabs) {
		throw new Error(`A browser session holds at most ${BROWSER_LIMITS.tabs} tabs`);
	}
	const url = value === undefined ? "about:blank" : normalizeBrowserUrl(value);
	const tab = newTab(url);
	session.tabs.push(tab);
	session.activeTabId = tab.id;
	return changed(session);
}

export function closeBrowserTab(workspaceId: string, tabId: string): BrowserSession {
	const session = sessionFor(workspaceId);
	const index = session.tabs.findIndex((tab) => tab.id === tabId);
	if (index < 0) throw new Error("Browser tab not found");
	if (session.tabs.length === 1) {
		session.tabs = [newTab("about:blank")];
		session.activeTabId = session.tabs[0]?.id ?? "";
		return changed(session);
	}
	session.tabs.splice(index, 1);
	if (session.activeTabId === tabId) {
		const next = session.tabs[Math.min(index, session.tabs.length - 1)];
		if (next) session.activeTabId = next.id;
	}
	return changed(session);
}

export function selectBrowserTab(workspaceId: string, tabId: string): BrowserSession {
	const session = sessionFor(workspaceId);
	if (!session.tabs.some((tab) => tab.id === tabId)) throw new Error("Browser tab not found");
	session.activeTabId = tabId;
	return changed(session);
}

export function activeBrowserUrl(workspaceId: string): string {
	const session = sessionFor(workspaceId);
	return session.tabs.find((tab) => tab.id === session.activeTabId)?.url ?? "about:blank";
}

export function forgetBrowserSession(workspaceId: string): void {
	sessions.delete(workspaceId);
}
