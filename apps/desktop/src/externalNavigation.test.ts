import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
	desktopNavigationRules,
	externalNavigationUrl,
	installExternalNavigation,
	isLocalNavigationUrl,
} from "./externalNavigation";

const origin = "http://127.0.0.1:24242";

test("keeps same-origin navigation inside the webview", () => {
	expect(externalNavigationUrl(`${origin}/#/v1`, origin)).toBeNull();
	expect(externalNavigationUrl({ url: `${origin}/files/a/b` }, origin)).toBeNull();
});

test("keeps local development servers inside the webview", () => {
	expect(isLocalNavigationUrl(new URL("http://localhost:42850/"), origin)).toBe(true);
	expect(isLocalNavigationUrl(new URL("https://example.com/"), origin)).toBe(false);
	expect(externalNavigationUrl("http://localhost:42850/", origin)).toBeNull();
	expect(externalNavigationUrl("http://localhost:3000/dashboard", origin)).toBeNull();
	expect(externalNavigationUrl("http://127.0.0.1:5173/", origin)).toBeNull();
	expect(externalNavigationUrl("http://0.0.0.0:8080/", origin)).toBeNull();
	expect(externalNavigationUrl("http://[::1]:4200/", origin)).toBeNull();
	expect(externalNavigationUrl("https://localhost:8443/", origin)).toBeNull();
	expect(
		externalNavigationUrl(
			JSON.stringify({ url: "http://localhost:42850/", allowed: false }),
			origin,
		),
	).toBeNull();
	expect(
		externalNavigationUrl(
			JSON.stringify({ url: "http://localhost:42850/", allowed: true }),
			origin,
		),
	).toBeNull();
});

test("desktopNavigationRules confines to app origin and permits local development servers", () => {
	const rules = desktopNavigationRules(origin);
	expect(rules[0]).toBe("^*");
	expect(rules).toContain(`${origin}/*`);
	expect(rules).toContain("http://localhost:*/*");
	expect(rules).toContain("http://127.0.0.1:*/*");
	expect(rules).toContain("http://0.0.0.0:*/*");
	expect(rules).toContain("http://[::1]:*/*");
});

test("opens reviewed external protocols only", () => {
	expect(externalNavigationUrl("https://example.com/docs", origin)).toBe(
		"https://example.com/docs",
	);
	expect(externalNavigationUrl({ url: "mailto:hello@thinkrail.ai" }, origin)).toBe(
		"mailto:hello@thinkrail.ai",
	);
	expect(externalNavigationUrl("file:///tmp/private", origin)).toBeNull();
	expect(externalNavigationUrl("javascript:alert(1)", origin)).toBeNull();
});

test("opens the serialized will-navigate payload emitted by the native SDK", () => {
	expect(
		externalNavigationUrl(
			JSON.stringify({ url: "https://example.com/docs", allowed: false }),
			origin,
		),
	).toBe("https://example.com/docs");
	expect(
		externalNavigationUrl(JSON.stringify({ url: `${origin}/#/v1`, allowed: true }), origin),
	).toBeNull();
	expect(externalNavigationUrl(JSON.stringify({ url: "mailto:hello@thinkrail.ai" }), origin)).toBe(
		"mailto:hello@thinkrail.ai",
	);
});

test.each([
	"file:///tmp/private",
	"javascript:alert(1)",
	"data:text/html,hello",
	"views://web",
])("rejects unsafe protocols in every SDK payload form: %s", (url) => {
	for (const detail of [url, { url }, JSON.stringify({ url, allowed: false })]) {
		expect(externalNavigationUrl(detail, origin)).toBeNull();
	}
});

test.each([
	null,
	{},
	{ url: 123 },
	"{broken",
	'{"url":null}',
	'{"url":{}}',
	'["https://example.com"]',
])("rejects malformed event detail: %j", (detail) => {
	expect(externalNavigationUrl(detail, origin)).toBeNull();
});

test("bounds native JSON decoding and URL length", () => {
	const url = `https://example.com/${"x".repeat(64 * 1024)}`;
	for (const detail of [url, { url }, JSON.stringify({ url })]) {
		expect(externalNavigationUrl(detail, origin)).toBeNull();
	}
});

test("subscribes only to this webview's SDK channels and removes its listeners on disposal", () => {
	const events = new EventEmitter();
	const opened: string[] = [];
	const remove = installExternalNavigation(events, 7, origin, (url) => opened.push(url));
	const navigation = {
		data: { detail: JSON.stringify({ url: "https://example.com/nav", allowed: false }) },
	};
	const popup = { data: { detail: { url: "https://example.com/popup", isCmdClick: true } } };

	events.emit("will-navigate", navigation);
	events.emit("new-window-open", popup);
	events.emit("will-navigate-8", navigation);
	events.emit("new-window-open-8", popup);
	expect(opened).toEqual([]);

	events.emit("will-navigate-7", {
		data: { detail: JSON.stringify({ url: "http://localhost:42850/", allowed: true }) },
	});
	events.emit("will-navigate-7", navigation);
	events.emit("new-window-open-7", popup);
	expect(opened).toEqual(["https://example.com/nav", "https://example.com/popup"]);

	let siblingCalls = 0;
	events.on("new-window-open-7", () => siblingCalls++);
	remove();
	events.emit("will-navigate-7", navigation);
	events.emit("new-window-open-7", popup);
	expect(opened).toHaveLength(2);
	expect(siblingCalls).toBe(1);
	expect(events.listenerCount("will-navigate-7")).toBe(0);
});
