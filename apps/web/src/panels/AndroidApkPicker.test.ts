import { expect, test } from "bun:test";
import type { FileNode } from "@thinkrail/contracts";
import { apkPickerEntries } from "./AndroidApkPicker";

test("APK browser keeps folders and APKs in the host's listing order", () => {
	const nodes: FileNode[] = [
		{ path: "build", name: "build", kind: "dir" },
		{ path: "src", name: "src", kind: "dir" },
		{ path: "build/debug.APK", name: "debug.APK", kind: "file" },
		{ path: "build/release.apk", name: "release.apk", kind: "file" },
		{ path: "z.txt", name: "z.txt", kind: "file" },
	];

	expect(apkPickerEntries(nodes).map((node) => node.path)).toEqual([
		"build",
		"src",
		"build/debug.APK",
		"build/release.apk",
	]);
});
