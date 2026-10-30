import { expect, test } from "bun:test";
import type { MemoryCheckpoint } from "@thinkrail/contracts";
import { analyzeCheckpoints } from "./checkpoints";
import { parsePs } from "./resources";

const PS = [
	"    1     0   6688   0.9 10:43:56 /sbin/launchd    /sbin/launchd",
	"  161   133  37696   0.0    07:22 /Users/joseangel node /tmp/app/server.js --port 3000",
	"  320     1   9552   0.4 10:43:39 /opt/homebrew/bin/bun bun run dev",
].join("\n");

test("ps rows become processes with readable names and elapsed seconds", () => {
	const processes = parsePs(PS);
	expect(processes).toHaveLength(3);
	expect(processes[0]).toMatchObject({ pid: 1, ppid: 0, name: "launchd", rssBytes: 6_688 * 1024 });
	expect(processes[1]?.name).toBe("node");
	expect(processes[1]?.elapsedSeconds).toBe(7 * 60 + 22);
	expect(processes[2]?.elapsedSeconds).toBe(10 * 3600 + 43 * 60 + 39);
});

function checkpoint(
	at: number,
	processes: Array<{ pid: number; name: string; rssBytes: number }>,
): MemoryCheckpoint {
	return {
		id: String(at),
		at,
		tag: String(at),
		totalRssBytes: processes.reduce((sum, entry) => sum + entry.rssBytes, 0),
		processes: processes.map((entry) => ({ ...entry, key: `${entry.pid}:${entry.name}` })),
	};
}

test("leak analysis distinguishes healthy growth from a sustained leak", () => {
	const healthy = analyzeCheckpoints([
		checkpoint(1, [{ pid: 10, name: "vite", rssBytes: 100 * 1024 * 1024 }]),
		checkpoint(2, [{ pid: 10, name: "vite", rssBytes: 102 * 1024 * 1024 }]),
	]);
	expect(healthy.verdict).toBe("HEALTHY");
	expect(healthy.suspects).toEqual([]);

	const leaking = analyzeCheckpoints([
		checkpoint(1, [{ pid: 10, name: "vite", rssBytes: 100 * 1024 * 1024 }]),
		checkpoint(2, [{ pid: 10, name: "vite", rssBytes: 130 * 1024 * 1024 }]),
		checkpoint(3, [{ pid: 10, name: "vite", rssBytes: 180 * 1024 * 1024 }]),
	]);
	expect(leaking.verdict).toBe("LEAK_DETECTED");
	expect(leaking.suspects[0]).toMatchObject({
		pid: 10,
		name: "vite",
		deltaBytes: 80 * 1024 * 1024,
	});
	expect(leaking.recommendations.length).toBeGreaterThan(0);
});

test("analysis asks for two checkpoints when there is not enough evidence", async () => {
	const analysis = await analyzeCheckpoints([]);
	expect(analysis.verdict).toBe("HEALTHY");
	expect(analysis.summary).toContain("two checkpoints");
});
