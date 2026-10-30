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
} from "@remixicon/react";
import {
	BROWSER_LIMITS,
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
import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "../lib";
import { toast, useAppStore } from "../store";
import { errorText, getTransport } from "../transport";

type Viewport = "desktop" | "tablet" | "mobile";

const VIEWPORT_CLASS: Record<Viewport, string> = {
	desktop: "max-w-full",
	tablet: "max-w-[820px]",
	mobile: "max-w-[390px]",
};

const VIEWPORT_KEYS = {
	desktop: "browser.viewport.desktop",
	tablet: "browser.viewport.tablet",
	mobile: "browser.viewport.mobile",
} as const satisfies Record<Viewport, MessageKey>;

const INPUT_CLASS =
	"min-h-32 min-w-0 flex-1 rounded-sm border border-control-border-default bg-control-bg px-8 tr-code-text text-text-default outline-none placeholder:text-text-muted focus-visible:border-control-border-active";

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
	const hideTimer = useRef<number | null>(null);
	const history = useRef<string[]>([]);
	const historyIndex = useRef(-1);
	const lastUrl = useRef("about:blank");

	const activeTab = session?.tabs.find((tab) => tab.id === session.activeTabId) ?? null;

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
								onClick={() => setViewport(preset)}
								aria-label={t(VIEWPORT_KEYS[preset])}
							>
								{t(VIEWPORT_KEYS[preset])}
							</Button>
						))}
					</div>
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
						<div className="flex h-full min-h-0 flex-col">
							<div
								className={cn(
									"mx-auto min-h-0 w-full flex-1 overflow-hidden",
									VIEWPORT_CLASS[viewport],
								)}
							>
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
							<p className="shrink-0 border-border-default border-t px-12 py-4 text-text-subtle tr-text-metadata">
								{t("browser.frameHint")}
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
		</div>
	);
}
