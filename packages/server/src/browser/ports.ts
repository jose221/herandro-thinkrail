import type { DevServerFramework, DevServerPort } from "@thinkrail/contracts";
import { runBounded } from "../subprocess";

const COMMAND_TIMEOUT_MS = 4_000;
const MAX_OUTPUT_BYTES = 512 * 1024;
const RESERVED_PORTS = new Set([
	22, 80, 443, 2019, 2375, 2376, 3306, 4180, 4181, 4182, 5432, 6379, 9999, 27017, 34100, 34200,
]);

const NON_DEV_PROCESSES = new Set([
	"ControlCenter",
	"rapportd",
	"sharingd",
	"identityservicesd",
	"adb",
	"ollama",
]);

const FRAMEWORK_PORTS: Readonly<Record<number, DevServerFramework>> = {
	3000: "next",
	4200: "angular",
	4173: "vite",
	5173: "vite",
	5174: "vite",
	6006: "storybook",
	8000: "fastapi",
	8001: "fastapi",
	5000: "flask",
	8080: "go",
	1420: "node",
};

const FRAMEWORK_COMMANDS: readonly [RegExp, DevServerFramework][] = [
	[/\bvite\b/, "vite"],
	[/\bnext(?:-server)?\b/, "next"],
	[/\bng\s+serve\b|\bangular\b/, "angular"],
	[/\bstorybook\b/, "storybook"],
	[/\buvicorn\b|\bhypercorn\b/, "fastapi"],
	[/\bflask\b/, "flask"],
	[/\bdjango\b|\bmanage\.py\s+runserver\b/, "django"],
	[/\bgo\s+run\b|\bair\b|\bgolang\b/, "go"],
	[/\bcargo\s+run\b|\btrunk\s+serve\b/, "rust"],
];

export function frameworkFor(port: number, command: string): DevServerFramework {
	for (const [pattern, framework] of FRAMEWORK_COMMANDS) {
		if (pattern.test(command)) return framework;
	}
	return FRAMEWORK_PORTS[port] ?? "other";
}

export function localPort(address: string): number | null {
	const match = /^(?:\*|0\.0\.0\.0|127\.0\.0\.1|\[::1\]|\[::\]|localhost)[:.](\d{1,5})$/.exec(
		address.trim(),
	);
	if (!match) return null;
	const port = Number(match[1]);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
	if (port < 1024 || RESERVED_PORTS.has(port)) return null;
	return port;
}

interface RawListener {
	port: number;
	process: string;
	pid?: number;
}

export function parseLsof(output: string): RawListener[] {
	const listeners: RawListener[] = [];
	let pid: number | undefined;
	let process = "";
	for (const line of output.split("\n")) {
		if (line.startsWith("p")) {
			const value = Number(line.slice(1));
			pid = Number.isInteger(value) && value > 0 ? value : undefined;
			process = "";
			continue;
		}
		if (line.startsWith("c")) {
			process = line.slice(1).trim().slice(0, 120);
			continue;
		}
		if (!line.startsWith("n")) continue;
		const port = localPort(line.slice(1));
		if (port !== null) listeners.push({ port, process, ...(pid ? { pid } : {}) });
	}
	return listeners;
}

/** Parses Linux `ss -ltnpH`; the local address lives in the fourth column. */
export function parseSs(output: string): RawListener[] {
	const listeners: RawListener[] = [];
	for (const line of output.split("\n")) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 4) continue;
		const port = localPort(parts[3] ?? "");
		if (port === null) continue;
		const users = /"([^"]+)",pid=(\d+)/.exec(line);
		const pid = users?.[2] ? Number(users[2]) : undefined;
		listeners.push({
			port,
			process: users?.[1] ?? "",
			...(pid && Number.isInteger(pid) ? { pid } : {}),
		});
	}
	return listeners;
}

/** Parses Windows `netstat -ano`; the local address is the second column and the PID the last one. */
export function parseNetstat(output: string): RawListener[] {
	const listeners: RawListener[] = [];
	for (const line of output.split("\n")) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 5 || !/^TCP$/i.test(parts[0] ?? "")) continue;
		if (!/LISTENING/i.test(parts[3] ?? "")) continue;
		const port = localPort(parts[1] ?? "");
		if (port === null) continue;
		const pid = Number(parts.at(-1));
		listeners.push({
			port,
			process: "",
			...(Number.isInteger(pid) && pid > 0 ? { pid } : {}),
		});
	}
	return listeners;
}

export function dedupe(listeners: RawListener[]): DevServerPort[] {
	const byPort = new Map<number, RawListener>();
	for (const listener of listeners) {
		const current = byPort.get(listener.port);
		if (!current || (current.process === "" && listener.process !== "")) {
			byPort.set(listener.port, listener);
		}
	}
	return [...byPort.values()]
		.filter((listener) => !NON_DEV_PROCESSES.has(listener.process))
		.map((listener) => ({
			port: listener.port,
			url: `http://localhost:${listener.port}/`,
			process: listener.process || "unknown",
			...(listener.pid ? { pid: listener.pid } : {}),
			framework: frameworkFor(listener.port, listener.process),
		}))
		.sort((a, b) => a.port - b.port);
}

async function run(argv: string[]): Promise<string | null> {
	if (!Bun.which(argv[0] ?? "")) return null;
	const result = await runBounded(argv, {
		timeoutMs: COMMAND_TIMEOUT_MS,
		maxOutputBytes: MAX_OUTPUT_BYTES,
	});
	return result.ok ? result.out : null;
}

/** Lists local development listeners. Uses lsof when present and platform tools elsewhere; never probes ports. */
export async function listDevServerPorts(): Promise<DevServerPort[]> {
	const lsof = await run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]);
	if (lsof !== null) return dedupe(parseLsof(lsof));
	if (Bun.which("ss")) {
		const ss = await run(["ss", "-ltnpH"]);
		if (ss !== null) return dedupe(parseSs(ss));
	}
	if (process.platform === "win32") {
		const netstat = await run(["netstat", "-ano"]);
		if (netstat !== null) return dedupe(parseNetstat(netstat));
	}
	return [];
}
