import { expect, test } from "bun:test";
import type { VideoAttachment } from "./types";
import { videoFrameAttachments } from "./videoAttachments";

const video: VideoAttachment = {
	id: "capture-1",
	name: "video-capture.webm",
	note: "Browser recording: /tmp/video-capture.webm",
	path: "/tmp/video-capture.webm",
	mimeType: "video/webm",
	durationMs: 12_000,
	width: 440,
	height: 956,
	bytes: 1024,
	frames: [
		{ mimeType: "image/jpeg", data: "frame-1", width: 440, height: 956 },
		{ mimeType: "image/png", data: "frame-2", width: 440, height: 956 },
	],
};

test("turns a recording into ordered image attachments for the prompt", () => {
	expect(videoFrameAttachments([video])).toEqual([
		{
			name: "video-capture.webm-1.jpg",
			content: { type: "image", mimeType: "image/jpeg", data: "frame-1" },
		},
		{
			name: "video-capture.webm-2.png",
			content: { type: "image", mimeType: "image/png", data: "frame-2" },
		},
	]);
});

test("preserves multiple recordings in order", () => {
	const frame = video.frames[0];
	if (!frame) throw new Error("test fixture has no frame");
	const second = { ...video, id: "capture-2", name: "second.webm", frames: [frame] };
	expect(videoFrameAttachments([video, second]).map((attachment) => attachment.name)).toEqual([
		"video-capture.webm-1.jpg",
		"video-capture.webm-2.png",
		"second.webm-1.jpg",
	]);
});
