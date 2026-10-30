import type { ImageContent } from "@thinkrail/contracts";

export const BROWSER_CAPTURE_EVENT = "thinkrail:browser-capture";

export interface BrowserCapturePayload {
	workspaceId: string;
	sessionId: string;
	captureId: string;
	fileName: string;
	path: string;
	mimeType: "image/png" | "image/jpeg";
	content: ImageContent;
	width: number;
	height: number;
	device: string;
	url: string;
	note: string;
}

export function announceBrowserCapture(payload: BrowserCapturePayload): void {
	window.dispatchEvent(
		new CustomEvent<BrowserCapturePayload>(BROWSER_CAPTURE_EVENT, { detail: payload }),
	);
}
