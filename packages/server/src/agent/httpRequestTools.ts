import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	executeHttpRequest,
	getHttpHistory,
	listHttpHistory,
	listSavedHttpRequests,
	saveHttpRequest,
} from "../httpRequests";
import { workspaceIdAt } from "./workspaceTools";

const HeaderMap = Type.Record(Type.String({ maxLength: 256 }), Type.String({ maxLength: 8_192 }));
const RequestSchema = Type.Object({
	method: Type.String({
		maxLength: 16,
		description: "GET, POST, PUT, PATCH, DELETE, HEAD or OPTIONS.",
	}),
	url: Type.String({ minLength: 1, maxLength: 8_192 }),
	headers: Type.Optional(HeaderMap),
	query: Type.Optional(HeaderMap),
	body: Type.Optional(Type.String({ maxLength: 262_144 })),
	bodyType: Type.Optional(
		Type.Union([
			Type.Literal("none"),
			Type.Literal("json"),
			Type.Literal("text"),
			Type.Literal("urlencoded"),
		]),
	),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 120_000 })),
});

function json(value: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
		details: value,
	};
}

const TOOL_BODY_CHARS = 20_000;

function boundedBody<T extends { body: string; bodyTruncated: boolean }>(value: T): T {
	if (value.body.length <= TOOL_BODY_CHARS) return value;
	return {
		...value,
		body: value.body.slice(0, TOOL_BODY_CHARS),
		bodyTruncated: true,
	};
}

export function httpRequestToolsExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "http_request_send",
		label: "Send HTTP Request",
		description:
			"Send an HTTP request through ThinkRail's request client and record it in the workspace history. Use it to verify APIs, local services, and error responses.",
		parameters: RequestSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const workspaceId = workspaceIdAt(ctx.cwd);
			return json(
				boundedBody(await executeHttpRequest({ workspaceId, request: params, source: "agent" })),
			);
		},
	});
	pi.registerTool({
		name: "http_request_history",
		label: "HTTP Request History",
		description: "List recent user and agent HTTP requests for the active workspace.",
		parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return json(listHttpHistory(workspaceIdAt(ctx.cwd), params.limit ?? 20));
		},
	});
	pi.registerTool({
		name: "http_request_history_detail",
		label: "HTTP Request Detail",
		description:
			"Read one saved HTTP history entry, including request and response headers and bodies.",
		parameters: Type.Object({ id: Type.String({ minLength: 1, maxLength: 256 }) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const detail = getHttpHistory(workspaceIdAt(ctx.cwd), params.id);
			return json({
				...detail,
				requestBody:
					detail.requestBody.length > TOOL_BODY_CHARS
						? detail.requestBody.slice(0, TOOL_BODY_CHARS)
						: detail.requestBody,
				responseBody:
					detail.responseBody.length > TOOL_BODY_CHARS
						? detail.responseBody.slice(0, TOOL_BODY_CHARS)
						: detail.responseBody,
				bodyTruncated: detail.bodyTruncated || detail.responseBody.length > TOOL_BODY_CHARS,
			});
		},
	});
	pi.registerTool({
		name: "http_request_saved_list",
		label: "Saved HTTP Requests",
		description: "List the workspace's saved HTTP requests and collections.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			return json(listSavedHttpRequests(workspaceIdAt(ctx.cwd)));
		},
	});
	pi.registerTool({
		name: "http_request_save",
		label: "Save HTTP Request",
		description:
			"Save or update a named request in a workspace collection so the person can replay it from the Requests panel.",
		parameters: Type.Object({
			collection: Type.String({ minLength: 1, maxLength: 120 }),
			name: Type.String({ minLength: 1, maxLength: 160 }),
			id: Type.Optional(Type.String({ maxLength: 256 })),
			request: RequestSchema,
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return json(
				saveHttpRequest({
					workspaceId: workspaceIdAt(ctx.cwd),
					collection: params.collection,
					name: params.name,
					...(params.id ? { id: params.id } : {}),
					request: params.request,
				}),
			);
		},
	});
}
