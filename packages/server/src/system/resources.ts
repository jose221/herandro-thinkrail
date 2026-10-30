import { availableParallelism, freemem, loadavg, totalmem } from "node:os";
import { basename } from "node:path";
import {
	type MonitoredProcess,
	type MonitoredProcessKind,
	SYSTEM_MONITOR_LIMITS,
	type SystemResourceSnapshot,
} from "@thinkrail/contracts";
import { listProjects } from "../projects";
import { runBounded } from "../subprocess";
import { listWorkspaceRecords } from "../workspaces";

const SAMPLE_TIMEOUT_MS = 4_000;
const SAMPLE_CACHE_MS = 1_000;

const DEV_SERVER = [
	/\bvite\b/i,
	/\bnext(?:-server)?\b/i,
	/\bng\s+serve\b/i,
	/\bwebpack\b/i,
	/\bturbo\b.*\bdev\b/i,
	/\bbun\s+(?:run\s+)?dev\b/i,
	/\buvicorn\b/i,
	/\bgunicorn\b/i,
	/\bflask\s+run\b/i,
	/\bmanage\.py\s+runserver\b/i,
	/\bgo\s+run\b/i,
	/\bcargo\s+run\b/i,
];

const ANDROID = [/\bqemu-system\b/i, /\bemulator\b/i, /\badb\b/i];

interface WorkspaceRoot {
	id: string;
	path: string;
}

interface CachedSample {
	at: number;
	processes: MonitoredProcess[];
	supported: boolean;
	note?: string;
}

let cached: CachedSample | null = null;
let inflight: Promise<CachedSample> | null = null;

function parseElapsed(value: string): number {
	const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value);
	if (!match) return 0;
	const days = Number(match[1] ?? 0);
	const hours = Number(match[2] ?? 0);
	const minutes = Number(match[3] ?? 0);
	const seconds = Number(match[4] ?? 0);
	return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

function processName(comm: string, args: string): string {
	const fromArgs = args.trim().split(/\s+/)[0];
	const candidate = (fromArgs || comm).trim() || "process";
	return basename(candidate).slice(0, 120);
}

function kindFor(pid: number, name: string, command: string): MonitoredProcessKind {
	if (pid === process.pid) return "host";
	if (ANDROID.some((pattern) => pattern.test(command) || pattern.test(name))) return "android";
	if (DEV_SERVER.some((pattern) => pattern.test(command))) return "dev-server";
	if (pid !== process.pid && command.length === 0) return "other";
	return "other";
}

const SECRET_FLAG =
	/((?:^|\s)--?(?:token|api[-_]?key|secret|password|authorization)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi;
const SECRET_QUERY = /([?&](?:token|api[-_]?key|secret|password|authorization)=)[^&\s]+/gi;
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;

function redactCommand(command: string): string {
	return command
		.replace(SECRET_FLAG, "$1[redacted]")
		.replace(SECRET_QUERY, "$1[redacted]")
		.replace(BEARER, "$1[redacted]");
}

function workspaceRoots(): WorkspaceRoot[] {
	const roots: WorkspaceRoot[] = [];
	for (const project of listProjects()) {
		for (const workspace of listWorkspaceRecords(project.id)) {
			if (workspace.worktreePath) roots.push({ id: workspace.id, path: workspace.worktreePath });
		}
	}
	return roots;
}

export function parsePs(output: string): MonitoredProcess[] {
	const processes: MonitoredProcess[] = [];
	for (const line of output.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(\S+)\s?(.*)$/.exec(line);
		if (!match) continue;
		const pid = Number(match[1]);
		const ppid = Number(match[2]);
		const rssKb = Number(match[3]);
		const cpu = Number(match[4]);
		if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
		const args = (match[7] ?? "").trim();
		const name = processName(match[6] ?? "", args);
		processes.push({
			pid,
			ppid,
			name,
			command: args.slice(0, SYSTEM_MONITOR_LIMITS.commandChars),
			rssBytes: Math.max(0, Math.round(rssKb * 1024)),
			cpuPercent: Number.isFinite(cpu) ? Math.max(0, Math.round(cpu * 10) / 10) : 0,
			elapsedSeconds: parseElapsed(match[5] ?? ""),
			kind: kindFor(pid, name, args),
		});
	}
	return processes;
}

async function collect(): Promise<CachedSample> {
	const at = Date.now();
	if (process.platform === "win32") {
		return {
			at,
			processes: [],
			supported: false,
			note: "Process sampling is not implemented on Windows yet.",
		};
	}
	const argv =
		process.platform === "darwin"
			? ["ps", "-axo", "pid=,ppid=,rss=,pcpu=,etime=,comm=,args=", "-ww"]
			: ["ps", "-eo", "pid=,ppid=,rss=,pcpu=,etime=,comm=,args="];
	const result = await runBounded(argv, {
		timeoutMs: SAMPLE_TIMEOUT_MS,
		maxOutputBytes: 4 * 1024 * 1024,
	});
	if (!result.ok) {
		return { at, processes: [], supported: false, note: "Could not read the process table." };
	}
	const roots = workspaceRoots();
	const processes = parsePs(result.out).map((entry) => {
		const root = roots.find((candidate) => entry.command.includes(candidate.path));
		const kind: MonitoredProcessKind =
			entry.kind === "host"
				? "host"
				: entry.kind === "android"
					? "android"
					: entry.kind === "dev-server"
						? "dev-server"
						: entry.ppid === process.pid
							? "terminal"
							: "other";
		return {
			...entry,
			kind,
			command: redactCommand(entry.command),
			...(root ? { workspaceId: root.id } : {}),
		};
	});
	return { at, processes, supported: true };
}

async function sample(): Promise<CachedSample> {
	if (cached && Date.now() - cached.at < SAMPLE_CACHE_MS) return cached;
	if (inflight) return inflight;
	inflight = collect()
		.then((value) => {
			cached = value;
			return value;
		})
		.finally(() => {
			inflight = null;
		});
	return inflight;
}

export async function systemResourceSnapshot(
	workspaceId?: string,
): Promise<SystemResourceSnapshot> {
	const sampleResult = await sample();
	const processes = sampleResult.processes
		.filter(
			(entry) =>
				workspaceId === undefined ||
				entry.workspaceId === workspaceId ||
				entry.kind === "host" ||
				entry.kind === "android",
		)
		.sort((a, b) => {
			const rank = (entry: MonitoredProcess) =>
				entry.kind === "host" ? 0 : entry.workspaceId ? 1 : entry.kind === "dev-server" ? 2 : 3;
			const delta = rank(a) - rank(b);
			return delta === 0 ? b.rssBytes - a.rssBytes : delta;
		})
		.slice(0, SYSTEM_MONITOR_LIMITS.processes);
	const total = totalmem();
	const free = freemem();
	return {
		at: sampleResult.at,
		supported: sampleResult.supported,
		...(sampleResult.note ? { note: sampleResult.note } : {}),
		host: {
			totalBytes: total,
			freeBytes: free,
			usedBytes: Math.max(0, total - free),
			cpuCount: availableParallelism(),
			loadAverage: loadavg(),
			rssBytes: process.memoryUsage.rss(),
		},
		processes,
	};
}

export function __resetSystemSampleForTests(): void {
	cached = null;
	inflight = null;
}
