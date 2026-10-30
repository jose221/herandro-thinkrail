import type { ChatAttachment, VideoAttachment } from "./types";

/** Flattens a recording into the ordered still frames sent to the model with the prompt. */
export function videoFrameAttachments(videos: VideoAttachment[]): ChatAttachment[] {
	return videos.flatMap((video) =>
		video.frames.map((frame, index) => ({
			name: `${video.name}-${index + 1}.${frame.mimeType === "image/png" ? "png" : "jpg"}`,
			content: {
				type: "image" as const,
				mimeType: frame.mimeType,
				data: frame.data,
			},
		})),
	);
}
