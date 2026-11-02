import type { EventEmitter } from "node:events";
import type Electrobun from "electrobun/main";

type NavigationEvent = ReturnType<
	(typeof Electrobun.events.events.webview)["willNavigate" | "newWindowOpen"]
>;

const MAX_NAVIGATION_DETAIL_LENGTH = 64 * 1024;

export function isLocalNavigationUrl(url: URL, origin: string): boolean {
	try {
		const parsedOrigin = new URL(origin);
		if (url.origin === parsedOrigin.origin) return true;
	} catch {}
	const host = url.hostname.toLowerCase();
	return (
		(url.protocol === "http:" || url.protocol === "https:") &&
		(host === "localhost" ||
			host === "127.0.0.1" ||
			host === "0.0.0.0" ||
			host === "[::1]" ||
			host === "::1")
	);
}

export function desktopNavigationRules(origin: string): string[] {
	return [
		"^*",
		`${origin}/*`,
		"http://localhost",
		"http://localhost/*",
		"http://localhost:*",
		"http://localhost:*/*",
		"https://localhost",
		"https://localhost/*",
		"https://localhost:*",
		"https://localhost:*/*",
		"http://127.0.0.1",
		"http://127.0.0.1/*",
		"http://127.0.0.1:*",
		"http://127.0.0.1:*/*",
		"https://127.0.0.1",
		"https://127.0.0.1/*",
		"https://127.0.0.1:*",
		"https://127.0.0.1:*/*",
		"http://0.0.0.0",
		"http://0.0.0.0/*",
		"http://0.0.0.0:*",
		"http://0.0.0.0:*/*",
		"https://0.0.0.0",
		"https://0.0.0.0/*",
		"https://0.0.0.0:*",
		"https://0.0.0.0:*/*",
		"http://[::1]",
		"http://[::1]/*",
		"http://[::1]:*",
		"http://[::1]:*/*",
		"https://[::1]",
		"https://[::1]/*",
		"https://[::1]:*",
		"https://[::1]:*/*",
	];
}

export function externalNavigationUrl(value: unknown, origin: string): string | null {
	let detail = value;
	if (typeof detail === "string") {
		if (detail.length > MAX_NAVIGATION_DETAIL_LENGTH) return null;
		if (detail.trimStart().startsWith("{")) {
			try {
				detail = JSON.parse(detail);
			} catch {
				return null;
			}
		}
	}
	const raw =
		typeof detail === "string"
			? detail
			: typeof detail === "object" &&
					detail !== null &&
					!Array.isArray(detail) &&
					"url" in detail &&
					typeof detail.url === "string"
				? detail.url
				: null;
	if (!raw || raw.length > MAX_NAVIGATION_DETAIL_LENGTH) return null;
	try {
		const url = new URL(raw, origin);
		if (isLocalNavigationUrl(url, origin)) return null;
		return ["https:", "http:", "mailto:"].includes(url.protocol) ? url.href : null;
	} catch {
		return null;
	}
}

export function installExternalNavigation(
	events: Pick<EventEmitter, "on" | "off">,
	webviewId: number,
	origin: string,
	openExternal: (url: string) => unknown,
): () => void {
	const names = [`will-navigate-${webviewId}`, `new-window-open-${webviewId}`];
	const onNavigation = (event: NavigationEvent) => {
		const url = externalNavigationUrl(event.data.detail, origin);
		if (url) openExternal(url);
	};
	for (const name of names) events.on(name, onNavigation);
	return () => {
		for (const name of names) events.off(name, onNavigation);
	};
}
