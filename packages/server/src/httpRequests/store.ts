import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	HTTP_REQUEST_LIMITS,
	type HttpHistoryDetail,
	type HttpHistoryEntry,
	type HttpRequestInput,
	type SavedHttpRequest,
} from "@thinkrail/contracts";
import { dataDir } from "../persistence";

const STORE_FILE = "http-requests.json";
const STORE_VERSION = 1;
const STORED_BODY_CHARS = 16 * 1024;

interface StoredState {
	version: number;
	history: HttpHistoryDetail[];
	saved: SavedHttpRequest[];
}

let state: StoredState | null = null;
let writes: Promise<void> = Promise.resolve();

function emptyState(): StoredState {
	return { version: STORE_VERSION, history: [], saved: [] };
}

function readState(): StoredState {
	if (state) return state;
	try {
		const parsed = JSON.parse(
			readFileSync(join(dataDir(), STORE_FILE), "utf8"),
		) as Partial<StoredState>;
		state = {
			version: STORE_VERSION,
			history: Array.isArray(parsed.history)
				? parsed.history.filter(
						(entry): entry is HttpHistoryDetail =>
							!!entry && typeof entry.id === "string" && typeof entry.workspaceId === "string",
					)
				: [],
			saved: Array.isArray(parsed.saved)
				? parsed.saved.filter(
						(entry): entry is SavedHttpRequest =>
							!!entry && typeof entry.id === "string" && typeof entry.workspaceId === "string",
					)
				: [],
		};
	} catch {
		state = emptyState();
	}
	return state;
}

function persist(): void {
	const snapshot = readState();
	const target = join(dataDir(), STORE_FILE);
	writes = writes
		.then(() => {
			mkdirSync(dataDir(), { recursive: true });
			const temporary = `${target}.${randomUUID()}.tmp`;
			try {
				writeFileSync(temporary, `${JSON.stringify(snapshot, null, "\t")}\n`, {
					mode: 0o600,
				});
				renameSync(temporary, target);
			} finally {
				rmSync(temporary, { force: true });
			}
		})
		.catch(() => undefined);
}

function storedBody(value: string): string {
	return value.length > STORED_BODY_CHARS ? value.slice(0, STORED_BODY_CHARS) : value;
}

export function recordHttpHistory(detail: HttpHistoryDetail): void {
	const current = readState();
	current.history.unshift({
		...detail,
		requestBody: storedBody(detail.requestBody),
		responseBody: storedBody(detail.responseBody),
	});
	const workspaceEntries = current.history.filter(
		(entry) => entry.workspaceId === detail.workspaceId,
	);
	if (workspaceEntries.length > HTTP_REQUEST_LIMITS.historyPerWorkspace) {
		const drop = new Set(
			workspaceEntries.slice(HTTP_REQUEST_LIMITS.historyPerWorkspace).map((entry) => entry.id),
		);
		current.history = current.history.filter((entry) => !drop.has(entry.id));
	}
	if (current.history.length > HTTP_REQUEST_LIMITS.historyPerWorkspace * 4) {
		current.history = current.history.slice(0, HTTP_REQUEST_LIMITS.historyPerWorkspace * 4);
	}
	persist();
}

export function listHttpHistory(workspaceId: string, limit: number): HttpHistoryEntry[] {
	return readState()
		.history.filter((entry) => entry.workspaceId === workspaceId)
		.slice(0, Math.max(1, Math.min(limit, HTTP_REQUEST_LIMITS.historyPerWorkspace)))
		.map(
			({
				requestHeaders: _a,
				requestBody: _b,
				responseHeaders: _c,
				responseBody: _d,
				bodyTruncated: _e,
				...entry
			}) => entry,
		);
}

export function getHttpHistory(workspaceId: string, id: string): HttpHistoryDetail {
	const entry = readState().history.find(
		(candidate) => candidate.workspaceId === workspaceId && candidate.id === id,
	);
	if (!entry) throw new Error("Request history entry not found");
	return entry;
}

export function clearHttpHistory(workspaceId: string, id?: string): void {
	const current = readState();
	current.history = id
		? current.history.filter((entry) => entry.workspaceId !== workspaceId || entry.id !== id)
		: current.history.filter((entry) => entry.workspaceId !== workspaceId);
	persist();
}

export function listSavedHttpRequests(workspaceId: string): SavedHttpRequest[] {
	return readState()
		.saved.filter((entry) => entry.workspaceId === workspaceId)
		.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function saveHttpRequest(input: {
	workspaceId: string;
	id?: string;
	collection: string;
	name: string;
	request: HttpRequestInput;
}): SavedHttpRequest {
	const collection = typeof input.collection === "string" ? input.collection.trim() : "";
	const name = typeof input.name === "string" ? input.name.trim() : "";
	if (collection.length === 0 || collection.length > 120)
		throw new Error("Invalid collection name");
	if (name.length === 0 || name.length > 160) throw new Error("Invalid request name");
	if ((input.request.body?.length ?? 0) > HTTP_REQUEST_LIMITS.bodyChars) {
		throw new Error("Saved request is too large");
	}
	if (JSON.stringify(input.request).length > HTTP_REQUEST_LIMITS.bodyChars + 64 * 1024) {
		throw new Error("Saved request is too large");
	}
	const current = readState();
	const now = Date.now();
	const existing = input.id
		? current.saved.find(
				(entry) => entry.workspaceId === input.workspaceId && entry.id === input.id,
			)
		: undefined;
	const record: SavedHttpRequest = {
		id: existing?.id ?? randomUUID(),
		workspaceId: input.workspaceId,
		collection,
		name,
		request: input.request,
		updatedAt: now,
	};
	if (existing) {
		const index = current.saved.indexOf(existing);
		current.saved[index] = record;
	} else {
		current.saved.unshift(record);
	}
	const workspaceEntries = current.saved.filter((entry) => entry.workspaceId === input.workspaceId);
	if (workspaceEntries.length > HTTP_REQUEST_LIMITS.savedRequests) {
		const drop = new Set(
			workspaceEntries.slice(HTTP_REQUEST_LIMITS.savedRequests).map((entry) => entry.id),
		);
		current.saved = current.saved.filter((entry) => !drop.has(entry.id));
	}
	if (current.saved.length > HTTP_REQUEST_LIMITS.savedRequests) {
		current.saved = current.saved.slice(0, HTTP_REQUEST_LIMITS.savedRequests);
	}
	persist();
	return record;
}

export function deleteSavedHttpRequest(workspaceId: string, id: string): void {
	const current = readState();
	current.saved = current.saved.filter(
		(entry) => entry.workspaceId !== workspaceId || entry.id !== id,
	);
	persist();
}

export function resetHttpRequestStoreForTests(): void {
	state = emptyState();
}
