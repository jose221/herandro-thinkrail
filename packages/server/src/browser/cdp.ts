import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	BrowserConsoleEntry,
	BrowserConsoleLevel,
	BrowserConsolePush,
	BrowserDialogPush,
	BrowserDialogState,
	BrowserElementInfo,
	BrowserEngineStatus,
	BrowserFramePush,
	BrowserNetworkEntry,
	BrowserNetworkPush,
	BrowserStorageSnapshot,
	CaptureFrame,
} from "@thinkrail/contracts";
import {
	browserSession,
	normalizeBrowserUrl,
	registerBrowserEngineHooks,
	syncActiveBrowserTabMeta,
} from "./session";

const IDLE_TTL_MS = 5 * 60 * 1000;
const MAX_CONSOLE_ENTRIES = 300;
const MAX_NETWORK_ENTRIES = 300;
const CDP_COMMAND_TIMEOUT_MS = 20_000;

interface CdpMessage {
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	sessionId?: string;
	result?: Record<string, unknown>;
	error?: { code?: number; message?: string };
}

interface PendingCommand {
	resolve: (result: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface TabTarget {
	tabId: string;
	targetId: string;
	sessionId: string;
	url: string;
	title: string;
}

interface WorkspaceEngineState {
	workspaceId: string;
	tabs: Map<string, TabTarget>;
	activeTabId: string;
	streaming: boolean;
	viewport: { width: number; height: number; deviceScaleFactor: number };
	consoleLogs: BrowserConsoleEntry[];
	networkLogs: Map<string, BrowserNetworkEntry>;
	networkOrder: string[];
	requestStarts: Map<string, number>;
	dialog: BrowserDialogState | null;
	lastFrameAt: number;
	inputQueue: Promise<void>;
}

export interface BrowserRealtimePublishers {
	onFrame: (push: BrowserFramePush) => void;
	onConsole: (push: BrowserConsolePush) => void;
	onNetwork: (push: BrowserNetworkPush) => void;
	onDialog: (push: BrowserDialogPush) => void;
}

let publishers: BrowserRealtimePublishers = {
	onFrame: () => {},
	onConsole: () => {},
	onNetwork: () => {},
	onDialog: () => {},
};

export function setBrowserRealtimePublishers(next: BrowserRealtimePublishers): void {
	publishers = next;
}

function findChromeBinary(): string | null {
	const envBin = process.env.CHROME_BIN;
	if (envBin && existsSync(envBin)) return envBin;
	const candidates =
		process.platform === "darwin"
			? [
					"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
					"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
					"/Applications/Chromium.app/Contents/MacOS/Chromium",
					"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
					"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
				]
			: process.platform === "win32"
				? [
						"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
						"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
						"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
					]
				: [
						"/usr/bin/google-chrome",
						"/usr/bin/google-chrome-stable",
						"/usr/bin/chromium",
						"/usr/bin/chromium-browser",
						"/snap/bin/chromium",
						"/opt/google/chrome/google-chrome",
					];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringHeaders(raw: unknown): Record<string, string> | undefined {
	if (!isRecord(raw)) return undefined;
	const result: Record<string, string> = {};
	for (const [k, v] of Object.entries(raw)) {
		if (typeof v === "string") result[k] = v.slice(0, 500);
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function mapConsoleLevel(raw: unknown): BrowserConsoleLevel {
	switch (raw) {
		case "error":
		case "assert":
			return "error";
		case "warning":
		case "warn":
			return "warn";
		case "info":
			return "info";
		case "debug":
			return "debug";
		default:
			return "log";
	}
}

function formatRemoteArg(arg: unknown): string {
	if (!isRecord(arg)) return String(arg ?? "");
	if (arg.type === "undefined") return "undefined";
	if (Object.hasOwn(arg, "value")) {
		const val = arg.value;
		if (typeof val === "string") return val;
		try {
			return JSON.stringify(val);
		} catch {
			return String(val);
		}
	}
	if (isRecord(arg.preview) && Array.isArray(arg.preview.properties)) {
		const props = arg.preview.properties
			.slice(0, 8)
			.map((p) => (isRecord(p) ? `${String(p.name)}: ${String(p.value ?? p.type)}` : ""))
			.filter(Boolean)
			.join(", ");
		return `{${props}}`;
	}
	return typeof arg.description === "string" ? arg.description : String(arg.type ?? "");
}

const KEY_DEFS: Readonly<
	Record<string, { key: string; code: string; keyCode: number; text?: string }>
> = {
	Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
	Tab: { key: "Tab", code: "Tab", keyCode: 9 },
	Escape: { key: "Escape", code: "Escape", keyCode: 27 },
	Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
	Delete: { key: "Delete", code: "Delete", keyCode: 46 },
	ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
	ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
	ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
	ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
	Home: { key: "Home", code: "Home", keyCode: 36 },
	End: { key: "End", code: "End", keyCode: 35 },
	PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
	PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
	Space: { key: " ", code: "Space", keyCode: 32, text: " " },
	" ": { key: " ", code: "Space", keyCode: 32, text: " " },
};

const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);

function editingCommandsForKey(key: string, modifiers: number): string[] | undefined {
	const alt = (modifiers & 1) !== 0;
	const ctrl = (modifiers & 2) !== 0;
	const meta = (modifiers & 4) !== 0;
	const shift = (modifiers & 8) !== 0;
	switch (key) {
		case "ArrowLeft":
			if (meta && !ctrl && !alt) {
				return [shift ? "moveToBeginningOfLineAndModifySelection" : "moveToBeginningOfLine"];
			}
			if (alt && !ctrl && !meta) {
				return [shift ? "moveWordBackwardAndModifySelection" : "moveWordBackward"];
			}
			return undefined;
		case "ArrowRight":
			if (meta && !ctrl && !alt) {
				return [shift ? "moveToEndOfLineAndModifySelection" : "moveToEndOfLine"];
			}
			if (alt && !ctrl && !meta) {
				return [shift ? "moveWordForwardAndModifySelection" : "moveWordForward"];
			}
			return undefined;
		case "Backspace":
			if (meta && !ctrl && !alt) return ["deleteToBeginningOfLine"];
			if (alt && !ctrl && !meta) return ["deleteWordBackward"];
			return undefined;
		case "Delete":
			if (alt && !ctrl && !meta) return ["deleteWordForward"];
			if (!ctrl && !meta && !alt) return ["deleteForward"];
			return undefined;
		case "a":
		case "A":
			if ((meta || ctrl) && !alt && !shift) return ["selectAll"];
			return undefined;
		case "c":
		case "C":
			if ((meta || ctrl) && !alt && !shift) return ["copy"];
			return undefined;
		case "x":
		case "X":
			if ((meta || ctrl) && !alt && !shift) return ["cut"];
			return undefined;
		case "z":
		case "Z":
			if ((meta || ctrl) && !alt) return [shift ? "redo" : "undo"];
			return undefined;
		default:
			return undefined;
	}
}

class CdpBrowserDaemon {
	private proc: ReturnType<typeof Bun.spawn> | null = null;
	private ws: WebSocket | null = null;
	private profileDir: string | null = null;
	private starting: Promise<void> | null = null;
	private nextCommandId = 1;
	private readonly pending = new Map<number, PendingCommand>();
	private readonly workspaces = new Map<string, WorkspaceEngineState>();
	private readonly sessionToWorkspace = new Map<string, { workspaceId: string; tabId: string }>();
	private lastActivityAt = 0;
	private lastError: string | undefined;
	private readonly idleTimer: ReturnType<typeof setInterval>;

	constructor() {
		this.idleTimer = setInterval(() => {
			void this.stopIfIdle();
		}, 30_000);
		this.idleTimer.unref?.();
	}

	status(): BrowserEngineStatus {
		const bin = findChromeBinary();
		return {
			available: bin !== null,
			running: this.ws !== null && this.ws.readyState === WebSocket.OPEN,
			...(this.lastError ? { error: this.lastError } : {}),
		};
	}

	private touch(): void {
		this.lastActivityAt = Date.now();
	}

	private async stopIfIdle(): Promise<void> {
		if (!this.ws) return;
		for (const state of this.workspaces.values()) {
			if (state.streaming) return;
		}
		if (Date.now() - this.lastActivityAt > IDLE_TTL_MS) {
			await this.dispose();
		}
	}

	private async ensureConnected(): Promise<void> {
		this.touch();
		if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
		if (this.starting) return this.starting;
		this.starting = this.startInternal().finally(() => {
			this.starting = null;
		});
		return this.starting;
	}

	private async startInternal(): Promise<void> {
		const bin = findChromeBinary();
		if (!bin) {
			const msg = "Chrome/Chromium binary not found on host";
			this.lastError = msg;
			throw new Error(msg);
		}
		this.lastError = undefined;
		const profileDir = await mkdtemp(join(tmpdir(), "thinkrail-cdp-"));
		this.profileDir = profileDir;
		const args = [
			"--headless=new",
			"--remote-debugging-port=0",
			`--user-data-dir=${profileDir}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-dev-shm-usage",
			"--disable-background-networking",
			"--disable-gpu",
			"--window-size=1280,800",
			...(process.platform === "linux" ? ["--no-sandbox", "--disable-setuid-sandbox"] : []),
			"about:blank",
		];
		const proc = Bun.spawn([bin, ...args], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
		});
		this.proc = proc;

		const wsUrl = await this.readDevToolsUrl(proc.stderr as ReadableStream<Uint8Array>);
		await this.connectWebSocket(wsUrl);
		void proc.exited.then(() => {
			if (this.proc === proc) {
				this.cleanupConnection("Chrome process exited");
			}
		});
	}

	private async readDevToolsUrl(stderr: ReadableStream<Uint8Array>): Promise<string> {
		const reader = stderr.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const deadline = Date.now() + 15_000;
		try {
			while (Date.now() < deadline) {
				const remaining = Math.max(100, deadline - Date.now());
				const readPromise = reader.read();
				const timeoutPromise = new Promise<{ done: true; value: undefined }>((resolve) =>
					setTimeout(() => resolve({ done: true, value: undefined }), remaining),
				);
				const { done, value } = await Promise.race([readPromise, timeoutPromise]);
				if (done && !value) break;
				if (value) {
					buffer += decoder.decode(value, { stream: true });
					const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(buffer);
					if (match?.[1]) {
						// Drain stderr silently in background so pipe never stalls Chrome
						void (async () => {
							try {
								while (true) {
									const next = await reader.read();
									if (next.done) break;
								}
							} catch {}
						})();
						return match[1];
					}
				}
			}
		} catch {}
		this.lastError = "Chrome DevTools failed to start";
		await this.dispose();
		throw new Error(this.lastError);
	}

	private connectWebSocket(wsUrl: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(wsUrl);
			let settled = false;
			const timer = setTimeout(() => {
				if (!settled) {
					settled = true;
					reject(new Error("Chrome DevTools WebSocket timed out"));
				}
			}, 10_000);
			ws.addEventListener("open", () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.ws = ws;
				resolve();
			});
			ws.addEventListener("message", (event) => {
				this.handleMessage(String(event.data));
			});
			ws.addEventListener("error", () => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					reject(new Error("Chrome DevTools WebSocket error"));
				}
			});
			ws.addEventListener("close", () => {
				if (this.ws === ws) {
					this.cleanupConnection();
				}
			});
		});
	}

	private cleanupConnection(errorMessage?: string): void {
		if (errorMessage) this.lastError = errorMessage;
		for (const item of this.pending.values()) {
			clearTimeout(item.timer);
			item.reject(new Error(errorMessage ?? "Browser connection closed"));
		}
		this.pending.clear();
		this.ws = null;
		this.sessionToWorkspace.clear();
		for (const state of this.workspaces.values()) {
			state.tabs.clear();
			state.streaming = false;
		}
	}

	async dispose(): Promise<void> {
		const proc = this.proc;
		const ws = this.ws;
		const profileDir = this.profileDir;
		this.proc = null;
		this.ws = null;
		this.profileDir = null;
		this.cleanupConnection();
		this.workspaces.clear();
		try {
			ws?.close();
		} catch {}
		if (proc) {
			try {
				proc.kill();
			} catch {}
		}
		if (profileDir) {
			await rm(profileDir, { recursive: true, force: true }).catch(() => {});
		}
	}

	private sendCdp(
		method: string,
		params?: Record<string, unknown>,
		sessionId?: string,
	): Promise<Record<string, unknown>> {
		this.touch();
		const ws = this.ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error("Browser engine is not connected"));
		}
		const id = this.nextCommandId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Browser CDP command timed out: ${method}`));
			}, CDP_COMMAND_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer });
			const payload: Record<string, unknown> = { id, method };
			if (params) payload.params = params;
			if (sessionId) payload.sessionId = sessionId;
			ws.send(JSON.stringify(payload));
		});
	}

	private handleMessage(raw: string): void {
		let msg: CdpMessage;
		try {
			msg = JSON.parse(raw) as CdpMessage;
		} catch {
			return;
		}
		if (typeof msg.id === "number") {
			const pending = this.pending.get(msg.id);
			if (!pending) return;
			this.pending.delete(msg.id);
			clearTimeout(pending.timer);
			if (msg.error) {
				pending.reject(new Error(msg.error.message ?? "CDP error"));
			} else {
				pending.resolve(msg.result ?? {});
			}
			return;
		}
		if (!msg.method || !msg.sessionId) return;
		const owner = this.sessionToWorkspace.get(msg.sessionId);
		if (!owner) return;
		const state = this.workspaces.get(owner.workspaceId);
		if (!state) return;
		const params = msg.params ?? {};

		switch (msg.method) {
			case "Page.screencastFrame": {
				const cdpFrameSessionId = params.sessionId;
				const data = typeof params.data === "string" ? params.data : "";
				if (typeof cdpFrameSessionId === "number") {
					void this.sendCdp(
						"Page.screencastFrameAck",
						{ sessionId: cdpFrameSessionId },
						msg.sessionId,
					).catch(() => {});
				}
				if (!data || owner.tabId !== state.activeTabId) return;
				const now = Date.now();
				if (now - state.lastFrameAt < 25) return;
				state.lastFrameAt = now;
				const meta = isRecord(params.metadata) ? params.metadata : {};
				const width =
					typeof meta.deviceWidth === "number" ? meta.deviceWidth : state.viewport.width;
				const height =
					typeof meta.deviceHeight === "number" ? meta.deviceHeight : state.viewport.height;
				publishers.onFrame({
					workspaceId: state.workspaceId,
					mimeType: "image/jpeg",
					data,
					width,
					height,
				});
				return;
			}
			case "Runtime.consoleAPICalled": {
				const args = Array.isArray(params.args) ? params.args : [];
				const text = args.map(formatRemoteArg).join(" ").slice(0, 4_000);
				const stack =
					isRecord(params.stackTrace) && Array.isArray(params.stackTrace.callFrames)
						? params.stackTrace.callFrames[0]
						: undefined;
				const entry: BrowserConsoleEntry = {
					id: randomUUID(),
					level: mapConsoleLevel(params.type),
					text,
					timestamp: Date.now(),
					...(isRecord(stack) && typeof stack.url === "string" && stack.url
						? { url: stack.url }
						: {}),
					...(isRecord(stack) && typeof stack.lineNumber === "number"
						? { line: stack.lineNumber + 1 }
						: {}),
				};
				this.appendConsole(state, entry);
				return;
			}
			case "Runtime.exceptionThrown": {
				const details = isRecord(params.exceptionDetails) ? params.exceptionDetails : {};
				const ex = isRecord(details.exception) ? details.exception : {};
				const text =
					(typeof ex.description === "string" && ex.description) ||
					(typeof details.text === "string" && details.text) ||
					"Uncaught exception";
				const entry: BrowserConsoleEntry = {
					id: randomUUID(),
					level: "error",
					text: text.slice(0, 4_000),
					timestamp: Date.now(),
					...(typeof details.url === "string" && details.url ? { url: details.url } : {}),
					...(typeof details.lineNumber === "number" ? { line: details.lineNumber + 1 } : {}),
				};
				this.appendConsole(state, entry);
				return;
			}
			case "Log.entryAdded": {
				const rawEntry = isRecord(params.entry) ? params.entry : {};
				const entry: BrowserConsoleEntry = {
					id: randomUUID(),
					level: mapConsoleLevel(rawEntry.level),
					text: String(rawEntry.text ?? "").slice(0, 4_000),
					timestamp: Date.now(),
					...(typeof rawEntry.url === "string" && rawEntry.url ? { url: rawEntry.url } : {}),
					...(typeof rawEntry.lineNumber === "number" ? { line: rawEntry.lineNumber + 1 } : {}),
				};
				this.appendConsole(state, entry);
				return;
			}
			case "Network.requestWillBeSent": {
				const requestId = typeof params.requestId === "string" ? params.requestId : "";
				const req = isRecord(params.request) ? params.request : {};
				const url = typeof req.url === "string" ? req.url : "";
				if (!requestId || !url || url.startsWith("data:")) return;
				const reqHeaders = stringHeaders(req.headers);
				const entry: BrowserNetworkEntry = {
					id: requestId,
					url: url.slice(0, 2_000),
					method: typeof req.method === "string" ? req.method : "GET",
					status: -2,
					resourceType: typeof params.type === "string" ? params.type.toLowerCase() : "other",
					timestamp: Date.now(),
					durationMs: 0,
					...(reqHeaders ? { requestHeaders: reqHeaders } : {}),
				};
				state.requestStarts.set(requestId, Date.now());
				this.upsertNetwork(state, entry);
				return;
			}
			case "Network.responseReceived": {
				const requestId = typeof params.requestId === "string" ? params.requestId : "";
				const resp = isRecord(params.response) ? params.response : {};
				const existing = state.networkLogs.get(requestId);
				if (!existing) return;
				const startedAt = state.requestStarts.get(requestId) ?? existing.timestamp;
				const resHeaders = stringHeaders(resp.headers);
				const updated: BrowserNetworkEntry = {
					...existing,
					status: typeof resp.status === "number" ? resp.status : existing.status,
					durationMs: Math.max(0, Date.now() - startedAt),
					...(typeof params.type === "string" ? { resourceType: params.type.toLowerCase() } : {}),
					...(resHeaders ? { responseHeaders: resHeaders } : {}),
				};
				this.upsertNetwork(state, updated);
				return;
			}
			case "Network.loadingFailed": {
				const requestId = typeof params.requestId === "string" ? params.requestId : "";
				const existing = state.networkLogs.get(requestId);
				if (!existing) return;
				const startedAt = state.requestStarts.get(requestId) ?? existing.timestamp;
				const errorText =
					typeof params.errorText === "string" ? params.errorText : "Failed to load";
				const blockedReason =
					typeof params.blockedReason === "string" ? params.blockedReason : undefined;
				const corsStatus = isRecord(params.corsErrorStatus)
					? String(params.corsErrorStatus.corsError ?? "")
					: undefined;
				const updated: BrowserNetworkEntry = {
					...existing,
					status: 0,
					durationMs: Math.max(0, Date.now() - startedAt),
					error: errorText,
					...(blockedReason ? { blockedReason } : {}),
					...(corsStatus ? { corsError: corsStatus } : {}),
				};
				this.upsertNetwork(state, updated);
				return;
			}
			case "Page.javascriptDialogOpening": {
				const type = params.type;
				const dialogType =
					type === "confirm" || type === "prompt" || type === "beforeunload" ? type : "alert";
				state.dialog = {
					dialogType,
					message: typeof params.message === "string" ? params.message : "",
					...(typeof params.defaultPrompt === "string"
						? { defaultValue: params.defaultPrompt }
						: {}),
				};
				publishers.onDialog({ workspaceId: state.workspaceId, dialog: state.dialog });
				return;
			}
			case "Page.javascriptDialogClosed": {
				state.dialog = null;
				publishers.onDialog({ workspaceId: state.workspaceId, dialog: null });
				return;
			}
			case "Page.frameNavigated": {
				const frame = isRecord(params.frame) ? params.frame : {};
				if (frame.parentId !== undefined) return;
				const url = typeof frame.url === "string" ? frame.url : undefined;
				if (!url) return;
				const tab = state.tabs.get(owner.tabId);
				if (tab) {
					tab.url = url;
					syncActiveBrowserTabMeta(state.workspaceId, owner.tabId, url, tab.title || undefined);
				}
				return;
			}
			case "Page.navigatedWithinDocument": {
				const url = typeof params.url === "string" ? params.url : undefined;
				if (!url) return;
				const tab = state.tabs.get(owner.tabId);
				if (tab) {
					tab.url = url;
					syncActiveBrowserTabMeta(state.workspaceId, owner.tabId, url, tab.title || undefined);
				}
				return;
			}
		}
	}

	private appendConsole(state: WorkspaceEngineState, entry: BrowserConsoleEntry): void {
		state.consoleLogs.push(entry);
		if (state.consoleLogs.length > MAX_CONSOLE_ENTRIES) {
			state.consoleLogs.splice(0, state.consoleLogs.length - MAX_CONSOLE_ENTRIES);
		}
		publishers.onConsole({ workspaceId: state.workspaceId, entry });
	}

	private upsertNetwork(state: WorkspaceEngineState, entry: BrowserNetworkEntry): void {
		if (!state.networkLogs.has(entry.id)) {
			state.networkOrder.push(entry.id);
			if (state.networkOrder.length > MAX_NETWORK_ENTRIES) {
				const evicted = state.networkOrder.shift();
				if (evicted) {
					state.networkLogs.delete(evicted);
					state.requestStarts.delete(evicted);
				}
			}
		}
		state.networkLogs.set(entry.id, entry);
		publishers.onNetwork({ workspaceId: state.workspaceId, entry });
	}

	private ensureWorkspaceState(workspaceId: string): WorkspaceEngineState {
		let state = this.workspaces.get(workspaceId);
		if (!state) {
			state = {
				workspaceId,
				tabs: new Map(),
				activeTabId: "",
				streaming: false,
				viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
				consoleLogs: [],
				networkLogs: new Map(),
				networkOrder: [],
				requestStarts: new Map(),
				dialog: null,
				lastFrameAt: 0,
				inputQueue: Promise.resolve(),
			};
			this.workspaces.set(workspaceId, state);
		}
		return state;
	}

	private enqueueInput<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
		const state = this.ensureWorkspaceState(workspaceId);
		const run = state.inputQueue.then(fn, fn);
		state.inputQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async ensureActiveTab(workspaceId: string): Promise<{
		state: WorkspaceEngineState;
		tab: TabTarget;
	}> {
		await this.ensureConnected();
		const session = browserSession(workspaceId);
		const state = this.ensureWorkspaceState(workspaceId);
		state.activeTabId = session.activeTabId;
		const activeMeta = session.tabs.find((t) => t.id === session.activeTabId);
		const desiredUrl = activeMeta?.url ?? "about:blank";

		let tab = state.tabs.get(session.activeTabId);
		if (!tab) {
			tab = await this.createTargetForTab(state, session.activeTabId, desiredUrl);
		} else if (desiredUrl !== "about:blank" && tab.url === "about:blank") {
			await this.navigateTarget(state, tab, desiredUrl);
		}
		if (state.streaming) {
			await this.startScreencast(state, tab).catch(() => {});
		}
		return { state, tab };
	}

	private async createTargetForTab(
		state: WorkspaceEngineState,
		tabId: string,
		url: string,
	): Promise<TabTarget> {
		const created = await this.sendCdp("Target.createTarget", {
			url: url === "about:blank" ? "about:blank" : url,
		});
		const targetId = typeof created.targetId === "string" ? created.targetId : "";
		if (!targetId) throw new Error("Failed to create browser target");
		const attached = await this.sendCdp("Target.attachToTarget", {
			targetId,
			flatten: true,
		});
		const sessionId = typeof attached.sessionId === "string" ? attached.sessionId : "";
		if (!sessionId) throw new Error("Failed to attach to browser target");

		const tab: TabTarget = { tabId, targetId, sessionId, url, title: "" };
		state.tabs.set(tabId, tab);
		this.sessionToWorkspace.set(sessionId, { workspaceId: state.workspaceId, tabId });

		await Promise.all([
			this.sendCdp("Page.enable", {}, sessionId),
			this.sendCdp("Runtime.enable", {}, sessionId),
			this.sendCdp("Log.enable", {}, sessionId),
			this.sendCdp("Network.enable", {}, sessionId),
			this.sendCdp("DOM.enable", {}, sessionId),
			this.applyViewportToTab(state, tab),
		]);
		return tab;
	}

	private async applyViewportToTab(state: WorkspaceEngineState, tab: TabTarget): Promise<void> {
		await this.sendCdp(
			"Emulation.setDeviceMetricsOverride",
			{
				width: state.viewport.width,
				height: state.viewport.height,
				deviceScaleFactor: state.viewport.deviceScaleFactor,
				mobile: state.viewport.width <= 820,
			},
			tab.sessionId,
		).catch(() => {});
	}

	private async startScreencast(state: WorkspaceEngineState, tab: TabTarget): Promise<void> {
		try {
			await this.sendCdp(
				"Page.startScreencast",
				{
					format: "jpeg",
					quality: 82,
					maxWidth: state.viewport.width,
					maxHeight: state.viewport.height,
					everyNthFrame: 1,
				},
				tab.sessionId,
			);
		} catch (error) {
			if (error instanceof Error && error.message.includes("already active")) return;
			throw error;
		}
	}

	private async navigateTarget(
		state: WorkspaceEngineState,
		tab: TabTarget,
		url: string,
	): Promise<void> {
		tab.url = url;
		await this.sendCdp("Page.navigate", { url }, tab.sessionId);
		const titleRes = await this.sendCdp(
			"Runtime.evaluate",
			{ expression: "document.title", returnByValue: true },
			tab.sessionId,
		).catch(() => null);
		const title =
			titleRes && isRecord(titleRes.result) && typeof titleRes.result.value === "string"
				? titleRes.result.value
				: undefined;
		if (title !== undefined) tab.title = title;
		syncActiveBrowserTabMeta(state.workspaceId, tab.tabId, url, title);
	}

	async startStream(
		workspaceId: string,
		width?: number,
		height?: number,
	): Promise<BrowserEngineStatus> {
		const state = this.ensureWorkspaceState(workspaceId);
		if (width && height) {
			state.viewport = {
				width: Math.max(320, Math.min(1920, Math.round(width))),
				height: Math.max(240, Math.min(1440, Math.round(height))),
				deviceScaleFactor: 1,
			};
		}
		state.streaming = true;
		const { tab } = await this.ensureActiveTab(workspaceId);
		await this.applyViewportToTab(state, tab);
		await this.startScreencast(state, tab);
		return this.status();
	}

	async stopStream(workspaceId: string): Promise<void> {
		const state = this.workspaces.get(workspaceId);
		if (!state) return;
		state.streaming = false;
		const tab = state.tabs.get(state.activeTabId);
		if (tab && this.ws?.readyState === WebSocket.OPEN) {
			await this.sendCdp("Page.stopScreencast", {}, tab.sessionId).catch(() => {});
		}
	}

	async syncNavigation(workspaceId: string, tabId: string, url: string): Promise<void> {
		const state = this.workspaces.get(workspaceId);
		if (!state || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
		state.activeTabId = tabId;
		let tab = state.tabs.get(tabId);
		if (!tab) {
			tab = await this.createTargetForTab(state, tabId, url);
		} else if (tab.url !== url && url !== "about:blank") {
			await this.navigateTarget(state, tab, url);
		}
		if (state.streaming) {
			await this.startScreencast(state, tab).catch(() => {});
		}
	}

	async syncSelectTab(workspaceId: string, tabId: string): Promise<void> {
		const state = this.workspaces.get(workspaceId);
		if (!state || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
		const prev = state.tabs.get(state.activeTabId);
		if (prev && prev.tabId !== tabId) {
			await this.sendCdp("Page.stopScreencast", {}, prev.sessionId).catch(() => {});
		}
		state.activeTabId = tabId;
		const { tab } = await this.ensureActiveTab(workspaceId);
		await this.sendCdp("Target.activateTarget", { targetId: tab.targetId }).catch(() => {});
		if (state.streaming) {
			await this.startScreencast(state, tab).catch(() => {});
		}
	}

	async syncCloseTab(workspaceId: string, tabId: string): Promise<void> {
		const state = this.workspaces.get(workspaceId);
		if (!state) return;
		const tab = state.tabs.get(tabId);
		if (!tab) return;
		state.tabs.delete(tabId);
		this.sessionToWorkspace.delete(tab.sessionId);
		if (this.ws?.readyState === WebSocket.OPEN) {
			await this.sendCdp("Target.closeTarget", { targetId: tab.targetId }).catch(() => {});
		}
	}

	async forgetWorkspace(workspaceId: string): Promise<void> {
		const state = this.workspaces.get(workspaceId);
		if (!state) return;
		this.workspaces.delete(workspaceId);
		for (const tab of state.tabs.values()) {
			this.sessionToWorkspace.delete(tab.sessionId);
			if (this.ws?.readyState === WebSocket.OPEN) {
				await this.sendCdp("Target.closeTarget", { targetId: tab.targetId }).catch(() => {});
			}
		}
	}

	async navigate(workspaceId: string, rawUrl: string): Promise<void> {
		const url = normalizeBrowserUrl(rawUrl);
		const { state, tab } = await this.ensureActiveTab(workspaceId);
		await this.navigateTarget(state, tab, url);
	}

	async resize(
		workspaceId: string,
		width: number,
		height: number,
		deviceScaleFactor = 1,
	): Promise<void> {
		const state = this.ensureWorkspaceState(workspaceId);
		state.viewport = {
			width: Math.max(320, Math.min(1920, Math.round(width))),
			height: Math.max(240, Math.min(1440, Math.round(height))),
			deviceScaleFactor: Math.max(1, Math.min(3, deviceScaleFactor)),
		};
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
		const tab = state.tabs.get(state.activeTabId);
		if (!tab) return;
		await this.applyViewportToTab(state, tab);
		if (state.streaming) {
			await this.sendCdp("Page.stopScreencast", {}, tab.sessionId).catch(() => {});
			await this.startScreencast(state, tab).catch(() => {});
		}
	}

	async back(workspaceId: string): Promise<void> {
		const { state, tab } = await this.ensureActiveTab(workspaceId);
		const history = await this.sendCdp("Page.getNavigationHistory", {}, tab.sessionId);
		const idx = typeof history.currentIndex === "number" ? history.currentIndex : 0;
		const entries = Array.isArray(history.entries) ? history.entries : [];
		const target = idx > 0 ? entries[idx - 1] : undefined;
		if (isRecord(target) && typeof target.id === "number") {
			await this.sendCdp("Page.navigateToHistoryEntry", { entryId: target.id }, tab.sessionId);
			if (typeof target.url === "string") {
				tab.url = target.url;
				syncActiveBrowserTabMeta(state.workspaceId, tab.tabId, target.url);
			}
		}
	}

	async forward(workspaceId: string): Promise<void> {
		const { state, tab } = await this.ensureActiveTab(workspaceId);
		const history = await this.sendCdp("Page.getNavigationHistory", {}, tab.sessionId);
		const idx = typeof history.currentIndex === "number" ? history.currentIndex : 0;
		const entries = Array.isArray(history.entries) ? history.entries : [];
		const target = idx < entries.length - 1 ? entries[idx + 1] : undefined;
		if (isRecord(target) && typeof target.id === "number") {
			await this.sendCdp("Page.navigateToHistoryEntry", { entryId: target.id }, tab.sessionId);
			if (typeof target.url === "string") {
				tab.url = target.url;
				syncActiveBrowserTabMeta(state.workspaceId, tab.tabId, target.url);
			}
		}
	}

	async reload(workspaceId: string): Promise<void> {
		const { tab } = await this.ensureActiveTab(workspaceId);
		await this.sendCdp("Page.reload", {}, tab.sessionId);
	}

	pointer(
		workspaceId: string,
		action: "down" | "up" | "move",
		x: number,
		y: number,
		button: "left" | "middle" | "right" = "left",
		clickCount = 1,
	): Promise<void> {
		return this.enqueueInput(workspaceId, async () => {
			const { tab } = await this.ensureActiveTab(workspaceId);
			const type =
				action === "down" ? "mousePressed" : action === "up" ? "mouseReleased" : "mouseMoved";
			await this.sendCdp(
				"Input.dispatchMouseEvent",
				{
					type,
					x: Math.round(x),
					y: Math.round(y),
					button: action === "move" ? "none" : button,
					clickCount: action === "move" ? 0 : clickCount,
				},
				tab.sessionId,
			);
		});
	}

	wheel(workspaceId: string, x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
		return this.enqueueInput(workspaceId, async () => {
			const { tab } = await this.ensureActiveTab(workspaceId);
			await this.sendCdp(
				"Input.dispatchMouseEvent",
				{
					type: "mouseWheel",
					x: Math.round(x),
					y: Math.round(y),
					deltaX,
					deltaY,
				},
				tab.sessionId,
			);
		});
	}

	key(
		workspaceId: string,
		action: "down" | "up",
		key: string,
		code?: string,
		keyCode?: number,
		modifiers = 0,
	): Promise<void> {
		if (MODIFIER_KEYS.has(key)) return Promise.resolve();
		return this.enqueueInput(workspaceId, async () => {
			const { tab } = await this.ensureActiveTab(workspaceId);
			const mapped = KEY_DEFS[key];
			const resolvedKey = mapped?.key ?? key;
			const type = action === "down" ? "keyDown" : "keyUp";
			const commands =
				action === "down" ? editingCommandsForKey(resolvedKey, modifiers) : undefined;
			await this.sendCdp(
				"Input.dispatchKeyEvent",
				{
					type,
					key: resolvedKey,
					code: code ?? mapped?.code ?? key,
					windowsVirtualKeyCode: keyCode ?? mapped?.keyCode ?? 0,
					nativeVirtualKeyCode: keyCode ?? mapped?.keyCode ?? 0,
					modifiers,
					...(action === "down" && mapped?.text ? { text: mapped.text } : {}),
					...(commands ? { commands } : {}),
				},
				tab.sessionId,
			);
		});
	}

	insertText(workspaceId: string, text: string): Promise<void> {
		return this.enqueueInput(workspaceId, async () => {
			const { tab } = await this.ensureActiveTab(workspaceId);
			await this.sendCdp("Input.insertText", { text }, tab.sessionId);
		});
	}

	async pressKey(workspaceId: string, keyName: string): Promise<void> {
		await this.key(workspaceId, "down", keyName);
		await this.key(workspaceId, "up", keyName);
	}

	async replyDialog(workspaceId: string, accept: boolean, promptText?: string): Promise<void> {
		const { state, tab } = await this.ensureActiveTab(workspaceId);
		await this.sendCdp(
			"Page.handleJavaScriptDialog",
			{ accept, ...(promptText !== undefined ? { promptText } : {}) },
			tab.sessionId,
		);
		state.dialog = null;
		publishers.onDialog({ workspaceId, dialog: null });
	}

	async screenshot(workspaceId: string, fullPage = false): Promise<CaptureFrame> {
		const { state, tab } = await this.ensureActiveTab(workspaceId);
		let clip: Record<string, unknown> | undefined;
		let width = state.viewport.width;
		let height = state.viewport.height;
		if (fullPage) {
			const metrics = await this.sendCdp("Page.getLayoutMetrics", {}, tab.sessionId).catch(
				() => null,
			);
			const content = metrics && isRecord(metrics.contentSize) ? metrics.contentSize : null;
			if (content && typeof content.width === "number" && typeof content.height === "number") {
				width = Math.max(1, Math.min(4_096, Math.round(content.width)));
				height = Math.max(1, Math.min(8_192, Math.round(content.height)));
				clip = { x: 0, y: 0, width, height, scale: 1 };
			}
		}
		const shot = await this.sendCdp(
			"Page.captureScreenshot",
			{
				format: "png",
				fromSurface: true,
				...(clip ? { clip } : {}),
			},
			tab.sessionId,
		);
		const data = typeof shot.data === "string" ? shot.data : "";
		if (!data) throw new Error("Screenshot returned empty image");
		return { mimeType: "image/png", data, width, height };
	}

	async evaluate(
		workspaceId: string,
		expression: string,
	): Promise<{ value: unknown; error?: string }> {
		const { tab } = await this.ensureActiveTab(workspaceId);
		const res = await this.sendCdp(
			"Runtime.evaluate",
			{
				expression,
				awaitPromise: true,
				returnByValue: true,
			},
			tab.sessionId,
		);
		if (isRecord(res.exceptionDetails)) {
			const ex = isRecord(res.exceptionDetails.exception) ? res.exceptionDetails.exception : {};
			const errMsg =
				(typeof ex.description === "string" && ex.description) ||
				(typeof res.exceptionDetails.text === "string" && res.exceptionDetails.text) ||
				"Evaluation error";
			return { value: null, error: errMsg };
		}
		const remote = isRecord(res.result) ? res.result : {};
		return { value: remote.value ?? remote.description ?? null };
	}

	async getElements(
		workspaceId: string,
		selector?: string,
		limit = 60,
	): Promise<BrowserElementInfo[]> {
		const capped = Math.max(1, Math.min(200, limit));
		const queryArg = JSON.stringify(
			selector ||
				'a,button,input,textarea,select,[role="button"],[role="link"],[role="tab"],[contenteditable="true"]',
		);
		const expr = `(() => {
			const cssPath = (el) => {
				if (el.id) return '#' + CSS.escape(el.id);
				const parts = [];
				let cur = el;
				while (cur && cur.nodeType === 1 && parts.length < 5) {
					let sel = cur.tagName.toLowerCase();
					if (cur.id) { parts.unshift('#' + CSS.escape(cur.id)); break; }
					const sibs = cur.parentElement ? [...cur.parentElement.children].filter(c => c.tagName === cur.tagName) : [];
					if (sibs.length > 1) sel += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
					parts.unshift(sel);
					cur = cur.parentElement;
				}
				return parts.join(' > ');
			};
			const nodes = [...document.querySelectorAll(${queryArg})];
			const out = [];
			for (const el of nodes) {
				if (out.length >= ${capped}) break;
				const r = el.getBoundingClientRect();
				if (r.width <= 0 || r.height <= 0) continue;
				const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
				out.push({
					tag: el.tagName.toLowerCase(),
					...(el.id ? { id: el.id } : {}),
					text,
					selector: cssPath(el),
					...(el.getAttribute('role') ? { role: el.getAttribute('role') } : {}),
					...(el.getAttribute('type') ? { type: el.getAttribute('type') } : {}),
					...(el.getAttribute('href') ? { href: el.getAttribute('href') } : {}),
					...(el.getAttribute('placeholder') ? { placeholder: el.getAttribute('placeholder') } : {}),
					rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
				});
			}
			return out;
		})()`;
		const { value, error } = await this.evaluate(workspaceId, expr);
		if (error) throw new Error(error);
		return Array.isArray(value) ? (value as BrowserElementInfo[]) : [];
	}

	async highlight(
		workspaceId: string,
		selector: string,
		label?: string,
		durationMs = 2_500,
	): Promise<void> {
		const ms = Math.max(200, Math.min(10_000, durationMs));
		const expr = `(() => {
			const el = document.querySelector(${JSON.stringify(selector)});
			if (!el) return false;
			el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
			const r = el.getBoundingClientRect();
			const old = document.getElementById('__thinkrail_highlight__');
			if (old) old.remove();
			const box = document.createElement('div');
			box.id = '__thinkrail_highlight__';
			Object.assign(box.style, {
				position: 'fixed',
				left: Math.max(0, r.left - 3) + 'px',
				top: Math.max(0, r.top - 3) + 'px',
				width: (r.width + 6) + 'px',
				height: (r.height + 6) + 'px',
				border: '2px solid #f59e0b',
				background: 'rgba(245, 158, 11, 0.16)',
				borderRadius: '6px',
				zIndex: '2147483647',
				pointerEvents: 'none',
				boxSizing: 'border-box',
			});
			if (${JSON.stringify(label ?? "")}) {
				const tag = document.createElement('div');
				tag.textContent = ${JSON.stringify(label ?? "")};
				Object.assign(tag.style, {
					position: 'absolute',
					left: '0',
					top: '-22px',
					background: '#f59e0b',
					color: '#111',
					fontSize: '11px',
					fontWeight: '600',
					padding: '1px 6px',
					borderRadius: '4px',
					whiteSpace: 'nowrap',
				});
				box.appendChild(tag);
			}
			document.body.appendChild(box);
			setTimeout(() => box.remove(), ${ms});
			return true;
		})()`;
		const { value } = await this.evaluate(workspaceId, expr);
		if (value !== true) throw new Error(`Element not found: ${selector}`);
	}

	async clickElementOrPoint(
		workspaceId: string,
		target: { selector?: string; x?: number; y?: number },
	): Promise<{ x: number; y: number }> {
		let x = target.x;
		let y = target.y;
		if (target.selector) {
			await this.highlight(workspaceId, target.selector, "AI click", 900).catch(() => {});
			const expr = `(() => {
				const el = document.querySelector(${JSON.stringify(target.selector)});
				if (!el) return null;
				el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
				const r = el.getBoundingClientRect();
				return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
			})()`;
			const { value, error } = await this.evaluate(workspaceId, expr);
			if (error) throw new Error(error);
			if (!isRecord(value) || typeof value.x !== "number" || typeof value.y !== "number") {
				throw new Error(`Element not found: ${target.selector}`);
			}
			x = value.x;
			y = value.y;
		}
		if (typeof x !== "number" || typeof y !== "number") {
			throw new Error("Provide either a CSS selector or x/y coordinates");
		}
		await this.pointer(workspaceId, "move", x, y);
		await this.pointer(workspaceId, "down", x, y, "left", 1);
		await this.pointer(workspaceId, "up", x, y, "left", 1);
		return { x, y };
	}

	async typeIntoElement(
		workspaceId: string,
		opts: { selector?: string; text: string; clear?: boolean; submit?: boolean },
	): Promise<void> {
		if (opts.selector) {
			await this.clickElementOrPoint(workspaceId, { selector: opts.selector });
			if (opts.clear) {
				await this.evaluate(
					workspaceId,
					`(() => {
						const el = document.querySelector(${JSON.stringify(opts.selector)});
						if (el && 'value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
					})()`,
				);
			}
		}
		await this.insertText(workspaceId, opts.text);
		if (opts.submit) {
			await this.pressKey(workspaceId, "Enter");
		}
	}

	async storage(workspaceId: string): Promise<BrowserStorageSnapshot> {
		const expr = `(() => {
			const read = (s) => {
				const out = [];
				for (let i = 0; i < Math.min(s.length, 200); i++) {
					const k = s.key(i);
					if (k !== null) out.push({ key: k, value: String(s.getItem(k) ?? '').slice(0, 2000) });
				}
				return out;
			};
			return { local: read(window.localStorage), session: read(window.sessionStorage) };
		})()`;
		const { value, error } = await this.evaluate(workspaceId, expr);
		if (error) throw new Error(error);
		if (isRecord(value) && Array.isArray(value.local) && Array.isArray(value.session)) {
			return value as unknown as BrowserStorageSnapshot;
		}
		return { local: [], session: [] };
	}

	consoleLogs(workspaceId: string, limit = 100, level?: string): BrowserConsoleEntry[] {
		const state = this.workspaces.get(workspaceId);
		if (!state) return [];
		const filtered =
			level && level !== "all"
				? state.consoleLogs.filter((item) => item.level === level)
				: state.consoleLogs;
		return filtered.slice(-Math.max(1, Math.min(MAX_CONSOLE_ENTRIES, limit)));
	}

	clearConsole(workspaceId: string): void {
		const state = this.workspaces.get(workspaceId);
		if (state) state.consoleLogs = [];
	}

	networkLogs(workspaceId: string, limit = 100, failedOnly = false): BrowserNetworkEntry[] {
		const state = this.workspaces.get(workspaceId);
		if (!state) return [];
		const list: BrowserNetworkEntry[] = [];
		for (const id of state.networkOrder) {
			const item = state.networkLogs.get(id);
			if (!item) continue;
			if (failedOnly && item.status > 0 && item.status < 400) continue;
			list.push(item);
		}
		return list.slice(-Math.max(1, Math.min(MAX_NETWORK_ENTRIES, limit)));
	}

	clearNetwork(workspaceId: string): void {
		const state = this.workspaces.get(workspaceId);
		if (!state) return;
		state.networkLogs.clear();
		state.networkOrder = [];
		state.requestStarts.clear();
	}
}

const daemon = new CdpBrowserDaemon();

registerBrowserEngineHooks({
	onNavigate: (workspaceId, tabId, url) => void daemon.syncNavigation(workspaceId, tabId, url),
	onSelectTab: (workspaceId, tabId) => void daemon.syncSelectTab(workspaceId, tabId),
	onCloseTab: (workspaceId, tabId) => void daemon.syncCloseTab(workspaceId, tabId),
	onForget: (workspaceId) => void daemon.forgetWorkspace(workspaceId),
});

export function browserEngineStatus(): BrowserEngineStatus {
	return daemon.status();
}

export function startBrowserStream(
	workspaceId: string,
	width?: number,
	height?: number,
): Promise<BrowserEngineStatus> {
	return daemon.startStream(workspaceId, width, height);
}

export function stopBrowserStream(workspaceId: string): Promise<void> {
	return daemon.stopStream(workspaceId);
}

export function resizeBrowserEngine(
	workspaceId: string,
	width: number,
	height: number,
	deviceScaleFactor?: number,
): Promise<void> {
	return daemon.resize(workspaceId, width, height, deviceScaleFactor);
}

export function browserEngineNavigate(workspaceId: string, url: string): Promise<void> {
	return daemon.navigate(workspaceId, url);
}

export function browserEngineBack(workspaceId: string): Promise<void> {
	return daemon.back(workspaceId);
}

export function browserEngineForward(workspaceId: string): Promise<void> {
	return daemon.forward(workspaceId);
}

export function browserEngineReload(workspaceId: string): Promise<void> {
	return daemon.reload(workspaceId);
}

export function browserEnginePointer(
	workspaceId: string,
	action: "down" | "up" | "move",
	x: number,
	y: number,
	button?: "left" | "middle" | "right",
	clickCount?: number,
): Promise<void> {
	return daemon.pointer(workspaceId, action, x, y, button, clickCount);
}

export function browserEngineWheel(
	workspaceId: string,
	x: number,
	y: number,
	deltaX: number,
	deltaY: number,
): Promise<void> {
	return daemon.wheel(workspaceId, x, y, deltaX, deltaY);
}

export function browserEngineKey(
	workspaceId: string,
	action: "down" | "up",
	key: string,
	code?: string,
	keyCode?: number,
	modifiers?: number,
): Promise<void> {
	return daemon.key(workspaceId, action, key, code, keyCode, modifiers);
}

export function browserEngineText(workspaceId: string, text: string): Promise<void> {
	return daemon.insertText(workspaceId, text);
}

export function browserEnginePressKey(workspaceId: string, key: string): Promise<void> {
	return daemon.pressKey(workspaceId, key);
}

export function browserEngineReplyDialog(
	workspaceId: string,
	accept: boolean,
	promptText?: string,
): Promise<void> {
	return daemon.replyDialog(workspaceId, accept, promptText);
}

export function browserEngineScreenshot(
	workspaceId: string,
	fullPage?: boolean,
): Promise<CaptureFrame> {
	return daemon.screenshot(workspaceId, fullPage);
}

export function browserEngineEvaluate(
	workspaceId: string,
	expression: string,
): Promise<{ value: unknown; error?: string }> {
	return daemon.evaluate(workspaceId, expression);
}

export function browserEngineElements(
	workspaceId: string,
	selector?: string,
	limit?: number,
): Promise<BrowserElementInfo[]> {
	return daemon.getElements(workspaceId, selector, limit);
}

export function browserEngineClick(
	workspaceId: string,
	target: { selector?: string; x?: number; y?: number },
): Promise<{ x: number; y: number }> {
	return daemon.clickElementOrPoint(workspaceId, target);
}

export function browserEngineType(
	workspaceId: string,
	opts: { selector?: string; text: string; clear?: boolean; submit?: boolean },
): Promise<void> {
	return daemon.typeIntoElement(workspaceId, opts);
}

export function browserEngineHighlight(
	workspaceId: string,
	selector: string,
	label?: string,
	durationMs?: number,
): Promise<void> {
	return daemon.highlight(workspaceId, selector, label, durationMs);
}

export function browserEngineStorage(workspaceId: string): Promise<BrowserStorageSnapshot> {
	return daemon.storage(workspaceId);
}

export function browserEngineConsoleLogs(
	workspaceId: string,
	limit?: number,
	level?: string,
): BrowserConsoleEntry[] {
	return daemon.consoleLogs(workspaceId, limit, level);
}

export function browserEngineClearConsole(workspaceId: string): void {
	daemon.clearConsole(workspaceId);
}

export function browserEngineNetworkLogs(
	workspaceId: string,
	limit?: number,
	failedOnly?: boolean,
): BrowserNetworkEntry[] {
	return daemon.networkLogs(workspaceId, limit, failedOnly);
}

export function browserEngineClearNetwork(workspaceId: string): void {
	daemon.clearNetwork(workspaceId);
}

export async function stopBrowserEngine(): Promise<void> {
	await daemon.dispose();
}
