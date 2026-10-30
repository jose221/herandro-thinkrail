import {
	RiAddLine,
	RiArrowLeftLine,
	RiArrowRightLine,
	RiCloseLine,
	RiCodeSSlashLine,
	RiComputerLine,
	RiExternalLinkLine,
	RiGlobalFill,
	RiGlobalLine,
	RiRecordCircleLine,
	RiRefreshLine,
	RiScreenshotLine,
	RiSmartphoneLine,
	RiStopCircleLine,
	RiTabletLine,
} from "@remixicon/react";
import {
	BROWSER_LIMITS,
	type BrowserPageSnapshot,
	type BrowserSession,
	CAPTURE_LIMITS,
	type CaptureFrame,
	type DevServerPort,
	MEDIA_CAPTURE_PROTOCOL_VERSION,
	type MediaCapture,
	WORKSPACE_TOOLS_PROTOCOL_VERSION,
	WS_CHANNELS,
} from "@thinkrail/contracts";
import type { MessageKey } from "@thinkrail/locales";
import { useT } from "@thinkrail/locales/react";
import { Button, IconButton } from "@thinkrail/ui/button";
import { cn } from "@thinkrail/ui/utils";
import {
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { copyText } from "../lib";
import { activeChatSessionId } from "../lib/activeChatSession";
import { announceMediaCapture } from "../lib/mediaCapture";
import { toast, useAppStore } from "../store";
import { errorText, getTransport } from "../transport";
import { ConfirmDialog } from "./ConfirmDialog";

type Viewport = "desktop" | "tablet" | "mobile";

type CurrentTabCaptureOptions = DisplayMediaStreamOptions & {
	preferCurrentTab?: boolean;
	selfBrowserSurface?: "include" | "exclude";
};

interface DevicePreset {
	id: string;
	label: MessageKey;
	width: number;
	height: number;
	kind: "phone" | "tablet";
}

const PHONES: readonly DevicePreset[] = [
	{ id: "iphone-se", label: "browser.device.iphoneSe", width: 375, height: 667, kind: "phone" },
	{ id: "pixel-xl", label: "browser.device.pixelXl", width: 412, height: 732, kind: "phone" },
	{
		id: "iphone-17-pro-max",
		label: "browser.device.iphone17ProMax",
		width: 440,
		height: 956,
		kind: "phone",
	},
];

const TABLETS: readonly DevicePreset[] = [
	{ id: "ipad-mini", label: "browser.device.ipadMini", width: 744, height: 1133, kind: "tablet" },
	{ id: "ipad-air", label: "browser.device.ipadAir", width: 820, height: 1180, kind: "tablet" },
	{ id: "ipad-pro", label: "browser.device.ipadPro", width: 1024, height: 1366, kind: "tablet" },
];

const VIEWPORT_KEYS = {
	desktop: "browser.viewport.desktop",
	tablet: "browser.viewport.tablet",
	mobile: "browser.viewport.mobile",
} as const satisfies Record<Viewport, MessageKey>;

const VIEWPORT_ICONS = {
	desktop: RiComputerLine,
	tablet: RiTabletLine,
	mobile: RiSmartphoneLine,
} as const satisfies Record<Viewport, typeof RiComputerLine>;

const INPUT_CLASS =
	"min-h-32 min-w-0 flex-1 rounded-sm border border-control-border-default bg-control-bg px-8 tr-code-text text-text-default outline-none placeholder:text-text-muted focus-visible:border-control-border-active";

const RECORDING_MAX_MS = 30_000;
const RECORDING_FPS = 10;
const RECORDING_FRAME_INTERVAL_MS = 2_000;
const RECORDING_FRAME_LIMIT = 8;
const RECORDING_MAX_WIDTH = 1_280;

interface VideoRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

function visibleVideoRect(
	video: HTMLVideoElement,
	target: HTMLElement,
	clip: HTMLElement | null,
): VideoRect {
	const rect = target.getBoundingClientRect();
	const clipRect = clip?.getBoundingClientRect() ?? {
		left: 0,
		top: 0,
		right: window.innerWidth,
		bottom: window.innerHeight,
	};
	const left = Math.max(0, rect.left, clipRect.left);
	const top = Math.max(0, rect.top, clipRect.top);
	const right = Math.min(window.innerWidth, rect.right, clipRect.right);
	const bottom = Math.min(window.innerHeight, rect.bottom, clipRect.bottom);
	if (right <= left || bottom <= top) throw new Error("Browser capture target is not visible");
	const scaleX = video.videoWidth / window.innerWidth;
	const scaleY = video.videoHeight / window.innerHeight;
	const x = Math.max(0, Math.min(video.videoWidth - 1, Math.round(left * scaleX)));
	const y = Math.max(0, Math.min(video.videoHeight - 1, Math.round(top * scaleY)));
	return {
		x,
		y,
		width: Math.max(1, Math.min(video.videoWidth - x, Math.round((right - left) * scaleX))),
		height: Math.max(1, Math.min(video.videoHeight - y, Math.round((bottom - top) * scaleY))),
	};
}

function drawVideoRect(video: HTMLVideoElement, rect: VideoRect, canvas: HTMLCanvasElement): void {
	const context = canvas.getContext("2d");
	if (!context) throw new Error("Browser capture canvas is unavailable");
	context.drawImage(
		video,
		rect.x,
		rect.y,
		rect.width,
		rect.height,
		0,
		0,
		canvas.width,
		canvas.height,
	);
}

function frameFromCanvas(
	canvas: HTMLCanvasElement,
	mimeType: "image/png" | "image/jpeg",
	quality?: number,
): CaptureFrame {
	const dataUrl = canvas.toDataURL(mimeType, quality);
	const comma = dataUrl.indexOf(",");
	if (comma < 0) throw new Error("Browser capture encoding failed");
	return {
		mimeType,
		data: dataUrl.slice(comma + 1),
		width: canvas.width,
		height: canvas.height,
	};
}

async function captureVisibleFrame(
	video: HTMLVideoElement | null,
	target: HTMLElement | null,
	clip: HTMLElement | null,
): Promise<CaptureFrame> {
	if (!video || !target) throw new Error("Browser capture target is unavailable");
	if (video.readyState < 2) throw new Error("Browser capture is not ready");
	const rect = visibleVideoRect(video, target, clip);
	const canvas = document.createElement("canvas");
	canvas.width = rect.width;
	canvas.height = rect.height;
	drawVideoRect(video, rect, canvas);
	const frame = frameFromCanvas(canvas, "image/png");
	canvas.width = 0;
	canvas.height = 0;
	return frame;
}

function recordingMimeType(): string | null {
	if (typeof MediaRecorder === "undefined") return null;
	for (const candidate of ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]) {
		if (MediaRecorder.isTypeSupported(candidate)) return candidate;
	}
	return null;
}

function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = String(reader.result ?? "");
			const comma = result.indexOf(",");
			if (comma < 0) reject(new Error("Browser recording encoding failed"));
			else resolve(result.slice(comma + 1));
		};
		reader.onerror = () => reject(reader.error ?? new Error("Browser recording encoding failed"));
		reader.readAsDataURL(blob);
	});
}

function devicesFor(viewport: Viewport): readonly DevicePreset[] | null {
	if (viewport === "mobile") return PHONES;
	if (viewport === "tablet") return TABLETS;
	return null;
}

function formatRecordingTime(elapsedMs: number): string {
	const seconds = Math.max(0, Math.round(elapsedMs / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function logicalDimension(value: number | undefined, fallback: number): number {
	return value === undefined ? fallback : value;
}

interface BrowserRecordingSession {
	recorder: MediaRecorder;
	canvas: HTMLCanvasElement;
	stream: MediaStream;
	video: HTMLVideoElement;
	rect: VideoRect;
	frames: CaptureFrame[];
	chunks: Blob[];
	startedAt: number;
	durationMs: number;
	sessionId: string;
	url: string;
	deviceLabel: string;
	logicalWidth: number;
	logicalHeight: number;
	drawTimer: number;
	frameTimer: number;
	autoTimer: number;
}

function clearRecordingTimers(session: BrowserRecordingSession): void {
	window.clearInterval(session.drawTimer);
	window.clearInterval(session.frameTimer);
	window.clearTimeout(session.autoTimer);
}

function DevicePreview({
	device,
	frameRef,
	hostRef,
	children,
}: {
	device: DevicePreset;
	frameRef: RefObject<HTMLDivElement | null>;
	hostRef: RefObject<HTMLDivElement | null>;
	children: ReactNode;
}) {
	const [scale, setScale] = useState(0.4);
	const frameWidth = device.width + 24;
	const frameHeight = device.height + 24;

	useLayoutEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const update = () => {
			const bounds = host.getBoundingClientRect();
			const next = Math.min(
				0.9,
				Math.max(
					0.1,
					Math.min(
						Math.max(0, bounds.width - 24) / frameWidth,
						Math.max(0, bounds.height - 24) / frameHeight,
					),
				),
			);
			setScale(next);
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(host);
		return () => observer.disconnect();
	}, [frameHeight, frameWidth]);

	return (
		<div
			ref={hostRef}
			className="m-8 flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden rounded-sm border border-border-muted bg-container-content-bg p-8"
		>
			<div style={{ width: frameWidth * scale, height: frameHeight * scale }}>
				<div
					ref={frameRef}
					style={{
						width: frameWidth,
						height: frameHeight,
						transform: `scale(${scale})`,
						transformOrigin: "top left",
					}}
					className={cn(
						"relative bg-container-terminal-bg p-12 shadow-[var(--shadow-md)] ring-1 ring-border-default",
						device.kind === "phone" ? "device-frame" : "device-frame-tablet",
					)}
				>
					<div
						className={cn(
							"relative h-full w-full overflow-hidden bg-container-elevated-bg",
							device.kind === "phone" ? "device-frame-screen" : "device-frame-tablet-screen",
						)}
					>
						{children}
						{device.kind === "phone" ? (
							<div className="pointer-events-none absolute top-4 left-1/2 z-10 h-12 w-72 -translate-x-1/2 rounded-full bg-container-terminal-bg" />
						) : (
							<div className="pointer-events-none absolute top-4 left-1/2 z-10 size-4 -translate-x-1/2 rounded-full bg-container-terminal-bg" />
						)}
						<div className="pointer-events-none absolute bottom-4 left-1/2 z-10 h-2 w-24 -translate-x-1/2 rounded-full bg-text-subtle" />
					</div>
				</div>
			</div>
		</div>
	);
}

export function supportsWorkspaceTools(protocolVersion: number | null): boolean {
	return protocolVersion !== null && protocolVersion >= WORKSPACE_TOOLS_PROTOCOL_VERSION;
}

function displayUrl(url: string): string {
	if (url === "about:blank") return "";
	try {
		const parsed = new URL(url);
		return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}`;
	} catch {
		return url;
	}
}

function tabLabel(tab: { url: string; title?: string }): string {
	if (tab.title && tab.title.trim().length > 0) return tab.title;
	return displayUrl(tab.url) || "New tab";
}

export function BrowserPane({ workspaceId }: { workspaceId: string }) {
	const t = useT();
	const protocolVersion = useAppStore((state) => state.protocolVersion);
	const supported = supportsWorkspaceTools(protocolVersion);
	const captureSupported =
		protocolVersion !== null && protocolVersion >= MEDIA_CAPTURE_PROTOCOL_VERSION;
	const [session, setSession] = useState<BrowserSession | null>(null);
	const [ports, setPorts] = useState<DevServerPort[]>([]);
	const [urlInput, setUrlInput] = useState("");
	const [editingUrl, setEditingUrl] = useState(false);
	const [viewport, setViewport] = useState<Viewport>("desktop");
	const [deviceId, setDeviceId] = useState(PHONES[0]?.id ?? "");
	const [captureIntroOpen, setCaptureIntroOpen] = useState(false);
	const [pendingAction, setPendingAction] = useState<"capture" | "record" | null>(null);
	const [capturing, setCapturing] = useState(false);
	const [recording, setRecording] = useState<{ startedAt: number; durationMs: number } | null>(
		null,
	);
	const [recordedMs, setRecordedMs] = useState(0);
	const [recordingBusy, setRecordingBusy] = useState(false);
	const [reloadKey, setReloadKey] = useState(0);
	const [loading, setLoading] = useState(true);
	const [failed, setFailed] = useState(false);
	const [suspended, setSuspended] = useState(false);
	const [panelVisible, setPanelVisible] = useState(true);
	const [snapshot, setSnapshot] = useState<BrowserPageSnapshot | null>(null);
	const [reading, setReading] = useState(false);
	const [readFailed, setReadFailed] = useState(false);
	const [historyInfo, setHistoryInfo] = useState({ index: -1, length: 0 });
	const rootRef = useRef<HTMLDivElement>(null);
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const deviceFrameRef = useRef<HTMLDivElement>(null);
	const deviceHostRef = useRef<HTMLDivElement>(null);
	const captureVideo = useRef<HTMLVideoElement>(null);
	const captureStream = useRef<MediaStream | null>(null);
	const recordingRef = useRef<BrowserRecordingSession | null>(null);
	const recordingStopRef = useRef<(() => void) | null>(null);
	const hideTimer = useRef<number | null>(null);
	const history = useRef<string[]>([]);
	const historyIndex = useRef(-1);
	const lastUrl = useRef("about:blank");

	const activeTab = session?.tabs.find((tab) => tab.id === session.activeTabId) ?? null;
	const devices = devicesFor(viewport);
	const device = devices?.find((candidate) => candidate.id === deviceId) ?? devices?.[0] ?? null;

	const applyUrl = useCallback((url: string, record: boolean) => {
		if (url === "about:blank") {
			lastUrl.current = url;
			return;
		}
		const current = history.current[historyIndex.current];
		if (record && url !== current) {
			history.current = [...history.current.slice(0, historyIndex.current + 1), url];
			historyIndex.current = history.current.length - 1;
		} else if (!record && current === undefined) {
			history.current = [url];
			historyIndex.current = 0;
		}
		lastUrl.current = url;
		setHistoryInfo({ index: historyIndex.current, length: history.current.length });
	}, []);

	useEffect(() => {
		if (!supported) {
			setLoading(protocolVersion === null);
			setSession(null);
			setPorts([]);
			return;
		}
		let mounted = true;
		setLoading(true);
		setFailed(false);
		getTransport()
			.request("browser.state", { workspaceId })
			.then((next) => {
				if (!mounted) return;
				setSession(next);
			})
			.catch(() => {
				if (mounted) setFailed(true);
			})
			.finally(() => {
				if (mounted) setLoading(false);
			});
		const unsubscribe = getTransport().subscribe(WS_CHANNELS.browserChanged, (data) => {
			const next = data as BrowserSession;
			if (next?.workspaceId !== workspaceId) return;
			setSession(next);
		});
		return () => {
			mounted = false;
			unsubscribe();
		};
	}, [protocolVersion, supported, workspaceId]);

	useEffect(() => {
		const url = activeTab?.url ?? "about:blank";
		if (url !== lastUrl.current) applyUrl(url, url !== "about:blank");
		if (!editingUrl) setUrlInput(url === "about:blank" ? "" : url);
	}, [activeTab?.url, applyUrl, editingUrl]);

	useEffect(() => {
		if (!supported || !rootRef.current) return;
		let hiddenSince: number | null = null;
		const observer = new IntersectionObserver(
			([entry]) => {
				const isVisible = entry?.isIntersecting ?? true;
				setPanelVisible(isVisible);
				if (isVisible) {
					hiddenSince = null;
					if (hideTimer.current !== null) {
						window.clearTimeout(hideTimer.current);
						hideTimer.current = null;
					}
					return;
				}
				hiddenSince = Date.now();
				if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
				hideTimer.current = window.setTimeout(() => {
					if (hiddenSince !== null) setSuspended(true);
				}, 90_000);
			},
			{ threshold: 0.02 },
		);
		observer.observe(rootRef.current);
		return () => {
			observer.disconnect();
			if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
		};
	}, [supported]);

	const loadPorts = useCallback(async () => {
		if (!supported) return;
		try {
			setPorts(await getTransport().request("browser.ports", {}));
		} catch {}
	}, [supported]);

	useEffect(() => {
		if (!supported || suspended || !panelVisible) return;
		void loadPorts();
		const timer = window.setInterval(() => void loadPorts(), 5_000);
		return () => window.clearInterval(timer);
	}, [loadPorts, panelVisible, suspended, supported]);

	const toastError = useCallback(
		(error: unknown) => {
			toast.error(errorText(error, t("browser.requestFailed")));
		},
		[t],
	);

	const changeViewport = (next: Viewport) => {
		setViewport(next);
		const list = devicesFor(next);
		if (list?.[0]) setDeviceId(list[0].id);
		setSuspended(false);
	};

	const captureError = useCallback(
		(error: unknown, fallback: string) => {
			const name = error instanceof DOMException ? error.name : "";
			if (name === "NotAllowedError" || name === "AbortError") {
				toast.info(t("browser.captureCancelled"));
			} else if (name === "NotSupportedError") {
				toast.error(t("browser.captureUnsupported"));
			} else {
				toast.error(errorText(error, fallback));
			}
		},
		[t],
	);

	const stopCaptureStream = useCallback(() => {
		const activeRecording = recordingRef.current;
		if (activeRecording) {
			recordingRef.current = null;
			recordingStopRef.current = null;
			clearRecordingTimers(activeRecording);
			try {
				activeRecording.recorder.stop();
			} catch {}
			for (const track of activeRecording.stream.getTracks()) track.stop();
			setRecording(null);
			setRecordedMs(0);
		}
		const stream = captureStream.current;
		captureStream.current = null;
		if (stream) for (const track of stream.getTracks()) track.stop();
		if (captureVideo.current) captureVideo.current.srcObject = null;
	}, []);

	useEffect(() => () => stopCaptureStream(), [stopCaptureStream]);
	useEffect(() => {
		if (suspended) stopCaptureStream();
	}, [stopCaptureStream, suspended]);

	useEffect(() => {
		if (!recording) {
			setRecordedMs(0);
			return;
		}
		const update = () =>
			setRecordedMs(Math.min(recording.durationMs, Date.now() - recording.startedAt));
		update();
		const timer = window.setInterval(update, 500);
		return () => window.clearInterval(timer);
	}, [recording]);

	const ensureCaptureStream = useCallback(async (): Promise<MediaStream> => {
		const current = captureStream.current;
		if (current?.active) return current;
		if (!navigator.mediaDevices?.getDisplayMedia) {
			throw new Error(t("browser.captureUnsupported"));
		}
		const options: CurrentTabCaptureOptions = {
			video: { displaySurface: "browser" },
			audio: false,
			preferCurrentTab: true,
			selfBrowserSurface: "include",
		};
		const stream = await navigator.mediaDevices.getDisplayMedia(options);
		const track = stream.getVideoTracks()[0];
		const surface = track?.getSettings().displaySurface;
		if (surface && surface !== "browser") {
			for (const currentTrack of stream.getTracks()) currentTrack.stop();
			throw new Error(t("browser.captureChooseTab"));
		}
		const video = captureVideo.current;
		if (!video) {
			for (const currentTrack of stream.getTracks()) currentTrack.stop();
			throw new Error(t("browser.captureUnsupported"));
		}
		video.srcObject = stream;
		await video.play();
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		captureStream.current = stream;
		track?.addEventListener("ended", () => {
			if (captureStream.current === stream) captureStream.current = null;
			video.srcObject = null;
			recordingStopRef.current?.();
		});
		return stream;
	}, [t]);

	const capture = async () => {
		if (!captureSupported) return;
		const sessionId = activeChatSessionId(workspaceId);
		const url = activeTab?.url ?? "about:blank";
		if (!sessionId || !activeTab || url === "about:blank") {
			toast.error(t("browser.captureNoChat"));
			return;
		}
		const target = viewport === "desktop" ? iframeRef.current : deviceFrameRef.current;
		const clip = viewport === "desktop" ? null : deviceHostRef.current;
		const deviceLabel = device ? t(device.label) : t("browser.viewport.desktop");
		setCapturing(true);
		let saved: MediaCapture | null = null;
		let frame: CaptureFrame | null = null;
		try {
			await ensureCaptureStream();
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			);
			frame = await captureVisibleFrame(captureVideo.current, target, clip);
			saved = await getTransport().request("capture.save", {
				workspaceId,
				kind: "image",
				data: frame.data,
				mimeType: frame.mimeType,
				width: frame.width,
				height: frame.height,
			});
		} catch (error) {
			captureError(error, t("browser.captureFailed"));
		}
		setCapturing(false);
		if (!saved || !frame) return;
		const note = t("browser.captureNote", {
			path: saved.path,
			device: deviceLabel,
			width: device?.width ?? frame.width,
			height: device?.height ?? frame.height,
			url,
		});
		announceMediaCapture({
			workspaceId,
			sessionId,
			capture: saved,
			image: frame,
			device: deviceLabel,
			url,
			note,
		});
		toast.success(t("browser.captureSaved"));
	};

	const stopRecording = async () => {
		const active = recordingRef.current;
		if (!active) return;
		recordingRef.current = null;
		recordingStopRef.current = null;
		clearRecordingTimers(active);
		setRecording(null);
		setRecordedMs(0);
		setRecordingBusy(true);
		try {
			drawVideoRect(active.video, active.rect, active.canvas);
		} catch {}
		await new Promise<void>((resolve) => {
			if (active.recorder.state === "inactive") {
				resolve();
				return;
			}
			active.recorder.addEventListener("stop", () => resolve(), { once: true });
			active.recorder.stop();
		});
		for (const track of active.stream.getTracks()) track.stop();
		const durationMs = Math.max(1, Math.min(active.durationMs, Date.now() - active.startedAt));
		const blob = new Blob(active.chunks, { type: "video/webm" });
		if (blob.size === 0) {
			toast.error(t("browser.recordFailed"));
		} else if (blob.size > CAPTURE_LIMITS.videoBytes) {
			toast.error(t("browser.recordTooLarge"));
		} else {
			let saved: MediaCapture | null = null;
			try {
				const data = await blobToBase64(blob);
				saved = await getTransport().request("capture.save", {
					workspaceId,
					kind: "video",
					data,
					mimeType: "video/webm",
					width: active.canvas.width,
					height: active.canvas.height,
					durationMs,
				});
			} catch (error) {
				captureError(error, t("browser.recordFailed"));
			}
			if (saved) {
				const frames =
					active.frames.length > 0
						? active.frames
						: [frameFromCanvas(active.canvas, "image/jpeg", 0.8)];
				const poster = frames[0];
				const note = t("browser.recordNote", {
					path: saved.path,
					device: active.deviceLabel,
					width: active.logicalWidth,
					height: active.logicalHeight,
					duration: String(Math.max(1, Math.round(durationMs / 1000))),
					url: active.url,
				});
				announceMediaCapture({
					workspaceId,
					sessionId: active.sessionId,
					capture: saved,
					...(poster ? { poster } : {}),
					frames,
					device: active.deviceLabel,
					url: active.url,
					note,
				});
				toast.success(t("browser.recordSaved"));
			}
		}
		setRecordingBusy(false);
	};

	const startRecording = async () => {
		if (!captureSupported || recordingRef.current) return;
		const sessionId = activeChatSessionId(workspaceId);
		const url = activeTab?.url ?? "about:blank";
		if (!sessionId || !activeTab || url === "about:blank") {
			toast.error(t("browser.captureNoChat"));
			return;
		}
		const target = viewport === "desktop" ? iframeRef.current : deviceFrameRef.current;
		const clip = viewport === "desktop" ? null : deviceHostRef.current;
		const deviceLabel = device ? t(device.label) : t("browser.viewport.desktop");
		const deviceWidth = device?.width;
		const deviceHeight = device?.height;
		const video = captureVideo.current;
		if (!video || !target) {
			toast.error(t("browser.captureUnsupported"));
			return;
		}
		const mimeType = recordingMimeType();
		if (!mimeType) {
			toast.error(t("browser.recordUnsupported"));
			return;
		}
		setRecordingBusy(true);
		let stream: MediaStream | null = null;
		let recorder: MediaRecorder | null = null;
		let session: BrowserRecordingSession | null = null;
		try {
			await ensureCaptureStream();
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			);
			const rect = visibleVideoRect(video, target, clip);
			const canvas = document.createElement("canvas");
			const scale = Math.min(1, RECORDING_MAX_WIDTH / rect.width);
			canvas.width = Math.max(1, Math.round(rect.width * scale));
			canvas.height = Math.max(1, Math.round(rect.height * scale));
			drawVideoRect(video, rect, canvas);
			stream = canvas.captureStream(RECORDING_FPS);
			recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_000_000 });
			const chunks: Blob[] = [];
			recorder.ondataavailable = (event) => {
				if (event.data.size > 0) chunks.push(event.data);
			};
			const frames: CaptureFrame[] = [frameFromCanvas(canvas, "image/jpeg", 0.8)];
			const startedAt = Date.now();
			const drawTimer = window.setInterval(
				() => {
					try {
						drawVideoRect(video, rect, canvas);
					} catch {}
				},
				Math.round(1000 / RECORDING_FPS),
			);
			const frameTimer = window.setInterval(() => {
				if (frames.length >= RECORDING_FRAME_LIMIT) return;
				try {
					frames.push(frameFromCanvas(canvas, "image/jpeg", 0.8));
				} catch {}
			}, RECORDING_FRAME_INTERVAL_MS);
			recorder.start(500);
			const autoTimer = window.setTimeout(() => void stopRecording(), RECORDING_MAX_MS);
			session = {
				recorder,
				canvas,
				stream,
				video,
				rect,
				frames,
				chunks,
				startedAt,
				durationMs: RECORDING_MAX_MS,
				sessionId,
				url,
				deviceLabel,
				logicalWidth: logicalDimension(deviceWidth, rect.width),
				logicalHeight: logicalDimension(deviceHeight, rect.height),
				drawTimer,
				frameTimer,
				autoTimer,
			};
			recordingRef.current = session;
			recordingStopRef.current = () => void stopRecording();
			setRecording({ startedAt, durationMs: RECORDING_MAX_MS });
			toast.info(t("browser.recordingStarted"));
		} catch (error) {
			if (session) {
				clearRecordingTimers(session);
				try {
					session.recorder.stop();
				} catch {}
			}
			for (const track of stream?.getTracks() ?? []) track.stop();
			recordingRef.current = null;
			recordingStopRef.current = null;
			setRecording(null);
			captureError(error, t("browser.recordFailed"));
		}
		setRecordingBusy(false);
	};

	const requestCapture = (action: "capture" | "record") => {
		if (!captureSupported) return;
		if (captureStream.current) {
			if (action === "record") void startRecording();
			else void capture();
			return;
		}
		setPendingAction(action);
		setCaptureIntroOpen(true);
	};

	const navigate = useCallback(
		async (value: string) => {
			const raw = value.trim();
			if (!raw) return;
			const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
			try {
				const next = await getTransport().request("browser.navigate", { workspaceId, url });
				setSession(next);
				setFailed(false);
				setSuspended(false);
			} catch (error) {
				setFailed(true);
				toastError(error);
			}
		},
		[toastError, workspaceId],
	);

	const submitUrl = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setEditingUrl(false);
		void navigate(urlInput);
	};

	const openTab = async () => {
		try {
			setSession(await getTransport().request("browser.openTab", { workspaceId }));
			setSuspended(false);
		} catch (error) {
			toastError(error);
		}
	};

	const closeTab = async (tabId: string) => {
		try {
			setSession(await getTransport().request("browser.closeTab", { workspaceId, tabId }));
		} catch (error) {
			toastError(error);
		}
	};

	const selectTab = async (tabId: string) => {
		try {
			setSession(await getTransport().request("browser.selectTab", { workspaceId, tabId }));
		} catch (error) {
			toastError(error);
		}
	};

	const back = () => {
		if (historyIndex.current <= 0) return;
		historyIndex.current -= 1;
		const url = history.current[historyIndex.current];
		if (url) void navigate(url);
	};

	const forward = () => {
		if (historyIndex.current >= history.current.length - 1) return;
		historyIndex.current += 1;
		const url = history.current[historyIndex.current];
		if (url) void navigate(url);
	};
	const reload = () => {
		setReloadKey((value) => value + 1);
		setSnapshot(null);
	};

	const readPage = async () => {
		if (!activeTab || activeTab.url === "about:blank") return;
		setReading(true);
		setReadFailed(false);
		try {
			setSnapshot(
				await getTransport().request("browser.snapshot", {
					workspaceId,
					url: activeTab.url,
				}),
			);
		} catch {
			setReadFailed(true);
		}
		setReading(false);
	};

	const copyUrl = async () => {
		if (activeTab && (await copyText(activeTab.url))) toast.success(t("browser.urlCopied"));
	};

	const iframeVisible =
		supported && !suspended && activeTab !== null && activeTab.url !== "about:blank";

	return (
		<section
			ref={rootRef}
			data-testid="browser-pane"
			aria-label={t("browser.title")}
			className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
		>
			<video ref={captureVideo} className="hidden" muted playsInline />

			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				<div className="flex min-w-0 flex-wrap items-center gap-4 border-border-default border-b px-8 py-4">
					<IconButton
						icon={RiArrowLeftLine}
						label={t("browser.back")}
						variant="ghost"
						size="s"
						disabled={historyInfo.index <= 0}
						onClick={back}
					/>
					<IconButton
						icon={RiArrowRightLine}
						label={t("browser.forward")}
						variant="ghost"
						size="s"
						disabled={historyInfo.index >= historyInfo.length - 1}
						onClick={forward}
					/>
					<IconButton
						icon={RiRefreshLine}
						label={t("browser.reload")}
						variant="ghost"
						size="s"
						disabled={!iframeVisible}
						onClick={reload}
					/>
					<form className="flex min-w-0 flex-1 items-center gap-4" onSubmit={submitUrl}>
						<input
							data-testid="browser-url"
							className={cn(INPUT_CLASS, "min-h-28")}
							value={urlInput}
							onFocus={() => setEditingUrl(true)}
							onBlur={() => setEditingUrl(false)}
							onChange={(event) => setUrlInput(event.currentTarget.value)}
							placeholder={t("browser.urlPlaceholder")}
							spellCheck={false}
							autoComplete="off"
							aria-label={t("browser.urlPlaceholder")}
							maxLength={BROWSER_LIMITS.urlLength}
						/>
						<Button type="submit" size="s" disabled={!supported || urlInput.trim() === ""}>
							{t("browser.go")}
						</Button>
					</form>
					{activeTab && activeTab.url !== "about:blank" ? (
						<>
							<IconButton
								icon={RiCodeSSlashLine}
								label={t("browser.inspect")}
								variant="ghost"
								size="s"
								selected={snapshot !== null}
								loading={reading}
								onClick={() => void readPage()}
							/>
							<IconButton
								icon={RiExternalLinkLine}
								label={t("browser.copyUrl")}
								variant="ghost"
								size="s"
								onClick={() => void copyUrl()}
							/>
						</>
					) : null}
				</div>

				<div className="flex min-w-0 flex-wrap items-center gap-8 border-border-default border-b px-8 py-4">
					<div className="flex shrink-0 items-center gap-2 rounded-sm border border-border-default bg-container-content-bg p-2">
						{(["desktop", "tablet", "mobile"] as const).map((preset) => (
							<Button
								key={preset}
								variant="ghost"
								size="s"
								selected={viewport === preset}
								iconLeft={VIEWPORT_ICONS[preset]}
								data-testid={`browser-viewport-${preset}`}
								onClick={() => changeViewport(preset)}
								aria-label={t(VIEWPORT_KEYS[preset])}
							>
								{t(VIEWPORT_KEYS[preset])}
							</Button>
						))}
					</div>
					{devices ? (
						<div className="ml-auto flex min-w-0 flex-wrap items-center gap-4">
							{devices.map((candidate) => (
								<Button
									key={candidate.id}
									variant="ghost"
									size="s"
									selected={device?.id === candidate.id}
									data-testid={`browser-device-${candidate.id}`}
									onClick={() => setDeviceId(candidate.id)}
								>
									<span className="tr-text-metadata">{t(candidate.label)}</span>
									<span className="whitespace-nowrap text-text-subtle tr-text-metadata">
										· {candidate.width}×{candidate.height}
									</span>
								</Button>
							))}
						</div>
					) : null}
				</div>

				{(session?.tabs.length ?? 0) > 0 ? (
					<div className="flex min-w-0 items-center gap-2 overflow-x-auto border-border-default border-b px-8 py-4">
						{session?.tabs.map((tab) => (
							<div
								key={tab.id}
								className={cn(
									"group flex min-w-0 max-w-[16rem] items-center gap-2 rounded-sm border px-4 py-2",
									tab.id === session.activeTabId
										? "border-control-border-active bg-primary-subtle text-text-default"
										: "border-transparent text-text-muted hover:bg-control-bg-hovered",
								)}
							>
								<button
									type="button"
									className="min-w-0 flex-1 truncate text-left tr-text-metadata"
									onClick={() => void selectTab(tab.id)}
									title={tab.url}
								>
									{tabLabel(tab)}
								</button>
								<button
									type="button"
									aria-label={t("browser.closeTab")}
									className="rounded-sm p-2 text-text-subtle hover:bg-control-bg-hovered hover:text-text-default"
									onClick={() => void closeTab(tab.id)}
								>
									<RiCloseLine className="size-12" />
								</button>
							</div>
						))}
						<IconButton
							icon={RiAddLine}
							label={t("browser.newTab")}
							variant="ghost"
							size="s"
							onClick={() => void openTab()}
						/>
					</div>
				) : null}

				<div className="min-h-0 min-w-0 flex-1 overflow-auto bg-sunken">
					{failed ? (
						<p
							role="alert"
							className="border-feedback-error border-b px-12 py-4 text-feedback-error tr-text-metadata"
						>
							{t("browser.requestFailed")}
						</p>
					) : null}
					{!supported ? (
						<div className="flex h-full items-center justify-center p-16 text-text-muted tr-text-ui">
							{protocolVersion === null ? t("browser.loading") : t("browser.hostTooOld")}
						</div>
					) : loading ? (
						<div className="flex h-full items-center justify-center p-16 text-text-muted tr-text-ui">
							{t("browser.loading")}
						</div>
					) : suspended ? (
						<div className="flex h-full flex-col items-center justify-center gap-8 p-16 text-center">
							<RiGlobalLine className="size-24 text-text-subtle" aria-hidden="true" />
							<p className="text-text-muted tr-text-ui">{t("browser.suspended")}</p>
							<Button
								variant="outline"
								size="m"
								onClick={() => setSuspended(false)}
								data-testid="browser-resume"
							>
								{t("browser.resume")}
							</Button>
						</div>
					) : activeTab === null || activeTab.url === "about:blank" ? (
						<div
							className="flex h-full flex-col items-center justify-center gap-8 p-16 text-center"
							data-testid="browser-empty"
						>
							<RiGlobalFill className="size-24 text-text-subtle" aria-hidden="true" />
							<p className="text-text-muted tr-text-ui">{t("browser.description")}</p>
							<p className="text-text-muted tr-text-ui">{t("browser.startHint")}</p>
							{ports.length > 0 ? (
								<div className="flex max-w-[32rem] flex-wrap items-center justify-center gap-4">
									{ports.slice(0, 8).map((port) => (
										<Button
											key={port.port}
											variant="outline"
											size="s"
											onClick={() => void navigate(port.url)}
											tooltip={port.process}
										>
											:{port.port} · {port.framework ?? t("browser.portFallback")}
										</Button>
									))}
								</div>
							) : (
								<p className="text-text-subtle tr-text-metadata">{t("browser.noPorts")}</p>
							)}
						</div>
					) : (
						<div className="relative flex h-full min-h-0 flex-col">
							{viewport === "desktop" ? (
								<div className="mx-auto min-h-0 w-full flex-1 overflow-hidden">
									<iframe
										ref={iframeRef}
										key={`${activeTab.id}:${reloadKey}`}
										data-testid="browser-frame"
										title={t("browser.frameTitle", { url: activeTab.url })}
										src={activeTab.url}
										className="h-full min-h-[24rem] w-full border-0 bg-container-elevated-bg"
										sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
										referrerPolicy="no-referrer"
										allow="clipboard-read; clipboard-write; fullscreen"
									/>
								</div>
							) : device ? (
								<DevicePreview device={device} frameRef={deviceFrameRef} hostRef={deviceHostRef}>
									<iframe
										ref={iframeRef}
										key={`${activeTab.id}:${reloadKey}`}
										data-testid="browser-frame"
										title={t("browser.frameTitle", { url: activeTab.url })}
										src={activeTab.url}
										className="h-full w-full border-0 bg-container-elevated-bg"
										sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
										referrerPolicy="no-referrer"
										allow="clipboard-read; clipboard-write; fullscreen"
									/>
								</DevicePreview>
							) : null}
							<div className="flex shrink-0 flex-wrap items-center gap-8 border-border-default border-t px-12 py-8">
								<p className="min-w-0 flex-1 truncate text-text-subtle tr-text-metadata">
									{viewport === "desktop"
										? t("browser.frameHint")
										: t("browser.deviceHint", {
												device: device ? t(device.label) : "",
											})}
								</p>
								{captureSupported ? (
									recording ? (
										<div className="flex shrink-0 items-center gap-8">
											<span className="flex items-center gap-2 text-feedback-error tr-text-metadata">
												<span
													className="size-6 animate-pulse rounded-full bg-feedback-error"
													aria-hidden="true"
												/>
												{t("browser.recording")} {formatRecordingTime(recordedMs)}
											</span>
											<Button
												variant="primary"
												size="s"
												iconLeft={RiStopCircleLine}
												loading={recordingBusy}
												onClick={() => void stopRecording()}
												data-testid="browser-record-stop"
											>
												{t("browser.recordStop")}
											</Button>
										</div>
									) : (
										<div className="flex shrink-0 items-center gap-4">
											<Button
												variant="outline"
												size="s"
												iconLeft={RiRecordCircleLine}
												disabled={capturing || recordingBusy}
												onClick={() => requestCapture("record")}
												data-testid="browser-record"
											>
												{t("browser.record")}
											</Button>
											<Button
												variant="primary"
												size="s"
												iconLeft={RiScreenshotLine}
												loading={capturing}
												disabled={recordingBusy}
												onClick={() => requestCapture("capture")}
												data-testid="browser-capture"
											>
												{t("browser.capture")}
											</Button>
										</div>
									)
								) : null}
							</div>
						</div>
					)}
				</div>

				{snapshot || readFailed ? (
					<section
						data-testid="browser-inspector"
						className="max-h-[40%] shrink-0 overflow-auto border-border-default border-t bg-container-elevated-bg p-12"
						aria-label={t("browser.inspect")}
					>
						<div className="mb-8 flex min-w-0 items-center gap-8">
							<h3 className="min-w-0 flex-1 truncate tr-title-compact text-text-default">
								{snapshot?.title || t("browser.inspect")}
							</h3>
							<Button variant="ghost" size="s" onClick={() => setSnapshot(null)}>
								{t("common.close")}
							</Button>
						</div>
						{readFailed ? (
							<p className="text-feedback-error tr-text-metadata">{t("browser.readFailed")}</p>
						) : snapshot ? (
							<div className="flex min-w-0 flex-col gap-8">
								<p className="break-all text-text-muted tr-text-metadata">
									{t("browser.pageMeta", {
										status: snapshot.status,
										contentType: snapshot.contentType || t("browser.unknown"),
										ms: snapshot.elapsedMs,
									})}
									{snapshot.truncated ? ` · ${t("browser.truncated")}` : ""}
								</p>
								<p className="whitespace-pre-wrap text-text-default tr-text-metadata">
									{snapshot.text || t("browser.noText")}
								</p>
								{snapshot.links.length > 0 ? (
									<details>
										<summary className="cursor-pointer text-text-muted tr-text-metadata">
											{t("browser.links", { count: snapshot.links.length })}
										</summary>
										<ul className="mt-4 flex flex-col gap-2">
											{snapshot.links.map((link) => (
												<li key={link} className="truncate">
													<button
														type="button"
														className="text-left text-primary tr-text-metadata hover:underline"
														onClick={() => void navigate(link)}
													>
														{link}
													</button>
												</li>
											))}
										</ul>
									</details>
								) : null}
							</div>
						) : null}
					</section>
				) : null}
			</div>
			<ConfirmDialog
				open={captureIntroOpen}
				onOpenChange={setCaptureIntroOpen}
				title={t("browser.captureIntroTitle")}
				description={t("browser.captureIntro")}
				confirmLabel={t("browser.captureStart")}
				confirmTestId="browser-capture-start"
				onConfirm={() => {
					const action = pendingAction ?? "capture";
					setPendingAction(null);
					if (action === "record") void startRecording();
					else void capture();
				}}
			/>
		</section>
	);
}
