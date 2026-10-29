import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAcpWorktreePath } from "./runtime";

let tempDirectory = "";

const canSymlink = (() => {
	const probe = mkdtempSync(join(tmpdir(), "thinkrail-acp-symlink-probe-"));
	try {
		symlinkSync(join(probe, "target"), join(probe, "link"), "file");
		return true;
	} catch {
		return false;
	} finally {
		rmSync(probe, { recursive: true, force: true });
	}
})();

beforeEach(() => {
	tempDirectory = mkdtempSync(join(tmpdir(), "thinkrail-acp-path-"));
});

afterEach(() => {
	rmSync(tempDirectory, { recursive: true, force: true });
});

test.skipIf(!canSymlink)(
	"rejects a dangling in-worktree symlink before it can create an outside file",
	async () => {
		const workspace = join(tempDirectory, "workspace");
		const outside = join(tempDirectory, "outside");
		const escapePath = join(outside, "new-file.txt");
		mkdirSync(workspace);
		mkdirSync(outside);
		symlinkSync(escapePath, join(workspace, "shortcut.txt"));

		await expect(resolveAcpWorktreePath(workspace, "shortcut.txt", false)).rejects.toThrow(
			"cannot be resolved safely",
		);
		expect(existsSync(escapePath)).toBe(false);
	},
);

test.skipIf(!canSymlink)(
	"resolves existing in-worktree symlinks to their contained target",
	async () => {
		const workspace = join(tempDirectory, "workspace");
		const target = join(workspace, "target.txt");
		mkdirSync(workspace);
		writeFileSync(target, "safe");
		symlinkSync(target, join(workspace, "shortcut.txt"));

		expect(await resolveAcpWorktreePath(workspace, "shortcut.txt", false)).toBe(
			realpathSync(target),
		);
	},
);

test.skipIf(!canSymlink)(
	"rejects a symlink retargeted outside the workspace after permission was shown",
	async () => {
		const workspace = join(tempDirectory, "workspace");
		const outside = join(tempDirectory, "outside");
		mkdirSync(workspace);
		mkdirSync(outside);
		writeFileSync(join(outside, "target.txt"), "outside");
		writeFileSync(join(workspace, "inside.txt"), "safe");
		const shortcut = join(workspace, "shortcut.txt");
		symlinkSync(join(workspace, "inside.txt"), shortcut);

		const approvedPath = await resolveAcpWorktreePath(workspace, "shortcut.txt", false);
		rmSync(shortcut);
		symlinkSync(join(outside, "target.txt"), shortcut);

		await expect(resolveAcpWorktreePath(workspace, "shortcut.txt", false)).rejects.toThrow(
			"outside this workspace",
		);
		expect(approvedPath).toBe(join(realpathSync(workspace), "inside.txt"));
	},
);

test("accepts a new file under a canonical in-worktree directory", async () => {
	const workspace = join(tempDirectory, "workspace");
	const nested = join(workspace, "nested");
	mkdirSync(nested, { recursive: true });

	expect(await resolveAcpWorktreePath(workspace, "nested/new-file.txt", false)).toBe(
		join(realpathSync(nested), "new-file.txt"),
	);
});
