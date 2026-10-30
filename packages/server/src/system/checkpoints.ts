import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type MemoryAnalysis,
	type MemoryCheckpoint,
	type MemoryLeakSuspect,
	SYSTEM_MONITOR_LIMITS,
} from "@thinkrail/contracts";
import { dataDir } from "../persistence";
import { systemResourceSnapshot } from "./resources";

const STORE_FILE = "memory-checkpoints.json";
const STORE_VERSION = 1;
const MAX_CHECKPOINT_PROCESSES = 120;

interface Stored {
	version: number;
	checkpoints: MemoryCheckpoint[];
}

let state: Stored | null = null;
let writes: Promise<void> = Promise.resolve();

function read(): Stored {
	if (state) return state;
	try {
		const parsed = JSON.parse(readFileSync(join(dataDir(), STORE_FILE), "utf8")) as Partial<Stored>;
		state = {
			version: STORE_VERSION,
			checkpoints: Array.isArray(parsed.checkpoints)
				? parsed.checkpoints.filter(
						(entry): entry is MemoryCheckpoint =>
							!!entry && typeof entry.id === "string" && Array.isArray(entry.processes),
					)
				: [],
		};
	} catch {
		state = { version: STORE_VERSION, checkpoints: [] };
	}
	return state;
}

function persist(): void {
	const snapshot = read();
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

function trim(value: string, max: number): string {
	return value.length > max ? value.slice(0, max) : value;
}

export async function captureMemoryCheckpoint(input: {
	workspaceId?: string;
	tag: string;
	description?: string;
}): Promise<MemoryCheckpoint> {
	const tag = trim(typeof input.tag === "string" ? input.tag.trim() : "", 120);
	if (tag.length === 0) throw new Error("A checkpoint needs a tag");
	const snapshot = await systemResourceSnapshot(input.workspaceId);
	const processes = snapshot.processes
		.slice()
		.sort((a, b) => b.rssBytes - a.rssBytes)
		.slice(0, MAX_CHECKPOINT_PROCESSES)
		.map((entry) => ({
			key: `${entry.pid}:${entry.name}`,
			pid: entry.pid,
			name: entry.name,
			rssBytes: entry.rssBytes,
		}));
	const checkpoint: MemoryCheckpoint = {
		id: randomUUID(),
		at: Date.now(),
		tag,
		...(input.description?.trim() ? { description: trim(input.description.trim(), 500) } : {}),
		...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
		totalRssBytes: snapshot.processes.reduce((sum, entry) => sum + entry.rssBytes, 0),
		processes,
	};
	const current = read();
	current.checkpoints.unshift(checkpoint);
	current.checkpoints = current.checkpoints.slice(0, SYSTEM_MONITOR_LIMITS.checkpoints);
	persist();
	return checkpoint;
}

export function listMemoryCheckpoints(workspaceId?: string): MemoryCheckpoint[] {
	return read().checkpoints.filter(
		(entry) => workspaceId === undefined || entry.workspaceId === workspaceId,
	);
}

export function clearMemoryCheckpoints(): void {
	const current = read();
	current.checkpoints = [];
	persist();
}

export async function analyzeMemory(workspaceId?: string): Promise<MemoryAnalysis> {
	return analyzeCheckpoints(listMemoryCheckpoints(workspaceId));
}

export function analyzeCheckpoints(checkpointsInput: MemoryCheckpoint[]): MemoryAnalysis {
	const checkpoints = checkpointsInput.slice().sort((a, b) => a.at - b.at);
	if (checkpoints.length < 2) {
		return {
			verdict: "HEALTHY",
			summary:
				"Capture at least two checkpoints around a workload to compare process memory over time.",
			recommendations: [
				"Capture a baseline while idle, run the workload, then capture a second checkpoint.",
			],
			suspects: [],
			checkedAt: Date.now(),
		};
	}
	const first = checkpoints[0];
	const last = checkpoints[checkpoints.length - 1];
	if (!first || !last) throw new Error("Memory checkpoints are unavailable");
	const starts = new Map(first.processes.map((entry) => [entry.key, entry.rssBytes]));
	const counts = new Map<string, number>();
	for (const checkpoint of checkpoints) {
		for (const entry of checkpoint.processes) {
			counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1);
		}
	}
	const suspects: MemoryLeakSuspect[] = [];
	for (const entry of last.processes) {
		const start = starts.get(entry.key);
		if (start === undefined || (counts.get(entry.key) ?? 0) < 2) continue;
		const deltaBytes = entry.rssBytes - start;
		const growthPercent = start > 0 ? (deltaBytes / start) * 100 : 0;
		if (
			deltaBytes >= SYSTEM_MONITOR_LIMITS.suspectGrowthBytes &&
			growthPercent >= SYSTEM_MONITOR_LIMITS.suspectGrowthPercent
		) {
			suspects.push({
				pid: entry.pid,
				name: entry.name,
				deltaBytes,
				growthPercent: Math.round(growthPercent * 10) / 10,
				checkpoints: counts.get(entry.key) ?? 0,
			});
		}
	}
	suspects.sort((a, b) => b.deltaBytes - a.deltaBytes);
	const severe = suspects.some(
		(suspect) => suspect.deltaBytes >= SYSTEM_MONITOR_LIMITS.suspectGrowthBytes * 4,
	);
	const verdict =
		suspects.length === 0
			? "HEALTHY"
			: suspects.length >= 2 || severe
				? "LEAK_DETECTED"
				: "WARNING";
	const spanMinutes = Math.max(1, Math.round((last.at - first.at) / 60_000));
	const summary =
		verdict === "HEALTHY"
			? `Memory stayed within the expected range across ${checkpoints.length} checkpoints (${spanMinutes} min).`
			: verdict === "WARNING"
				? `One process grew beyond the alert threshold across ${checkpoints.length} checkpoints (${spanMinutes} min); confirm whether the growth is a cache or a leak.`
				: `${suspects.length} processes kept growing across ${checkpoints.length} checkpoints (${spanMinutes} min); this pattern is consistent with a memory leak.`;
	const recommendations =
		verdict === "HEALTHY"
			? ["No action needed; keep a checkpoint before and after the next load test."]
			: [
					"Reproduce the workload and capture another checkpoint to confirm the growth is monotonic.",
					"Check listeners, intervals, caches and open handles in the highlighted processes.",
					"Restart only the suspect process to recover memory, then re-measure.",
				];
	return { verdict, summary, recommendations, suspects, checkedAt: Date.now() };
}

export function resetMemoryCheckpointsForTests(): void {
	state = { version: STORE_VERSION, checkpoints: [] };
}

export async function killMonitoredProcess(
	pid: number,
	signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
): Promise<void> {
	if (!Number.isInteger(pid) || pid <= 1) throw new Error("Invalid process id");
	if (pid === process.pid || pid === process.ppid) {
		throw new Error("ThinkRail will not terminate its own host process");
	}
	const snapshot = await systemResourceSnapshot();
	const target = snapshot.processes.find((entry) => entry.pid === pid);
	if (!target) throw new Error("Process is not part of a detected workspace");
	if (!target.workspaceId && target.kind === "other") {
		throw new Error("Only workspace and development processes can be terminated here");
	}
	if (target.kind === "host") throw new Error("ThinkRail will not terminate its own host process");
	process.kill(pid, signal);
}
