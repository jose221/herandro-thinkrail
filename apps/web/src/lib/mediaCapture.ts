import type { CaptureFrame, MediaCapture } from "@thinkrail/contracts";

export const MEDIA_CAPTURE_EVENT = "thinkrail:media-capture";

export interface MediaCapturePayload {
	workspaceId: string;
	sessionId: string;
	capture: MediaCapture;
	image?: CaptureFrame;
	poster?: CaptureFrame;
	frames?: CaptureFrame[];
	device: string;
	url: string;
	note: string;
}

export function announceMediaCapture(payload: MediaCapturePayload): void {
	window.dispatchEvent(
		new CustomEvent<MediaCapturePayload>(MEDIA_CAPTURE_EVENT, { detail: payload }),
	);
}
