import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	analyzeMemory,
	captureMemoryCheckpoint,
	killMonitoredProcess,
	listMemoryCheckpoints,
	systemResourceSnapshot,
} from "../system";
import { workspaceIdAt } from "./workspaceTools";

function json(value: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
		details: value,
	};
}

const TOOL_PROCESSES = 60;
const TOOL_COMMAND_CHARS = 240;

function boundedSnapshot(snapshot: Awaited<ReturnType<typeof systemResourceSnapshot>>) {
	const processes = snapshot.processes.slice(0, TOOL_PROCESSES).map((entry) => ({
		...entry,
		command:
			entry.command.length > TOOL_COMMAND_CHARS
				? `${entry.command.slice(0, TOOL_COMMAND_CHARS)}…`
				: entry.command,
	}));
	return {
		...snapshot,
		processes,
		truncatedProcesses: snapshot.processes.length > TOOL_PROCESSES,
	};
}

export function memoryToolsExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "system_memory_status",
		label: "Memory Status",
		description:
			"Read host memory, CPU load, and workspace processes (RSS, CPU, role, PID). Use it before and after a workload to verify stability.",
		parameters: Type.Object({
			allWorkspaces: Type.Optional(
				Type.Boolean({ description: "Include every workspace. Defaults to the tool's workspace." }),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const workspaceId = params.allWorkspaces ? undefined : workspaceIdAt(ctx.cwd);
			return json(boundedSnapshot(await systemResourceSnapshot(workspaceId)));
		},
	});
	pi.registerTool({
		name: "system_memory_checkpoint",
		label: "Memory Checkpoint",
		description:
			"Capture a named memory checkpoint for the workspace and compare it with earlier points to isolate leaks.",
		parameters: Type.Object({
			tag: Type.String({ minLength: 1, maxLength: 120 }),
			description: Type.Optional(Type.String({ maxLength: 500 })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return json(
				await captureMemoryCheckpoint({
					workspaceId: workspaceIdAt(ctx.cwd),
					tag: params.tag,
					...(params.description ? { description: params.description } : {}),
				}),
			);
		},
	});
	pi.registerTool({
		name: "system_memory_checkpoints",
		label: "Memory Checkpoints",
		description: "List the workspace's memory checkpoints with their captured processes.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			return json(listMemoryCheckpoints(workspaceIdAt(ctx.cwd)));
		},
	});
	pi.registerTool({
		name: "system_memory_analyze",
		label: "Analyze Memory",
		description:
			"Run a heuristic leak analysis over the workspace checkpoints. Returns HEALTHY, WARNING or LEAK_DETECTED with suspects and recommendations.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			return json(await analyzeMemory(workspaceIdAt(ctx.cwd)));
		},
	});
	pi.registerTool({
		name: "system_process_kill",
		label: "Terminate Process",
		description:
			"Terminate one detected workspace or development process by PID. Never targets the ThinkRail host.",
		parameters: Type.Object({
			pid: Type.Integer({ minimum: 2, maximum: 2_147_483_647 }),
			signal: Type.Optional(Type.Union([Type.Literal("SIGTERM"), Type.Literal("SIGKILL")])),
		}),
		async execute(_id, params) {
			await killMonitoredProcess(params.pid, params.signal);
			return json({ ok: true, pid: params.pid });
		},
	});
}
