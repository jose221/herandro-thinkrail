import { type ChildProcessByStdio, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import {
	type ClientConnection,
	client,
	type InitializeResponse,
	methods,
	ndJsonStream,
	type RequestPermissionOutcome,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import {
	type AcpAvailableCommand,
	type AcpClientCheckResult,
	type AcpClientConfig,
	type AcpConfigOption,
	type AcpPermissionOption,
	type AcpPermissionRequest,
	type AcpPlanEntry,
	type AcpSessionEvent,
	type AcpSessionSnapshot,
	type AcpSessionState,
	type AcpSessionSummary,
	type AcpToolCallSummary,
	type AcpTranscriptEntry,
	type AcpUsage,
	IMAGE_MAX_BASE64_BYTES,
	type ImageContent,
	isAcpClientConfig,
	normalizeSessionTitle,
} from "@thinkrail/contracts";
import { logger } from "../log";
import { loadAcpSessionData, saveAcpSessionData } from "../persistence";

const ACP_VERSION = 1;
const ACP_START_TIMEOUT_MS = 15_000;
const ACP_MESSAGE_LIMIT = 800;
const ACP_TRANSCRIPT_CHAR_LIMIT = 1_000_000;
const ACP_ENTRY_CHAR_LIMIT = 100_000;
const ACP_MODEL_CATALOG_LIMIT = 32;
const ACP_MODEL_OPTION_VALUES_LIMIT = 100;
const ACP_IMAGE_CHAR_LIMIT = IMAGE_MAX_BASE64_BYTES;
const ACP_READ_FILE_BYTE_LIMIT = 2 * 1024 * 1024;
const ACP_WRITE_FILE_BYTE_LIMIT = 2 * 1024 * 1024;
const ACP_TERMINAL_COUNT_LIMIT = 10;
const ACP_TERMINAL_OUTPUT_LIMIT = 1024 * 1024;
const ACP_PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;
const ACP_SESSION_LIMIT = 500;

type ChildProcess = ChildProcessByStdio<
	import("node:stream").Writable,
	import("node:stream").Readable,
	import("node:stream").Readable
>;
type TerminalChild = ChildProcessByStdio<
	null,
	import("node:stream").Readable,
	import("node:stream").Readable
>;

interface StoredAcpSession {
	snapshot: AcpSessionSnapshot;
	agentSessionId: string;
	clientSignature: string;
	canLoadSession: boolean;
}

interface StoredAcpData {
	version: 1;
	sessions: StoredAcpSession[];
}

interface PendingPermission {
	sessionId: string;
	requestId: string;
	toolCallId: string;
	title: string;
	options: AcpPermissionOption[];
	resolve: (outcome: RequestPermissionOutcome) => void;
	timer: ReturnType<typeof setTimeout>;
	abortSignal?: AbortSignal;
	abortListener?: () => void;
}

type PendingPermissionInput = Pick<
	PendingPermission,
	"requestId" | "toolCallId" | "title" | "options"
>;

interface TerminalProcess {
	child: TerminalChild;
	output: string;
	truncated: boolean;
	outputByteLimit: number;
	exitStatus: { exitCode: number | null; signal: string | null } | null;
	exited: Promise<void>;
}

interface LiveAcpSession {
	child: ChildProcess;
	connection: ClientConnection;
	agentSessionId: string;
	promptRunning: boolean;
	closing: boolean;
	pendingPermission: PendingPermission | null;
	terminals: Map<string, TerminalProcess>;
	pendingMessages: Map<"assistant" | "thought", AcpTranscriptEntry>;
}

export interface AcpSessionManagerOptions {
	getClient: (id: string) => AcpClientConfig | undefined;
	resolveWorkspaceCwd: (workspaceId: string) => string;
	publish: (event: AcpSessionEvent) => void;
	clientVersion: string;
}

const log = logger("acp");

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptySnapshot(summary: AcpSessionSummary): AcpSessionSnapshot {
	return {
		summary,
		messages: [],
		toolCalls: [],
		plan: [],
		modes: [],
		currentMode: null,
		configOptions: [],
		availableCommands: [],
		usage: null,
		permission: null,
	};
}

function normalizeConfigOption(
	option: {
		id: string;
		name: string;
		type: "select" | "boolean";
		currentValue: string | boolean;
		options?:
			| Array<{ value: string; name: string }>
			| Array<{ group: string; name: string; options: Array<{ value: string; name: string }> }>;
		description?: string | null;
		category?: string | null;
	},
	maxOptions = Number.POSITIVE_INFINITY,
): AcpConfigOption {
	const values =
		option.type === "boolean"
			? [
					{ value: "true", name: "On" },
					{ value: "false", name: "Off" },
				]
			: (option.options ?? []);
	return {
		id: option.id,
		name: option.name,
		currentValue: String(option.currentValue),
		options: values
			.flatMap((entry) =>
				"group" in entry ? entry.options : [{ value: entry.value, name: entry.name }],
			)
			.slice(0, maxOptions),
		...(option.description ? { description: option.description } : {}),
		...(typeof option.category === "string" && option.category.length <= 128
			? { category: option.category }
			: {}),
	};
}

function sessionSignature(config: AcpClientConfig): string {
	return JSON.stringify([config.command, config.args]);
}

function transcriptTextLength(messages: AcpTranscriptEntry[]): number {
	return messages.reduce(
		(total, message) =>
			total +
			message.text.length +
			(message.images?.reduce((imageTotal, image) => imageTotal + image.data.length, 0) ?? 0),
		0,
	);
}

function boundedString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length <= maxLength;
}

function normalizeStoredSession(value: unknown): StoredAcpSession | null {
	if (!isRecord(value) || !isRecord(value.snapshot) || !isRecord(value.snapshot.summary))
		return null;
	const snapshot = value.snapshot;
	const summary = snapshot.summary as Record<string, unknown>;
	if (
		!boundedString(summary.id, 128) ||
		!summary.id.startsWith("acp_") ||
		!boundedString(summary.workspaceId, 256) ||
		!boundedString(summary.clientId, 64) ||
		!boundedString(summary.clientName, 80) ||
		!boundedString(summary.title, 80) ||
		!["idle", "running", "needs-input", "failed", "interrupted"].includes(String(summary.state)) ||
		typeof summary.resumable !== "boolean" ||
		typeof summary.createdAt !== "number" ||
		typeof summary.updatedAt !== "number" ||
		!Array.isArray(snapshot.messages) ||
		!Array.isArray(snapshot.toolCalls) ||
		!Array.isArray(snapshot.plan) ||
		!Array.isArray(snapshot.modes) ||
		!Array.isArray(snapshot.configOptions) ||
		!Array.isArray(snapshot.availableCommands) ||
		(snapshot.permission !== null && snapshot.permission !== undefined)
	) {
		return null;
	}
	const messages: AcpTranscriptEntry[] = [];
	for (const entry of snapshot.messages.slice(-ACP_MESSAGE_LIMIT)) {
		if (
			!isRecord(entry) ||
			!boundedString(entry.id, 128) ||
			!["user", "assistant", "thought", "notice"].includes(String(entry.role)) ||
			!boundedString(entry.text, ACP_ENTRY_CHAR_LIMIT) ||
			typeof entry.createdAt !== "number"
		) {
			return null;
		}
		const images = Array.isArray(entry.images)
			? entry.images.filter(
					(image): image is { mimeType: string; data: string } =>
						isRecord(image) &&
						typeof image.mimeType === "string" &&
						image.mimeType.startsWith("image/") &&
						typeof image.data === "string" &&
						image.data.length <= ACP_IMAGE_CHAR_LIMIT,
				)
			: undefined;
		messages.push({
			id: entry.id,
			role: entry.role as AcpTranscriptEntry["role"],
			text: entry.text,
			...(images?.length ? { images } : {}),
			createdAt: entry.createdAt,
		});
	}
	const toolCalls: AcpToolCallSummary[] = [];
	for (const tool of snapshot.toolCalls.slice(-500)) {
		if (
			!isRecord(tool) ||
			!boundedString(tool.id, 256) ||
			!boundedString(tool.title, 1000) ||
			!boundedString(tool.kind, 64) ||
			!["pending", "in-progress", "completed", "failed"].includes(String(tool.status))
		) {
			return null;
		}
		toolCalls.push({
			id: tool.id,
			title: tool.title,
			kind: tool.kind,
			status: tool.status as AcpToolCallSummary["status"],
		});
	}
	const normalizedSummary: AcpSessionSummary = {
		id: summary.id,
		workspaceId: summary.workspaceId,
		clientId: summary.clientId,
		clientName: summary.clientName,
		title: summary.title,
		state: summary.state as AcpSessionState,
		resumable: summary.resumable,
		createdAt: summary.createdAt,
		updatedAt: summary.updatedAt,
	};
	const normalizedSnapshot: AcpSessionSnapshot = {
		...emptySnapshot(normalizedSummary),
		messages,
		toolCalls,
		plan: snapshot.plan.filter(
			(entry): entry is AcpPlanEntry =>
				isRecord(entry) &&
				typeof entry.content === "string" &&
				["pending", "in_progress", "completed"].includes(String(entry.status)) &&
				["high", "medium", "low"].includes(String(entry.priority)),
		),
		modes: snapshot.modes.filter(
			(mode): mode is { id: string; name: string } =>
				isRecord(mode) && typeof mode.id === "string" && typeof mode.name === "string",
		),
		currentMode: typeof snapshot.currentMode === "string" ? snapshot.currentMode : null,
		configOptions: snapshot.configOptions.filter(
			(option): option is AcpConfigOption =>
				isRecord(option) &&
				typeof option.id === "string" &&
				typeof option.name === "string" &&
				typeof option.currentValue === "string" &&
				Array.isArray(option.options) &&
				(option.category === undefined || boundedString(option.category, 128)),
		),
		availableCommands: snapshot.availableCommands.filter(
			(command): command is AcpAvailableCommand =>
				isRecord(command) &&
				typeof command.name === "string" &&
				typeof command.description === "string",
		),
		usage:
			isRecord(snapshot.usage) &&
			typeof snapshot.usage.used === "number" &&
			typeof snapshot.usage.size === "number"
				? {
						used: snapshot.usage.used,
						size: snapshot.usage.size,
						...(isRecord(snapshot.usage.cost) &&
						typeof snapshot.usage.cost.amount === "number" &&
						typeof snapshot.usage.cost.currency === "string"
							? {
									cost: {
										amount: snapshot.usage.cost.amount,
										currency: snapshot.usage.cost.currency,
									},
								}
							: {}),
					}
				: null,
		permission: null,
	};
	if (
		!boundedString(value.agentSessionId, 512) ||
		!boundedString(value.clientSignature, 2048) ||
		typeof value.canLoadSession !== "boolean"
	) {
		return null;
	}
	normalizedSnapshot.summary.state = "interrupted";
	normalizedSnapshot.summary.resumable = value.canLoadSession;
	return {
		snapshot: normalizedSnapshot,
		agentSessionId: value.agentSessionId,
		clientSignature: value.clientSignature,
		canLoadSession: value.canLoadSession,
	};
}

function containedPath(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return (
		rel === "" ||
		(rel !== ".." &&
			!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
			!isAbsolute(rel))
	);
}

export async function resolveAcpWorktreePath(
	root: string,
	value: string,
	mustExist: boolean,
): Promise<string> {
	if (typeof value !== "string" || value.length === 0) throw new Error("ACP file path is invalid");
	const absoluteRoot = await fs.realpath(root);
	const candidate = resolve(isAbsolute(value) ? value : resolve(absoluteRoot, value));
	if (!containedPath(absoluteRoot, candidate))
		throw new Error("ACP file path is outside this workspace");
	if (mustExist) {
		const realCandidate = await fs.realpath(candidate);
		if (!containedPath(absoluteRoot, realCandidate))
			throw new Error("ACP file path is outside this workspace");
		return realCandidate;
	}
	const realParent = await fs.realpath(dirname(candidate));
	if (!containedPath(absoluteRoot, realParent))
		throw new Error("ACP file path is outside this workspace");
	const writePath = resolve(realParent, basename(candidate));
	try {
		const realCandidate = await fs.realpath(writePath);
		if (!containedPath(absoluteRoot, realCandidate))
			throw new Error("ACP file path is outside this workspace");
		return realCandidate;
	} catch (realpathError) {
		if ((realpathError as NodeJS.ErrnoException).code !== "ENOENT") throw realpathError;
		try {
			if ((await fs.lstat(writePath)).isSymbolicLink()) {
				throw new Error("ACP file path cannot be resolved safely");
			}
		} catch (lstatError) {
			if ((lstatError as NodeJS.ErrnoException).code !== "ENOENT") throw lstatError;
		}
	}
	return writePath;
}

function appendBounded(
	current: string,
	addition: string,
	limit: number,
): { text: string; truncated: boolean } {
	const combined = current + addition;
	if (Buffer.byteLength(combined, "utf8") <= limit) return { text: combined, truncated: false };
	const bytes = Buffer.from(combined, "utf8").subarray(-limit);
	let text = bytes.toString("utf8");
	if (text.startsWith("\uFFFD")) text = text.slice(1);
	return { text, truncated: true };
}

function readableWebStream(stream: import("node:stream").Readable): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			stream.on("data", (chunk: Buffer) => {
				controller.enqueue(chunk);
				stream.pause();
			});
			stream.on("end", () => controller.close());
			stream.on("error", (error) => controller.error(error));
		},
		pull() {
			stream.resume();
		},
		cancel() {
			stream.destroy();
		},
	});
}

function mapToolStatus(status: string | null | undefined): AcpToolCallSummary["status"] {
	switch (status) {
		case "pending":
			return "pending";
		case "in_progress":
			return "in-progress";
		case "completed":
			return "completed";
		case "failed":
			return "failed";
		default:
			return "in-progress";
	}
}

function permissionIsGranted(
	outcome: RequestPermissionOutcome,
	options: AcpPermissionOption[],
): boolean {
	if (outcome.outcome !== "selected") return false;
	const option = options.find((candidate) => candidate.optionId === outcome.optionId);
	return option?.kind === "allow_once" || option?.kind === "allow_always";
}

export class AcpSessionManager {
	private readonly records = new Map<string, StoredAcpSession>();
	private readonly live = new Map<string, LiveAcpSession>();
	private readonly options: AcpSessionManagerOptions;

	constructor(options: AcpSessionManagerOptions) {
		this.options = options;
		const stored = loadAcpSessionData();
		if (!isRecord(stored) || stored.version !== 1 || !Array.isArray(stored.sessions)) return;
		for (const raw of stored.sessions.slice(-ACP_SESSION_LIMIT)) {
			const record = normalizeStoredSession(raw);
			if (record) this.records.set(record.snapshot.summary.id, record);
		}
	}

	list(workspaceId: string): AcpSessionSummary[] {
		return [...this.records.values()]
			.map((record) => record.snapshot.summary)
			.filter((summary) => summary.workspaceId === workspaceId)
			.sort((left, right) => right.updatedAt - left.updatedAt)
			.map((summary) => ({ ...summary }));
	}

	get(workspaceId: string, sessionId: string): AcpSessionSnapshot {
		return structuredClone(this.getRecord(workspaceId, sessionId).snapshot);
	}

	async checkClient(clientId: string): Promise<AcpClientCheckResult> {
		const config = this.getConfiguredClient(clientId);
		let child: ChildProcess | undefined;
		let connection: ClientConnection | undefined;
		let executableUnavailable = false;
		try {
			const spawned = this.spawnConnection(config, process.cwd());
			child = spawned.child;
			connection = spawned.connection;
			child.once("error", (error) => {
				const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
				if (["EACCES", "ENOENT", "ENOTDIR"].includes(code ?? "")) {
					executableUnavailable = true;
				}
			});
			const initialized = await this.initializeConnection(connection);
			if (initialized.protocolVersion !== ACP_VERSION) {
				return { available: false, issue: "protocol" };
			}
			return { available: true };
		} catch {
			log.warn("ACP client handshake failed");
			return { available: false, issue: executableUnavailable ? "executable" : "handshake" };
		} finally {
			if (child && connection) await this.closeChild(child, connection);
		}
	}

	async listClientModels(workspaceId: string, clientId: string): Promise<AcpConfigOption[]> {
		const config = this.getConfiguredClient(clientId);
		if (!config.enabled) {
			throw new Error("Enable this ACP client in Settings before listing its models.");
		}
		const cwd = this.options.resolveWorkspaceCwd(workspaceId);
		let child: ChildProcess | undefined;
		let connection: ClientConnection | undefined;
		try {
			const spawned = this.spawnConnection(config, cwd);
			child = spawned.child;
			connection = spawned.connection;
			const initialized = await this.initializeConnection(connection);
			if (initialized.protocolVersion !== ACP_VERSION) {
				throw new Error("The command does not support stable ACP v1.");
			}
			if (initialized.authMethods?.length) {
				throw new Error(
					"Authenticate with this ACP client in its own command-line app, then retry.",
				);
			}
			const created = await this.requestWithTimeout(
				connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] }),
			);
			return (created.configOptions ?? [])
				.filter((option) => option.category === "model")
				.slice(0, ACP_MODEL_CATALOG_LIMIT)
				.map((option) => normalizeConfigOption(option, ACP_MODEL_OPTION_VALUES_LIMIT))
				.filter((option) => option.options.length > 0);
		} catch (error) {
			if (
				error instanceof Error &&
				(error.message.startsWith("Authenticate with") ||
					error.message.startsWith("Enable this ACP client"))
			) {
				throw error;
			}
			log.warn("ACP model catalog discovery failed");
			throw new Error(
				`Could not list models from ${config.name}. Check that its ACP adapter is installed and configured.`,
			);
		} finally {
			if (child && connection) await this.closeChild(child, connection);
		}
	}

	async create(workspaceId: string, clientId: string): Promise<AcpSessionSnapshot> {
		const config = this.getConfiguredClient(clientId);
		if (!config.enabled)
			throw new Error("Enable this ACP client in Settings before starting a chat.");
		const cwd = this.options.resolveWorkspaceCwd(workspaceId);
		const now = Date.now();
		const sessionId = `acp_${randomUUID()}`;
		const summary: AcpSessionSummary = {
			id: sessionId,
			workspaceId,
			clientId: config.id,
			clientName: config.name,
			title: config.name,
			state: "running",
			resumable: false,
			createdAt: now,
			updatedAt: now,
		};
		const record: StoredAcpSession = {
			snapshot: emptySnapshot(summary),
			agentSessionId: "",
			clientSignature: sessionSignature(config),
			canLoadSession: false,
		};
		this.records.set(sessionId, record);
		try {
			const { live, initialized } = await this.openSession(record, config, cwd);
			if (initialized.protocolVersion !== ACP_VERSION) {
				throw new Error("The command did not negotiate stable ACP v1.");
			}
			if (initialized.authMethods?.length) {
				throw new Error(
					"Authenticate with this ACP client in its own command-line app, then retry.",
				);
			}
			const created = await this.requestWithTimeout(
				live.connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] }),
			);
			live.agentSessionId = created.sessionId;
			record.agentSessionId = created.sessionId;
			record.canLoadSession = initialized.agentCapabilities?.loadSession === true;
			record.snapshot.summary.resumable = record.canLoadSession;
			this.applySessionSetup(record, created);
			record.snapshot.summary.state = "idle";
			record.snapshot.summary.updatedAt = Date.now();
			this.persist();
			this.options.publish({ type: "created", session: { ...record.snapshot.summary } });
			this.publishState(record);
			return structuredClone(record.snapshot);
		} catch (error) {
			const current = this.live.get(sessionId);
			if (current) await this.closeLive(sessionId, current);
			this.records.delete(sessionId);
			this.persist();
			if (error instanceof Error && error.message.startsWith("Authenticate with")) throw error;
			if (error instanceof Error && error.message.includes("stable ACP v1")) throw error;
			log.warn("ACP session creation failed");
			throw new Error(
				`Could not start ${config.name}. Check that its ACP adapter is installed and configured.`,
			);
		}
	}

	async resume(workspaceId: string, sessionId: string): Promise<AcpSessionSnapshot> {
		const record = this.getRecord(workspaceId, sessionId);
		if (this.live.has(sessionId)) return structuredClone(record.snapshot);
		if (!record.canLoadSession || !record.agentSessionId) {
			throw new Error(
				"This ACP agent does not support restoring its session. The saved transcript is still available.",
			);
		}
		const config = this.getConfiguredClient(record.snapshot.summary.clientId);
		if (!config.enabled)
			throw new Error("Enable this ACP client in Settings before resuming the chat.");
		if (sessionSignature(config) !== record.clientSignature) {
			throw new Error(
				"This ACP launch command changed. Start a new chat to use the updated configuration.",
			);
		}
		const cwd = this.options.resolveWorkspaceCwd(workspaceId);
		const { live, initialized } = await this.openSession(record, config, cwd);
		try {
			if (initialized.protocolVersion !== ACP_VERSION) throw new Error("ACP version mismatch");
			if (initialized.agentCapabilities?.loadSession !== true) {
				throw new Error("This ACP agent no longer supports session restoration.");
			}
			const loaded = await this.requestWithTimeout(
				live.connection.agent.request(methods.agent.session.load, {
					cwd,
					sessionId: record.agentSessionId,
					mcpServers: [],
				}),
			);
			this.applySessionSetup(record, loaded);
			record.snapshot.summary.state = "idle";
			record.snapshot.summary.resumable = true;
			record.snapshot.summary.updatedAt = Date.now();
			this.persist();
			this.publishState(record);
			return structuredClone(record.snapshot);
		} catch {
			await this.closeLive(sessionId, live);
			record.snapshot.summary.state = "interrupted";
			this.persist();
			throw new Error(
				"The ACP agent could not restore this session. Its saved transcript is still available.",
			);
		}
	}

	async prompt(
		workspaceId: string,
		sessionId: string,
		text: string,
		images: ImageContent[] = [],
	): Promise<{ ok: true }> {
		const record = this.getRecord(workspaceId, sessionId);
		const live = this.requireLive(sessionId);
		if (live.promptRunning) throw new Error("This ACP chat is already responding.");
		if (typeof text !== "string" || text.length > 100_000)
			throw new Error("ACP prompt text is too long.");
		if (!text.trim() && images.length === 0) throw new Error("Enter a message before sending.");
		if (
			!Array.isArray(images) ||
			images.length > 8 ||
			images.some(
				(image) =>
					!image ||
					typeof image.mimeType !== "string" ||
					!image.mimeType.startsWith("image/") ||
					typeof image.data !== "string" ||
					image.data.length > IMAGE_MAX_BASE64_BYTES,
			)
		) {
			throw new Error("One or more ACP images are invalid or too large.");
		}
		const content = [
			...(text.trim() ? [{ type: "text" as const, text }] : []),
			...images.map((image) => ({
				type: "image" as const,
				mimeType: image.mimeType,
				data: image.data,
			})),
		];
		const userEntry: AcpTranscriptEntry = {
			id: randomUUID(),
			role: "user",
			text,
			createdAt: Date.now(),
			...(images.length
				? { images: images.map(({ mimeType, data }) => ({ mimeType, data })) }
				: {}),
		};
		this.addMessage(record, userEntry);
		live.promptRunning = true;
		this.setState(record, "running");
		void this.executePrompt(record, live, content).catch(() => {
			live.promptRunning = false;
			this.flushPendingMessages(record, live);
			this.setState(record, "failed");
			this.emit({
				type: "error",
				sessionId,
				message: "The ACP agent could not complete this request.",
			});
			log.warn("ACP prompt failed");
		});
		return { ok: true };
	}

	async cancel(workspaceId: string, sessionId: string): Promise<{ ok: true }> {
		this.getRecord(workspaceId, sessionId);
		const live = this.requireLive(sessionId);
		if (live.pendingPermission) {
			this.resolvePermission(live, { outcome: "cancelled" });
		}
		await live.connection.agent.notify(methods.agent.session.cancel, {
			sessionId: live.agentSessionId,
		});
		return { ok: true };
	}

	async replyPermission(
		workspaceId: string,
		sessionId: string,
		requestId: string,
		optionId: string,
	): Promise<{ ok: true }> {
		this.getRecord(workspaceId, sessionId);
		const live = this.requireLive(sessionId);
		const pending = live.pendingPermission;
		if (!pending || pending.requestId !== requestId)
			throw new Error("This ACP permission request is no longer active.");
		const selected = pending.options.find((option) => option.optionId === optionId);
		if (!selected) throw new Error("Choose one of the available ACP permission options.");
		this.resolvePermission(live, { outcome: "selected", optionId });
		return { ok: true };
	}

	async setMode(workspaceId: string, sessionId: string, modeId: string): Promise<{ ok: true }> {
		const record = this.getRecord(workspaceId, sessionId);
		const live = this.requireLive(sessionId);
		if (!record.snapshot.modes.some((mode) => mode.id === modeId)) {
			throw new Error("That ACP mode is not available in this session.");
		}
		await live.connection.agent.request(methods.agent.session.setMode, {
			sessionId: live.agentSessionId,
			modeId,
		});
		record.snapshot.currentMode = modeId;
		this.persist();
		this.emit({ type: "mode", sessionId, mode: modeId });
		return { ok: true };
	}

	async setConfigOption(
		workspaceId: string,
		sessionId: string,
		configId: string,
		value: string,
	): Promise<{ ok: true }> {
		const record = this.getRecord(workspaceId, sessionId);
		const live = this.requireLive(sessionId);
		const configOption = record.snapshot.configOptions.find((option) => option.id === configId);
		if (!configOption?.options.some((option) => option.value === value)) {
			throw new Error("That ACP configuration value is not available.");
		}
		const result = await live.connection.agent.request(methods.agent.session.setConfigOption, {
			sessionId: live.agentSessionId,
			configId,
			value,
		});
		record.snapshot.configOptions = result.configOptions.map((option) =>
			normalizeConfigOption(option),
		);
		this.persist();
		this.emitConfigOptions(record);
		return { ok: true };
	}

	async delete(workspaceId: string, sessionId: string): Promise<{ ok: true }> {
		const record = this.getRecord(workspaceId, sessionId);
		const live = this.live.get(sessionId);
		if (live) {
			try {
				await live.connection.agent.request(methods.agent.session.close, {
					sessionId: live.agentSessionId,
				});
			} catch {}
			await this.closeLive(sessionId, live);
		}
		this.records.delete(sessionId);
		this.persist();
		this.emit({ type: "deleted", sessionId: record.snapshot.summary.id });
		return { ok: true };
	}

	async closeAll(): Promise<void> {
		await Promise.all(
			[...this.live.entries()].map(async ([sessionId, live]) => {
				const record = this.records.get(sessionId);
				if (record) {
					this.flushPendingMessages(record, live);
					record.snapshot.summary.state = "interrupted";
					record.snapshot.summary.updatedAt = Date.now();
				}
				await this.closeLive(sessionId, live);
			}),
		);
		this.persist();
	}

	private getConfiguredClient(clientId: string): AcpClientConfig {
		const config = this.options.getClient(clientId);
		if (!config || !isAcpClientConfig(config))
			throw new Error("This ACP client is not configured.");
		return { ...config, args: [...config.args] };
	}

	private getRecord(workspaceId: string, sessionId: string): StoredAcpSession {
		const record = this.records.get(sessionId);
		if (!record || record.snapshot.summary.workspaceId !== workspaceId) {
			throw new Error("This ACP chat is not available in the selected workspace.");
		}
		return record;
	}

	private requireLive(sessionId: string): LiveAcpSession {
		const live = this.live.get(sessionId);
		if (!live || live.closing) throw new Error("Resume this ACP chat before sending a message.");
		return live;
	}

	private persist(): void {
		while (this.records.size > ACP_SESSION_LIMIT) {
			const oldest = [...this.records.values()].sort(
				(left, right) => left.snapshot.summary.updatedAt - right.snapshot.summary.updatedAt,
			)[0];
			if (!oldest) break;
			this.records.delete(oldest.snapshot.summary.id);
		}
		const data: StoredAcpData = {
			version: 1,
			sessions: [...this.records.values()],
		};
		saveAcpSessionData(data);
	}

	private emit(event: AcpSessionEvent): void {
		try {
			this.options.publish(event);
		} catch {
			log.warn("ACP event publication failed");
		}
	}

	private publishState(record: StoredAcpSession): void {
		this.emit({
			type: "state",
			sessionId: record.snapshot.summary.id,
			state: record.snapshot.summary.state,
		});
	}

	private setState(record: StoredAcpSession, state: AcpSessionState): void {
		record.snapshot.summary.state = state;
		record.snapshot.summary.updatedAt = Date.now();
		this.persist();
		this.publishState(record);
	}

	private addMessage(record: StoredAcpSession, entry: AcpTranscriptEntry): void {
		record.snapshot.messages.push(entry);
		while (
			record.snapshot.messages.length > ACP_MESSAGE_LIMIT ||
			transcriptTextLength(record.snapshot.messages) > ACP_TRANSCRIPT_CHAR_LIMIT
		) {
			record.snapshot.messages.shift();
		}
		record.snapshot.summary.updatedAt = Date.now();
		this.persist();
		this.emit({ type: "message", sessionId: record.snapshot.summary.id, entry });
	}

	private async openSession(
		record: StoredAcpSession,
		config: AcpClientConfig,
		cwd: string,
	): Promise<{ live: LiveAcpSession; initialized: InitializeResponse }> {
		const sessionId = record.snapshot.summary.id;
		const app = client();
		const live = {} as LiveAcpSession;
		app.onNotification(methods.client.session.update, ({ params }) => {
			this.handleUpdate(record, live, params);
		});
		app.onRequest(methods.client.session.requestPermission, ({ params, requestId, signal }) =>
			this.waitForPermission(
				record,
				live,
				{
					requestId: String(requestId),
					toolCallId: params.toolCall.toolCallId,
					title: params.toolCall.title ?? "ACP tool permission request",
					options: params.options.map((option) => ({
						optionId: option.optionId,
						name: option.name,
						kind: option.kind,
					})),
				},
				signal,
			),
		);
		app.onRequest(methods.client.fs.readTextFile, async ({ params }) => {
			this.assertAgentSession(live, params.sessionId);
			const root = this.options.resolveWorkspaceCwd(record.snapshot.summary.workspaceId);
			const filePath = await resolveAcpWorktreePath(root, params.path, true);
			const info = await fs.stat(filePath);
			if (info.size > ACP_READ_FILE_BYTE_LIMIT) throw new Error("ACP file is too large to read.");
			const text = await fs.readFile(filePath, "utf8");
			if (params.line == null && params.limit == null) return { content: text };
			const lines = text.split(/\r?\n/);
			const start = Math.max(0, (params.line ?? 1) - 1);
			const end = params.limit == null ? lines.length : start + Math.max(0, params.limit);
			return { content: lines.slice(start, end).join("\n") };
		});
		app.onRequest(methods.client.fs.writeTextFile, async ({ params }) => {
			this.assertAgentSession(live, params.sessionId);
			if (Buffer.byteLength(params.content, "utf8") > ACP_WRITE_FILE_BYTE_LIMIT) {
				throw new Error("ACP file write is too large.");
			}
			const root = this.options.resolveWorkspaceCwd(record.snapshot.summary.workspaceId);
			const filePath = await resolveAcpWorktreePath(root, params.path, false);
			const relativePath = relative(root, filePath) || ".";
			const allowed = await this.requestLocalPermission(
				record,
				live,
				`Allow ${record.snapshot.summary.clientName} to modify ${relativePath}?`,
			);
			if (!allowed) throw new Error("The user denied this ACP file write.");
			const approvedFilePath = await resolveAcpWorktreePath(root, params.path, false);
			if (approvedFilePath !== filePath) {
				throw new Error("ACP file path changed while permission was pending.");
			}
			await fs.writeFile(approvedFilePath, params.content, { encoding: "utf8", flag: "w" });
			return {};
		});
		app.onRequest(methods.client.terminal.create, ({ params }) =>
			this.createTerminal(record, live, params),
		);
		app.onRequest(methods.client.terminal.output, ({ params }) =>
			this.terminalOutput(live, params.sessionId, params.terminalId),
		);
		app.onRequest(methods.client.terminal.waitForExit, ({ params }) =>
			this.waitForTerminal(live, params.sessionId, params.terminalId),
		);
		app.onRequest(methods.client.terminal.kill, ({ params }) =>
			this.killTerminal(live, params.sessionId, params.terminalId),
		);
		app.onRequest(methods.client.terminal.release, ({ params }) =>
			this.releaseTerminal(live, params.sessionId, params.terminalId),
		);

		const spawned = this.spawnConnection(config, cwd, app);
		live.child = spawned.child;
		live.connection = spawned.connection;
		live.agentSessionId = record.agentSessionId;
		live.promptRunning = false;
		live.closing = false;
		live.pendingPermission = null;
		live.terminals = new Map();
		live.pendingMessages = new Map();
		this.live.set(sessionId, live);
		void live.connection.closed
			.then(() => this.handleConnectionClosed(sessionId, record, live))
			.catch(() => log.warn("ACP connection cleanup failed"));
		try {
			const initialized = await this.initializeConnection(live.connection);
			return { live, initialized };
		} catch (error) {
			await this.closeLive(sessionId, live);
			throw error;
		}
	}

	private spawnConnection(
		config: AcpClientConfig,
		cwd: string,
		app = client(),
	): { child: ChildProcess; connection: ClientConnection } {
		const child = spawn(config.command, config.args, {
			cwd,
			env: process.env,
			shell: false,
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", () => {});
		const stream = ndJsonStream(Writable.toWeb(child.stdin), readableWebStream(child.stdout));
		const connection = app.connect(stream);
		child.once("error", () => connection.close());
		return { child, connection };
	}

	private initializeConnection(connection: ClientConnection): Promise<InitializeResponse> {
		return this.requestWithTimeout(
			connection.agent.request(methods.agent.initialize, {
				protocolVersion: ACP_VERSION,
				clientCapabilities: {
					fs: { readTextFile: true, writeTextFile: true },
					terminal: true,
					plan: {},
					session: { configOptions: { boolean: {} }, notices: {} },
				},
				clientInfo: { name: "ThinkRail", version: this.options.clientVersion },
			}),
		);
	}

	private async requestWithTimeout<T>(promise: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				promise,
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(
						() => reject(new Error("ACP request timed out")),
						ACP_START_TIMEOUT_MS,
					);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	private applySessionSetup(
		record: StoredAcpSession,
		setup: {
			modes?: { currentModeId: string; availableModes: Array<{ id: string; name: string }> } | null;
			configOptions?: Parameters<typeof normalizeConfigOption>[0][] | null;
		},
	): void {
		record.snapshot.modes = setup.modes?.availableModes.map(({ id, name }) => ({ id, name })) ?? [];
		record.snapshot.currentMode = setup.modes?.currentModeId ?? null;
		record.snapshot.configOptions = (setup.configOptions ?? []).map((option) =>
			normalizeConfigOption(option),
		);
		this.persist();
	}

	private emitConfigOptions(record: StoredAcpSession): void {
		const sessionId = record.snapshot.summary.id;
		for (const option of record.snapshot.configOptions) {
			this.emit({ type: "configOption", sessionId, option });
		}
		this.emit({
			type: "configOptions",
			sessionId,
			options: record.snapshot.configOptions,
		});
	}

	private async executePrompt(
		record: StoredAcpSession,
		live: LiveAcpSession,
		content: Array<
			{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }
		>,
	): Promise<void> {
		try {
			await live.connection.agent.request(methods.agent.session.prompt, {
				sessionId: live.agentSessionId,
				prompt: content,
			});
			this.flushPendingMessages(record, live);
			live.promptRunning = false;
			if (this.live.get(record.snapshot.summary.id) === live) this.setState(record, "idle");
		} catch (error) {
			this.flushPendingMessages(record, live);
			live.promptRunning = false;
			if (this.live.get(record.snapshot.summary.id) === live) this.setState(record, "failed");
			throw error;
		}
	}

	private handleUpdate(
		record: StoredAcpSession,
		live: LiveAcpSession,
		notification: SessionNotification,
	): void {
		const { sessionId, update } = notification;
		if (sessionId !== live.agentSessionId) return;
		const thinkrailSessionId = record.snapshot.summary.id;
		switch (update.sessionUpdate) {
			case "agent_message_chunk":
				if (update.content.type === "text")
					this.appendMessageDelta(record, live, "assistant", update.content.text);
				else if (update.content.type === "image")
					this.appendImage(record, live, "assistant", update.content);
				break;
			case "agent_thought_chunk":
				if (update.content.type === "text")
					this.appendMessageDelta(record, live, "thought", update.content.text);
				else if (update.content.type === "image")
					this.appendImage(record, live, "thought", update.content);
				break;
			case "tool_call":
			case "tool_call_update": {
				const toolCall: AcpToolCallSummary = {
					id: update.toolCallId,
					title:
						update.title ??
						record.snapshot.toolCalls.find((tool) => tool.id === update.toolCallId)?.title ??
						"Agent tool",
					kind:
						update.kind ??
						record.snapshot.toolCalls.find((tool) => tool.id === update.toolCallId)?.kind ??
						"other",
					status: mapToolStatus(update.status),
				};
				const existing = record.snapshot.toolCalls.findIndex((tool) => tool.id === toolCall.id);
				if (existing < 0) record.snapshot.toolCalls.push(toolCall);
				else record.snapshot.toolCalls[existing] = toolCall;
				record.snapshot.toolCalls = record.snapshot.toolCalls.slice(-500);
				this.persist();
				this.emit({ type: "toolCall", sessionId: thinkrailSessionId, toolCall });
				break;
			}
			case "plan":
				record.snapshot.plan = update.entries.map(({ content, status, priority }) => ({
					content,
					status,
					priority,
				}));
				this.persist();
				this.emit({ type: "plan", sessionId: thinkrailSessionId, entries: record.snapshot.plan });
				break;
			case "plan_update":
				if (update.plan.type === "items") {
					record.snapshot.plan = update.plan.entries.map(({ content, status, priority }) => ({
						content,
						status,
						priority,
					}));
				} else if (update.plan.type === "markdown") {
					record.snapshot.plan = [
						{
							content: update.plan.content,
							status: "in_progress",
							priority: "medium",
						},
					];
				} else {
					record.snapshot.plan = [
						{
							content: update.plan.uri,
							status: "in_progress",
							priority: "medium",
						},
					];
				}
				this.persist();
				this.emit({ type: "plan", sessionId: thinkrailSessionId, entries: record.snapshot.plan });
				break;
			case "plan_removed":
				record.snapshot.plan = [];
				this.persist();
				this.emit({ type: "plan", sessionId: thinkrailSessionId, entries: [] });
				break;
			case "current_mode_update":
				record.snapshot.currentMode = update.currentModeId;
				this.persist();
				this.emit({ type: "mode", sessionId: thinkrailSessionId, mode: update.currentModeId });
				break;
			case "config_option_update":
				record.snapshot.configOptions = update.configOptions.map((option) =>
					normalizeConfigOption(option),
				);
				this.persist();
				this.emitConfigOptions(record);
				break;
			case "available_commands_update":
				record.snapshot.availableCommands = update.availableCommands.map((command) => ({
					name: command.name,
					description: command.description,
					...(command.input?.hint ? { inputHint: command.input.hint } : {}),
				}));
				this.persist();
				this.emit({
					type: "availableCommands",
					sessionId: thinkrailSessionId,
					commands: record.snapshot.availableCommands,
				});
				break;
			case "usage_update": {
				const usage: AcpUsage = {
					used: update.used,
					size: update.size,
					...(update.cost
						? { cost: { amount: update.cost.amount, currency: update.cost.currency } }
						: {}),
				};
				record.snapshot.usage = usage;
				this.persist();
				this.emit({ type: "usage", sessionId: thinkrailSessionId, usage });
				break;
			}
			case "session_info_update": {
				const title = normalizeSessionTitle(update.title);
				if (title) {
					record.snapshot.summary.title = title;
					record.snapshot.summary.updatedAt = Date.now();
					this.persist();
				}
				break;
			}
			case "notice":
				this.addMessage(record, {
					id: randomUUID(),
					role: "notice",
					text: [update.title, update.description].filter(Boolean).join("\n"),
					createdAt: Date.now(),
				});
				break;
			case "user_message_chunk":
			case "compaction_update":
			case "compaction_summary_chunk":
			case "subagent_update":
				break;
			default:
				break;
		}
	}

	private appendMessageDelta(
		record: StoredAcpSession,
		live: LiveAcpSession,
		role: "assistant" | "thought",
		text: string,
	): void {
		const current =
			live.pendingMessages.get(role) ??
			({
				id: randomUUID(),
				role,
				text: "",
				createdAt: Date.now(),
			} satisfies AcpTranscriptEntry);
		const remaining = Math.max(0, ACP_ENTRY_CHAR_LIMIT - current.text.length);
		const delta = text.slice(0, remaining);
		if (!delta) return;
		current.text += delta;
		live.pendingMessages.set(role, current);
		record.snapshot.summary.updatedAt = Date.now();
		this.emit({ type: "messageDelta", sessionId: record.snapshot.summary.id, role, delta });
	}

	private appendImage(
		record: StoredAcpSession,
		live: LiveAcpSession,
		role: "assistant" | "thought",
		image: { mimeType: string; data: string },
	): void {
		if (
			!image.mimeType.startsWith("image/") ||
			image.data.length > ACP_IMAGE_CHAR_LIMIT ||
			!/^[-A-Za-z0-9+/]*={0,2}$/.test(image.data)
		) {
			return;
		}
		const current =
			live.pendingMessages.get(role) ??
			({
				id: randomUUID(),
				role,
				text: "",
				createdAt: Date.now(),
			} satisfies AcpTranscriptEntry);
		current.images = [...(current.images ?? []), { mimeType: image.mimeType, data: image.data }];
		live.pendingMessages.set(role, current);
		this.emit({
			type: "image",
			sessionId: record.snapshot.summary.id,
			role,
			image: { mimeType: image.mimeType, data: image.data },
		});
	}

	private flushPendingMessages(record: StoredAcpSession, live: LiveAcpSession): void {
		for (const entry of live.pendingMessages.values()) {
			if (entry.text || entry.images?.length) this.addMessage(record, entry);
		}
		live.pendingMessages.clear();
	}

	private async waitForPermission(
		record: StoredAcpSession,
		live: LiveAcpSession,
		request: PendingPermissionInput,
		signal: AbortSignal,
	): Promise<{ outcome: RequestPermissionOutcome }> {
		if (live.pendingPermission) return { outcome: { outcome: "cancelled" } };
		return new Promise((resolvePromise) => {
			const timer = setTimeout(() => {
				this.resolvePermission(live, { outcome: "cancelled" });
			}, ACP_PERMISSION_TIMEOUT_MS);
			const abortListener = () => this.resolvePermission(live, { outcome: "cancelled" });
			live.pendingPermission = {
				...request,
				sessionId: record.snapshot.summary.id,
				resolve: (outcome) => resolvePromise({ outcome }),
				timer,
				abortSignal: signal,
				abortListener,
			};
			const permission: AcpPermissionRequest = {
				requestId: request.requestId,
				toolCallId: request.toolCallId,
				title: request.title,
				options: request.options,
			};
			record.snapshot.permission = permission;
			try {
				this.setState(record, "needs-input");
			} catch {
				record.snapshot.summary.state = "needs-input";
				this.publishState(record);
				log.warn("ACP permission state could not be persisted");
			}
			this.emit({ type: "permission", sessionId: record.snapshot.summary.id, permission });
			signal.addEventListener("abort", abortListener, { once: true });
			if (signal.aborted) abortListener();
		});
	}

	private async requestLocalPermission(
		record: StoredAcpSession,
		live: LiveAcpSession,
		title: string,
	): Promise<boolean> {
		const options: AcpPermissionOption[] = [
			{ optionId: "allow-once", name: "Allow once", kind: "allow_once" },
			{ optionId: "reject-once", name: "Deny", kind: "reject_once" },
		];
		const result = await this.waitForPermission(
			record,
			live,
			{
				requestId: randomUUID(),
				toolCallId: `thinkrail-${randomUUID()}`,
				title,
				options,
			},
			live.connection.signal,
		);
		return permissionIsGranted(result.outcome, options);
	}

	private resolvePermission(live: LiveAcpSession, outcome: RequestPermissionOutcome): void {
		const pending = live.pendingPermission;
		if (!pending) return;
		clearTimeout(pending.timer);
		if (pending.abortSignal && pending.abortListener) {
			pending.abortSignal.removeEventListener("abort", pending.abortListener);
		}
		live.pendingPermission = null;
		const record = this.records.get(pending.sessionId);
		if (record) {
			record.snapshot.permission = null;
			try {
				this.persist();
				this.emit({ type: "permission", sessionId: record.snapshot.summary.id, permission: null });
				if (!live.closing) this.setState(record, live.promptRunning ? "running" : "idle");
			} catch {
				log.warn("ACP permission state could not be persisted");
			}
		}
		pending.resolve(outcome);
	}

	private assertAgentSession(live: LiveAcpSession, agentSessionId: string): void {
		if (agentSessionId !== live.agentSessionId)
			throw new Error("ACP session id does not match this connection.");
	}

	private async createTerminal(
		record: StoredAcpSession,
		live: LiveAcpSession,
		params: {
			sessionId: string;
			command: string;
			args?: string[];
			env?: Array<{ name: string; value: string }>;
			cwd?: string | null;
			outputByteLimit?: number | null;
		},
	): Promise<{ terminalId: string }> {
		this.assertAgentSession(live, params.sessionId);
		if (live.terminals.size >= ACP_TERMINAL_COUNT_LIMIT)
			throw new Error("Too many ACP terminals are active.");
		if (!params.command || params.command.includes("\0"))
			throw new Error("ACP terminal command is invalid.");
		const root = this.options.resolveWorkspaceCwd(record.snapshot.summary.workspaceId);
		const cwd = params.cwd
			? await resolveAcpWorktreePath(root, params.cwd, true)
			: await fs.realpath(root);
		const command = [params.command, ...(params.args ?? [])].join(" ");
		const allowed = await this.requestLocalPermission(
			record,
			live,
			`Allow ${record.snapshot.summary.clientName} to run ${command}?`,
		);
		if (!allowed) throw new Error("The user denied this ACP command.");
		const approvedCwd = params.cwd
			? await resolveAcpWorktreePath(root, params.cwd, true)
			: await fs.realpath(root);
		if (approvedCwd !== cwd) {
			throw new Error("ACP terminal working directory changed while permission was pending.");
		}
		const env = { ...process.env };
		for (const variable of params.env ?? []) {
			if (
				!variable ||
				typeof variable.name !== "string" ||
				typeof variable.value !== "string" ||
				variable.value.includes("\0") ||
				!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.name)
			) {
				throw new Error("ACP terminal environment is invalid.");
			}
			env[variable.name] = variable.value;
		}
		const child = spawn(params.command, params.args ?? [], {
			cwd,
			env,
			shell: false,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const outputByteLimit = Math.min(
			ACP_TERMINAL_OUTPUT_LIMIT,
			Math.max(1024, params.outputByteLimit ?? ACP_TERMINAL_OUTPUT_LIMIT),
		);
		const terminal: TerminalProcess = {
			child,
			output: "",
			truncated: false,
			outputByteLimit,
			exitStatus: null,
			exited: new Promise((resolvePromise) => {
				child.once("close", (exitCode, signal) => {
					terminal.exitStatus = { exitCode, signal };
					resolvePromise();
				});
			}),
		};
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");
		const capture = (text: string) => {
			const next = appendBounded(terminal.output, text, terminal.outputByteLimit);
			terminal.output = next.text;
			terminal.truncated ||= next.truncated;
		};
		child.stdout.on("data", (chunk: Buffer) => capture(stdoutDecoder.write(chunk)));
		child.stderr.on("data", (chunk: Buffer) => capture(stderrDecoder.write(chunk)));
		child.once("close", () => {
			capture(stdoutDecoder.end());
			capture(stderrDecoder.end());
		});
		const terminalId = randomUUID();
		live.terminals.set(terminalId, terminal);
		return { terminalId };
	}

	private getTerminal(
		live: LiveAcpSession,
		sessionId: string,
		terminalId: string,
	): TerminalProcess {
		this.assertAgentSession(live, sessionId);
		const terminal = live.terminals.get(terminalId);
		if (!terminal) throw new Error("ACP terminal is no longer available.");
		return terminal;
	}

	private terminalOutput(
		live: LiveAcpSession,
		sessionId: string,
		terminalId: string,
	): {
		output: string;
		truncated: boolean;
		exitStatus?: { exitCode: number | null; signal: string | null };
	} {
		const terminal = this.getTerminal(live, sessionId, terminalId);
		return {
			output: terminal.output,
			truncated: terminal.truncated,
			...(terminal.exitStatus ? { exitStatus: terminal.exitStatus } : {}),
		};
	}

	private async waitForTerminal(
		live: LiveAcpSession,
		sessionId: string,
		terminalId: string,
	): Promise<{ exitCode?: number | null; signal?: string | null }> {
		const terminal = this.getTerminal(live, sessionId, terminalId);
		await terminal.exited;
		const exitStatus = terminal.exitStatus;
		if (!exitStatus) return {};
		return {
			exitCode: exitStatus.exitCode,
			signal: exitStatus.signal,
		};
	}

	private killTerminal(
		live: LiveAcpSession,
		sessionId: string,
		terminalId: string,
	): Record<string, never> {
		this.getTerminal(live, sessionId, terminalId).child.kill("SIGTERM");
		return {};
	}

	private async releaseTerminal(
		live: LiveAcpSession,
		sessionId: string,
		terminalId: string,
	): Promise<Record<string, never>> {
		const terminal = this.getTerminal(live, sessionId, terminalId);
		if (terminal.exitStatus === null) {
			terminal.child.kill("SIGTERM");
			await Promise.race([
				terminal.exited,
				new Promise((resolvePromise) => setTimeout(resolvePromise, 1000)),
			]);
			if (terminal.exitStatus === null) terminal.child.kill("SIGKILL");
		}
		live.terminals.delete(terminalId);
		return {};
	}

	private async handleConnectionClosed(
		sessionId: string,
		record: StoredAcpSession,
		live: LiveAcpSession,
	): Promise<void> {
		if (live.closing || this.live.get(sessionId) !== live) return;
		this.live.delete(sessionId);
		this.flushPendingMessages(record, live);
		if (live.pendingPermission) this.resolvePermission(live, { outcome: "cancelled" });
		for (const terminal of live.terminals.values()) terminal.child.kill("SIGTERM");
		record.snapshot.summary.state = "interrupted";
		record.snapshot.summary.updatedAt = Date.now();
		this.persist();
		this.publishState(record);
	}

	private async closeLive(sessionId: string, live: LiveAcpSession): Promise<void> {
		live.closing = true;
		if (live.pendingPermission) this.resolvePermission(live, { outcome: "cancelled" });
		for (const terminal of live.terminals.values()) terminal.child.kill("SIGTERM");
		live.terminals.clear();
		this.live.delete(sessionId);
		await this.closeChild(live.child, live.connection);
	}

	private async closeChild(child: ChildProcess, connection: ClientConnection): Promise<void> {
		const closed = once(child, "close").then(() => undefined);
		connection.close();
		child.stdin.end();
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
		await Promise.race([closed, new Promise((resolvePromise) => setTimeout(resolvePromise, 1000))]);
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
			await Promise.race([
				closed,
				new Promise((resolvePromise) => setTimeout(resolvePromise, 1000)),
			]);
		}
	}
}
