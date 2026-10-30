import {
	RiAddLine,
	RiArrowLeftLine,
	RiArrowRightLine,
	RiCloseLine,
	RiCodeSSlashLine,
	RiExternalLinkLine,
	RiGlobalFill,
	RiGlobalLine,
	RiRefreshLine,
	RiScreenshotLine,
} from "@remixicon/react";
import {
	BROWSER_LIMITS,
	type BrowserCapture,
	type BrowserPageSnapshot,
	type BrowserSession,
	type DevServerPort,
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
import { announceBrowserCapture } from "../lib/browserCapture";
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

const INPUT_CLASS =
	"min-h-32 min-w-0 flex-1 rounded-sm border border-control-border-default bg-control-bg px-8 tr-code-text text-text-default outline-none placeholder:text-text-muted focus-visible:border-control-border-active";

interface CapturedFrame {
	data: string;
	width: number;
	height: number;
}

async function captureVisibleFrame(
	video: HTMLVideoElement | null,
	target: HTMLElement | null,
	clip: HTMLElement | null,
): Promise<CapturedFrame> {
	if (!video || !target) throw new Error("Browser capture target is unavailable");
	if (video.readyState < 2) throw new Error("Browser capture is not ready");
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
	const width = Math.max(1, Math.min(video.videoWidth - x, Math.round((right - left) * scaleX)));
	const height = Math.max(1, Math.min(video.videoHeight - y, Math.round((bottom - top) * scaleY)));
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d");
	if (!context) throw new Error("Browser capture canvas is unavailable");
	context.drawImage(video, x, y, width, height, 0, 0, width, height);
	const dataUrl = canvas.toDataURL("image/png");
	canvas.width = 0;
	canvas.height = 0;
	const comma = dataUrl.indexOf(",");
	if (comma < 0) throw new Error("Browser capture encoding failed");
	return { data: dataUrl.slice(comma + 1), width, height };
}

function devicesFor(viewport: Viewport): readonly DevicePreset[] | null {
	if (viewport === "mobile") return PHONES;
	if (viewport === "tablet") return TABLETS;
	return null;
}

function activeChatSessionId(workspaceId: string): string | null {
	const state = useAppStore.getState();
	const tabId = state.activeTabByWorkspace[workspaceId];
	const tab = (state.tabsByWorkspace[workspaceId] ?? []).find(
		(candidate) => candidate.id === tabId,
	);
	return tab?.kind === "chat" ? tab.sessionId : null;
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
			const next = Math.min(0.9, Math.max(0.1, Math.max(0, bounds.width - 24) / frameWidth));
			setScale(next);
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(host);
		return () => observer.disconnect();
	}, [frameWidth]);

	return (
		<div
			ref={hostRef}
			className="flex h-full min-h-0 w-full items-start justify-center overflow-y-auto overflow-x-hidden bg-sunken p-8"
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
	const [session, setSession] = useState<BrowserSession | null>(null);
	const [ports, setPorts] = useState<DevServerPort[]>([]);
	const [urlInput, setUrlInput] = useState("");
	const [editingUrl, setEditingUrl] = useState(false);
	const [viewport, setViewport] = useState<Viewport>("desktop");
	const [deviceId, setDeviceId] = useState(PHONES[0]?.id ?? "");
	const [captureIntroOpen, setCaptureIntroOpen] = useState(false);
	const [capturing, setCapturing] = useState(false);
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
	const captureButtonRef = useRef<HTMLButtonElement>(null);
	const captureVideo = useRef<HTMLVideoElement>(null);
	const captureStream = useRef<MediaStream | null>(null);
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

	const stopCaptureStream = useCallback(() => {
		const stream = captureStream.current;
		captureStream.current = null;
		if (stream) for (const track of stream.getTracks()) track.stop();
		if (captureVideo.current) captureVideo.current.srcObject = null;
	}, []);

	useEffect(() => () => stopCaptureStream(), [stopCaptureStream]);
	useEffect(() => {
		if (suspended) stopCaptureStream();
	}, [stopCaptureStream, suspended]);

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
		});
		return stream;
	}, [t]);

	const capture = async () => {
		const sessionId = activeChatSessionId(workspaceId);
		const url = activeTab?.url ?? "about:blank";
		if (!sessionId || !activeTab || url === "about:blank") {
			toast.error(t("browser.captureNoChat"));
			return;
		}
		const target = viewport === "desktop" ? iframeRef.current : deviceFrameRef.current;
		const clip = viewport === "desktop" ? null : deviceHostRef.current;
		const deviceLabel = device ? t(device.label) : t("browser.viewport.desktop");
		const button = captureButtonRef.current;
		const previousVisibility = button?.style.visibility ?? "";
		if (button) button.style.visibility = "hidden";
		setCapturing(true);
		let saved: BrowserCapture | null = null;
		let frame: CapturedFrame | null = null;
		try {
			await ensureCaptureStream();
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			);
			frame = await captureVisibleFrame(captureVideo.current, target, clip);
			saved = await getTransport().request("browser.capture.save", {
				workspaceId,
				data: frame.data,
				mimeType: "image/png",
				url,
				device: deviceLabel,
				width: frame.width,
				height: frame.height,
			});
		} catch (error) {
			const name = error instanceof DOMException ? error.name : "";
			if (name === "NotAllowedError" || name === "AbortError") {
				toast.info(t("browser.captureCancelled"));
			} else if (name === "NotSupportedError") {
				toast.error(t("browser.captureUnsupported"));
			} else {
				toast.error(errorText(error, t("browser.captureFailed")));
			}
		}
		setCapturing(false);
		if (button) button.style.visibility = previousVisibility;
		if (!saved || !frame) return;
		const note = t("browser.captureNote", {
			path: saved.path,
			device: deviceLabel,
			width: device?.width ?? frame.width,
			height: device?.height ?? frame.height,
			url,
		});
		announceBrowserCapture({
			workspaceId,
			sessionId,
			captureId: saved.id,
			fileName: saved.fileName,
			path: saved.path,
			mimeType: "image/png",
			content: { type: "image", mimeType: "image/png", data: frame.data },
			width: frame.width,
			height: frame.height,
			device: deviceLabel,
			url,
			note,
		});
		toast.success(t("browser.captureSaved"));
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
		<div
			ref={rootRef}
			data-testid="browser-pane"
			className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
		>
			<video ref={captureVideo} className="hidden" muted playsInline />
			<header className="flex h-panel-header-row shrink-0 items-center gap-8 border-border-default border-b px-12">
				<RiGlobalLine className="size-16 shrink-0 text-text-muted" aria-hidden="true" />
				<h2 className="min-w-0 flex-1 truncate tr-title-compact text-text-default">
					{t("browser.title")}
				</h2>
				{activeTab && activeTab.url !== "about:blank" ? (
					<>
						<IconButton
							icon={RiCodeSSlashLine}
							label={t("browser.inspect")}
							variant="ghost"
							size="m"
							selected={snapshot !== null}
							loading={reading}
							onClick={() => void readPage()}
						/>
						<IconButton
							icon={RiExternalLinkLine}
							label={t("browser.copyUrl")}
							variant="ghost"
							size="m"
							onClick={() => void copyUrl()}
						/>
					</>
				) : null}
				<IconButton
					icon={RiRefreshLine}
					label={t("browser.refresh")}
					variant="ghost"
					size="m"
					disabled={!supported}
					onClick={() => {
						void loadPorts();
						if (session) {
							getTransport()
								.request("browser.state", { workspaceId })
								.then(setSession)
								.catch(() => undefined);
						}
					}}
				/>
			</header>

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
					<div className="flex items-center gap-2">
						{(["desktop", "tablet", "mobile"] as const).map((preset) => (
							<Button
								key={preset}
								variant="ghost"
								size="s"
								selected={viewport === preset}
								data-testid={`browser-viewport-${preset}`}
								onClick={() => changeViewport(preset)}
								aria-label={t(VIEWPORT_KEYS[preset])}
							>
								{t(VIEWPORT_KEYS[preset])}
							</Button>
						))}
					</div>
				</div>

				{devices ? (
					<div className="grid min-w-0 grid-cols-3 gap-4 border-border-default border-b px-8 py-4">
						{devices.map((candidate) => (
							<Button
								key={candidate.id}
								variant="ghost"
								size="s"
								selected={device?.id === candidate.id}
								data-testid={`browser-device-${candidate.id}`}
								onClick={() => setDeviceId(candidate.id)}
							>
								<span className="flex min-w-0 flex-col items-start">
									<span className="w-full truncate tr-text-metadata">{t(candidate.label)}</span>
									<span className="text-text-subtle tr-text-metadata">
										{candidate.width}×{candidate.height}
									</span>
								</span>
							</Button>
						))}
					</div>
				) : null}

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
							<Button
								ref={captureButtonRef}
								variant="primary"
								size="m"
								iconLeft={RiScreenshotLine}
								loading={capturing}
								className="absolute right-12 bottom-64 z-20 shadow-[var(--shadow-md)]"
								data-testid="browser-capture"
								onClick={() => {
									if (captureStream.current) void capture();
									else setCaptureIntroOpen(true);
								}}
							>
								{t("browser.capture")}
							</Button>
							<p className="shrink-0 border-border-default border-t px-12 py-4 text-text-subtle tr-text-metadata">
								{viewport === "desktop"
									? t("browser.frameHint")
									: t("browser.deviceHint", {
											device: device ? t(device.label) : "",
										})}
							</p>
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
				onConfirm={() => void capture()}
			/>
		</div>
	);
}
