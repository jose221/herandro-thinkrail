import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
	AndroidEmulatorDetails,
	AndroidEmulatorLogs,
	AndroidEmulatorScreenshot,
	AndroidEmulatorState,
	AndroidEmulatorStatus,
} from "@thinkrail/contracts";
import { runBounded } from "../subprocess";

export const ANDROID_EMULATOR_IDLE_TTL_MS = 5 * 60 * 1000;

const AVD_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const EMULATOR_SERIAL = /^emulator-\d{4,5}$/;
const MAX_PORT = 5682;
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
const MAX_LOG_BYTES = 256 * 1024;
const MAX_APK_BYTES = 256 * 1024 * 1024;
const MAX_COORDINATE = 100_000;

export interface AndroidToolchain {
	adb: string[] | null;
	emulator: string[] | null;
	sdkRoot?: string;
}

interface ActiveEmulator {
	avdName: string;
	serial: string;
	process: ReturnType<typeof Bun.spawn>;
	state: AndroidEmulatorState;
	lastActivityAt: number;
	exited: boolean;
}

interface PendingStart {
	avdName: string;
	controller: AbortController;
	promise: Promise<AndroidEmulatorStatus>;
}

function executableAt(root: string, path: string): string[] | null {
	const base = join(root, path);
	const candidates = process.platform === "win32" ? [base, `${base}.exe`] : [base];
	const executable = candidates.find((candidate) => existsSync(candidate));
	return executable ? [executable] : null;
}

function sdkRootFromEnvironment(): string | undefined {
	const suffix =
		process.platform === "darwin"
			? ["Library", "Android", "sdk"]
			: process.platform === "win32"
				? ["AppData", "Local", "Android", "Sdk"]
				: ["Android", "Sdk"];
	const candidates = [
		process.env.ANDROID_SDK_ROOT,
		process.env.ANDROID_HOME,
		join(homedir(), ...suffix),
	].filter((candidate): candidate is string => Boolean(candidate));
	return candidates.find((candidate) => existsSync(candidate));
}

export function resolveAndroidToolchain(): AndroidToolchain {
	const sdkRoot = sdkRootFromEnvironment();
	const adbFromSdk = sdkRoot ? executableAt(sdkRoot, join("platform-tools", "adb")) : null;
	const adbFromPath = Bun.which("adb");
	const adb = adbFromSdk ?? (adbFromPath ? [adbFromPath] : null);
	const emulatorFromSdk = sdkRoot ? executableAt(sdkRoot, join("emulator", "emulator")) : null;
	const emulatorFromPath = Bun.which("emulator");
	const emulator = emulatorFromSdk ?? (emulatorFromPath ? [emulatorFromPath] : null);
	return { adb, emulator, ...(sdkRoot ? { sdkRoot } : {}) };
}

function isWithin(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function parseEmulatorPorts(output: string): Set<number> {
	const ports = new Set<number>();
	for (const line of output.split(/\r?\n/)) {
		const match = line.match(/^emulator-(\d{4,5})\s/);
		if (match) ports.add(Number(match[1]));
	}
	return ports;
}

function checkPng(bytes: Uint8Array): { width: number; height: number } {
	const signature = [137, 80, 78, 71, 13, 10, 26, 10];
	if (bytes.byteLength < 24 || signature.some((byte, index) => bytes[index] !== byte)) {
		throw new Error("The Android emulator did not return a valid screenshot.");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const width = view.getUint32(16, false);
	const height = view.getUint32(20, false);
	if (width < 1 || height < 1 || width > 8192 || height > 8192) {
		throw new Error("The Android emulator returned an unsupported screen size.");
	}
	return { width, height };
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function boundedLines(value: number | undefined): number {
	if (value === undefined) return 200;
	if (!Number.isInteger(value) || value < 1 || value > 1000) {
		throw new Error("Log line count must be between 1 and 1000.");
	}
	return value;
}

function coordinate(value: number): string {
	if (!Number.isInteger(value) || value < 0 || value > MAX_COORDINATE) {
		throw new Error("Screen coordinates must be non-negative whole numbers.");
	}
	return String(value);
}

export class AndroidEmulatorManager {
	private readonly toolchain: AndroidToolchain;
	private readonly idleTtlMs: number;
	private active: ActiveEmulator | undefined;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingStart: PendingStart | undefined;
	private stopPromise: Promise<AndroidEmulatorStatus> | undefined;

	constructor(options: { toolchain?: AndroidToolchain; idleTtlMs?: number } = {}) {
		this.toolchain = options.toolchain ?? resolveAndroidToolchain();
		this.idleTtlMs = options.idleTtlMs ?? ANDROID_EMULATOR_IDLE_TTL_MS;
	}

	async listAvds(signal?: AbortSignal): Promise<string[]> {
		const emulator = this.requireEmulator();
		const result = await runBounded([...emulator, "-list-avds"], {
			timeoutMs: 10_000,
			maxOutputBytes: 64 * 1024,
			...(signal ? { signal } : {}),
		});
		if (!result.ok || result.truncated) {
			throw new Error("Could not list Android virtual devices. Check the local Android SDK.");
		}
		return [
			...new Set(
				result.out
					.split(/\r?\n/)
					.map((name) => name.trim())
					.filter((name) => AVD_NAME.test(name)),
			),
		];
	}

	async status(): Promise<AndroidEmulatorStatus> {
		const issue = this.toolchainIssue();
		const active = this.active;
		if (active && !active.exited && active.state === "starting") {
			const deviceState = await this.adbText(active.serial, ["get-state"], 3000, 4096);
			if (deviceState === "device") {
				const bootComplete = await this.adbText(
					active.serial,
					["shell", "getprop", "sys.boot_completed"],
					3000,
					4096,
				);
				if (bootComplete === "1") active.state = "running";
			}
		}
		const current = this.active;
		return {
			available: issue === undefined,
			...(issue ? { issue } : {}),
			state: current && !current.exited ? current.state : "stopped",
			...(current && !current.exited
				? {
						avdName: current.avdName,
						serial: current.serial,
						lastActivityAt: current.lastActivityAt,
						idleRemainingMs: Math.max(0, this.idleTtlMs - (Date.now() - current.lastActivityAt)),
					}
				: {}),
			idleTtlMs: this.idleTtlMs,
		};
	}

	start(avdName: string): Promise<AndroidEmulatorStatus> {
		if (this.stopPromise) return this.stopPromise.then(() => this.start(avdName));
		const pending = this.pendingStart;
		if (pending) {
			return pending.avdName === avdName
				? pending.promise
				: Promise.reject(new Error("Stop the current ThinkRail emulator before starting another."));
		}
		const controller = new AbortController();
		const promise = this.startInternal(avdName, controller.signal).finally(() => {
			if (this.pendingStart?.promise === promise) this.pendingStart = undefined;
		});
		this.pendingStart = { avdName, controller, promise };
		return promise;
	}

	private async startInternal(
		avdName: string,
		signal: AbortSignal,
	): Promise<AndroidEmulatorStatus> {
		const adb = this.requireAdb();
		const emulator = this.requireEmulator();
		if (!AVD_NAME.test(avdName) || !(await this.listAvds(signal)).includes(avdName)) {
			throw new Error("Choose an Android virtual device from the available AVD list.");
		}
		if (signal.aborted) return this.status();
		if (this.active && !this.active.exited) {
			if (this.active.avdName === avdName) return this.status();
			throw new Error("Stop the current ThinkRail emulator before starting another.");
		}
		const devices = await runBounded([...adb, "devices", "-l"], {
			timeoutMs: 5000,
			maxOutputBytes: 64 * 1024,
			signal,
		});
		if (!devices.ok || devices.truncated) {
			throw new Error("Could not safely inspect Android emulator ports.");
		}
		if (signal.aborted) return this.status();
		const occupied = parseEmulatorPorts(devices.out);
		let port: number | undefined;
		for (let candidate = 5554; candidate <= MAX_PORT; candidate += 2) {
			if (!occupied.has(candidate)) {
				port = candidate;
				break;
			}
		}
		if (port === undefined) throw new Error("No Android emulator port is available.");
		const args = [
			...emulator,
			`@${avdName}`,
			"-port",
			String(port),
			"-no-window",
			"-no-audio",
			"-no-boot-anim",
			"-no-snapshot-save",
		];
		let child: ReturnType<typeof Bun.spawn>;
		try {
			child = Bun.spawn(args, {
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
				windowsHide: true,
			});
		} catch {
			throw new Error("Could not start the Android emulator. Check the local SDK installation.");
		}
		const active: ActiveEmulator = {
			avdName,
			serial: `emulator-${port}`,
			process: child,
			state: "starting",
			lastActivityAt: Date.now(),
			exited: false,
		};
		this.active = active;
		void child.exited.then(() => {
			active.exited = true;
			this.clearIdleTimer();
			if (this.active === active) this.active = undefined;
		});
		this.scheduleIdleStop(active);
		return this.status();
	}

	stop(): Promise<AndroidEmulatorStatus> {
		if (this.stopPromise) return this.stopPromise;
		const pending = this.pendingStart;
		pending?.controller.abort();
		let stopping: Promise<AndroidEmulatorStatus>;
		stopping = (async () => {
			if (pending) await pending.promise.catch(() => {});
			return this.stopActive();
		})().finally(() => {
			if (this.stopPromise === stopping) this.stopPromise = undefined;
		});
		this.stopPromise = stopping;
		return stopping;
	}

	private async stopActive(): Promise<AndroidEmulatorStatus> {
		const active = this.active;
		if (!active || active.exited) {
			this.active = undefined;
			return this.status();
		}
		this.clearIdleTimer();
		active.state = "stopping";
		if (this.toolchain.adb && EMULATOR_SERIAL.test(active.serial)) {
			try {
				await runBounded([...this.toolchain.adb, "-s", active.serial, "emu", "kill"], {
					timeoutMs: 5000,
					maxOutputBytes: 4096,
				});
			} catch {}
		}
		try {
			active.process.kill("SIGTERM");
		} catch {}
		const exited = await this.waitForExit(active.process, 3000);
		if (!exited) {
			try {
				active.process.kill("SIGKILL");
			} catch {}
			await this.waitForExit(active.process, 1500);
		}
		if (this.active === active) this.active = undefined;
		return this.status();
	}

	async dispose(): Promise<void> {
		await this.stop();
	}

	async details(): Promise<AndroidEmulatorDetails> {
		const active = await this.requireRunning();
		this.touch(active);
		const [manufacturer, model, androidVersion, apiLevel, size, density] = await Promise.all([
			this.adbText(active.serial, ["shell", "getprop", "ro.product.manufacturer"]),
			this.adbText(active.serial, ["shell", "getprop", "ro.product.model"]),
			this.adbText(active.serial, ["shell", "getprop", "ro.build.version.release"]),
			this.adbText(active.serial, ["shell", "getprop", "ro.build.version.sdk"]),
			this.adbText(active.serial, ["shell", "wm", "size"]),
			this.adbText(active.serial, ["shell", "wm", "density"]),
		]);
		const resolution = size?.match(/(?:Physical|Override) size:\s*(\d+x\d+)/)?.[1];
		const densityDpi = density?.match(/(?:Physical|Override) density:\s*(\d+)/)?.[1];
		return {
			...(manufacturer ? { manufacturer } : {}),
			...(model ? { model } : {}),
			...(androidVersion ? { androidVersion } : {}),
			...(apiLevel ? { apiLevel } : {}),
			...(resolution ? { resolution } : {}),
			...(densityDpi ? { densityDpi } : {}),
		};
	}

	async screenshot(): Promise<AndroidEmulatorScreenshot> {
		const active = await this.requireRunning();
		this.touch(active);
		const result = await runBounded(
			[...this.requireAdb(), "-s", active.serial, "exec-out", "screencap", "-p"],
			{
				timeoutMs: 15_000,
				stdout: "bytes",
				maxOutputBytes: MAX_SCREENSHOT_BYTES,
			},
		);
		if (!result.ok || result.truncated) {
			throw new Error("Could not capture a complete Android emulator screenshot.");
		}
		const { width, height } = checkPng(result.out);
		return {
			mimeType: "image/png",
			data: Buffer.from(result.out).toString("base64"),
			width,
			height,
		};
	}

	async tap(x: number, y: number): Promise<void> {
		const active = await this.requireRunning();
		this.touch(active);
		await this.runDeviceAction(active.serial, [
			"shell",
			"input",
			"tap",
			coordinate(x),
			coordinate(y),
		]);
	}

	async typeText(text: string): Promise<void> {
		if (
			typeof text !== "string" ||
			text.length < 1 ||
			text.length > 2000 ||
			text.includes("%") ||
			[...text].some((character) => {
				const codePoint = character.codePointAt(0) ?? 0;
				return codePoint <= 0x1f || codePoint === 0x7f;
			})
		) {
			throw new Error(
				"Text must be 1–2000 characters without control characters or percent signs.",
			);
		}
		const active = await this.requireRunning();
		this.touch(active);
		const encoded = text.replaceAll(" ", "%s");
		await this.runDeviceAction(active.serial, ["shell", "input", "text", shellQuote(encoded)]);
	}

	async swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 300): Promise<void> {
		if (!Number.isInteger(durationMs) || durationMs < 50 || durationMs > 10_000) {
			throw new Error("Swipe duration must be between 50 and 10000 milliseconds.");
		}
		const active = await this.requireRunning();
		this.touch(active);
		await this.runDeviceAction(active.serial, [
			"shell",
			"input",
			"swipe",
			coordinate(x1),
			coordinate(y1),
			coordinate(x2),
			coordinate(y2),
			String(durationMs),
		]);
	}

	async installApk(workspaceRoot: string, workspacePath: string): Promise<void> {
		if (
			typeof workspacePath !== "string" ||
			workspacePath.length === 0 ||
			workspacePath.length > 1000 ||
			workspacePath.includes("\0") ||
			isAbsolute(workspacePath)
		) {
			throw new Error("Choose an APK using a relative path inside the active workspace.");
		}
		let apkPath: string;
		try {
			const root = await realpath(workspaceRoot);
			const candidate = resolve(root, workspacePath);
			if (!isWithin(root, candidate)) {
				throw new Error("outside");
			}
			apkPath = await realpath(candidate);
			if (!isWithin(root, apkPath)) throw new Error("outside");
			const info = await stat(apkPath);
			if (
				!info.isFile() ||
				extname(apkPath).toLowerCase() !== ".apk" ||
				info.size > MAX_APK_BYTES
			) {
				throw new Error("invalid");
			}
		} catch {
			throw new Error("APK must be a regular file up to 256 MiB inside the active workspace.");
		}
		const active = await this.requireRunning();
		this.touch(active);
		const result = await runBounded(
			[...this.requireAdb(), "-s", active.serial, "install", "-r", apkPath],
			{ timeoutMs: 120_000, maxOutputBytes: 16 * 1024 },
		);
		if (!result.ok || result.truncated) {
			throw new Error("Android rejected the APK. Check its compatibility and installation state.");
		}
	}

	async logs(lines?: number): Promise<AndroidEmulatorLogs> {
		const active = await this.requireRunning();
		this.touch(active);
		const result = await runBounded(
			[
				...this.requireAdb(),
				"-s",
				active.serial,
				"logcat",
				"-d",
				"-t",
				String(boundedLines(lines)),
			],
			{ timeoutMs: 10_000, maxOutputBytes: MAX_LOG_BYTES },
		);
		if (!result.ok && !result.truncated) {
			throw new Error("Could not read Android emulator logs.");
		}
		return { text: result.out, truncated: result.truncated === true };
	}

	private toolchainIssue(): AndroidEmulatorStatus["issue"] {
		if (!this.toolchain.adb && !this.toolchain.emulator && !this.toolchain.sdkRoot) {
			return "sdk-not-found";
		}
		if (!this.toolchain.adb) return "adb-not-found";
		if (!this.toolchain.emulator) return "emulator-not-found";
		return undefined;
	}

	private requireAvailable(): void {
		if (this.toolchainIssue()) {
			throw new Error(
				"Android SDK tools are unavailable. Install/configure the local Android SDK.",
			);
		}
	}

	private requireAdb(): string[] {
		const adb = this.toolchain.adb;
		if (!adb) throw new Error("Android ADB is unavailable.");
		return adb;
	}

	private requireEmulator(): string[] {
		const emulator = this.toolchain.emulator;
		if (!emulator) throw new Error("The Android emulator executable is unavailable.");
		return emulator;
	}

	private async requireRunning(): Promise<ActiveEmulator> {
		this.requireAvailable();
		const active = this.active;
		if (!active || active.exited || active.state === "stopping") {
			throw new Error("Start an Android emulator in ThinkRail before using device controls.");
		}
		const status = await this.status();
		if (status.state !== "running") {
			throw new Error("The Android emulator is still starting. Try again when it is ready.");
		}
		return active;
	}

	private async runDeviceAction(serial: string, args: string[]): Promise<void> {
		const result = await runBounded([...this.requireAdb(), "-s", serial, ...args], {
			timeoutMs: 10_000,
			maxOutputBytes: 16 * 1024,
		});
		if (!result.ok || result.truncated) {
			throw new Error("The Android emulator did not accept that device action.");
		}
	}

	private async adbText(
		serial: string,
		args: string[],
		timeoutMs = 5000,
		maxOutputBytes = 16 * 1024,
	): Promise<string | null> {
		if (!this.toolchain.adb || !EMULATOR_SERIAL.test(serial)) return null;
		const result = await runBounded([...this.toolchain.adb, "-s", serial, ...args], {
			timeoutMs,
			maxOutputBytes,
		});
		return result.ok && !result.truncated ? result.out.trim() : null;
	}

	private touch(active: ActiveEmulator): void {
		active.lastActivityAt = Date.now();
		this.scheduleIdleStop(active);
	}

	private scheduleIdleStop(active: ActiveEmulator): void {
		this.clearIdleTimer();
		this.idleTimer = setTimeout(() => {
			if (this.active === active && !active.exited) void this.stop().catch(() => {});
		}, this.idleTtlMs);
		this.idleTimer.unref();
	}

	private clearIdleTimer(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
	}

	private async waitForExit(
		child: ReturnType<typeof Bun.spawn>,
		timeoutMs: number,
	): Promise<boolean> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				child.exited.then(() => true),
				new Promise<boolean>((resolvePromise) => {
					timer = setTimeout(() => resolvePromise(false), timeoutMs);
					timer.unref();
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
}

let sharedManager: AndroidEmulatorManager | undefined;

export function getAndroidEmulatorManager(): AndroidEmulatorManager {
	sharedManager ??= new AndroidEmulatorManager();
	return sharedManager;
}

export async function stopAndroidEmulatorManager(): Promise<void> {
	const manager = sharedManager;
	sharedManager = undefined;
	if (manager) await manager.dispose();
}
