import { type ChildProcessByStdio, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { accessSync, promises as fs, constants as fsConstants, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import {
	type AuthMethod,
	type ClientApp,
	type ClientConnection,
	client,
	type InitializeResponse,
	methods,
	ndJsonStream,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import * as AcpV2 from "@agentclientprotocol/sdk/experimental/v2";
import {
	ACP_START_TIMEOUT_MAX_MS,
	ACP_START_TIMEOUT_MIN_MS,
	type AcpAuthMethodSummary,
	type AcpAuthTerminalEvent,
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
	DEFAULT_ACP_START_TIMEOUT_MS,
	IMAGE_MAX_BASE64_BYTES,
	type ImageContent,
	isAcpClientConfig,
	normalizeSessionTitle,
} from "@thinkrail/contracts";
import { type IPty, spawn as spawnPty } from "bun-pty";
import { logger } from "../log";
import { loadAcpSessionData, saveAcpSessionData } from "../persistence";

const ACP_V1 = 1;
const ACP_V2 = 2;
const ACP_AUTH_TIMEOUT_MS = 10 * 60 * 1000;
const ACP_AUTH_TERMINAL_TIMEOUT_MS = 15 * 60 * 1000;
const ACP_AUTH_TERMINAL_OUTPUT_LIMIT = 8 * 1024 * 1024;
const ACP_AUTH_TERMINAL_INPUT_LIMIT = 32 * 1024;
const ACP_AUTH_TERMINAL_LIMIT = 4;
const ACP_AUTH_METHOD_LIMIT = 16;
const ACP_ARGUMENT_LIMIT = 128;
const ACP_ENVIRONMENT_LIMIT = 64;
const ACP_CONFIG_ID_LIMIT = 128;
const ACP_CONFIG_NAME_LIMIT = 256;
const ACP_CONFIG_VALUE_LIMIT = 256;
const ACP_CONFIG_DESCRIPTION_LIMIT = 1024;
const ACP_CONFIG_CHOICE_NAME_LIMIT = 256;
const ACP_CONFIG_CHOICE_VALUE_LIMIT = 256;
const ACP_MESSAGE_LIMIT = 800;
const ACP_TRANSCRIPT_CHAR_LIMIT = 1_000_000;
const ACP_ENTRY_CHAR_LIMIT = 100_000;
const ACP_PENDING_MESSAGE_LIMIT = 128;
const ACP_MODE_LIMIT = 100;
const ACP_MODE_ID_LIMIT = 128;
const ACP_MODE_NAME_LIMIT = 256;
const ACP_PLAN_ENTRY_LIMIT = 100;
const ACP_PLAN_TEXT_LIMIT = 10_000;
const ACP_AVAILABLE_COMMAND_LIMIT = 100;
const ACP_COMMAND_NAME_LIMIT = 128;
const ACP_COMMAND_DESCRIPTION_LIMIT = 2_048;
const ACP_COMMAND_HINT_LIMIT = 2_048;
const ACP_CONFIG_OPTION_LIMIT = 32;
const ACP_MODEL_OPTION_VALUES_LIMIT = 100;
const ACP_IMAGE_CHAR_LIMIT = IMAGE_MAX_BASE64_BYTES;
const ACP_READ_FILE_BYTE_LIMIT = 2 * 1024 * 1024;
const ACP_WRITE_FILE_BYTE_LIMIT = 2 * 1024 * 1024;
const ACP_TERMINAL_COUNT_LIMIT = 10;
const ACP_TERMINAL_OUTPUT_LIMIT = 1024 * 1024;
const ACP_PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;
const ACP_SESSION_LIMIT = 500;
const ACP_PERSIST_DEBOUNCE_MS = 100;
const ACP_PERSIST_RETRY_MS = 500;

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
type ManagedChild = {
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	kill: (signal?: NodeJS.Signals | number) => boolean;
};

type AcpProtocolVersion = typeof ACP_V1 | typeof ACP_V2;

type WireConnection =
	| { version: typeof ACP_V1; child: ChildProcess; connection: ClientConnection }
	| { version: typeof ACP_V2; child: ChildProcess; connection: AcpV2.ClientConnection };

interface AcpInitialization {
	protocolVersion: number;
	authMethods: RuntimeAuthMethod[];
	canResumeSession: boolean;
}

type ConnectedAcp = WireConnection & { initialized: AcpInitialization };

interface RuntimeAuthMethod {
	id: string;
	name: string;
	description?: string | null;
	type?: "agent" | "terminal";
	args?: string[];
	env?: Record<string, string> | Array<{ name: string; value: string }>;
	launchDataValid?: boolean;
}

type PermissionOutcome = { outcome: "cancelled" } | { outcome: "selected"; optionId: string };

interface NormalizedSessionSetup {
	sessionId: string;
	modes: Array<{ id: string; name: string }>;
	currentMode: string | null;
	configOptions: AcpConfigOption[];
	booleanConfigOptionIds: string[];
	availableCommands: AcpAvailableCommand[];
}

interface V2PromptTurn {
	sawActivity: boolean;
	resolve: () => void;
	promise: Promise<void>;
}

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
	resolve: (outcome: PermissionOutcome) => void;
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
	connection: ConnectedAcp;
	agentSessionId: string;
	promptRunning: boolean;
	v2PromptTurn: V2PromptTurn | null;
	v2StateUpdateReceived: boolean;
	booleanConfigOptionIds: Set<string>;
	closing: boolean;
	pendingPermission: PendingPermission | null;
	terminals: Map<string, TerminalProcess>;
	pendingMessages: Map<string, AcpTranscriptEntry>;
}

interface PendingAcpConnection {
	clientId: string;
	clientKey: string;
	connection: WireConnection | null;
	cancelled: boolean;
	cancelledPromise: Promise<never>;
	rejectCancelled: () => void;
	settled: Promise<void>;
	resolveSettled: () => void;
}

interface AuthTerminal {
	id: string;
	clientId: string;
	clientKey: string;
	configSignature: string;
	pty: IPty;
	outputBytes: number;
	cancelled: boolean;
	timer: ReturnType<typeof setTimeout>;
	exited: Promise<void>;
	resolveExited: () => void;
	killTimer?: ReturnType<typeof setTimeout>;
}

export interface AcpSessionManagerOptions {
	getClient: (id: string) => AcpClientConfig | undefined;
	getStartTimeout?: () => number;
	resolveWorkspaceCwd: (workspaceId: string) => string;
	publish: (event: AcpSessionEvent) => void;
	publishAuthTerminal: (clientKey: string, event: AcpAuthTerminalEvent) => boolean;
	clientVersion: string;
}

const log = logger("acp");

class UnsupportedAcpProtocolError extends Error {}

class AcpTimeoutError extends Error {
	constructor(readonly timeoutMs: number) {
		super(`ACP request timed out after ${timeoutMs} ms.`);
		this.name = "AcpTimeoutError";
	}
}

class AcpExecutableUnavailableError extends Error {
	constructor() {
		super("ACP executable is unavailable.");
		this.name = "AcpExecutableUnavailableError";
	}
}

function normalizeAcpStartTimeout(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_ACP_START_TIMEOUT_MS;
	return Math.min(ACP_START_TIMEOUT_MAX_MS, Math.max(ACP_START_TIMEOUT_MIN_MS, Math.trunc(value)));
}

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

function normalizeAcpArguments(value: unknown): string[] | null {
	if (!Array.isArray(value) || value.length > ACP_ARGUMENT_LIMIT) return null;
	const normalized: string[] = [];
	let totalBytes = 0;
	for (const argument of value) {
		if (typeof argument !== "string" || argument.length > 4096 || argument.includes("\0")) {
			return null;
		}
		totalBytes += Buffer.byteLength(argument, "utf8");
		if (totalBytes > 32_768) return null;
		normalized.push(argument);
	}
	return normalized;
}

function normalizeAcpEnvironment(value: unknown): Record<string, string> | null {
	let entries: Array<[unknown, unknown]>;
	if (Array.isArray(value)) {
		if (value.length > ACP_ENVIRONMENT_LIMIT) return null;
		entries = value.map((entry): [unknown, unknown] =>
			isRecord(entry) ? [entry.name, entry.value] : [undefined, undefined],
		);
	} else if (isRecord(value)) {
		entries = Object.entries(value);
		if (entries.length > ACP_ENVIRONMENT_LIMIT) return null;
	} else {
		return null;
	}
	const env = Object.create(null) as Record<string, string>;
	const seenNames = new Set<string>();
	let totalBytes = 0;
	for (const [rawName, rawValue] of entries) {
		if (typeof rawName !== "string" || typeof rawValue !== "string") return null;
		const nameKey = process.platform === "win32" ? rawName.toUpperCase() : rawName;
		if (
			!/^[A-Za-z_][A-Za-z0-9_]*$/.test(rawName) ||
			rawName.length > 128 ||
			rawValue.length > 8192 ||
			rawValue.includes("\0") ||
			seenNames.has(nameKey)
		) {
			return null;
		}
		seenNames.add(nameKey);
		totalBytes += Buffer.byteLength(rawName, "utf8") + Buffer.byteLength(rawValue, "utf8");
		if (totalBytes > 32_768) return null;
		Object.defineProperty(env, rawName, {
			value: rawValue,
			enumerable: true,
			configurable: true,
			writable: true,
		});
	}
	return env;
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
	maxOptions = ACP_MODEL_OPTION_VALUES_LIMIT,
): AcpConfigOption | null {
	if (
		!boundedString(option.id, ACP_CONFIG_ID_LIMIT) ||
		!boundedString(option.name, ACP_CONFIG_NAME_LIMIT) ||
		!boundedString(String(option.currentValue), ACP_CONFIG_VALUE_LIMIT)
	) {
		return null;
	}
	const values =
		option.type === "boolean"
			? [
					{ value: "true", name: "On" },
					{ value: "false", name: "Off" },
				]
			: (option.options ?? []);
	const options: Array<{ value: string; name: string }> = [];
	for (const entry of values) {
		const choices = "group" in entry ? entry.options : [entry];
		for (const choice of choices) {
			if (options.length >= maxOptions) break;
			if (
				!boundedString(choice.value, ACP_CONFIG_CHOICE_VALUE_LIMIT) ||
				!boundedString(choice.name, ACP_CONFIG_CHOICE_NAME_LIMIT)
			) {
				continue;
			}
			options.push({ value: choice.value, name: choice.name });
		}
		if (options.length >= maxOptions) break;
	}
	return {
		id: option.id,
		name: option.name,
		currentValue: String(option.currentValue),
		options,
		...(boundedString(option.description, ACP_CONFIG_DESCRIPTION_LIMIT)
			? { description: option.description }
			: {}),
		...(typeof option.category === "string" && option.category.length <= 128
			? { category: option.category }
			: {}),
	};
}

function normalizeV1ConfigOptions(
	values: Parameters<typeof normalizeConfigOption>[0][] | null | undefined,
): AcpConfigOption[] {
	return (values ?? []).slice(0, ACP_CONFIG_OPTION_LIMIT).flatMap((option) => {
		const normalized = normalizeConfigOption(option);
		return normalized ? [normalized] : [];
	});
}

function normalizeV2ConfigOptions(options: unknown): {
	configOptions: AcpConfigOption[];
	booleanConfigOptionIds: string[];
} {
	const rawOptions = Array.isArray(options) ? options.slice(0, ACP_CONFIG_OPTION_LIMIT) : [];
	const configOptions: AcpConfigOption[] = [];
	const booleanConfigOptionIds: string[] = [];
	for (const rawOption of rawOptions) {
		if (!isRecord(rawOption)) continue;
		const { configId, name, type, currentValue } = rawOption;
		if (
			typeof configId !== "string" ||
			typeof name !== "string" ||
			!boundedString(configId, ACP_CONFIG_ID_LIMIT) ||
			!boundedString(name, ACP_CONFIG_NAME_LIMIT) ||
			!boundedString(String(currentValue), ACP_CONFIG_VALUE_LIMIT) ||
			(type !== "select" && type !== "boolean") ||
			(typeof currentValue !== "string" && typeof currentValue !== "boolean")
		) {
			continue;
		}
		const choices: AcpConfigOption["options"] = [];
		if (type === "select" && Array.isArray(rawOption.options)) {
			for (const rawEntry of rawOption.options) {
				const group =
					isRecord(rawEntry) && Array.isArray(rawEntry.options) ? rawEntry.options : [rawEntry];
				for (const rawChoice of group) {
					if (choices.length >= ACP_MODEL_OPTION_VALUES_LIMIT) break;
					if (
						isRecord(rawChoice) &&
						boundedString(rawChoice.value, ACP_CONFIG_CHOICE_VALUE_LIMIT) &&
						boundedString(rawChoice.name, ACP_CONFIG_CHOICE_NAME_LIMIT)
					) {
						choices.push({ value: rawChoice.value, name: rawChoice.name });
					}
				}
				if (choices.length >= ACP_MODEL_OPTION_VALUES_LIMIT) break;
			}
		}
		const option = normalizeConfigOption({
			id: configId,
			name,
			type,
			currentValue,
			options: choices,
			...(typeof rawOption.description === "string" &&
			rawOption.description.length <= ACP_CONFIG_DESCRIPTION_LIMIT
				? { description: rawOption.description }
				: {}),
			...(typeof rawOption.category === "string" && rawOption.category.length <= 128
				? { category: rawOption.category }
				: {}),
		});
		if (!option) continue;
		configOptions.push(option);
		if (type === "boolean") booleanConfigOptionIds.push(configId);
	}
	return {
		configOptions,
		booleanConfigOptionIds,
	};
}

function normalizeV2SessionSetup(
	sessionId: string,
	setup: {
		configOptions?: unknown;
		availableCommands?: unknown;
	},
): NormalizedSessionSetup {
	const { configOptions, booleanConfigOptionIds } = normalizeV2ConfigOptions(setup.configOptions);
	const modeOption = configOptions.find((option) => option.category === "mode");
	return {
		sessionId,
		modes: modeOption?.options.map(({ value, name }) => ({ id: value, name })) ?? [],
		currentMode: modeOption?.currentValue ?? null,
		configOptions,
		booleanConfigOptionIds,
		availableCommands: normalizeV2AvailableCommands(setup.availableCommands),
	};
}

function normalizeV2AvailableCommands(commands: unknown): AcpAvailableCommand[] {
	return normalizeAcpAvailableCommands(commands);
}

function normalizeAcpPlanEntries(entries: unknown): AcpPlanEntry[] {
	if (!Array.isArray(entries)) return [];
	const normalized: AcpPlanEntry[] = [];
	for (const entry of entries.slice(0, ACP_PLAN_ENTRY_LIMIT)) {
		if (
			!isRecord(entry) ||
			!boundedString(entry.content, ACP_PLAN_TEXT_LIMIT) ||
			!["pending", "in_progress", "completed"].includes(String(entry.status)) ||
			!["high", "medium", "low"].includes(String(entry.priority))
		) {
			continue;
		}
		normalized.push({
			content: entry.content,
			status: entry.status as AcpPlanEntry["status"],
			priority: entry.priority as AcpPlanEntry["priority"],
		});
	}
	return normalized;
}

function normalizeAcpAvailableCommands(commands: unknown): AcpAvailableCommand[] {
	if (!Array.isArray(commands)) return [];
	const normalized: AcpAvailableCommand[] = [];
	for (const command of commands.slice(0, ACP_AVAILABLE_COMMAND_LIMIT)) {
		if (
			!isRecord(command) ||
			!boundedString(command.name, ACP_COMMAND_NAME_LIMIT) ||
			!boundedString(command.description, ACP_COMMAND_DESCRIPTION_LIMIT)
		) {
			continue;
		}
		const input = isRecord(command.input) ? command.input : null;
		const inputHint =
			typeof command.inputHint === "string"
				? command.inputHint
				: input && (input.type === undefined || input.type === "text")
					? input.hint
					: undefined;
		normalized.push({
			name: command.name,
			description: command.description,
			...(boundedString(inputHint, ACP_COMMAND_HINT_LIMIT) ? { inputHint } : {}),
		});
	}
	return normalized;
}

function normalizeV1SessionSetup(setup: {
	sessionId: string;
	modes?: { currentModeId: string; availableModes: Array<{ id: string; name: string }> } | null;
	configOptions?: Parameters<typeof normalizeConfigOption>[0][] | null;
}): NormalizedSessionSetup {
	const currentMode = setup.modes?.currentModeId;
	return {
		sessionId: setup.sessionId,
		modes: normalizeAcpModes(setup.modes?.availableModes),
		currentMode: boundedString(currentMode, ACP_MODE_ID_LIMIT) ? currentMode : null,
		configOptions: normalizeV1ConfigOptions(setup.configOptions),
		booleanConfigOptionIds: [],
		availableCommands: [],
	};
}

function normalizeAcpModes(value: unknown): Array<{ id: string; name: string }> {
	if (!Array.isArray(value)) return [];
	const modes: Array<{ id: string; name: string }> = [];
	for (const mode of value.slice(0, ACP_MODE_LIMIT)) {
		if (
			isRecord(mode) &&
			boundedString(mode.id, ACP_MODE_ID_LIMIT) &&
			boundedString(mode.name, ACP_MODE_NAME_LIMIT)
		) {
			modes.push({ id: mode.id, name: mode.name });
		}
	}
	return modes;
}

function normalizeStoredConfigOption(value: unknown): AcpConfigOption | null {
	if (
		!isRecord(value) ||
		!boundedString(value.id, ACP_CONFIG_ID_LIMIT) ||
		!boundedString(value.name, ACP_CONFIG_NAME_LIMIT) ||
		!boundedString(value.currentValue, ACP_CONFIG_VALUE_LIMIT) ||
		!Array.isArray(value.options)
	) {
		return null;
	}
	const options: AcpConfigOption["options"] = [];
	for (const option of value.options.slice(0, ACP_MODEL_OPTION_VALUES_LIMIT)) {
		if (
			isRecord(option) &&
			boundedString(option.value, ACP_CONFIG_CHOICE_VALUE_LIMIT) &&
			boundedString(option.name, ACP_CONFIG_CHOICE_NAME_LIMIT)
		) {
			options.push({ value: option.value, name: option.name });
		}
	}
	return {
		id: value.id,
		name: value.name,
		currentValue: value.currentValue,
		options,
		...(boundedString(value.description, ACP_CONFIG_DESCRIPTION_LIMIT)
			? { description: value.description }
			: {}),
		...(boundedString(value.category, 128) ? { category: value.category } : {}),
	};
}

function normalizeAcpToolCall(value: unknown): AcpToolCallSummary | null {
	if (
		!isRecord(value) ||
		!boundedString(value.id, 256) ||
		!boundedString(value.title, 1000) ||
		!boundedString(value.kind, 64) ||
		!["pending", "in-progress", "completed", "failed"].includes(String(value.status))
	) {
		return null;
	}
	return {
		id: value.id,
		title: value.title,
		kind: value.kind,
		status: value.status as AcpToolCallSummary["status"],
	};
}

function sessionSignature(config: AcpClientConfig): string {
	return JSON.stringify([config.command, config.args]);
}

function transcriptTextLength(messages: AcpTranscriptEntry[]): number {
	return messages.reduce((total, message) => total + transcriptEntryTextLength(message), 0);
}

function transcriptEntryTextLength(message: AcpTranscriptEntry): number {
	return (
		message.text.length +
		(message.images?.reduce((total, image) => total + image.data.length, 0) ?? 0)
	);
}

function boundedString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length <= maxLength;
}

function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code < 32 || code === 127) return true;
	}
	return false;
}

function isExecutableUnavailable(error: Error): boolean {
	const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
	return ["EACCES", "ENOENT", "ENOTDIR"].includes(code ?? "");
}

function resolveExecutable(command: string): string | null {
	const windows = process.platform === "win32";
	const inspect = (candidate: string): string | null => {
		try {
			accessSync(candidate, windows ? fsConstants.F_OK : fsConstants.X_OK);
			if (!statSync(candidate).isFile()) return null;
			return candidate;
		} catch {
			return null;
		}
	};
	if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
		return inspect(command);
	}
	const extensions = windows
		? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
		: [""];
	const directories = (process.env.PATH ?? "").split(delimiter);
	for (const entry of directories) {
		const directory = entry.replace(/^"(.*)"$/, "$1");
		if (!directory) continue;
		for (const extension of extensions) {
			const found = inspect(join(directory, `${command}${extension}`));
			if (found) return found;
		}
		if (windows) {
			const found = inspect(join(directory, command));
			if (found) return found;
		}
	}
	return null;
}

function cleanAuthLabel(value: unknown, maxLength: number): string | null {
	if (typeof value !== "string") return null;
	let cleaned = "";
	for (const character of value) {
		cleaned += hasControlCharacter(character) ? " " : character;
	}
	const label = cleaned.replace(/\s+/g, " ").trim();
	return label ? label.slice(0, maxLength) : null;
}

function normalizeV1AuthMethod(method: AuthMethod): RuntimeAuthMethod {
	return {
		id: method.id,
		name: method.name,
		...(method.description ? { description: method.description } : {}),
		...("type" in method && method.type === "terminal"
			? {
					type: "terminal" as const,
					...(method.args ? { args: method.args } : {}),
					...(method.env ? { env: method.env } : {}),
				}
			: { type: "agent" as const }),
	};
}

function normalizeV2AuthMethods(methods: unknown): RuntimeAuthMethod[] {
	if (!Array.isArray(methods)) return [];
	const normalized: RuntimeAuthMethod[] = [];
	for (const rawMethod of methods) {
		if (
			!isRecord(rawMethod) ||
			typeof rawMethod.methodId !== "string" ||
			typeof rawMethod.name !== "string" ||
			(rawMethod.type !== "terminal" && rawMethod.type !== "agent")
		) {
			continue;
		}
		const terminal = rawMethod.type === "terminal";
		const method: RuntimeAuthMethod = {
			id: rawMethod.methodId,
			name: rawMethod.name,
			...(typeof rawMethod.description === "string" ? { description: rawMethod.description } : {}),
			type: terminal ? "terminal" : "agent",
		};
		if (terminal) {
			let launchDataValid = true;
			if (rawMethod.args !== undefined) {
				if (
					Array.isArray(rawMethod.args) &&
					rawMethod.args.every((arg) => typeof arg === "string")
				) {
					method.args = rawMethod.args;
				} else launchDataValid = false;
			}
			if (rawMethod.env !== undefined) {
				const env: Array<{ name: string; value: string }> = [];
				if (!Array.isArray(rawMethod.env)) {
					launchDataValid = false;
				} else {
					for (const entry of rawMethod.env) {
						if (
							!isRecord(entry) ||
							typeof entry.name !== "string" ||
							typeof entry.value !== "string"
						) {
							launchDataValid = false;
							break;
						}
						env.push({ name: entry.name, value: entry.value });
					}
				}
				if (launchDataValid) method.env = env;
			}
			method.launchDataValid = launchDataValid;
		}
		normalized.push(method);
	}
	return normalized;
}

function authMethodSummaries(methods: RuntimeAuthMethod[]): AcpAuthMethodSummary[] {
	const summaries: AcpAuthMethodSummary[] = [];
	const seenIds = new Set<string>();
	for (const method of methods) {
		const id =
			typeof method.id === "string" &&
			method.id.length > 0 &&
			method.id.length <= 256 &&
			!hasControlCharacter(method.id)
				? method.id
				: null;
		const name = cleanAuthLabel(method.name, 160);
		if (!id || !name || seenIds.has(id)) continue;
		seenIds.add(id);
		const description = cleanAuthLabel(method.description, 512);
		summaries.push({
			id,
			name,
			type: method.type === "terminal" ? "terminal" : "agent",
			...(description ? { description } : {}),
		});
		if (summaries.length === ACP_AUTH_METHOD_LIMIT) break;
	}
	return summaries;
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
		!Array.isArray(snapshot.availableCommands)
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
		const images: Array<{ mimeType: string; data: string }> = [];
		let entryLength = entry.text.length;
		if (Array.isArray(entry.images)) {
			for (const image of entry.images.slice(0, 8)) {
				if (
					isRecord(image) &&
					typeof image.mimeType === "string" &&
					image.mimeType.startsWith("image/") &&
					typeof image.data === "string" &&
					image.data.length <= ACP_IMAGE_CHAR_LIMIT &&
					entryLength + image.data.length <= ACP_TRANSCRIPT_CHAR_LIMIT
				) {
					images.push({ mimeType: image.mimeType, data: image.data });
					entryLength += image.data.length;
				}
			}
		}
		messages.push({
			id: entry.id,
			role: entry.role as AcpTranscriptEntry["role"],
			text: entry.text,
			...(images?.length ? { images } : {}),
			createdAt: entry.createdAt,
		});
	}
	while (
		messages.length > ACP_MESSAGE_LIMIT ||
		(messages.length > 1 && transcriptTextLength(messages) > ACP_TRANSCRIPT_CHAR_LIMIT)
	) {
		messages.shift();
	}
	const toolCalls: AcpToolCallSummary[] = [];
	for (const tool of snapshot.toolCalls.slice(-500)) {
		const normalized = normalizeAcpToolCall(tool);
		if (!normalized) return null;
		toolCalls.push(normalized);
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
		plan: normalizeAcpPlanEntries(snapshot.plan),
		modes: normalizeAcpModes(snapshot.modes),
		currentMode: boundedString(snapshot.currentMode, ACP_MODE_ID_LIMIT)
			? snapshot.currentMode
			: null,
		configOptions: snapshot.configOptions.slice(0, ACP_CONFIG_OPTION_LIMIT).flatMap((option) => {
			const normalized = normalizeStoredConfigOption(option);
			return normalized ? [normalized] : [];
		}),
		availableCommands: normalizeAcpAvailableCommands(snapshot.availableCommands),
		usage:
			isRecord(snapshot.usage) &&
			typeof snapshot.usage.used === "number" &&
			Number.isFinite(snapshot.usage.used) &&
			typeof snapshot.usage.size === "number" &&
			Number.isFinite(snapshot.usage.size)
				? {
						used: snapshot.usage.used,
						size: snapshot.usage.size,
						...(isRecord(snapshot.usage.cost) &&
						typeof snapshot.usage.cost.amount === "number" &&
						Number.isFinite(snapshot.usage.cost.amount) &&
						boundedString(snapshot.usage.cost.currency, 16)
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

export async function writeAcpWorktreeFile(
	root: string,
	approvedPath: string,
	content: string,
): Promise<void> {
	const safePath = await resolveAcpWorktreePath(root, approvedPath, false);
	if (safePath !== approvedPath)
		throw new Error("ACP file path changed before it could be written.");

	let existing: Awaited<ReturnType<typeof fs.lstat>> | null = null;
	try {
		existing = await fs.lstat(approvedPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
		throw new Error("ACP file path changed before it could be written.");
	}

	const noFollow = fsConstants.O_NOFOLLOW ?? 0;
	const flags =
		fsConstants.O_WRONLY | noFollow | (existing ? 0 : fsConstants.O_CREAT | fsConstants.O_EXCL);
	const handle = await fs.open(approvedPath, flags, 0o666);
	try {
		const currentPath = await resolveAcpWorktreePath(root, approvedPath, false);
		if (currentPath !== approvedPath) {
			throw new Error("ACP file path changed before it could be written.");
		}
		const [openedFile, pathFile] = await Promise.all([handle.stat(), fs.stat(currentPath)]);
		if (
			!openedFile.isFile() ||
			openedFile.nlink !== 1 ||
			openedFile.dev !== pathFile.dev ||
			openedFile.ino !== pathFile.ino
		) {
			throw new Error("ACP file path changed before it could be written.");
		}
		await handle.truncate(0);
		await handle.writeFile(content, { encoding: "utf8" });
	} finally {
		await handle.close();
	}
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

function waitForChildClose(closed: Promise<unknown>, timeoutMs: number): Promise<void> {
	return new Promise((resolvePromise) => {
		let timer: ReturnType<typeof setTimeout>;
		const finish = () => {
			clearTimeout(timer);
			resolvePromise();
		};
		timer = setTimeout(finish, timeoutMs);
		void closed.then(finish);
	});
}

async function terminateChildProcess(child: ManagedChild, closed: Promise<unknown>): Promise<void> {
	const isRunning = () =>
		typeof child.exitCode !== "number" && typeof child.signalCode !== "string";
	if (isRunning()) child.kill("SIGTERM");
	await waitForChildClose(closed, 1000);
	if (isRunning()) {
		child.kill("SIGKILL");
		await waitForChildClose(closed, 1000);
	}
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

function permissionIsGranted(outcome: PermissionOutcome, options: AcpPermissionOption[]): boolean {
	if (outcome.outcome !== "selected") return false;
	const option = options.find((candidate) => candidate.optionId === outcome.optionId);
	return option?.kind === "allow_once" || option?.kind === "allow_always";
}

export class AcpSessionManager {
	private readonly records = new Map<string, StoredAcpSession>();
	private readonly live = new Map<string, LiveAcpSession>();
	private readonly resumes = new Map<string, Promise<AcpSessionSnapshot>>();
	private readonly removingWorkspaces = new Set<string>();
	private readonly workspaceRemovals = new Map<string, Promise<void>>();
	private readonly workspaceOperations = new Map<string, Set<Promise<void>>>();
	private readonly protocolVersions = new Map<string, AcpProtocolVersion | null>();
	private readonly authenticationByClient = new Map<string, PendingAcpConnection>();
	private readonly authTerminalStarts = new Map<string, PendingAcpConnection>();
	private readonly authTerminals = new Map<string, AuthTerminal>();
	private readonly activeAuthClients = new Set<string>();
	private readonly closingConnections = new WeakMap<WireConnection, Promise<void>>();
	private readonly options: AcpSessionManagerOptions;
	private persistTimer: ReturnType<typeof setTimeout> | null = null;
	private persistWrite: Promise<void> | null = null;
	private persistRequested = false;

	constructor(options: AcpSessionManagerOptions) {
		this.options = options;
		const stored = loadAcpSessionData();
		if (!isRecord(stored) || stored.version !== 1 || !Array.isArray(stored.sessions)) return;
		for (const raw of stored.sessions.slice(-ACP_SESSION_LIMIT)) {
			const record = normalizeStoredSession(raw);
			if (record) this.records.set(record.snapshot.summary.id, record);
		}
	}

	private startTimeoutMs(): number {
		return normalizeAcpStartTimeout(
			this.options.getStartTimeout?.() ?? DEFAULT_ACP_START_TIMEOUT_MS,
		);
	}

	list(workspaceId: string): AcpSessionSummary[] {
		if (this.removingWorkspaces.has(workspaceId)) return [];
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
		let executableUnavailable = false;
		let connection: ConnectedAcp | undefined;
		try {
			connection = await this.connectClient(config, process.cwd(), undefined, (error) => {
				executableUnavailable ||= isExecutableUnavailable(error);
			});
			return {
				available: true,
				authMethods: authMethodSummaries(connection.initialized.authMethods),
			};
		} catch (error) {
			if (error instanceof UnsupportedAcpProtocolError) {
				return { available: false, issue: "protocol" };
			}
			if (error instanceof AcpTimeoutError) {
				return { available: false, issue: "timeout" };
			}
			if (error instanceof AcpExecutableUnavailableError || executableUnavailable) {
				return { available: false, issue: "executable" };
			}
			log.warn("ACP client handshake failed", error);
			return { available: false, issue: "handshake" };
		} finally {
			if (connection) await this.closeChild(connection);
		}
	}

	async authenticateClient(
		clientId: string,
		methodId: string,
		clientKey: string,
	): Promise<{ ok: true }> {
		const config = this.requireEnabledClient(clientId);
		this.assertAuthMethodId(methodId);
		this.claimAuthClient(clientId);
		let connection: ConnectedAcp | undefined;
		let rejectCancelled!: () => void;
		const cancelledPromise = new Promise<never>((_resolve, reject) => {
			rejectCancelled = () => reject(new Error("ACP connection start was cancelled."));
		});
		let resolveSettled!: () => void;
		const settled = new Promise<void>((resolve) => {
			resolveSettled = resolve;
		});
		const pending: PendingAcpConnection = {
			clientId,
			clientKey,
			connection: null,
			cancelled: false,
			cancelledPromise,
			rejectCancelled,
			settled,
			resolveSettled,
		};
		this.authenticationByClient.set(clientId, pending);
		try {
			connection = await Promise.race([
				this.connectClient(
					config,
					process.cwd(),
					undefined,
					undefined,
					(wire) => {
						pending.connection = wire;
					},
					() => pending.cancelled,
					pending.cancelledPromise,
				),
				pending.cancelledPromise,
			]);
			pending.connection = connection;
			const method = this.findAuthMethod(connection.initialized.authMethods, methodId);
			if (method.type === "terminal") {
				throw new Error("This method requires terminal authentication.");
			}
			this.assertCurrentAuthClient(config);
			await this.requestWithTimeout(
				this.authenticateAgent(connection, methodId),
				ACP_AUTH_TIMEOUT_MS,
				pending.cancelledPromise,
			);
			this.assertCurrentAuthClient(config);
			return { ok: true };
		} catch (error) {
			log.warn("ACP client authentication failed", error);
			throw new Error("ACP sign-in failed. Return to Settings and try again.");
		} finally {
			try {
				if (this.authenticationByClient.get(clientId) === pending) {
					this.authenticationByClient.delete(clientId);
				}
				if (connection) await this.closeChild(connection);
				else if (pending.connection) await this.closeChild(pending.connection);
			} finally {
				this.activeAuthClients.delete(clientId);
				pending.resolveSettled();
			}
		}
	}

	cancelClientAuthentication(clientId: string, clientKey: string): { ok: true } {
		const pending = this.authenticationByClient.get(clientId);
		if (pending?.clientKey === clientKey) this.cancelPendingAcpConnection(pending);
		return { ok: true };
	}

	cleanupClient(clientKey: string): void {
		for (const pending of this.authenticationByClient.values()) {
			if (pending.clientKey === clientKey) this.cancelPendingAcpConnection(pending);
		}
		for (const start of this.authTerminalStarts.values()) {
			if (start.clientKey === clientKey) this.cancelPendingAcpConnection(start);
		}
		for (const terminal of this.authTerminals.values()) {
			if (terminal.clientKey === clientKey) this.stopAuthTerminal(terminal.id, clientKey);
		}
	}

	async startAuthTerminal(
		params: {
			workspaceId?: string;
			clientId: string;
			methodId: string;
			cols: number;
			rows: number;
		},
		clientKey: string,
	): Promise<{ id: string }> {
		const config = this.requireEnabledClient(params.clientId);
		this.assertAuthMethodId(params.methodId);
		this.assertGridDimension(params.cols);
		this.assertGridDimension(params.rows);
		if (this.authTerminals.size + this.authTerminalStarts.size >= ACP_AUTH_TERMINAL_LIMIT) {
			throw new Error("Too many ACP sign-in terminals are active.");
		}
		this.claimAuthClient(params.clientId);
		let connection: ConnectedAcp | undefined;
		let rejectCancelled!: () => void;
		const cancelledPromise = new Promise<never>((_resolve, reject) => {
			rejectCancelled = () => reject(new Error("ACP connection start was cancelled."));
		});
		let resolveSettled!: () => void;
		const settled = new Promise<void>((resolve) => {
			resolveSettled = resolve;
		});
		const start: PendingAcpConnection = {
			clientId: params.clientId,
			clientKey,
			connection: null,
			cancelled: false,
			cancelledPromise,
			rejectCancelled,
			settled,
			resolveSettled,
		};
		this.authTerminalStarts.set(params.clientId, start);
		let started = false;
		try {
			const cwd = params.workspaceId
				? this.options.resolveWorkspaceCwd(params.workspaceId)
				: process.cwd();
			connection = await Promise.race([
				this.connectClient(
					config,
					cwd,
					undefined,
					undefined,
					(wire) => {
						start.connection = wire;
					},
					() => start.cancelled || this.authTerminalStarts.get(params.clientId) !== start,
					start.cancelledPromise,
				),
				start.cancelledPromise,
			]);
			start.connection = connection;
			this.assertAuthTerminalStartActive(start);
			const method = this.findAuthMethod(connection.initialized.authMethods, params.methodId);
			if (method.type !== "terminal") {
				throw new Error("This method does not use terminal authentication.");
			}
			const launch = this.validateTerminalAuthLaunch(method);
			this.assertCurrentAuthClient(config);
			await this.closeChild(connection);
			connection = undefined;
			this.assertAuthTerminalStartActive(start);
			this.assertCurrentAuthClient(config);
			const id = randomUUID();
			const env = Object.fromEntries(
				Object.entries(process.env).filter(
					(entry): entry is [string, string] => typeof entry[1] === "string",
				),
			);
			Object.assign(env, launch.env);
			const pty = spawnPty(config.command, [...config.args, ...launch.args], {
				name: "xterm-256color",
				cwd,
				cols: params.cols,
				rows: params.rows,
				env,
			});
			let resolveExited!: () => void;
			const exited = new Promise<void>((resolve) => {
				resolveExited = resolve;
			});
			const terminal: AuthTerminal = {
				id,
				clientId: params.clientId,
				clientKey,
				configSignature: sessionSignature(config),
				pty,
				outputBytes: 0,
				cancelled: false,
				timer: setTimeout(() => this.stopAuthTerminal(id, clientKey), ACP_AUTH_TERMINAL_TIMEOUT_MS),
				exited,
				resolveExited,
			};
			terminal.timer.unref?.();
			this.authTerminals.set(id, terminal);
			pty.onData((data) => this.publishAuthTerminalData(terminal, data));
			pty.onExit(({ exitCode }) => this.finishAuthTerminal(terminal, exitCode === 0));
			started = true;
			return { id };
		} catch {
			if (!start.cancelled) log.warn("ACP terminal sign-in could not start");
			throw new Error("ACP terminal sign-in could not start. Return to Settings and retry.");
		} finally {
			try {
				if (connection) await this.closeChild(connection);
				else if (start.connection) await this.closeChild(start.connection);
			} finally {
				if (this.authTerminalStarts.get(params.clientId) === start) {
					this.authTerminalStarts.delete(params.clientId);
				}
				start.resolveSettled();
				if (!started) this.activeAuthClients.delete(params.clientId);
			}
		}
	}

	writeAuthTerminal(id: string, data: string, clientKey: string): { ok: true } {
		const inputBytes = typeof data === "string" ? Buffer.byteLength(data, "utf8") : 0;
		if (typeof data !== "string" || inputBytes > ACP_AUTH_TERMINAL_INPUT_LIMIT) {
			throw new Error("ACP sign-in terminal input is invalid.");
		}
		const terminal = this.getAuthTerminal(id, clientKey);
		this.assertAuthTerminalConfig(terminal);
		terminal.pty.write(data);
		return { ok: true };
	}

	resizeAuthTerminal(id: string, cols: number, rows: number, clientKey: string): { ok: true } {
		this.assertGridDimension(cols);
		this.assertGridDimension(rows);
		const terminal = this.getAuthTerminal(id, clientKey);
		this.assertAuthTerminalConfig(terminal);
		terminal.pty.resize(cols, rows);
		return { ok: true };
	}

	stopAuthTerminal(id: string, clientKey: string): { ok: true } {
		const terminal = this.authTerminals.get(id);
		if (!terminal || terminal.clientKey !== clientKey) return { ok: true };
		terminal.cancelled = true;
		clearTimeout(terminal.timer);
		terminal.pty.kill("SIGTERM");
		terminal.killTimer ??= setTimeout(() => {
			if (this.authTerminals.get(id) === terminal) terminal.pty.kill("SIGKILL");
		}, 1000);
		terminal.killTimer.unref?.();
		return { ok: true };
	}

	cancelAuthTerminalStart(clientId: string, clientKey: string): { ok: true } {
		const start = this.authTerminalStarts.get(clientId);
		if (start?.clientKey === clientKey) this.cancelPendingAcpConnection(start);
		for (const terminal of this.authTerminals.values()) {
			if (terminal.clientId === clientId && terminal.clientKey === clientKey) {
				this.stopAuthTerminal(terminal.id, clientKey);
			}
		}
		return { ok: true };
	}

	async listClientModels(workspaceId: string, clientId: string): Promise<AcpConfigOption[]> {
		return this.runWorkspaceOperation(workspaceId, async () => {
			const config = this.getConfiguredClient(clientId);
			if (!config.enabled) {
				throw new Error("Enable this ACP client in Settings before listing its models.");
			}
			const cwd = this.options.resolveWorkspaceCwd(workspaceId);
			const timeoutMs = this.startTimeoutMs();
			let connection: ConnectedAcp | undefined;
			try {
				connection = await this.connectClient(config, cwd);
				const created = await this.createAgentSession(connection, cwd, timeoutMs);
				return created.configOptions
					.filter((option) => option.category === "model")
					.slice(0, ACP_CONFIG_OPTION_LIMIT)
					.map((option) => ({
						...option,
						options: option.options.slice(0, ACP_MODEL_OPTION_VALUES_LIMIT),
					}))
					.filter((option) => option.options.length > 0);
			} catch (error) {
				log.warn("ACP model catalog discovery failed", error);
				throw new Error(
					`Could not list models from ${config.name}. Check that its ACP adapter is installed and configured.`,
				);
			} finally {
				if (connection) await this.closeChild(connection);
			}
		});
	}

	async create(workspaceId: string, clientId: string): Promise<AcpSessionSnapshot> {
		return this.runWorkspaceOperation(workspaceId, async () => {
			const config = this.getConfiguredClient(clientId);
			if (!config.enabled)
				throw new Error("Enable this ACP client in Settings before starting a chat.");
			this.ensureSessionCapacity();
			const cwd = this.options.resolveWorkspaceCwd(workspaceId);
			const timeoutMs = this.startTimeoutMs();
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
				const created = await this.createAgentSession(live.connection, cwd, timeoutMs);
				live.agentSessionId = created.sessionId;
				record.agentSessionId = created.sessionId;
				record.canLoadSession = initialized.canResumeSession;
				record.snapshot.summary.resumable = record.canLoadSession;
				live.booleanConfigOptionIds = new Set(created.booleanConfigOptionIds);
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
				if (error instanceof UnsupportedAcpProtocolError) throw error;
				if (error instanceof AcpTimeoutError) {
					throw new Error(
						`Could not start ${config.name} within ${Math.round(error.timeoutMs / 1000)} seconds. Increase the ACP start timeout in Settings → ACP or check the adapter.`,
					);
				}
				if (error instanceof AcpExecutableUnavailableError) {
					throw new Error(
						`Could not start ${config.name}. Check that its ACP adapter is installed and available on the ThinkRail host PATH.`,
					);
				}
				log.warn("ACP session creation failed", error);
				throw new Error(
					`Could not start ${config.name}. Check that its ACP adapter is installed and configured.`,
				);
			}
		});
	}

	async resume(workspaceId: string, sessionId: string): Promise<AcpSessionSnapshot> {
		return this.runWorkspaceOperation(workspaceId, async () => {
			const record = this.getRecord(workspaceId, sessionId);
			const pending = this.resumes.get(sessionId);
			if (pending) return structuredClone(await pending);
			if (this.live.has(sessionId)) return structuredClone(record.snapshot);
			const resume = this.resumeRecord(record);
			this.resumes.set(sessionId, resume);
			try {
				return structuredClone(await resume);
			} finally {
				if (this.resumes.get(sessionId) === resume) this.resumes.delete(sessionId);
			}
		});
	}

	private async resumeRecord(record: StoredAcpSession): Promise<AcpSessionSnapshot> {
		const sessionId = record.snapshot.summary.id;
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
		const cwd = this.options.resolveWorkspaceCwd(record.snapshot.summary.workspaceId);
		const timeoutMs = this.startTimeoutMs();
		const { live, initialized } = await this.openSession(record, config, cwd);
		try {
			if (!initialized.canResumeSession) {
				throw new Error("This ACP agent no longer supports session restoration.");
			}
			live.v2StateUpdateReceived = false;
			const loaded = await this.resumeAgentSession(
				live.connection,
				cwd,
				record.agentSessionId,
				timeoutMs,
			);
			live.booleanConfigOptionIds = new Set(loaded.booleanConfigOptionIds);
			this.applySessionSetup(record, loaded);
			if (live.connection.version === ACP_V1 || !live.v2StateUpdateReceived) {
				record.snapshot.summary.state = "idle";
			}
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
		if (live.promptRunning || record.snapshot.summary.state === "running") {
			throw new Error("This ACP chat is already responding.");
		}
		if (typeof text !== "string" || text.length > 100_000)
			throw new Error("ACP prompt text is too long.");
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
		if (!text.trim() && images.length === 0) throw new Error("Enter a message before sending.");
		const messageLength =
			text.length + images.reduce((total, image) => total + image.data.length, 0);
		if (messageLength > ACP_TRANSCRIPT_CHAR_LIMIT) {
			throw new Error("The ACP message exceeds the transcript size limit.");
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
			if (this.live.get(sessionId) !== live) return;
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
		await this.cancelAgentSession(live.connection, live.agentSessionId);
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
		if (live.connection.version === ACP_V1) {
			await live.connection.connection.agent.request(methods.agent.session.setMode, {
				sessionId: live.agentSessionId,
				modeId,
			});
		} else {
			const modeOption = record.snapshot.configOptions.find(
				(option) =>
					option.category === "mode" && option.options.some((choice) => choice.value === modeId),
			);
			if (!modeOption) throw new Error("That ACP mode is not available in this session.");
			const updated = await this.setAgentConfigOption(live, modeOption.id, modeId);
			live.booleanConfigOptionIds = new Set(updated.booleanConfigOptionIds);
			this.applyConfigOptions(record, updated.configOptions, live.connection.version);
		}
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
		const updated = await this.setAgentConfigOption(live, configId, value);
		live.booleanConfigOptionIds = new Set(updated.booleanConfigOptionIds);
		this.applyConfigOptions(record, updated.configOptions, live.connection.version);
		this.persist();
		this.emitConfigOptions(record);
		return { ok: true };
	}

	async delete(workspaceId: string, sessionId: string): Promise<{ ok: true }> {
		const record = this.getRecord(workspaceId, sessionId);
		const live = this.live.get(sessionId);
		if (live) {
			try {
				await this.closeAgentSession(live.connection, live.agentSessionId);
			} catch {}
			await this.closeLive(sessionId, live);
		}
		this.records.delete(sessionId);
		this.persist();
		this.emit({ type: "deleted", sessionId: record.snapshot.summary.id });
		return { ok: true };
	}

	removeWorkspace(workspaceId: string): Promise<void> {
		const pending = this.workspaceRemovals.get(workspaceId);
		if (pending) return pending;
		this.removingWorkspaces.add(workspaceId);
		const removal = this.finishWorkspaceRemoval(workspaceId).finally(() => {
			this.workspaceRemovals.delete(workspaceId);
			this.removingWorkspaces.delete(workspaceId);
		});
		this.workspaceRemovals.set(workspaceId, removal);
		return removal;
	}

	private async finishWorkspaceRemoval(workspaceId: string): Promise<void> {
		await Promise.all(this.workspaceOperations.get(workspaceId) ?? []);
		const records = [...this.records.values()].filter(
			(record) => record.snapshot.summary.workspaceId === workspaceId,
		);
		await Promise.all(
			records.map(async (record) => {
				const sessionId = record.snapshot.summary.id;
				const live = this.live.get(sessionId);
				if (live) {
					try {
						await this.closeLive(sessionId, live);
					} catch {
						log.warn("ACP child shutdown failed during workspace removal");
					}
				}
				this.records.delete(sessionId);
				this.emit({ type: "deleted", sessionId });
			}),
		);
		this.persist();
	}

	async closeAll(): Promise<void> {
		const terminals = [...this.authTerminals.values()];
		for (const terminal of terminals) {
			this.stopAuthTerminal(terminal.id, terminal.clientKey);
		}
		const authentications = [...this.authenticationByClient.values()];
		for (const pending of authentications) this.cancelPendingAcpConnection(pending);
		const terminalStarts = [...this.authTerminalStarts.values()];
		for (const start of terminalStarts) this.cancelPendingAcpConnection(start);
		const liveSessions = [...this.live.entries()];
		await Promise.all([
			...terminals.map((terminal) => terminal.exited),
			...authentications.map((pending) => pending.settled),
			...terminalStarts.map((start) => start.settled),
			...liveSessions.map(async ([sessionId, live]) => {
				const record = this.records.get(sessionId);
				if (record) {
					this.flushPendingMessages(record, live);
					record.snapshot.summary.state = "interrupted";
					record.snapshot.summary.updatedAt = Date.now();
				}
				await this.closeLive(sessionId, live);
			}),
		]);
		if (liveSessions.length > 0) this.persist();
		if (this.persistRequested || this.persistWrite) await this.flushPersist();
	}

	private getConfiguredClient(clientId: string): AcpClientConfig {
		const config = this.options.getClient(clientId);
		if (!config || !isAcpClientConfig(config))
			throw new Error("This ACP client is not configured.");
		return { ...config, args: [...config.args] };
	}

	private requireEnabledClient(clientId: string): AcpClientConfig {
		if (typeof clientId !== "string" || clientId.length > 64) {
			throw new Error("This ACP client is not available.");
		}
		const config = this.getConfiguredClient(clientId);
		if (!config.enabled) throw new Error("Enable this ACP client in Settings before signing in.");
		return config;
	}

	private claimAuthClient(clientId: string): void {
		if (this.activeAuthClients.has(clientId)) {
			throw new Error("An ACP sign-in is already active for this client.");
		}
		this.activeAuthClients.add(clientId);
	}

	private cancelPendingAcpConnection(pending: PendingAcpConnection): void {
		if (!pending.cancelled) {
			pending.cancelled = true;
			pending.rejectCancelled();
		}
		if (pending.connection) void this.closeChild(pending.connection).catch(() => {});
	}

	private assertAuthTerminalStartActive(start: PendingAcpConnection): void {
		if (start.cancelled || this.authTerminalStarts.get(start.clientId) !== start) {
			throw new Error("ACP sign-in terminal start was cancelled.");
		}
	}

	private assertCurrentAuthClient(config: AcpClientConfig): void {
		const current = this.getConfiguredClient(config.id);
		if (!current.enabled || sessionSignature(current) !== sessionSignature(config)) {
			throw new Error("ACP client configuration changed during sign-in.");
		}
	}

	private assertAuthMethodId(methodId: string): void {
		if (
			typeof methodId !== "string" ||
			methodId.length === 0 ||
			methodId.length > 256 ||
			hasControlCharacter(methodId)
		) {
			throw new Error("ACP authentication method is invalid.");
		}
	}

	private findAuthMethod(methods: RuntimeAuthMethod[], methodId: string): RuntimeAuthMethod {
		const method = methods.find((candidate) => candidate.id === methodId);
		if (!method) throw new Error("ACP authentication method is no longer available.");
		return method;
	}

	private validateTerminalAuthLaunch(method: RuntimeAuthMethod): {
		args: string[];
		env: Record<string, string>;
	} {
		if (method.launchDataValid === false) {
			throw new Error("ACP terminal sign-in configuration is invalid.");
		}
		const args = normalizeAcpArguments(method.args ?? []);
		if (!args) {
			throw new Error("ACP terminal sign-in arguments are invalid.");
		}
		const env = normalizeAcpEnvironment(method.env ?? {});
		if (!env) throw new Error("ACP terminal sign-in environment is invalid.");
		return { args: [...args], env };
	}

	private assertGridDimension(value: number): void {
		if (!Number.isInteger(value) || value < 1 || value > 32_767) {
			throw new Error("Invalid ACP sign-in terminal size.");
		}
	}

	private getAuthTerminal(id: string, clientKey: string): AuthTerminal {
		const terminal = this.authTerminals.get(id);
		if (!terminal || terminal.clientKey !== clientKey) {
			throw new Error("ACP sign-in terminal is no longer available.");
		}
		return terminal;
	}

	private assertAuthTerminalConfig(terminal: AuthTerminal): void {
		try {
			const current = this.requireEnabledClient(terminal.clientId);
			if (sessionSignature(current) === terminal.configSignature) return;
		} catch {}
		this.stopAuthTerminal(terminal.id, terminal.clientKey);
		throw new Error("ACP sign-in terminal is no longer available.");
	}

	private publishAuthTerminalData(terminal: AuthTerminal, data: string): void {
		if (this.authTerminals.get(terminal.id) !== terminal || terminal.cancelled) return;
		try {
			this.assertAuthTerminalConfig(terminal);
		} catch {
			return;
		}
		terminal.outputBytes += Buffer.byteLength(data, "utf8");
		if (terminal.outputBytes > ACP_AUTH_TERMINAL_OUTPUT_LIMIT) {
			this.stopAuthTerminal(terminal.id, terminal.clientKey);
			return;
		}
		try {
			const delivered = this.options.publishAuthTerminal(terminal.clientKey, {
				type: "data",
				id: terminal.id,
				data,
			});
			if (!delivered) this.stopAuthTerminal(terminal.id, terminal.clientKey);
		} catch {
			this.stopAuthTerminal(terminal.id, terminal.clientKey);
		}
	}

	private finishAuthTerminal(terminal: AuthTerminal, success: boolean): void {
		if (this.authTerminals.get(terminal.id) !== terminal) return;
		this.authTerminals.delete(terminal.id);
		clearTimeout(terminal.timer);
		if (terminal.killTimer) clearTimeout(terminal.killTimer);
		this.activeAuthClients.delete(terminal.clientId);
		terminal.resolveExited();
		try {
			this.options.publishAuthTerminal(terminal.clientKey, {
				type: "exit",
				id: terminal.id,
				success: success && !terminal.cancelled,
			});
		} catch {
			log.warn("ACP terminal sign-in exit could not be delivered");
		}
	}

	private getRecord(workspaceId: string, sessionId: string): StoredAcpSession {
		const record = this.records.get(sessionId);
		if (
			this.removingWorkspaces.has(workspaceId) ||
			!record ||
			record.snapshot.summary.workspaceId !== workspaceId
		) {
			throw new Error("This ACP chat is not available in the selected workspace.");
		}
		return record;
	}

	private async runWorkspaceOperation<T>(
		workspaceId: string,
		operation: () => Promise<T>,
	): Promise<T> {
		if (this.removingWorkspaces.has(workspaceId)) {
			throw new Error("This workspace is being removed.");
		}
		let resolve!: () => void;
		const completion = new Promise<void>((done) => {
			resolve = done;
		});
		let operations = this.workspaceOperations.get(workspaceId);
		if (!operations) {
			operations = new Set();
			this.workspaceOperations.set(workspaceId, operations);
		}
		operations.add(completion);
		try {
			return await operation();
		} finally {
			operations.delete(completion);
			if (operations.size === 0) this.workspaceOperations.delete(workspaceId);
			resolve();
		}
	}

	private requireLive(sessionId: string): LiveAcpSession {
		const live = this.live.get(sessionId);
		if (!live || live.closing) throw new Error("Resume this ACP chat before sending a message.");
		return live;
	}

	private ensureSessionCapacity(): void {
		let evicted = false;
		while (this.records.size >= ACP_SESSION_LIMIT) {
			const oldest = [...this.records.values()]
				.filter((record) => !this.live.has(record.snapshot.summary.id))
				.sort(
					(left, right) => left.snapshot.summary.updatedAt - right.snapshot.summary.updatedAt,
				)[0];
			if (!oldest) {
				throw new Error("Close an existing ACP chat before starting another.");
			}
			this.records.delete(oldest.snapshot.summary.id);
			evicted = true;
		}
		if (evicted) this.persist();
	}

	private persist(): void {
		while (this.records.size > ACP_SESSION_LIMIT) {
			const oldest = [...this.records.values()]
				.filter((record) => !this.live.has(record.snapshot.summary.id))
				.sort(
					(left, right) => left.snapshot.summary.updatedAt - right.snapshot.summary.updatedAt,
				)[0];
			if (!oldest) break;
			this.records.delete(oldest.snapshot.summary.id);
		}
		this.persistRequested = true;
		if (this.persistTimer) return;
		this.persistTimer = setTimeout(() => {
			this.persistTimer = null;
			void this.flushPersist();
		}, ACP_PERSIST_DEBOUNCE_MS);
	}

	private async flushPersist(retry = false): Promise<void> {
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = null;
		}
		if (this.persistWrite) {
			await this.persistWrite;
			if (this.persistRequested) await this.flushPersist(retry);
			return;
		}
		if (!this.persistRequested) return;
		this.persistRequested = false;
		const data: StoredAcpData = {
			version: 1,
			sessions: [...this.records.values()],
		};
		const write = saveAcpSessionData(data);
		this.persistWrite = write;
		let failed = false;
		try {
			await write;
		} catch {
			failed = true;
			this.persistRequested = true;
			log.warn("ACP sessions could not be persisted");
			if (!retry && !this.persistTimer) {
				this.persistTimer = setTimeout(() => {
					this.persistTimer = null;
					void this.flushPersist(true);
				}, ACP_PERSIST_RETRY_MS);
			}
		} finally {
			if (this.persistWrite === write) this.persistWrite = null;
		}
		if (!failed && this.persistRequested && !this.persistTimer) await this.flushPersist();
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
		if (
			!boundedString(entry.id, 128) ||
			!boundedString(entry.text, ACP_ENTRY_CHAR_LIMIT) ||
			transcriptEntryTextLength(entry) > ACP_TRANSCRIPT_CHAR_LIMIT
		) {
			return;
		}
		const existingIndex = record.snapshot.messages.findIndex((message) => message.id === entry.id);
		if (existingIndex < 0) record.snapshot.messages.push(entry);
		else record.snapshot.messages[existingIndex] = entry;
		while (
			record.snapshot.messages.length > ACP_MESSAGE_LIMIT ||
			(record.snapshot.messages.length > 1 &&
				transcriptTextLength(record.snapshot.messages) > ACP_TRANSCRIPT_CHAR_LIMIT)
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
	): Promise<{ live: LiveAcpSession; initialized: AcpInitialization }> {
		const sessionId = record.snapshot.summary.id;
		const live = {} as LiveAcpSession;
		const appV1 = client();
		appV1.onNotification(methods.client.session.update, ({ params }) => {
			this.handleUpdate(record, live, params);
		});
		appV1.onRequest(methods.client.session.requestPermission, ({ params, requestId, signal }) =>
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
		appV1.onRequest(methods.client.fs.readTextFile, async ({ params }) => {
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
		appV1.onRequest(methods.client.fs.writeTextFile, async ({ params }) => {
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
			await writeAcpWorktreeFile(root, approvedFilePath, params.content);
			return {};
		});
		appV1.onRequest(methods.client.terminal.create, ({ params }) =>
			this.createTerminal(record, live, params),
		);
		appV1.onRequest(methods.client.terminal.output, ({ params }) =>
			this.terminalOutput(live, params.sessionId, params.terminalId),
		);
		appV1.onRequest(methods.client.terminal.waitForExit, ({ params }) =>
			this.waitForTerminal(live, params.sessionId, params.terminalId),
		);
		appV1.onRequest(methods.client.terminal.kill, ({ params }) =>
			this.killTerminal(live, params.sessionId, params.terminalId),
		);
		appV1.onRequest(methods.client.terminal.release, ({ params }) =>
			this.releaseTerminal(live, params.sessionId, params.terminalId),
		);

		const appV2 = AcpV2.client();
		appV2.onNotification(AcpV2.methods.client.session.update, ({ params }) => {
			this.handleV2Update(record, live, params);
		});
		appV2.onRequest(
			AcpV2.methods.client.session.requestPermission,
			({ params, requestId, signal }) => {
				const rawSubject: unknown = params.subject;
				const subject = isRecord(rawSubject) ? rawSubject : null;
				const subjectToolCall = isRecord(subject?.toolCall) ? subject.toolCall : null;
				const toolCallId =
					subject?.type === "tool_call" && typeof subjectToolCall?.toolCallId === "string"
						? subjectToolCall.toolCallId
						: subject?.type === "command" && typeof subject.toolCallId === "string"
							? subject.toolCallId
							: `thinkrail-${randomUUID()}`;
				const options: AcpPermissionOption[] = params.options.flatMap((option) => {
					switch (option.kind) {
						case "allow_once":
						case "allow_always":
						case "reject_once":
						case "reject_always":
							return [{ optionId: option.optionId, name: option.name, kind: option.kind }];
						default:
							return [];
					}
				});
				if (options.length === 0) return { outcome: { outcome: "cancelled" } };
				return this.waitForPermission(
					record,
					live,
					{
						requestId: String(requestId ?? randomUUID()),
						toolCallId,
						title: params.title,
						options,
					},
					signal,
				);
			},
		);

		const connected = await this.connectClient(config, cwd, { v1: appV1, v2: appV2 });
		live.connection = connected;
		live.agentSessionId = record.agentSessionId;
		live.promptRunning = false;
		live.v2PromptTurn = null;
		live.v2StateUpdateReceived = false;
		live.booleanConfigOptionIds = new Set();
		live.closing = false;
		live.pendingPermission = null;
		live.terminals = new Map();
		live.pendingMessages = new Map();
		this.live.set(sessionId, live);
		void connected.connection.closed
			.then(() => this.handleConnectionClosed(sessionId, record, live))
			.catch(() => log.warn("ACP connection cleanup failed"));
		return { live, initialized: connected.initialized };
	}

	private spawnChild(config: AcpClientConfig, cwd: string): ChildProcess {
		const executable = resolveExecutable(config.command);
		if (!executable) throw new AcpExecutableUnavailableError();
		try {
			const child = spawn(executable, config.args, {
				cwd,
				env: process.env,
				shell: false,
				windowsHide: true,
				stdio: ["pipe", "pipe", "pipe"],
			});
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", () => {});
			return child;
		} catch (error) {
			if (error instanceof Error && isExecutableUnavailable(error)) {
				throw new AcpExecutableUnavailableError();
			}
			throw error;
		}
	}

	private spawnV1Connection(
		config: AcpClientConfig,
		cwd: string,
		app: ClientApp = client(),
		onChildError?: (error: Error) => void,
	): Extract<WireConnection, { version: typeof ACP_V1 }> {
		const child = this.spawnChild(config, cwd);
		const stream = ndJsonStream(Writable.toWeb(child.stdin), readableWebStream(child.stdout));
		const connection = app.connect(stream);
		child.once("error", (error) => {
			onChildError?.(error);
			connection.close();
		});
		return { version: ACP_V1, child, connection };
	}

	private spawnV2Connection(
		config: AcpClientConfig,
		cwd: string,
		app: AcpV2.ClientApp = AcpV2.client(),
		onChildError?: (error: Error) => void,
	): Extract<WireConnection, { version: typeof ACP_V2 }> {
		const child = this.spawnChild(config, cwd);
		const stream = AcpV2.ndJsonStream(Writable.toWeb(child.stdin), readableWebStream(child.stdout));
		const connection = app.connect(stream);
		child.once("error", (error) => {
			onChildError?.(error);
			connection.close();
		});
		return { version: ACP_V2, child, connection };
	}

	private spawnConnection(
		config: AcpClientConfig,
		cwd: string,
		version: AcpProtocolVersion,
		apps?: { v1?: ClientApp; v2?: AcpV2.ClientApp },
		onChildError?: (error: Error) => void,
	): WireConnection {
		return version === ACP_V1
			? this.spawnV1Connection(config, cwd, apps?.v1, onChildError)
			: this.spawnV2Connection(config, cwd, apps?.v2, onChildError);
	}

	private shouldTryNextProtocol(error: unknown, isCancelled?: () => boolean): boolean {
		if (isCancelled?.()) return false;
		return !(
			error instanceof AcpExecutableUnavailableError ||
			error instanceof AcpTimeoutError ||
			error instanceof UnsupportedAcpProtocolError
		);
	}

	private async startConnection(
		config: AcpClientConfig,
		cwd: string,
		version: AcpProtocolVersion,
		apps: { v1?: ClientApp; v2?: AcpV2.ClientApp } | undefined,
		onChildError: ((error: Error) => void) | undefined,
		onConnection: ((connection: WireConnection) => void) | undefined,
		isCancelled: (() => boolean) | undefined,
		cancelledPromise: Promise<never> | undefined,
		timeoutMs: number,
	): Promise<ConnectedAcp> {
		if (isCancelled?.()) throw new Error("ACP connection start was cancelled.");
		let spawnError: Error | undefined;
		const connection = this.spawnConnection(config, cwd, version, apps, (error) => {
			spawnError = error;
			onChildError?.(error);
		});
		onConnection?.(connection);
		try {
			if (isCancelled?.()) throw new Error("ACP connection start was cancelled.");
			const initialized = await this.initializeConnection(connection, timeoutMs, cancelledPromise);
			if (isCancelled?.()) throw new Error("ACP connection start was cancelled.");
			return { ...connection, initialized };
		} catch (error) {
			await this.closeChild(connection);
			if (spawnError && isExecutableUnavailable(spawnError)) {
				throw new AcpExecutableUnavailableError();
			}
			throw error;
		}
	}

	private async connectClient(
		config: AcpClientConfig,
		cwd: string,
		apps?: { v1?: ClientApp; v2?: AcpV2.ClientApp },
		onChildError?: (error: Error) => void,
		onConnection?: (connection: WireConnection) => void,
		isCancelled?: () => boolean,
		cancelledPromise?: Promise<never>,
	): Promise<ConnectedAcp> {
		const signature = sessionSignature(config);
		const timeoutMs = this.startTimeoutMs();
		const cached = this.protocolVersions.get(signature);

		if (cached === ACP_V1 || cached === ACP_V2) {
			try {
				const connected = await this.startConnection(
					config,
					cwd,
					cached,
					apps,
					onChildError,
					onConnection,
					isCancelled,
					cancelledPromise,
					timeoutMs,
				);
				if (connected.initialized.protocolVersion === cached) return connected;
				await this.closeChild(connected);
				this.protocolVersions.delete(signature);
			} catch (error) {
				if (!this.shouldTryNextProtocol(error, isCancelled)) throw error;
				this.protocolVersions.delete(signature);
				log.warn("ACP cached protocol handshake failed; probing again", error);
			}
		}

		let v1Error: unknown;
		try {
			const connected = await this.startConnection(
				config,
				cwd,
				ACP_V1,
				apps,
				onChildError,
				onConnection,
				isCancelled,
				cancelledPromise,
				timeoutMs,
			);
			if (connected.initialized.protocolVersion === ACP_V1) {
				this.protocolVersions.set(signature, ACP_V1);
				return connected;
			}
			await this.closeChild(connected);
		} catch (error) {
			if (!this.shouldTryNextProtocol(error, isCancelled)) throw error;
			v1Error = error;
		}

		try {
			const connected = await this.startConnection(
				config,
				cwd,
				ACP_V2,
				apps,
				onChildError,
				onConnection,
				isCancelled,
				cancelledPromise,
				timeoutMs,
			);
			if (connected.initialized.protocolVersion === ACP_V2) {
				this.protocolVersions.set(signature, ACP_V2);
				return connected;
			}
			await this.closeChild(connected);
		} catch (error) {
			if (!this.shouldTryNextProtocol(error, isCancelled)) throw error;
			throw v1Error ?? error;
		}
		throw new UnsupportedAcpProtocolError("ACP v1 or v2 is required.");
	}

	private async initializeConnection(
		connection: WireConnection,
		timeoutMs: number,
		cancelledPromise?: Promise<never>,
	): Promise<AcpInitialization> {
		if (connection.version === ACP_V1) {
			const initialized: InitializeResponse = await this.requestWithTimeout(
				connection.connection.agent.request(methods.agent.initialize, {
					protocolVersion: ACP_V1,
					clientCapabilities: {
						fs: { readTextFile: true, writeTextFile: true },
						terminal: true,
						auth: { terminal: true },
						plan: {},
						session: { configOptions: { boolean: {} }, notices: {} },
					},
					clientInfo: { name: "ThinkRail", version: this.options.clientVersion },
				}),
				timeoutMs,
				cancelledPromise,
			);
			return {
				protocolVersion: initialized.protocolVersion,
				authMethods: (initialized.authMethods ?? []).map(normalizeV1AuthMethod),
				canResumeSession: initialized.agentCapabilities?.loadSession === true,
			};
		}
		const initialized = await this.requestWithTimeout(
			connection.connection.agent.request(AcpV2.methods.agent.initialize, {
				protocolVersion: ACP_V2,
				info: { name: "ThinkRail", version: this.options.clientVersion },
				capabilities: { auth: { terminal: {} } },
			}),
			timeoutMs,
			cancelledPromise,
		);
		return {
			protocolVersion: initialized.protocolVersion,
			authMethods: normalizeV2AuthMethods(initialized.authMethods),
			canResumeSession: initialized.capabilities?.session != null,
		};
	}

	private async requestWithTimeout<T>(
		promise: Promise<T>,
		timeoutMs: number,
		cancelledPromise?: Promise<never>,
	): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const pending: Promise<T>[] = [
				promise,
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new AcpTimeoutError(timeoutMs)), timeoutMs);
				}),
			];
			if (cancelledPromise) pending.push(cancelledPromise);
			return await Promise.race(pending);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	private async createAgentSession(
		connection: ConnectedAcp,
		cwd: string,
		timeoutMs: number,
	): Promise<NormalizedSessionSetup> {
		if (connection.version === ACP_V1) {
			const setup = await this.requestWithTimeout(
				connection.connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] }),
				timeoutMs,
			);
			return normalizeV1SessionSetup(setup);
		}
		const setup = await this.requestWithTimeout(
			connection.connection.agent.request(AcpV2.methods.agent.session.new, { cwd, mcpServers: [] }),
			timeoutMs,
		);
		return normalizeV2SessionSetup(setup.sessionId, setup);
	}

	private async resumeAgentSession(
		connection: ConnectedAcp,
		cwd: string,
		sessionId: string,
		timeoutMs: number,
	): Promise<NormalizedSessionSetup> {
		if (connection.version === ACP_V1) {
			const setup = await this.requestWithTimeout(
				connection.connection.agent.request(methods.agent.session.load, {
					cwd,
					sessionId,
					mcpServers: [],
				}),
				timeoutMs,
			);
			return normalizeV1SessionSetup({ ...setup, sessionId });
		}
		const setup = await this.requestWithTimeout(
			connection.connection.agent.request(AcpV2.methods.agent.session.resume, {
				cwd,
				sessionId,
				mcpServers: [],
			}),
			timeoutMs,
		);
		return normalizeV2SessionSetup(sessionId, setup);
	}

	private async authenticateAgent(connection: ConnectedAcp, methodId: string): Promise<void> {
		if (connection.version === ACP_V1) {
			await connection.connection.agent.request(methods.agent.authenticate, { methodId });
			return;
		}
		await connection.connection.agent.request(AcpV2.methods.agent.auth.login, { methodId });
	}

	private async cancelAgentSession(connection: ConnectedAcp, sessionId: string): Promise<void> {
		if (connection.version === ACP_V1) {
			await connection.connection.agent.notify(methods.agent.session.cancel, { sessionId });
			return;
		}
		await connection.connection.agent.notify(AcpV2.methods.agent.session.cancel, { sessionId });
	}

	private async closeAgentSession(connection: ConnectedAcp, sessionId: string): Promise<void> {
		if (connection.version === ACP_V1) {
			await connection.connection.agent.request(methods.agent.session.close, { sessionId });
			return;
		}
		await connection.connection.agent.request(AcpV2.methods.agent.session.close, { sessionId });
	}

	private async setAgentConfigOption(
		live: LiveAcpSession,
		configId: string,
		value: string,
	): Promise<{ configOptions: AcpConfigOption[]; booleanConfigOptionIds: string[] }> {
		if (live.connection.version === ACP_V1) {
			const result = await live.connection.connection.agent.request(
				methods.agent.session.setConfigOption,
				{ sessionId: live.agentSessionId, configId, value },
			);
			return {
				configOptions: normalizeV1ConfigOptions(result.configOptions),
				booleanConfigOptionIds: [],
			};
		}
		const params = live.booleanConfigOptionIds.has(configId)
			? {
					sessionId: live.agentSessionId,
					configId,
					type: "boolean" as const,
					value: value === "true",
				}
			: { sessionId: live.agentSessionId, configId, type: "id" as const, value };
		const result = await live.connection.connection.agent.request(
			AcpV2.methods.agent.session.setConfigOption,
			params,
		);
		return normalizeV2ConfigOptions(result.configOptions);
	}

	private async promptAgentSession(
		connection: ConnectedAcp,
		sessionId: string,
		content: Array<
			{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }
		>,
	): Promise<void> {
		if (connection.version === ACP_V1) {
			await connection.connection.agent.request(methods.agent.session.prompt, {
				sessionId,
				prompt: content,
			});
			return;
		}
		await connection.connection.agent.request(AcpV2.methods.agent.session.prompt, {
			sessionId,
			prompt: content,
		});
	}

	private applySessionSetup(record: StoredAcpSession, setup: NormalizedSessionSetup): void {
		record.snapshot.modes = setup.modes;
		record.snapshot.currentMode = setup.currentMode;
		record.snapshot.configOptions = setup.configOptions;
		record.snapshot.availableCommands = setup.availableCommands;
		this.persist();
	}

	private applyConfigOptions(
		record: StoredAcpSession,
		configOptions: AcpConfigOption[],
		version: AcpProtocolVersion,
	): void {
		record.snapshot.configOptions = configOptions.slice(0, ACP_CONFIG_OPTION_LIMIT);
		if (version === ACP_V2) {
			const modeOption = record.snapshot.configOptions.find((option) => option.category === "mode");
			record.snapshot.modes =
				modeOption?.options.map(({ value, name }) => ({ id: value, name })) ?? [];
			record.snapshot.currentMode = modeOption?.currentValue ?? null;
		}
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
		let turn: V2PromptTurn | null = null;
		try {
			if (live.connection.version === ACP_V2) {
				let resolve!: () => void;
				const promise = new Promise<void>((resolvePromise) => {
					resolve = resolvePromise;
				});
				turn = { sawActivity: false, resolve, promise };
				live.v2PromptTurn = turn;
			}
			await this.promptAgentSession(live.connection, live.agentSessionId, content);
			if (turn) await turn.promise;
			this.flushPendingMessages(record, live);
			live.promptRunning = false;
			live.v2PromptTurn = null;
			if (
				this.live.get(record.snapshot.summary.id) === live &&
				record.snapshot.summary.state !== "failed" &&
				record.snapshot.summary.state !== "idle"
			) {
				this.setState(record, "idle");
			}
		} catch {
			if (live.v2PromptTurn === turn) live.v2PromptTurn = null;
			turn?.resolve();
			this.flushPendingMessages(record, live);
			live.promptRunning = false;
			live.v2PromptTurn = null;
			if (this.live.get(record.snapshot.summary.id) === live) this.setState(record, "failed");
			throw new Error("ACP prompt failed.");
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
				const toolCall = normalizeAcpToolCall({
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
				});
				if (!toolCall) break;
				const existing = record.snapshot.toolCalls.findIndex((tool) => tool.id === toolCall.id);
				if (existing < 0) record.snapshot.toolCalls.push(toolCall);
				else record.snapshot.toolCalls[existing] = toolCall;
				record.snapshot.toolCalls = record.snapshot.toolCalls.slice(-500);
				this.persist();
				this.emit({ type: "toolCall", sessionId: thinkrailSessionId, toolCall });
				break;
			}
			case "plan":
				record.snapshot.plan = normalizeAcpPlanEntries(update.entries);
				this.persist();
				this.emit({ type: "plan", sessionId: thinkrailSessionId, entries: record.snapshot.plan });
				break;
			case "plan_update":
				if (update.plan.type === "items") {
					record.snapshot.plan = normalizeAcpPlanEntries(update.plan.entries);
				} else if (update.plan.type === "markdown") {
					record.snapshot.plan = normalizeAcpPlanEntries([
						{
							content: update.plan.content,
							status: "in_progress",
							priority: "medium",
						},
					]);
				} else {
					record.snapshot.plan = normalizeAcpPlanEntries([
						{
							content: update.plan.uri,
							status: "in_progress",
							priority: "medium",
						},
					]);
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
				if (!boundedString(update.currentModeId, ACP_MODE_ID_LIMIT)) break;
				record.snapshot.currentMode = update.currentModeId;
				this.persist();
				this.emit({ type: "mode", sessionId: thinkrailSessionId, mode: update.currentModeId });
				break;
			case "config_option_update":
				record.snapshot.configOptions = normalizeV1ConfigOptions(update.configOptions);
				this.persist();
				this.emitConfigOptions(record);
				break;
			case "available_commands_update":
				record.snapshot.availableCommands = normalizeAcpAvailableCommands(update.availableCommands);
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
					this.emit({ type: "title", sessionId: thinkrailSessionId, title });
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

	private handleV2Update(
		record: StoredAcpSession,
		live: LiveAcpSession,
		notification: unknown,
	): void {
		if (!isRecord(notification) || notification.sessionId !== live.agentSessionId) return;
		const update = isRecord(notification.update) ? notification.update : null;
		if (!update || typeof update.sessionUpdate !== "string") return;
		const thinkrailSessionId = record.snapshot.summary.id;
		switch (update.sessionUpdate) {
			case "agent_message_chunk":
				if (typeof update.messageId !== "string" || !isRecord(update.content)) break;
				if (update.content.type === "text" && typeof update.content.text === "string") {
					this.appendMessageDelta(record, live, "assistant", update.content.text, update.messageId);
				} else if (
					update.content.type === "image" &&
					typeof update.content.mimeType === "string" &&
					typeof update.content.data === "string"
				) {
					this.appendImage(
						record,
						live,
						"assistant",
						{ mimeType: update.content.mimeType, data: update.content.data },
						update.messageId,
					);
				}
				break;
			case "agent_message":
				if (typeof update.messageId === "string") {
					this.upsertV2Message(record, live, "assistant", update.messageId, update.content);
				}
				break;
			case "agent_thought_chunk":
				if (typeof update.messageId !== "string" || !isRecord(update.content)) break;
				if (update.content.type === "text" && typeof update.content.text === "string") {
					this.appendMessageDelta(record, live, "thought", update.content.text, update.messageId);
				} else if (
					update.content.type === "image" &&
					typeof update.content.mimeType === "string" &&
					typeof update.content.data === "string"
				) {
					this.appendImage(
						record,
						live,
						"thought",
						{ mimeType: update.content.mimeType, data: update.content.data },
						update.messageId,
					);
				}
				break;
			case "agent_thought":
				if (typeof update.messageId === "string") {
					this.upsertV2Message(record, live, "thought", update.messageId, update.content);
				}
				break;
			case "tool_call_update": {
				const existing = record.snapshot.toolCalls.find((tool) => tool.id === update.toolCallId);
				const toolCall = normalizeAcpToolCall({
					id: update.toolCallId,
					title:
						typeof update.title === "string" ? update.title : (existing?.title ?? "Agent tool"),
					kind: typeof update.kind === "string" ? update.kind : (existing?.kind ?? "other"),
					status:
						typeof update.status === "string"
							? mapToolStatus(update.status)
							: (existing?.status ?? "pending"),
				});
				if (!toolCall) break;
				const index = record.snapshot.toolCalls.findIndex((tool) => tool.id === toolCall.id);
				if (index < 0) record.snapshot.toolCalls.push(toolCall);
				else record.snapshot.toolCalls[index] = toolCall;
				record.snapshot.toolCalls = record.snapshot.toolCalls.slice(-500);
				this.persist();
				this.emit({ type: "toolCall", sessionId: thinkrailSessionId, toolCall });
				break;
			}
			case "plan_update": {
				const plan = isRecord(update.plan) ? update.plan : null;
				if (plan?.type === "items" && Array.isArray(plan.entries)) {
					record.snapshot.plan = normalizeAcpPlanEntries(plan.entries);
				} else if (plan?.type === "markdown" && typeof plan.content === "string") {
					record.snapshot.plan = normalizeAcpPlanEntries([
						{ content: plan.content, status: "in_progress", priority: "medium" },
					]);
				} else break;
				this.persist();
				this.emit({ type: "plan", sessionId: thinkrailSessionId, entries: record.snapshot.plan });
				break;
			}
			case "plan_removed":
				record.snapshot.plan = [];
				this.persist();
				this.emit({ type: "plan", sessionId: thinkrailSessionId, entries: [] });
				break;
			case "config_option_update": {
				const normalized = normalizeV2ConfigOptions(update.configOptions);
				live.booleanConfigOptionIds = new Set(normalized.booleanConfigOptionIds);
				const previousMode = record.snapshot.currentMode;
				this.applyConfigOptions(record, normalized.configOptions, ACP_V2);
				this.persist();
				this.emitConfigOptions(record);
				if (record.snapshot.currentMode && record.snapshot.currentMode !== previousMode) {
					this.emit({
						type: "mode",
						sessionId: thinkrailSessionId,
						mode: record.snapshot.currentMode,
					});
				}
				break;
			}
			case "available_commands_update":
				record.snapshot.availableCommands = normalizeV2AvailableCommands(update.availableCommands);
				this.persist();
				this.emit({
					type: "availableCommands",
					sessionId: thinkrailSessionId,
					commands: record.snapshot.availableCommands,
				});
				break;
			case "usage_update": {
				if (typeof update.used !== "number" || typeof update.size !== "number") break;
				const cost = isRecord(update.cost) ? update.cost : null;
				const usage: AcpUsage = {
					used: update.used,
					size: update.size,
					...(cost && typeof cost.amount === "number" && typeof cost.currency === "string"
						? { cost: { amount: cost.amount, currency: cost.currency } }
						: {}),
				};
				record.snapshot.usage = usage;
				this.persist();
				this.emit({ type: "usage", sessionId: thinkrailSessionId, usage });
				break;
			}
			case "session_info_update": {
				const title = typeof update.title === "string" ? normalizeSessionTitle(update.title) : null;
				if (title) {
					record.snapshot.summary.title = title;
					record.snapshot.summary.updatedAt = Date.now();
					this.persist();
					this.emit({ type: "title", sessionId: thinkrailSessionId, title });
				}
				break;
			}
			case "notice":
				if (typeof update.title !== "string") break;
				this.addMessage(record, {
					id: randomUUID(),
					role: "notice",
					text: [update.title, typeof update.description === "string" ? update.description : ""]
						.filter(Boolean)
						.join("\n"),
					createdAt: Date.now(),
				});
				break;
			case "state_update": {
				if (["running", "requires_action", "idle"].includes(String(update.state))) {
					live.v2StateUpdateReceived = true;
				}
				switch (update.state) {
					case "running":
						if (live.v2PromptTurn) live.v2PromptTurn.sawActivity = true;
						this.setState(record, "running");
						break;
					case "requires_action":
						if (live.v2PromptTurn) live.v2PromptTurn.sawActivity = true;
						this.setState(record, "needs-input");
						break;
					case "idle": {
						const turn = live.v2PromptTurn;
						if (turn?.sawActivity) {
							this.flushPendingMessages(record, live);
							const failed = update.stopReason === "error";
							if (failed) this.setState(record, "failed");
							if (failed) {
								this.emit({
									type: "error",
									sessionId: thinkrailSessionId,
									message: "The ACP agent could not complete this request.",
								});
							}
							turn.resolve();
						} else if (!turn) {
							this.setState(record, update.stopReason === "error" ? "failed" : "idle");
						}
						break;
					}
				}
				break;
			}
			case "user_message_chunk":
			case "user_message":
			case "terminal_update":
			case "terminal_output_chunk":
			case "tool_call_content_chunk":
			case "compaction_update":
			case "compaction_summary_chunk":
			case "subagent_update":
			case "session_message":
			case "session_message_chunk":
				break;
			default:
				break;
		}
	}

	private upsertV2Message(
		record: StoredAcpSession,
		live: LiveAcpSession,
		role: "assistant" | "thought",
		messageId: string,
		content: unknown,
	): void {
		if (!messageId || !boundedString(messageId, 110) || hasControlCharacter(messageId)) return;
		const id = `v2-${role}-${messageId}`;
		const existing =
			live.pendingMessages.get(id) ?? record.snapshot.messages.find((entry) => entry.id === id);
		if (content === undefined && !existing) return;
		const entry: AcpTranscriptEntry = existing
			? { ...existing, ...(existing.images ? { images: [...existing.images] } : {}) }
			: { id, role, text: "", createdAt: Date.now() };
		if (content !== undefined) {
			entry.text = "";
			const images: NonNullable<AcpTranscriptEntry["images"]> = [];
			entry.images = images;
			let entryLength = 0;
			for (const rawBlock of Array.isArray(content) ? content : []) {
				if (!isRecord(rawBlock)) continue;
				if (rawBlock.type === "text" && typeof rawBlock.text === "string") {
					const remaining = Math.min(
						ACP_ENTRY_CHAR_LIMIT - entry.text.length,
						ACP_TRANSCRIPT_CHAR_LIMIT - entryLength,
					);
					const text = rawBlock.text.slice(0, Math.max(0, remaining));
					entry.text += text;
					entryLength += text.length;
				} else if (
					rawBlock.type === "image" &&
					images.length < 8 &&
					typeof rawBlock.mimeType === "string" &&
					rawBlock.mimeType.startsWith("image/") &&
					typeof rawBlock.data === "string" &&
					rawBlock.data.length <= ACP_IMAGE_CHAR_LIMIT &&
					entryLength + rawBlock.data.length <= ACP_TRANSCRIPT_CHAR_LIMIT &&
					/^[-A-Za-z0-9+/]*={0,2}$/.test(rawBlock.data)
				) {
					images.push({ mimeType: rawBlock.mimeType, data: rawBlock.data });
					entryLength += rawBlock.data.length;
				}
			}
		}
		live.pendingMessages.delete(id);
		this.addMessage(record, entry);
	}

	private appendMessageDelta(
		record: StoredAcpSession,
		live: LiveAcpSession,
		role: "assistant" | "thought",
		text: string,
		messageId?: string,
	): void {
		if (messageId && (!boundedString(messageId, 110) || hasControlCharacter(messageId))) return;
		const key = messageId ? `v2-${role}-${messageId}` : role;
		if (!live.pendingMessages.has(key) && live.pendingMessages.size >= ACP_PENDING_MESSAGE_LIMIT) {
			this.flushPendingMessages(record, live);
		}
		const existing = messageId
			? record.snapshot.messages.find((entry) => entry.id === key)
			: undefined;
		const current =
			live.pendingMessages.get(key) ??
			(existing
				? { ...existing, ...(existing.images ? { images: [...existing.images] } : {}) }
				: ({
						id: messageId ? key : randomUUID(),
						role,
						text: "",
						createdAt: Date.now(),
					} satisfies AcpTranscriptEntry));
		const remaining = Math.max(
			0,
			Math.min(
				ACP_ENTRY_CHAR_LIMIT - current.text.length,
				ACP_TRANSCRIPT_CHAR_LIMIT - transcriptEntryTextLength(current),
			),
		);
		const delta = text.slice(0, remaining);
		if (!delta) return;
		current.text += delta;
		live.pendingMessages.set(key, current);
		record.snapshot.summary.updatedAt = Date.now();
		this.emit({ type: "messageDelta", sessionId: record.snapshot.summary.id, role, delta });
	}

	private appendImage(
		record: StoredAcpSession,
		live: LiveAcpSession,
		role: "assistant" | "thought",
		image: { mimeType: string; data: string },
		messageId?: string,
	): void {
		if (
			!image.mimeType.startsWith("image/") ||
			image.data.length > ACP_IMAGE_CHAR_LIMIT ||
			!/^[-A-Za-z0-9+/]*={0,2}$/.test(image.data)
		) {
			return;
		}
		if (messageId && (!boundedString(messageId, 110) || hasControlCharacter(messageId))) return;
		const key = messageId ? `v2-${role}-${messageId}` : role;
		if (!live.pendingMessages.has(key) && live.pendingMessages.size >= ACP_PENDING_MESSAGE_LIMIT) {
			this.flushPendingMessages(record, live);
		}
		const existing = messageId
			? record.snapshot.messages.find((entry) => entry.id === key)
			: undefined;
		const current =
			live.pendingMessages.get(key) ??
			(existing
				? { ...existing, ...(existing.images ? { images: [...existing.images] } : {}) }
				: ({
						id: messageId ? key : randomUUID(),
						role,
						text: "",
						createdAt: Date.now(),
					} satisfies AcpTranscriptEntry));
		if (
			(current.images?.length ?? 0) >= 8 ||
			transcriptEntryTextLength(current) + image.data.length > ACP_TRANSCRIPT_CHAR_LIMIT
		) {
			return;
		}
		current.images = [...(current.images ?? []), { mimeType: image.mimeType, data: image.data }];
		live.pendingMessages.set(key, current);
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
	): Promise<{ outcome: PermissionOutcome }> {
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
			live.connection.connection.signal,
		);
		return permissionIsGranted(result.outcome, options);
	}

	private resolvePermission(live: LiveAcpSession, outcome: PermissionOutcome): void {
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
				if (!live.closing && live.connection.version === ACP_V1) {
					this.setState(record, live.promptRunning ? "running" : "idle");
				} else if (!live.closing && !live.promptRunning) {
					this.setState(record, "idle");
				}
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
		if (
			typeof params.command !== "string" ||
			params.command.length === 0 ||
			params.command.includes("\0")
		)
			throw new Error("ACP terminal command is invalid.");
		const args = normalizeAcpArguments(params.args ?? []);
		if (
			params.command.length > 4096 ||
			!args ||
			Buffer.byteLength(params.command, "utf8") +
				args.reduce((total, arg) => total + Buffer.byteLength(arg, "utf8"), 0) >
				32_768
		) {
			throw new Error("ACP terminal command arguments are invalid.");
		}
		const environment = normalizeAcpEnvironment(params.env ?? []);
		if (!environment) throw new Error("ACP terminal environment is invalid.");
		const root = this.options.resolveWorkspaceCwd(record.snapshot.summary.workspaceId);
		const cwd = params.cwd
			? await resolveAcpWorktreePath(root, params.cwd, true)
			: await fs.realpath(root);
		const command = JSON.stringify([params.command, ...args]);
		const cwdDescription = JSON.stringify(relative(root, cwd) || ".");
		const environmentEntries = Object.entries(environment);
		const environmentDescription = environmentEntries.length
			? `\nEnvironment overrides: ${JSON.stringify(environmentEntries)}`
			: "";
		const allowed = await this.requestLocalPermission(
			record,
			live,
			`Allow ${record.snapshot.summary.clientName} to run ${command} in ${cwdDescription}?${environmentDescription}`,
		);
		if (!allowed) throw new Error("The user denied this ACP command.");
		const approvedCwd = params.cwd
			? await resolveAcpWorktreePath(root, params.cwd, true)
			: await fs.realpath(root);
		if (approvedCwd !== cwd) {
			throw new Error("ACP terminal working directory changed while permission was pending.");
		}
		const env = Object.assign(Object.create(null), process.env) as NodeJS.ProcessEnv;
		for (const [name, value] of environmentEntries) {
			Object.defineProperty(env, name, {
				value,
				enumerable: true,
				configurable: true,
				writable: true,
			});
		}
		const child = spawn(params.command, args, {
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

	private async killTerminal(
		live: LiveAcpSession,
		sessionId: string,
		terminalId: string,
	): Promise<Record<string, never>> {
		await this.terminateTerminal(this.getTerminal(live, sessionId, terminalId));
		return {};
	}

	private async releaseTerminal(
		live: LiveAcpSession,
		sessionId: string,
		terminalId: string,
	): Promise<Record<string, never>> {
		const terminal = this.getTerminal(live, sessionId, terminalId);
		await this.terminateTerminal(terminal);
		live.terminals.delete(terminalId);
		return {};
	}

	private async terminateTerminal(terminal: TerminalProcess): Promise<void> {
		await terminateChildProcess(terminal.child, terminal.exited);
	}

	private async handleConnectionClosed(
		sessionId: string,
		record: StoredAcpSession,
		live: LiveAcpSession,
	): Promise<void> {
		if (live.closing || this.live.get(sessionId) !== live) return;
		this.live.delete(sessionId);
		this.resolveV2PromptTurn(live);
		live.promptRunning = false;
		this.flushPendingMessages(record, live);
		if (live.pendingPermission) this.resolvePermission(live, { outcome: "cancelled" });
		await Promise.all(
			[...live.terminals.values()].map((terminal) => this.terminateTerminal(terminal)),
		);
		live.terminals.clear();
		record.snapshot.summary.state = "interrupted";
		record.snapshot.summary.updatedAt = Date.now();
		this.persist();
		this.publishState(record);
	}

	private async closeLive(sessionId: string, live: LiveAcpSession): Promise<void> {
		live.closing = true;
		this.resolveV2PromptTurn(live);
		live.promptRunning = false;
		if (live.pendingPermission) this.resolvePermission(live, { outcome: "cancelled" });
		await Promise.all(
			[...live.terminals.values()].map((terminal) => this.terminateTerminal(terminal)),
		);
		live.terminals.clear();
		this.live.delete(sessionId);
		await this.closeChild(live.connection);
	}

	private resolveV2PromptTurn(live: LiveAcpSession): void {
		const turn = live.v2PromptTurn;
		if (!turn) return;
		live.v2PromptTurn = null;
		turn.resolve();
	}

	private closeChild(connection: WireConnection): Promise<void> {
		const closing = this.closingConnections.get(connection);
		if (closing) return closing;
		const pending = this.terminateConnection(connection);
		this.closingConnections.set(connection, pending);
		return pending;
	}

	private async terminateConnection(connection: WireConnection): Promise<void> {
		const child = connection.child;
		const closed = once(child, "close").then(() => undefined);
		try {
			connection.connection.close();
		} catch {}
		try {
			child.stdin.end();
		} catch {}
		child.stdout.destroy();
		child.stderr.destroy();
		await terminateChildProcess(child, closed);
	}
}
