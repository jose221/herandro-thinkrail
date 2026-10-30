import { randomUUID } from "node:crypto";
import {
	HTTP_REQUEST_LIMITS,
	type HttpBodyType,
	type HttpCookie,
	type HttpHistoryDetail,
	type HttpRequestInput,
	type HttpResponseResult,
} from "@thinkrail/contracts";
import { recordHttpHistory } from "./store";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const BODY_TYPES = new Set<HttpBodyType>(["none", "json", "text", "urlencoded"]);

export interface ExecuteHttpRequestInput {
	workspaceId: string;
	request: HttpRequestInput;
	source: "user" | "agent";
}

function assertCount(record: Record<string, string> | undefined, label: string): void {
	if (record === undefined) return;
	const entries = Object.entries(record);
	if (entries.length > HTTP_REQUEST_LIMITS.headers) throw new Error(`Too many ${label}`);
	for (const [key, value] of entries) {
		if (key.length === 0 || key.length > HTTP_REQUEST_LIMITS.headerNameLength) {
			throw new Error(`Invalid ${label} name`);
		}
		if (value.length > HTTP_REQUEST_LIMITS.headerValueLength) throw new Error(`Invalid ${label}`);
		if (key.includes("\0") || value.includes("\0")) throw new Error(`Invalid ${label}`);
	}
}

function normalizeRequest(input: HttpRequestInput): {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: string;
	timeoutMs: number;
} {
	const method = String(input.method ?? "GET")
		.trim()
		.toUpperCase();
	if (!METHODS.has(method)) throw new Error("Unsupported HTTP method");
	const rawUrl = typeof input.url === "string" ? input.url.trim() : "";
	if (rawUrl.length === 0 || rawUrl.length > HTTP_REQUEST_LIMITS.urlLength) {
		throw new Error("Enter an http(s) URL");
	}
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error("Enter an http(s) URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Enter an http(s) URL");
	}
	assertCount(input.headers, "headers");
	assertCount(input.query, "query parameters");
	for (const [key, value] of Object.entries(input.query ?? {})) {
		if (key.length === 0) continue;
		url.searchParams.set(key, value);
	}
	const bodyType = input.bodyType ?? "none";
	if (!BODY_TYPES.has(bodyType)) throw new Error("Unsupported request body type");
	const body = typeof input.body === "string" ? input.body : "";
	if (body.length > HTTP_REQUEST_LIMITS.bodyChars) throw new Error("Request body is too large");
	const timeout = Number(input.timeoutMs ?? 30_000);
	const timeoutMs = Math.max(
		1_000,
		Math.min(Number.isFinite(timeout) ? timeout : 30_000, HTTP_REQUEST_LIMITS.timeoutMs),
	);
	return {
		method,
		url: url.toString(),
		headers: { ...(input.headers ?? {}) },
		body: method === "GET" || method === "HEAD" ? "" : body,
		timeoutMs,
	};
}

function bodyFor(
	method: string,
	body: string,
	bodyType: HttpBodyType,
	headers: Record<string, string>,
): string | undefined {
	if (body === "" || method === "GET" || method === "HEAD") return undefined;
	if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
		if (bodyType === "json") headers["Content-Type"] = "application/json";
		else if (bodyType === "urlencoded")
			headers["Content-Type"] = "application/x-www-form-urlencoded";
		else if (bodyType === "text") headers["Content-Type"] = "text/plain; charset=utf-8";
	}
	return body;
}

function responseCookies(headers: Headers): HttpCookie[] {
	const values =
		typeof headers.getSetCookie === "function"
			? headers.getSetCookie()
			: headers.get("set-cookie")
				? [headers.get("set-cookie") ?? ""]
				: [];
	const cookies: HttpCookie[] = [];
	for (const value of values.slice(0, 32)) {
		const [pair, ...attributes] = value.split(";");
		if (!pair) continue;
		const separator = pair.indexOf("=");
		if (separator <= 0) continue;
		const cookie: HttpCookie = {
			name: pair.slice(0, separator).trim(),
			value: pair.slice(separator + 1).trim(),
		};
		for (const attribute of attributes) {
			const [rawName, ...rest] = attribute.split("=");
			const name = rawName?.trim().toLowerCase();
			const attributeValue = rest.join("=").trim();
			if (name === "path") cookie.path = attributeValue;
			else if (name === "domain") cookie.domain = attributeValue;
			else if (name === "secure") cookie.secure = true;
			else if (name === "httponly") cookie.httpOnly = true;
		}
		cookies.push(cookie);
	}
	return cookies;
}

async function readResponseBody(
	response: Response,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
	if (!response.body) return { text: "", bytes: 0, truncated: false };
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	let truncated = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			bytes += value.byteLength;
			text += decoder.decode(value, { stream: true });
			if (text.length >= HTTP_REQUEST_LIMITS.responseChars) {
				text = text.slice(0, HTTP_REQUEST_LIMITS.responseChars);
				truncated = true;
				break;
			}
		}
		text += decoder.decode();
	} finally {
		if (truncated) await reader.cancel().catch(() => undefined);
	}
	return { text, bytes, truncated };
}

function headerRecord(headers: Headers): Record<string, string> {
	const record: Record<string, string> = {};
	for (const [key, value] of headers) record[key] = value;
	return record;
}

function isTextualContentType(contentType: string): boolean {
	if (contentType === "") return true;
	return /(?:^text\/|json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|yaml|csv|x-sh|sql)/i.test(
		contentType,
	);
}

const SECRET_HEADER =
	/^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i;

function redactedHeaders(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers).map(([key, value]) => [
			key,
			SECRET_HEADER.test(key) ? "[redacted]" : value,
		]),
	);
}

/** Executes one HTTP request from the host and records it in the workspace history. */
export async function executeHttpRequest({
	workspaceId,
	request,
	source,
}: ExecuteHttpRequestInput): Promise<HttpResponseResult> {
	const normalized = normalizeRequest(request);
	const headers = normalized.headers;
	const body = bodyFor(normalized.method, normalized.body, request.bodyType ?? "none", headers);
	const id = randomUUID();
	const startedAt = performance.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), normalized.timeoutMs);
	let status = 0;
	let statusText = "";
	let responseHeaders: Record<string, string> = {};
	let cookies: HttpCookie[] = [];
	let responseBody = "";
	let bodyTruncated = false;
	let bytes = 0;
	let contentType = "";
	try {
		const response = await fetch(normalized.url, {
			method: normalized.method,
			headers,
			...(body === undefined ? {} : { body }),
			redirect: "follow",
			signal: controller.signal,
		});
		status = response.status;
		statusText = response.statusText;
		responseHeaders = headerRecord(response.headers);
		contentType = response.headers.get("content-type") ?? "";
		cookies = responseCookies(response.headers);
		if (!isTextualContentType(contentType)) {
			const length = Number(response.headers.get("content-length") ?? 0);
			bytes = Number.isFinite(length) && length > 0 ? length : 0;
			responseBody = `Binary response: ${bytes} bytes (${contentType})`;
			await response.body?.cancel().catch(() => undefined);
		} else {
			const read = await readResponseBody(response);
			responseBody = read.text;
			bodyTruncated = read.truncated;
			bytes = read.bytes;
		}
	} catch (error) {
		status = 0;
		statusText =
			error instanceof Error && error.name === "AbortError" ? "Request timed out" : "Network error";
		responseBody =
			error instanceof Error && error.name !== "AbortError"
				? `Could not complete the request: ${error.message}`
				: `Could not complete the request: ${statusText.toLowerCase()}`;
		bytes = responseBody.length;
	} finally {
		clearTimeout(timer);
	}
	const durationMs = Math.round(performance.now() - startedAt);
	const at = Date.now();
	const detail: HttpHistoryDetail = {
		id,
		workspaceId,
		method: normalized.method,
		url: normalized.url,
		status,
		statusText,
		durationMs,
		sizeBytes: bytes,
		at,
		source,
		requestHeaders: redactedHeaders({ ...headers }),
		requestBody: body ?? "",
		responseHeaders: redactedHeaders(responseHeaders),
		responseBody,
		bodyTruncated,
	};
	recordHttpHistory(detail);
	return {
		id,
		status,
		statusText,
		headers: responseHeaders,
		cookies,
		body: responseBody,
		bodyTruncated,
		sizeBytes: bytes,
		durationMs,
		contentType,
		at,
	};
}
