import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	CAPTURE_LIMITS,
	type CaptureKind,
	type CaptureMimeType,
	type MediaCapture,
} from "@thinkrail/contracts";
import { dataDir } from "../persistence";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const WEBM_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const IMAGE_TYPES: ReadonlySet<CaptureMimeType> = new Set(["image/png", "image/jpeg"]);
const VIDEO_TYPES: ReadonlySet<CaptureMimeType> = new Set(["video/webm", "video/mp4"]);

function captureDirectory(workspaceId: string): string {
	const key = createHash("sha256").update(workspaceId).digest("hex").slice(0, 16);
	return join(dataDir(), "captures", key);
}

function extensionFor(mimeType: CaptureMimeType): string {
	switch (mimeType) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpg";
		case "video/webm":
			return "webm";
		case "video/mp4":
			return "mp4";
	}
}

function validMagic(bytes: Uint8Array, magic: readonly number[]): boolean {
	return magic.every((value, index) => bytes[index] === value);
}

function isMp4(bytes: Uint8Array): boolean {
	return (
		bytes.byteLength >= 12 &&
		bytes[4] === 0x66 &&
		bytes[5] === 0x74 &&
		bytes[6] === 0x79 &&
		bytes[7] === 0x70
	);
}

function decodeCapture(data: string, kind: CaptureKind, mimeType: CaptureMimeType): Buffer {
	const raw = data.startsWith("data:") ? (data.split(",", 2)[1] ?? "") : data;
	const bytes = Buffer.from(raw, "base64");
	const limit = kind === "image" ? CAPTURE_LIMITS.imageBytes : CAPTURE_LIMITS.videoBytes;
	if (bytes.byteLength === 0 || bytes.byteLength > limit) {
		throw new Error(`Capture exceeds the ${kind} size limit`);
	}
	const valid =
		mimeType === "image/png"
			? validMagic(bytes, PNG_MAGIC)
			: mimeType === "image/jpeg"
				? validMagic(bytes, JPEG_MAGIC)
				: mimeType === "video/webm"
					? validMagic(bytes, WEBM_MAGIC)
					: isMp4(bytes);
	if (!valid) throw new Error("Capture is not a valid image or video");
	return bytes;
}

function cleanup(directory: string): void {
	let entries: string[];
	try {
		entries = readdirSync(directory);
	} catch {
		return;
	}
	const cutoff = Date.now() - CAPTURE_LIMITS.ttlMs;
	for (const entry of entries.slice(0, 200)) {
		const path = join(directory, entry);
		try {
			if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
		} catch {}
	}
}

/** Saves one bounded host capture under the app data dir and returns its absolute path. */
export function saveCapture(input: {
	workspaceId: string;
	kind: CaptureKind;
	data: string;
	mimeType: CaptureMimeType;
	width: number;
	height: number;
	durationMs?: number;
}): MediaCapture {
	if (input.kind === "image" && !IMAGE_TYPES.has(input.mimeType)) {
		throw new Error("Capture kind does not match its mime type");
	}
	if (input.kind === "video" && !VIDEO_TYPES.has(input.mimeType)) {
		throw new Error("Capture kind does not match its mime type");
	}
	for (const value of [input.width, input.height]) {
		if (!Number.isInteger(value) || value < 1 || value > CAPTURE_LIMITS.maxDimension) {
			throw new Error("Capture dimensions are invalid");
		}
	}
	if (input.durationMs !== undefined) {
		if (
			input.kind !== "video" ||
			!Number.isInteger(input.durationMs) ||
			input.durationMs < 1 ||
			input.durationMs > CAPTURE_LIMITS.maxDurationMs
		) {
			throw new Error("Capture duration is invalid");
		}
	}
	const bytes = decodeCapture(input.data, input.kind, input.mimeType);
	const id = randomUUID();
	const directory = captureDirectory(input.workspaceId);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const fileName = `${input.kind}-${id}.${extensionFor(input.mimeType)}`;
	const path = join(directory, fileName);
	writeFileSync(path, bytes, { mode: 0o600 });
	cleanup(directory);
	return {
		id,
		kind: input.kind,
		path,
		fileName,
		mimeType: input.mimeType,
		width: input.width,
		height: input.height,
		bytes: bytes.byteLength,
		...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
	};
}

export function deleteCapture(workspaceId: string, id: string): void {
	if (!ID_PATTERN.test(id)) throw new Error("Capture id is invalid");
	const directory = captureDirectory(workspaceId);
	for (const prefix of ["image-", "video-"]) {
		for (const extension of ["png", "jpg", "webm", "mp4"]) {
			rmSync(join(directory, `${prefix}${id}.${extension}`), { force: true });
		}
	}
}
