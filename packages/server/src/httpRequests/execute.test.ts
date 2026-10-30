import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HTTP_REQUEST_LIMITS } from "@thinkrail/contracts";
import { executeHttpRequest } from "./execute";
import {
	clearHttpHistory,
	deleteSavedHttpRequest,
	getHttpHistory,
	listHttpHistory,
	listSavedHttpRequests,
	resetHttpRequestStoreForTests,
	saveHttpRequest,
} from "./store";

let dataDir: string;
let server: ReturnType<typeof Bun.serve> | null = null;
const savedDataDir = process.env.THINKRAIL_DATA_DIR;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "thinkrail-http-"));
	process.env.THINKRAIL_DATA_DIR = dataDir;
	resetHttpRequestStoreForTests();
});

afterEach(() => {
	server?.stop(true);
	server = null;
	rmSync(dataDir, { recursive: true, force: true });
	if (savedDataDir === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = savedDataDir;
	resetHttpRequestStoreForTests();
});

function serve(): string {
	server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/cookie") {
				return new Response("ok", {
					headers: { "set-cookie": "session=abc; Path=/; HttpOnly; Secure" },
				});
			}
			if (url.pathname === "/binary") {
				return new Response(new Uint8Array([0, 1, 2, 3]), {
					headers: { "content-type": "image/png", "content-length": "4" },
				});
			}
			const body = await request.text();
			return Response.json({
				method: request.method,
				path: url.pathname,
				query: Object.fromEntries(url.searchParams),
				authorization: request.headers.get("authorization"),
				contentType: request.headers.get("content-type"),
				body,
			});
		},
	});
	return `http://127.0.0.1:${server.port}`;
}

test("a request carries query, headers and JSON body and records history", async () => {
	const origin = serve();
	const result = await executeHttpRequest({
		workspaceId: "w1",
		source: "agent",
		request: {
			method: "POST",
			url: `${origin}/echo`,
			query: { page: "2" },
			headers: { Authorization: "Bearer secret" },
			body: '{"ok":true}',
			bodyType: "json",
		},
	});
	expect(result.status).toBe(200);
	const echoed = JSON.parse(result.body) as Record<string, unknown>;
	expect(echoed).toMatchObject({
		method: "POST",
		path: "/echo",
		query: { page: "2" },
		authorization: "Bearer secret",
		contentType: "application/json",
		body: '{"ok":true}',
	});
	expect(result.cookies).toEqual([]);
	const history = listHttpHistory("w1", 10);
	expect(history).toHaveLength(1);
	expect(history[0]).toMatchObject({ method: "POST", source: "agent", status: 200 });
	const detail = getHttpHistory("w1", history[0]?.id ?? "");
	expect(detail.requestBody).toBe('{"ok":true}');
	expect(detail.requestHeaders.Authorization).toBe("[redacted]");
	expect(detail.responseBody).toContain('"method":"POST"');
	clearHttpHistory("w1");
	expect(listHttpHistory("w1", 10)).toEqual([]);
});

test("response cookies are parsed without leaking them into history summaries", async () => {
	const origin = serve();
	const result = await executeHttpRequest({
		workspaceId: "w1",
		source: "user",
		request: { method: "GET", url: `${origin}/cookie` },
	});
	expect(result.cookies).toEqual([
		{ name: "session", value: "abc", path: "/", httpOnly: true, secure: true },
	]);
	expect(listHttpHistory("w1", 10)[0]).not.toHaveProperty("responseBody");
});

test("binary responses keep their size without decoding the payload", async () => {
	const origin = serve();
	const result = await executeHttpRequest({
		workspaceId: "w1",
		source: "user",
		request: { method: "GET", url: `${origin}/binary` },
	});
	expect(result.body).toContain("Binary response: 4 bytes");
	expect(result.sizeBytes).toBe(4);
	expect(result.contentType).toBe("image/png");
});

test("request validation rejects unsafe URLs and oversized bodies", async () => {
	await expect(
		executeHttpRequest({
			workspaceId: "w1",
			source: "user",
			request: { method: "GET", url: "file:///etc/passwd" },
		}),
	).rejects.toThrow("http(s)");
	await expect(
		executeHttpRequest({
			workspaceId: "w1",
			source: "user",
			request: { method: "TRACE", url: "http://localhost:1/" },
		}),
	).rejects.toThrow("Unsupported");
});

test("saved requests update by id and delete", () => {
	const record = saveHttpRequest({
		workspaceId: "w1",
		collection: "Core",
		name: "Health",
		request: { method: "GET", url: "http://localhost:3000/health" },
	});
	expect(listSavedHttpRequests("w1")).toHaveLength(1);
	const updated = saveHttpRequest({
		workspaceId: "w1",
		id: record.id,
		collection: "Core",
		name: "Health v2",
		request: { method: "GET", url: "http://localhost:3000/healthz" },
	});
	expect(updated.id).toBe(record.id);
	expect(listSavedHttpRequests("w1")[0]?.name).toBe("Health v2");
	deleteSavedHttpRequest("w1", record.id);
	expect(listSavedHttpRequests("w1")).toEqual([]);
});

test("saved requests reject empty names and oversized payloads", () => {
	expect(() =>
		saveHttpRequest({
			workspaceId: "w1",
			collection: "",
			name: "Health",
			request: { method: "GET", url: "http://localhost:3000/health" },
		}),
	).toThrow("collection");
	expect(() =>
		saveHttpRequest({
			workspaceId: "w1",
			collection: "Core",
			name: "Health",
			request: {
				method: "POST",
				url: "http://localhost:3000/health",
				body: "x".repeat(HTTP_REQUEST_LIMITS.bodyChars + 1),
			},
		}),
	).toThrow("too large");
});
