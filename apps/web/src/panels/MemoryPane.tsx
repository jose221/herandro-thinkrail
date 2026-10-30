import {
	RiAlertLine,
	RiCheckboxCircleLine,
	RiErrorWarningLine,
	RiRefreshLine,
	RiStopCircleLine,
} from "@remixicon/react";
import {
	type MemoryAnalysis,
	type MemoryCheckpoint,
	type MonitoredProcessKind,
	SYSTEM_MONITOR_LIMITS,
	type SystemResourceSnapshot,
	WORKSPACE_TOOLS_PROTOCOL_VERSION,
} from "@thinkrail/contracts";
import type { MessageKey } from "@thinkrail/locales";
import { useT } from "@thinkrail/locales/react";
import { Button, IconButton } from "@thinkrail/ui/button";
import { cn } from "@thinkrail/ui/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast, useAppStore } from "../store";
import { errorText, getTransport } from "../transport";
import { ConfirmDialog } from "./ConfirmDialog";

const KIND_KEYS: Record<MonitoredProcessKind, MessageKey> = {
	host: "memory.kind.host",
	terminal: "memory.kind.terminal",
	"dev-server": "memory.kind.devServer",
	android: "memory.kind.android",
	other: "memory.kind.other",
};

const VERDICT_KEYS: Record<MemoryAnalysis["verdict"], MessageKey> = {
	HEALTHY: "memory.verdict.healthy",
	WARNING: "memory.verdict.warning",
	LEAK_DETECTED: "memory.verdict.leak",
};

const INPUT_CLASS =
	"min-h-28 min-w-0 rounded-sm border border-control-border-default bg-control-bg px-8 tr-text-ui text-text-default outline-none placeholder:text-text-muted focus-visible:border-control-border-active";

interface Point {
	at: number;
	total: number;
	host: number;
}

function mb(bytes: number): string {
	const value = bytes / (1024 * 1024);
	return value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${value.toFixed(1)} MB`;
}

function elapsed(seconds: number): string {
	if (seconds >= 3600)
		return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
	if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
	return `${seconds}s`;
}

function line(points: Point[], key: "total" | "host", max: number): string {
	if (points.length === 0) return "";
	const step = points.length === 1 ? 0 : 100 / (points.length - 1);
	return points
		.map((point, index) => {
			const x = index * step;
			const y = 38 - (max > 0 ? (point[key] / max) * 34 : 0);
			return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
		})
		.join(" ");
}

export function MemoryPane({ workspaceId }: { workspaceId: string }) {
	const t = useT();
	const protocolVersion = useAppStore((state) => state.protocolVersion);
	const supported = protocolVersion !== null && protocolVersion >= WORKSPACE_TOOLS_PROTOCOL_VERSION;
	const [scope, setScope] = useState<"workspace" | "all">("workspace");
	const [snapshot, setSnapshot] = useState<SystemResourceSnapshot | null>(null);
	const [history, setHistory] = useState<Point[]>([]);
	const [loading, setLoading] = useState(true);
	const [failed, setFailed] = useState(false);
	const [checkpoints, setCheckpoints] = useState<MemoryCheckpoint[]>([]);
	const [analysis, setAnalysis] = useState<MemoryAnalysis | null>(null);
	const [capturing, setCapturing] = useState(false);
	const [analyzing, setAnalyzing] = useState(false);
	const [tag, setTag] = useState("");
	const [killTarget, setKillTarget] = useState<{ pid: number; name: string } | null>(null);
	const [visible, setVisible] = useState(true);
	const rootRef = useRef<HTMLDivElement>(null);

	const load = useCallback(async () => {
		if (!supported) return;
		const params = scope === "workspace" ? { workspaceId } : {};
		try {
			const next = await getTransport().request("system.resources", params);
			setSnapshot(next);
			setFailed(false);
			const total = next.processes.reduce((sum, entry) => sum + entry.rssBytes, 0);
			setHistory((current) => {
				const point = { at: next.at, total, host: next.host.rssBytes };
				const last = current.at(-1);
				if (last && last.at === point.at) return current;
				return [...current.slice(-119), point];
			});
		} catch {
			setFailed(true);
		}
		setLoading(false);
	}, [scope, supported, workspaceId]);

	const loadCheckpoints = useCallback(async () => {
		if (!supported) return;
		try {
			setCheckpoints(await getTransport().request("system.resources.checkpoints", { workspaceId }));
		} catch {}
	}, [supported, workspaceId]);

	useEffect(() => {
		if (!supported || !rootRef.current) return;
		const observer = new IntersectionObserver(
			([entry]) => setVisible(entry?.isIntersecting ?? true),
			{ threshold: 0.02 },
		);
		observer.observe(rootRef.current);
		return () => observer.disconnect();
	}, [supported]);

	useEffect(() => {
		if (!supported) {
			setLoading(protocolVersion === null);
			return;
		}
		if (!visible) return;
		setLoading(true);
		void load();
		void loadCheckpoints();
		const timer = window.setInterval(() => void load(), 5_000);
		return () => window.clearInterval(timer);
	}, [load, loadCheckpoints, protocolVersion, supported, visible]);

	useEffect(() => {
		setAnalysis(null);
	}, [scope]);

	const total = useMemo(
		() => snapshot?.processes.reduce((sum, entry) => sum + entry.rssBytes, 0) ?? 0,
		[snapshot],
	);
	const maxPoint = useMemo(
		() => Math.max(1, ...history.map((point) => Math.max(point.total, point.host))),
		[history],
	);

	const capture = async () => {
		const name = tag.trim();
		if (name === "" || capturing) return;
		setCapturing(true);
		try {
			await getTransport().request("system.resources.checkpoint", {
				workspaceId,
				tag: name,
			});
			setTag("");
			await loadCheckpoints();
			toast.success(t("memory.checkpointCaptured"));
		} catch (error) {
			toast.error(errorText(error, t("memory.checkpointFailed")));
		}
		setCapturing(false);
	};

	const analyze = async () => {
		if (analyzing) return;
		setAnalyzing(true);
		try {
			setAnalysis(await getTransport().request("system.resources.analyze", { workspaceId }));
		} catch (error) {
			toast.error(errorText(error, t("memory.analyzeFailed")));
		}
		setAnalyzing(false);
	};

	const kill = async () => {
		if (!killTarget) return;
		try {
			await getTransport().request("system.process.kill", {
				pid: killTarget.pid,
				signal: "SIGTERM",
			});
			toast.success(t("memory.killed", { name: killTarget.name }));
			void load();
		} catch (error) {
			toast.error(errorText(error, t("memory.killFailed")));
		}
		setKillTarget(null);
	};

	const verdictTone = (verdict: MemoryAnalysis["verdict"]) =>
		verdict === "HEALTHY"
			? "text-feedback-success"
			: verdict === "WARNING"
				? "text-feedback-warning"
				: "text-feedback-error";

	return (
		<div
			ref={rootRef}
			data-testid="memory-pane"
			className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
		>
			<header className="flex h-panel-header-row shrink-0 items-center gap-8 border-border-default border-b px-12">
				<RiErrorWarningLine className="size-16 shrink-0 text-text-muted" aria-hidden="true" />
				<h2 className="min-w-0 flex-1 truncate tr-title-compact text-text-default">
					{t("memory.title")}
				</h2>
				<Button
					variant="ghost"
					size="s"
					selected={scope === "workspace"}
					onClick={() => setScope("workspace")}
				>
					{t("memory.scopeWorkspace")}
				</Button>
				<Button variant="ghost" size="s" selected={scope === "all"} onClick={() => setScope("all")}>
					{t("memory.scopeAll")}
				</Button>
				<IconButton
					icon={RiRefreshLine}
					label={t("memory.refresh")}
					variant="ghost"
					size="m"
					disabled={!supported || loading}
					onClick={() => void load()}
				/>
			</header>

			<div className="min-h-0 min-w-0 flex-1 overflow-auto p-panel-inset">
				{!supported ? (
					<p className="text-text-muted tr-text-ui">
						{protocolVersion === null ? t("memory.loading") : t("memory.hostTooOld")}
					</p>
				) : failed && !snapshot ? (
					<p className="text-feedback-error tr-text-ui">{t("memory.loadFailed")}</p>
				) : loading && !snapshot ? (
					<p className="text-text-muted tr-text-ui">{t("memory.loading")}</p>
				) : snapshot ? (
					<div className="flex min-w-0 flex-col gap-16">
						{!snapshot.supported ? (
							<p className="text-feedback-warning tr-text-ui">
								{snapshot.note || t("memory.unsupported")}
							</p>
						) : null}

						<div className="grid min-w-0 grid-cols-2 gap-8 lg:grid-cols-4">
							<div className="rounded-sm border border-border-default p-8">
								<p className="text-text-muted tr-text-metadata">{t("memory.hostRss")}</p>
								<p className="tr-title-compact text-text-default">{mb(snapshot.host.rssBytes)}</p>
							</div>
							<div className="rounded-sm border border-border-default p-8">
								<p className="text-text-muted tr-text-metadata">{t("memory.workspaceRss")}</p>
								<p className="tr-title-compact text-text-default">{mb(total)}</p>
							</div>
							<div className="rounded-sm border border-border-default p-8">
								<p className="text-text-muted tr-text-metadata">{t("memory.processCount")}</p>
								<p className="tr-title-compact text-text-default">{snapshot.processes.length}</p>
							</div>
							<div className="rounded-sm border border-border-default p-8">
								<p className="text-text-muted tr-text-metadata">{t("memory.systemMemory")}</p>
								<p className="tr-title-compact text-text-default">
									{mb(snapshot.host.usedBytes)} / {mb(snapshot.host.totalBytes)}
								</p>
							</div>
						</div>

						<section className="min-w-0 rounded-sm border border-border-default p-8">
							<div className="mb-4 flex items-center gap-8">
								<h3 className="min-w-0 flex-1 tr-title-compact text-text-default">
									{t("memory.chartTitle")}
								</h3>
								<span className="flex items-center gap-2 text-text-subtle tr-text-metadata">
									<span className="inline-block size-4 rounded-full bg-primary" />
									{t("memory.total")}
								</span>
								<span className="flex items-center gap-2 text-text-subtle tr-text-metadata">
									<span className="inline-block size-4 rounded-full bg-feedback-warning" />
									{t("memory.host")}
								</span>
							</div>
							<svg
								viewBox="0 0 100 40"
								preserveAspectRatio="none"
								className="h-24 w-full"
								role="img"
								aria-label={t("memory.chartTitle")}
							>
								<line x1="0" y1="38" x2="100" y2="38" className="stroke-border-default" />
								<path d={line(history, "total", maxPoint)} className="fill-none stroke-primary" />
								<path
									d={line(history, "host", maxPoint)}
									className="fill-none stroke-feedback-warning"
								/>
							</svg>
							<div className="flex justify-between text-text-subtle tr-text-metadata">
								<span>{mb(maxPoint)}</span>
								<span>
									{history.length > 0 ? t("memory.samples", { count: history.length }) : ""}
								</span>
							</div>
						</section>

						<section className="flex min-w-0 flex-col gap-8">
							<h3 className="tr-title-compact text-text-default">{t("memory.processes")}</h3>
							<div className="min-w-0 overflow-x-auto rounded-sm border border-border-default">
								<table className="w-full min-w-[36rem] border-collapse">
									<thead>
										<tr className="border-border-default border-b text-left text-text-muted tr-text-metadata">
											<th className="px-8 py-4 tr-text-eyebrow">{t("memory.process")}</th>
											<th className="px-8 py-4 tr-text-eyebrow">{t("memory.pid")}</th>
											<th className="px-8 py-4 tr-text-eyebrow">{t("memory.kindLabel")}</th>
											<th className="px-8 py-4 text-right tr-text-eyebrow">{t("memory.rss")}</th>
											<th className="px-8 py-4 text-right tr-text-eyebrow">{t("memory.cpu")}</th>
											<th className="px-8 py-4 text-right tr-text-eyebrow">{t("memory.uptime")}</th>
											<th className="w-12 px-8 py-4" />
										</tr>
									</thead>
									<tbody>
										{snapshot.processes.slice(0, SYSTEM_MONITOR_LIMITS.processes).map((entry) => (
											<tr
												key={entry.pid}
												className="border-border-default border-b last:border-b-0"
											>
												<td className="max-w-[16rem] truncate px-8 py-4 tr-text-metadata text-text-default">
													{entry.name}
												</td>
												<td className="px-8 py-4 tr-code-text text-text-muted">{entry.pid}</td>
												<td className="px-8 py-4 tr-text-metadata text-text-muted">
													{t(KIND_KEYS[entry.kind])}
												</td>
												<td className="px-8 py-4 text-right tr-code-text text-text-default">
													{mb(entry.rssBytes)}
												</td>
												<td className="px-8 py-4 text-right tr-code-text text-text-muted">
													{entry.cpuPercent.toFixed(1)}%
												</td>
												<td className="px-8 py-4 text-right tr-code-text text-text-muted">
													{elapsed(entry.elapsedSeconds)}
												</td>
												<td className="px-8 py-4">
													<IconButton
														icon={RiStopCircleLine}
														label={t("memory.kill")}
														variant="ghost"
														size="s"
														tone="danger"
														onClick={() => setKillTarget({ pid: entry.pid, name: entry.name })}
													/>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</section>

						<section className="flex min-w-0 flex-col gap-8 rounded-sm border border-border-default p-8">
							<div className="flex min-w-0 flex-wrap items-center gap-8">
								<h3 className="min-w-0 flex-1 tr-title-compact text-text-default">
									{t("memory.checkpoints")}
								</h3>
								<span className="text-text-subtle tr-text-metadata">
									{t("memory.checkpointsHint")}
								</span>
							</div>
							<div className="flex min-w-0 flex-wrap items-end gap-4">
								<input
									className={cn(INPUT_CLASS, "flex-1")}
									value={tag}
									onChange={(event) => setTag(event.currentTarget.value)}
									placeholder={t("memory.checkpointPlaceholder")}
									aria-label={t("memory.checkpointPlaceholder")}
									maxLength={120}
								/>
								<Button
									variant="outline"
									size="m"
									loading={capturing}
									disabled={capturing || tag.trim() === ""}
									onClick={() => void capture()}
								>
									{t("memory.capture")}
								</Button>
								<Button
									variant="primary"
									size="m"
									iconLeft={RiAlertLine}
									loading={analyzing}
									disabled={analyzing || checkpoints.length < 2}
									onClick={() => void analyze()}
								>
									{t("memory.analyze")}
								</Button>
							</div>
							{checkpoints.length === 0 ? (
								<p className="text-text-muted tr-text-metadata">{t("memory.noCheckpoints")}</p>
							) : (
								<ul className="flex min-w-0 flex-col gap-2">
									{checkpoints.slice(0, 10).map((checkpoint, index) => {
										const previous = checkpoints[index + 1];
										const delta = previous ? checkpoint.totalRssBytes - previous.totalRssBytes : 0;
										return (
											<li
												key={checkpoint.id}
												className="flex min-w-0 items-center gap-8 border-border-default border-b py-4 last:border-b-0"
											>
												<span className="min-w-0 flex-1 truncate text-text-default tr-text-metadata">
													{checkpoint.tag}
												</span>
												<span className="shrink-0 tr-code-text text-text-muted">
													{mb(checkpoint.totalRssBytes)}
												</span>
												<span
													className={cn(
														"shrink-0 tr-code-text",
														delta > SYSTEM_MONITOR_LIMITS.suspectGrowthBytes
															? "text-feedback-warning"
															: "text-text-subtle",
													)}
												>
													{previous ? `${delta >= 0 ? "+" : ""}${mb(delta)}` : "—"}
												</span>
												<span className="shrink-0 text-text-subtle tr-text-metadata">
													{new Date(checkpoint.at).toLocaleTimeString()}
												</span>
											</li>
										);
									})}
								</ul>
							)}
							{analysis ? (
								<div
									data-testid="memory-analysis"
									className="flex min-w-0 flex-col gap-4 rounded-sm bg-sunken p-8"
								>
									<p className={cn("tr-title-compact", verdictTone(analysis.verdict))}>
										{t(VERDICT_KEYS[analysis.verdict])}
									</p>
									<p className="text-text-default tr-text-metadata">{analysis.summary}</p>
									{analysis.suspects.length > 0 ? (
										<ul className="flex flex-col gap-2">
											{analysis.suspects.map((suspect) => (
												<li key={suspect.pid} className="text-feedback-warning tr-text-metadata">
													{t("memory.suspect", {
														name: suspect.name,
														pid: suspect.pid,
														delta: mb(suspect.deltaBytes),
														percent: suspect.growthPercent,
													})}
												</li>
											))}
										</ul>
									) : (
										<p className="flex items-center gap-4 text-feedback-success tr-text-metadata">
											<RiCheckboxCircleLine className="size-14" /> {t("memory.noSuspects")}
										</p>
									)}
									<ul className="flex flex-col gap-2">
										{analysis.recommendations.map((recommendation) => (
											<li key={recommendation} className="text-text-muted tr-text-metadata">
												· {recommendation}
											</li>
										))}
									</ul>
								</div>
							) : null}
						</section>
					</div>
				) : null}
			</div>

			<ConfirmDialog
				open={killTarget !== null}
				onOpenChange={(open) => {
					if (!open) setKillTarget(null);
				}}
				title={t("memory.killTitle")}
				description={
					killTarget
						? t("memory.killDescription", { name: killTarget.name, pid: killTarget.pid })
						: undefined
				}
				confirmLabel={t("memory.kill")}
				destructive
				confirmTestId="memory-kill-confirm"
				onConfirm={() => void kill()}
			/>
		</div>
	);
}
