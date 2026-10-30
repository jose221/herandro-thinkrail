import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { listProjects } from "../projects";
import { listWorkspaceRecords } from "../workspaces";

function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/** Resolves the workspace whose worktree contains the tool's cwd, for host-owned workspace tools. */
export function workspaceIdAt(cwd: string): string {
	const target = canonical(cwd);
	for (const project of listProjects()) {
		for (const workspace of listWorkspaceRecords(project.id)) {
			const root = canonical(workspace.worktreePath);
			if (target === root || target.startsWith(`${root}${sep}`)) return workspace.id;
		}
	}
	throw new Error("This tool must run inside a ThinkRail workspace");
}
