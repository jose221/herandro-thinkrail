import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	gitControlBranches,
	gitControlCommit,
	gitControlCreateBranch,
	gitControlDiff,
	gitControlLog,
	gitControlStage,
	gitControlStatus,
	gitControlSwitchBranch,
	gitControlUnstage,
} from "./control";

const posix = test.skipIf(process.platform === "win32");
let dataDir: string;
let repo: string;
const savedDataDir = process.env.THINKRAIL_DATA_DIR;

function git(cwd: string, ...args: string[]): void {
	const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	if (!result.success) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "thinkrail-git-control-"));
	process.env.THINKRAIL_DATA_DIR = dataDir;
	repo = join(dataDir, "repo");
	mkdirSync(repo);
	git(repo, "init", "-b", "main");
	git(repo, "config", "user.email", "t@thinkrail.test");
	git(repo, "config", "user.name", "test");
	git(repo, "config", "commit.gpgsign", "false");
	writeFileSync(join(repo, "README.md"), "# repo\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-m", "init");
	writeFileSync(
		join(dataDir, "projects.json"),
		JSON.stringify([{ id: "p1", name: "repo", path: repo, slug: "repo", lastOpened: 1 }]),
	);
	writeFileSync(
		join(dataDir, "workspaces.json"),
		JSON.stringify([
			{
				id: "w1",
				projectId: "p1",
				name: "w1",
				branch: "main",
				worktreePath: repo,
				baseBranch: "main",
				createdAt: 1,
			},
		]),
	);
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
	if (savedDataDir === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = savedDataDir;
});

posix("status, stage, unstage and commit stay in the workspace", async () => {
	writeFileSync(join(repo, "new.txt"), "hello\n");
	expect(await gitControlStatus("w1")).toMatchObject({
		branch: "main",
		files: [{ path: "new.txt", status: "untracked", staged: false, unstaged: true }],
	});
	const staged = await gitControlStage("w1", ["new.txt"]);
	expect(staged.files[0]).toMatchObject({ path: "new.txt", status: "added", staged: true });
	const committed = await gitControlCommit("w1", "feat: add new file");
	expect(committed.subject).toBe("feat: add new file");
	expect(await gitControlStatus("w1")).toMatchObject({ files: [] });

	writeFileSync(join(repo, "README.md"), "# changed\n");
	await gitControlStage("w1", ["README.md"]);
	expect((await gitControlStatus("w1")).files[0]?.staged).toBe(true);
	await gitControlUnstage("w1", ["README.md"]);
	expect((await gitControlStatus("w1")).files[0]).toMatchObject({
		staged: false,
		unstaged: true,
	});
});

posix("diffs are bounded to the workspace and branches can be created", async () => {
	writeFileSync(join(repo, "README.md"), "# changed\n");
	const diff = await gitControlDiff("w1", "README.md");
	expect(diff.diff).toContain("-# repo");
	expect(diff.diff).toContain("+# changed");
	await expect(gitControlDiff("w1", "../outside")).rejects.toThrow("Invalid path");
	expect(await gitControlBranches("w1")).toMatchObject({ current: "main", local: ["main"] });
	await gitControlCreateBranch("w1", "feature/x");
	expect((await gitControlBranches("w1")).current).toBe("feature/x");
	await gitControlSwitchBranch("w1", "main");
	expect((await gitControlBranches("w1")).current).toBe("main");
	expect((await gitControlLog("w1", 5)).length).toBeGreaterThanOrEqual(1);
});
