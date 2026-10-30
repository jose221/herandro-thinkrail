import { afterEach, expect, test } from "bun:test";
import { fetchPageSnapshot } from "./page";

let server: ReturnType<typeof Bun.serve> | null = null;

afterEach(() => {
	server?.stop(true);
	server = null;
});

function serve(handler: (request: Request) => Response | Promise<Response>): string {
	server = Bun.serve({ port: 0, fetch: handler });
	return `http://127.0.0.1:${server.port}`;
}

test("page snapshots extract the title, visible text and resolved links", async () => {
	const origin = serve(
		() =>
			new Response(
				`<!doctype html><html><head><title>Demo &amp; Test</title><style>.x{}</style></head>
				<body><script>ignore()</script><h1>Hello</h1><p>World</p>
				<a href="/docs">Docs</a><a href="https://example.com/x">X</a></body></html>`,
				{ headers: { "content-type": "text/html; charset=utf-8" } },
			),
	);
	const snapshot = await fetchPageSnapshot(`${origin}/page`);
	expect(snapshot).toMatchObject({
		status: 200,
		title: "Demo & Test",
	});
	expect(snapshot.text).toContain("Hello World");
	expect(snapshot.text).not.toContain("ignore");
	expect(snapshot.links).toEqual([`${origin}/docs`, "https://example.com/x"]);
});

test("non-HTML pages return raw text and no links", async () => {
	const origin = serve(
		() =>
			new Response('{"ok":true}', {
				headers: { "content-type": "application/json" },
			}),
	);
	const snapshot = await fetchPageSnapshot(`${origin}/api`);
	expect(snapshot).toMatchObject({ title: "", text: '{"ok":true}', links: [] });
});

test("page snapshots reject non-http URLs", async () => {
	await expect(fetchPageSnapshot("file:///etc/passwd")).rejects.toThrow("http(s)");
});
