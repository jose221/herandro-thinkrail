import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BROWSER_LIMITS, type BrowserCapture } from "@thinkrail/contracts";
import { dataDir } from "../persistence";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE_PREFIX = "browser-";

function captureDirectory(workspaceId: string): string {
	const key = createHash("sha256").update(workspaceId).digest("hex").slice(0, 16);
	return join(dataDir(), "browser-captures", key);
}

function validMagic(bytes: Uint8Array, magic: readonly number[]): boolean {
	return magic.every((value, index) => bytes[index] === value);
}

function decodeCapture(data: string, mimeType: "image/png" | "image/jpeg"): Buffer {
	const raw = data.startsWith("data:") ? (data.split(",", 2)[1] ?? "") : data;
	const bytes = Buffer.from(raw, "base64");
	if (bytes.byteLength === 0 || bytes.byteLength > BROWSER_LIMITS.captureBytes) {
		throw new Error("Browser capture is too large");
	}
	const expected = mimeType === "image/png" ? PNG_MAGIC : JPEG_MAGIC;
	if (!validMagic(bytes, expected)) throw new Error("Browser capture is not a valid image");
	return bytes;
}

function cleanup(directory: string): void {
	let entries: string[];
	try {
		entries = readdirSync(directory);
	} catch {
		return;
	}
	const cutoff = Date.now() - BROWSER_LIMITS.captureTtlMs;
	for (const entry of entries.slice(0, 200)) {
		const path = join(directory, entry);
		try {
			if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
		} catch {}
	}
}

/** Saves one bounded browser screenshot under the app data dir and returns its absolute path. */
export function saveBrowserCapture(input: {
	workspaceId: string;
	data: string;
	mimeType: "image/png" | "image/jpeg";
	url: string;
	device: string;
	width: number;
	height: number;
}): BrowserCapture {
	if (input.url.length > BROWSER_LIMITS.urlLength || input.url.includes("\0")) {
		throw new Error("Browser capture URL is invalid");
	}
	if (input.device.length > 120 || input.device.includes("\0")) {
		throw new Error("Browser capture device is invalid");
	}
	for (const value of [input.width, input.height]) {
		if (!Number.isInteger(value) || value < 1 || value > 10_000) {
			throw new Error("Browser capture dimensions are invalid");
		}
	}
	const bytes = decodeCapture(input.data, input.mimeType);
	const id = randomUUID();
	const directory = captureDirectory(input.workspaceId);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const extension = input.mimeType === "image/png" ? "png" : "jpg";
	const fileName = `${FILE_PREFIX}${id}.${extension}`;
	const path = join(directory, fileName);
	writeFileSync(path, bytes, { mode: 0o600 });
	cleanup(directory);
	return { id, path, fileName };
}

export function deleteBrowserCapture(workspaceId: string, id: string): void {
	if (!ID_PATTERN.test(id)) throw new Error("Browser capture id is invalid");
	const directory = captureDirectory(workspaceId);
	for (const extension of ["png", "jpg"]) {
		rmSync(join(directory, `${FILE_PREFIX}${id}.${extension}`), { force: true });
	}
}
