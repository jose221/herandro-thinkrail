import { expect, test } from "bun:test";
import { parsePatch } from "./GitPatch";

const PATCH = `commit 93c9339
Author: Jose <jose@example.com>

    feat(audio): extend cloud TTS timeout

diff --git a/api/rules.md b/api/rules.md
index b03c193..3a4a661 100644
--- a/api/rules.md
+++ b/api/rules.md
@@ -1,3 +1,4 @@
 # Rules
-old line
+new line
+added line
 context
diff --git a/architecture.md b/architecture.md
new file mode 100644
index 0000000..4f2a1b9
--- /dev/null
+++ b/architecture.md
@@ -0,0 +1,2 @@
+first
+second
`;

test("splits a patch into one section per file", () => {
	const sections = parsePatch(PATCH);
	expect(sections.map((section) => section.path)).toEqual(["api/rules.md", "architecture.md"]);
	expect(sections.map((section) => [section.added, section.removed])).toEqual([
		[2, 1],
		[2, 0],
	]);
});

test("hides patch headers but keeps hunk headers and content", () => {
	const [section] = parsePatch(PATCH);
	const visible = section?.lines.filter((line) => !line.hidden).map((line) => line.text);
	expect(visible).toEqual([
		"@@ -1,3 +1,4 @@",
		" # Rules",
		"-old line",
		"+new line",
		"+added line",
		" context",
	]);
});

test("resolves deleted and renamed paths from the file headers", () => {
	const deleted = parsePatch(`diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-bye
`);
	expect(deleted[0]?.path).toBe("gone.ts");
	expect(deleted[0]?.removed).toBe(1);

	const renamed = parsePatch(`diff --git "a/docs/old name.md" "b/docs/new name.md"
similarity index 100%
rename from docs/old name.md
rename to docs/new name.md
`);
	expect(renamed[0]?.path).toBe("docs/new name.md");
});

test("treats a leading dash inside a hunk as deleted content, not a file header", () => {
	const sections = parsePatch(`diff --git a/notes.txt b/notes.txt
--- a/notes.txt
+++ b/notes.txt
@@ -1,1 +1,1 @@
--- separator
++- separator
`);
	expect(sections[0]?.path).toBe("notes.txt");
	expect(sections[0]?.lines.some((line) => line.text === "--- separator")).toBe(true);
});
