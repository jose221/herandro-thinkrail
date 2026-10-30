import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteBrowserCapture, saveBrowserCapture } from "./capture";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const savedDataDir = process.env.THINKRAIL_DATA_DIR;
let dataDir: string;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "thinkrail-browser-capture-"));
	process.env.THINKRAIL_DATA_DIR = dataDir;
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
	if (savedDataDir === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = savedDataDir;
});

test("captures are saved under the app data dir with a bounded PNG payload", () => {
	const capture = saveBrowserCapture({
		workspaceId: "workspace-1",
		data: PNG.toString("base64"),
		mimeType: "image/png",
		url: "http://localhost:5173/",
		device: "iPhone 17 Pro Max",
		width: 440,
		height: 956,
	});
	expect(capture.path.startsWith(dataDir)).toBe(true);
	expect(capture.fileName.endsWith(".png")).toBe(true);
	expect(readdirSync(join(dataDir, "browser-captures")).length).toBe(1);
	deleteBrowserCapture("workspace-1", capture.id);
	expect(existsSync(capture.path)).toBe(false);
});

test("captures reject non-images, oversized payloads and unsafe ids", () => {
	expect(() =>
		saveBrowserCapture({
			workspaceId: "w",
			data: Buffer.from("not an image").toString("base64"),
			mimeType: "image/png",
			url: "http://localhost/",
			device: "phone",
			width: 10,
			height: 10,
		}),
	).toThrow("valid image");
	expect(() =>
		saveBrowserCapture({
			workspaceId: "w",
			data: Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64"),
			mimeType: "image/png",
			url: "http://localhost/",
			device: "phone",
			width: 10,
			height: 10,
		}),
	).toThrow("too large");
	expect(() => deleteBrowserCapture("w", "../outside")).toThrow("invalid");
});
