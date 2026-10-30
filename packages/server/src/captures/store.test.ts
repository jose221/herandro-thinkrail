import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTURE_LIMITS } from "@thinkrail/contracts";
import { deleteCapture, saveCapture } from "./store";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
const MP4 = Buffer.alloc(16);
MP4.write("ftyp", 4, "ascii");
const savedDataDir = process.env.THINKRAIL_DATA_DIR;
let dataDir: string;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "thinkrail-capture-"));
	process.env.THINKRAIL_DATA_DIR = dataDir;
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
	if (savedDataDir === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = savedDataDir;
});

test("saves images and videos under the app data dir and deletes them by id", () => {
	const image = saveCapture({
		workspaceId: "workspace-1",
		kind: "image",
		data: PNG.toString("base64"),
		mimeType: "image/png",
		width: 440,
		height: 956,
	});
	const video = saveCapture({
		workspaceId: "workspace-1",
		kind: "video",
		data: WEBM.toString("base64"),
		mimeType: "video/webm",
		width: 440,
		height: 956,
		durationMs: 12_000,
	});
	expect(image.path.startsWith(dataDir)).toBe(true);
	expect(image.fileName.startsWith("image-")).toBe(true);
	expect(video.fileName.startsWith("video-")).toBe(true);
	expect(video.durationMs).toBe(12_000);
	expect(readdirSync(join(dataDir, "captures")).length).toBe(1);
	deleteCapture("workspace-1", image.id);
	deleteCapture("workspace-1", video.id);
	expect(existsSync(image.path)).toBe(false);
	expect(existsSync(video.path)).toBe(false);
});

test("accepts mp4 recordings", () => {
	const capture = saveCapture({
		workspaceId: "w",
		kind: "video",
		data: MP4.toString("base64"),
		mimeType: "video/mp4",
		width: 1080,
		height: 2400,
		durationMs: 5_000,
	});
	expect(capture.mimeType).toBe("video/mp4");
	expect(capture.fileName.endsWith(".mp4")).toBe(true);
	deleteCapture("w", capture.id);
});

test("rejects mismatched types, unsafe payloads, durations and ids", () => {
	expect(() =>
		saveCapture({
			workspaceId: "w",
			kind: "image",
			data: WEBM.toString("base64"),
			mimeType: "image/png",
			width: 10,
			height: 10,
		}),
	).toThrow("valid image or video");
	expect(() =>
		saveCapture({
			workspaceId: "w",
			kind: "video",
			data: PNG.toString("base64"),
			mimeType: "video/webm",
			width: 10,
			height: 10,
			durationMs: 1,
		}),
	).toThrow("valid image or video");
	expect(() =>
		saveCapture({
			workspaceId: "w",
			kind: "video",
			data: WEBM.toString("base64"),
			mimeType: "video/webm",
			width: 10,
			height: 10,
			durationMs: CAPTURE_LIMITS.maxDurationMs + 1,
		}),
	).toThrow("duration");
	expect(() =>
		saveCapture({
			workspaceId: "w",
			kind: "image",
			data: Buffer.alloc(0).toString("base64"),
			mimeType: "image/png",
			width: 10,
			height: 10,
		}),
	).toThrow("size limit");
	expect(() => deleteCapture("w", "../outside")).toThrow("invalid");
});
