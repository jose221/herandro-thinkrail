import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	gitControlBranches,
	gitControlCommit,
	gitControlCreateBranch,
	gitControlDiff,
	gitControlFetch,
	gitControlLog,
	gitControlPull,
	gitControlPush,
	gitControlShowCommit,
	gitControlStage,
	gitControlStatus,
	gitControlSwitchBranch,
	gitControlUnstage,
} from "../git";
import { workspaceIdAt } from "./workspaceTools";

const Paths = Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), {
	minItems: 1,
	maxItems: 200,
});

function json(value: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
		details: value,
	};
}

const TOOL_DIFF_CHARS = 40_000;

function boundedDiff(result: Awaited<ReturnType<typeof gitControlDiff>>) {
	if (result.diff.length <= TOOL_DIFF_CHARS) return result;
	return { ...result, diff: result.diff.slice(0, TOOL_DIFF_CHARS), truncated: true };
}

function boundedCommit<T extends { output: string; truncated: boolean }>(result: T): T {
	if (result.output.length <= TOOL_DIFF_CHARS) return result;
	return { ...result, output: result.output.slice(0, TOOL_DIFF_CHARS), truncated: true };
}

export function gitControlToolsExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "git_control_status",
		label: "Git Status",
		description: "Read the active workspace branch and changed files with line counts.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			return json(await gitControlStatus(workspaceIdAt(ctx.cwd)));
		},
	});
	pi.registerTool({
		name: "git_control_branches",
		label: "Git Branches",
		description: "List local and remote branches and the current branch.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			return json(await gitControlBranches(workspaceIdAt(ctx.cwd)));
		},
	});
	pi.registerTool({
		name: "git_control_log",
		label: "Git Log",
		description: "List recent commits in the active workspace.",
		parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return json(await gitControlLog(workspaceIdAt(ctx.cwd), params.limit ?? 30));
		},
	});
	pi.registerTool({
		name: "git_control_diff",
		label: "Git Diff",
		description: "Read the unified diff of one workspace-relative path, staged or unstaged.",
		parameters: Type.Object({
			path: Type.String({ minLength: 1, maxLength: 1_000 }),
			staged: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return json(
				boundedDiff(await gitControlDiff(workspaceIdAt(ctx.cwd), params.path, params.staged)),
			);
		},
	});
	pi.registerTool({
		name: "git_control_stage",
		label: "Stage Files",
		description:
			"Stage workspace-relative paths. Use only when the person asked to prepare a commit.",
		parameters: Type.Object({ paths: Paths }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return json(await gitControlStage(workspaceIdAt(ctx.cwd), params.paths));
		},
	});
	pi.registerTool({
		name: "git_control_unstage",
		label: "Unstage Files",
		description:
			"Remove workspace-relative paths from the index without touching the working tree.",
		parameters: Type.Object({ paths: Paths }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return json(await gitControlUnstage(workspaceIdAt(ctx.cwd), params.paths));
		},
	});
	pi.registerTool({
		name: "git_control_commit",
		label: "Commit",
		description:
			"Create one commit from already staged files. Never call it unless the person explicitly asked for a commit; always read status and diff first.",
		parameters: Type.Object({
			message: Type.String({ minLength: 1, maxLength: 4_000 }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return json(await gitControlCommit(workspaceIdAt(ctx.cwd), params.message));
		},
	});
	pi.registerTool({
		name: "git_control_fetch",
		label: "Fetch",
		description: "Fetch and prune remote refs for the active workspace.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			return json(await gitControlFetch(workspaceIdAt(ctx.cwd)));
		},
	});
	pi.registerTool({
		name: "git_control_pull",
		label: "Pull",
		description:
			"Fast-forward pull the active workspace branch. Refuses when it would create a merge commit.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			return json(await gitControlPull(workspaceIdAt(ctx.cwd)));
		},
	});
	pi.registerTool({
		name: "git_control_push",
		label: "Push",
		description: "Push the active branch to its upstream, creating one on origin when missing.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			return json(await gitControlPush(workspaceIdAt(ctx.cwd)));
		},
	});
	pi.registerTool({
		name: "git_control_create_branch",
		label: "Create Branch",
		description: "Create and switch to a new branch in the active workspace.",
		parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 200 }) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return json(await gitControlCreateBranch(workspaceIdAt(ctx.cwd), params.name));
		},
	});
	pi.registerTool({
		name: "git_control_switch_branch",
		label: "Switch Branch",
		description: "Switch the active workspace to an existing local branch.",
		parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 200 }) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return json(await gitControlSwitchBranch(workspaceIdAt(ctx.cwd), params.name));
		},
	});
	pi.registerTool({
		name: "git_control_show_commit",
		label: "Show Commit",
		description: "Read one commit's metadata, stats, and patch.",
		parameters: Type.Object({ sha: Type.String({ minLength: 4, maxLength: 40 }) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return json(boundedCommit(await gitControlShowCommit(workspaceIdAt(ctx.cwd), params.sha)));
		},
	});
}
