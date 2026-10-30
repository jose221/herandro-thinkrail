import { resolve, sep } from "node:path";
import {
	GIT_CONTROL_LIMITS,
	type GitControlBranches,
	type GitControlCommitResult,
	type GitControlDiff,
	type GitControlFile,
	type GitControlLogEntry,
	type GitControlStatus,
} from "@thinkrail/contracts";
import { gitAsync, isSafeRef } from "../git";
import { getWorkspace } from "../workspaces";

function worktree(workspaceId: string): string {
	return getWorkspace(workspaceId).worktreePath;
}

function assertPaths(cwd: string, paths: readonly string[]): string[] {
	if (!Array.isArray(paths) || paths.length === 0 || paths.length > GIT_CONTROL_LIMITS.paths) {
		throw new Error("Choose between 1 and 200 paths");
	}
	return paths.map((path) => {
		if (
			typeof path !== "string" ||
			path.length === 0 ||
			path.length > GIT_CONTROL_LIMITS.pathLength ||
			path.includes("\0") ||
			path.startsWith("/")
		) {
			throw new Error("Invalid path");
		}
		const normalized = path.replace(/^\.\//, "");
		if (normalized.split(/[\\/]/).some((part) => part === "..")) {
			throw new Error("Invalid path");
		}
		const candidate = resolve(cwd, normalized);
		if (candidate !== cwd && !candidate.startsWith(`${cwd}${sep}`)) {
			throw new Error("Invalid path");
		}
		return normalized;
	});
}

function bounded(
	value: string,
	limit = GIT_CONTROL_LIMITS.diffChars,
): { text: string; truncated: boolean } {
	if (value.length <= limit) return { text: value, truncated: false };
	return { text: value.slice(0, limit), truncated: true };
}

function failure(result: { err: string }): never {
	throw new Error(result.err || "git failed");
}

function statusOf(staged: string, unstaged: string): GitControlFile["status"] {
	if (staged === "?" || unstaged === "?") return "untracked";
	if (staged === "A" || unstaged === "A") return "added";
	if (staged === "D" || unstaged === "D") return "deleted";
	if (staged === "R" || unstaged === "R") return "renamed";
	return "modified";
}

export async function gitControlStatus(workspaceId: string): Promise<GitControlStatus> {
	const cwd = worktree(workspaceId);
	const [status, branch] = await Promise.all([
		gitAsync(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { raw: true }),
		gitAsync(cwd, ["branch", "--show-current"]),
	]);
	if (!status.ok) failure(status);
	if (!branch.ok) failure(branch);
	const tokens = status.out.split("\0");
	const files: GitControlFile[] = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (!token) continue;
		const match = /^(.)(.) (.*)$/.exec(token);
		if (!match) continue;
		const stagedChar = match[1] ?? " ";
		const unstagedChar = match[2] ?? " ";
		const path = match[3] ?? "";
		if (!path) continue;
		if (stagedChar === "R" || stagedChar === "C" || unstagedChar === "R" || unstagedChar === "C") {
			index += 1;
		}
		const untracked = stagedChar === "?" || unstagedChar === "?";
		files.push({
			path,
			status: statusOf(stagedChar, unstagedChar),
			staged: stagedChar !== " " && stagedChar !== "?",
			unstaged: untracked || (unstagedChar !== " " && unstagedChar !== "?"),
		});
	}
	files.sort((a, b) => a.path.localeCompare(b.path));
	return { branch: branch.out.trim(), files };
}

export async function gitControlBranches(workspaceId: string): Promise<GitControlBranches> {
	const cwd = worktree(workspaceId);
	const [local, remote, current] = await Promise.all([
		gitAsync(cwd, ["branch", "--format=%(refname:short)"]),
		gitAsync(cwd, ["branch", "-r", "--format=%(refname:short)"]),
		gitAsync(cwd, ["branch", "--show-current"]),
	]);
	if (!local.ok) failure(local);
	if (!remote.ok) failure(remote);
	if (!current.ok) failure(current);
	return {
		current: current.out.trim(),
		local: local.out
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean),
		remote: remote.out
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.endsWith("/HEAD")),
	};
}

export async function gitControlLog(
	workspaceId: string,
	limit = 30,
): Promise<GitControlLogEntry[]> {
	const count = Math.max(1, Math.min(limit, GIT_CONTROL_LIMITS.logEntries));
	const result = await gitAsync(worktree(workspaceId), [
		"log",
		`--max-count=${count}`,
		"--format=%H%x00%h%x00%cI%x00%an%x00%s",
		"--",
	]);
	if (!result.ok) failure(result);
	const entries: GitControlLogEntry[] = [];
	for (const line of result.out.split("\n")) {
		if (!line) continue;
		const [sha, shortSha, committedAt, author, ...subject] = line.split("\0");
		if (!sha || !shortSha) continue;
		entries.push({
			sha,
			shortSha,
			committedAt: committedAt ?? "",
			author: author ?? "",
			subject: (subject.join("\0") ?? "").trim(),
		});
	}
	return entries;
}

export async function gitControlDiff(
	workspaceId: string,
	path: string,
	staged = false,
): Promise<GitControlDiff> {
	const cwd = worktree(workspaceId);
	const [safePath] = assertPaths(cwd, [path]);
	if (!safePath) throw new Error("Invalid path");
	const result = await gitAsync(cwd, [
		"diff",
		...(staged ? ["--staged"] : []),
		"--no-color",
		"--",
		safePath,
	]);
	if (!result.ok) failure(result);
	const { text, truncated } = bounded(result.out);
	return { path: safePath, staged, diff: text, truncated };
}

export async function gitControlStage(
	workspaceId: string,
	paths: readonly string[],
): Promise<GitControlStatus> {
	const cwd = worktree(workspaceId);
	const safe = assertPaths(cwd, paths);
	const result = await gitAsync(cwd, ["add", "--", ...safe]);
	if (!result.ok) failure(result);
	return gitControlStatus(workspaceId);
}

export async function gitControlUnstage(
	workspaceId: string,
	paths: readonly string[],
): Promise<GitControlStatus> {
	const cwd = worktree(workspaceId);
	const safe = assertPaths(cwd, paths);
	const result = await gitAsync(cwd, ["reset", "-q", "HEAD", "--", ...safe]);
	if (!result.ok) failure(result);
	return gitControlStatus(workspaceId);
}

export async function gitControlCommit(
	workspaceId: string,
	message: string,
): Promise<GitControlCommitResult> {
	const text = typeof message === "string" ? message.trim() : "";
	if (text.length === 0 || text.length > GIT_CONTROL_LIMITS.messageLength) {
		throw new Error("Enter a commit message");
	}
	const cwd = worktree(workspaceId);
	const commit = await gitAsync(cwd, ["commit", "-m", text]);
	if (!commit.ok) failure(commit);
	const [head, subject] = await Promise.all([
		gitAsync(cwd, ["rev-parse", "HEAD"]),
		gitAsync(cwd, ["log", "-1", "--format=%s"]),
	]);
	if (!head.ok) failure(head);
	return { sha: head.out.trim(), subject: subject.ok ? subject.out.trim() : text };
}

async function networkOutput(workspaceId: string, args: string[]): Promise<{ output: string }> {
	const result = await gitAsync(worktree(workspaceId), args, { network: true, timeoutMs: 55_000 });
	if (!result.ok) failure(result);
	return { output: result.out.trim() || result.err.trim() || "Done" };
}

export function gitControlFetch(workspaceId: string): Promise<{ output: string }> {
	return networkOutput(workspaceId, ["fetch", "--prune"]);
}

export function gitControlPull(workspaceId: string): Promise<{ output: string }> {
	return networkOutput(workspaceId, ["pull", "--ff-only"]);
}

export async function gitControlPush(workspaceId: string): Promise<{ output: string }> {
	const cwd = worktree(workspaceId);
	const upstream = await gitAsync(cwd, [
		"rev-parse",
		"--abbrev-ref",
		"--symbolic-full-name",
		"@{u}",
	]);
	const branch = await gitAsync(cwd, ["branch", "--show-current"]);
	if (!branch.ok || !branch.out.trim()) throw new Error("The workspace is not on a branch");
	if (upstream.ok && upstream.out.trim()) return networkOutput(workspaceId, ["push"]);
	return networkOutput(workspaceId, ["push", "-u", "origin", branch.out.trim()]);
}

export async function gitControlCreateBranch(
	workspaceId: string,
	name: string,
): Promise<{ output: string }> {
	if (!isSafeRef(name)) throw new Error("Invalid branch name");
	return localOutput(workspaceId, ["switch", "-c", name]);
}

export async function gitControlSwitchBranch(
	workspaceId: string,
	name: string,
): Promise<{ output: string }> {
	if (!isSafeRef(name)) throw new Error("Invalid branch name");
	return localOutput(workspaceId, ["switch", name]);
}

async function localOutput(workspaceId: string, args: string[]): Promise<{ output: string }> {
	const result = await gitAsync(worktree(workspaceId), args);
	if (!result.ok) failure(result);
	return { output: result.out.trim() || result.err.trim() || "Done" };
}

export async function gitControlShowCommit(
	workspaceId: string,
	sha: string,
): Promise<{ output: string; truncated: boolean }> {
	if (typeof sha !== "string" || !/^[0-9a-f]{4,40}$/i.test(sha)) {
		throw new Error("Invalid commit");
	}
	const result = await gitAsync(worktree(workspaceId), [
		"show",
		"--no-color",
		"--stat",
		"--patch",
		"--format=fuller",
		sha,
	]);
	if (!result.ok) failure(result);
	const { text, truncated } = bounded(result.out);
	return { output: text, truncated };
}
