import {
	RiCloseLine,
	RiDeleteBinLine,
	RiFileCopyLine,
	RiRefreshLine,
	RiSparklingLine,
} from "@remixicon/react";
import type {
	BrowserConsoleEntry,
	BrowserNetworkEntry,
	BrowserStorageSnapshot,
} from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { Button, IconButton } from "@thinkrail/ui/button";
import { cn } from "@thinkrail/ui/utils";
import { useCallback, useEffect, useMemo, useState } from "react";
import { copyText } from "../lib";
import { toast } from "../store";
import { errorText, getTransport } from "../transport";

type DevToolsTab = "console" | "network" | "storage";
type ConsoleFilter = "all" | "error" | "warn";

const INPUT_CLASS =
	"min-h-28 min-w-0 rounded-sm border border-control-border-default bg-control-bg px-8 tr-code-text text-text-default placeholder:text-text-muted focus-visible:border-control-border-active focus-visible:focus-ring";

function isCorsOrBlocked(entry: BrowserNetworkEntry): boolean {
	if (entry.corsError || entry.blockedReason) return true;
	if (entry.status === 0 && entry.error) return true;
	if (!entry.error) return false;
	return /cors|err_failed|err_blocked|net::err_/i.test(entry.error);
}

function buildCurlCommand(entry: BrowserNetworkEntry): string {
	const escapedUrl = entry.url.replaceAll("'", "'\\''");
	const parts = [`curl -X ${entry.method} '${escapedUrl}'`];
	for (const [key, value] of Object.entries(entry.requestHeaders ?? {})) {
		if (key.toLowerCase() === "content-length" || key.toLowerCase() === "host") continue;
		const safeVal = `${key}: ${value}`.replaceAll("'", "'\\''");
		parts.push(`-H '${safeVal}'`);
	}
	return parts.join(" \\\n  ");
}

function levelBadgeClass(level: BrowserConsoleEntry["level"]): string {
	if (level === "error") return "text-feedback-error";
	if (level === "warn") return "text-feedback-warning";
	return "text-text-muted";
}

function networkStatusClass(entry: BrowserNetworkEntry): string {
	if (
		entry.error ||
		entry.corsError ||
		entry.blockedReason ||
		entry.status >= 400 ||
		entry.status === 0
	) {
		return "text-feedback-error";
	}
	if (entry.status >= 300) {
		return "text-feedback-warning";
	}
	return "text-feedback-success";
}

export function BrowserDevTools({
	workspaceId,
	activeUrl,
	consoleLogs,
	networkLogs,
	onClearConsole,
	onClearNetwork,
	onAskAi,
	onClose,
}: {
	workspaceId: string;
	activeUrl: string;
	consoleLogs: BrowserConsoleEntry[];
	networkLogs: BrowserNetworkEntry[];
	onClearConsole: () => void;
	onClearNetwork: () => void;
	onAskAi: (promptText: string) => void;
	onClose: () => void;
}) {
	const t = useT();
	const [tab, setTab] = useState<DevToolsTab>("console");
	const [consoleFilter, setConsoleFilter] = useState<ConsoleFilter>("all");
	const [consoleSearch, setConsoleSearch] = useState("");
	const [evalExpr, setEvalExpr] = useState("");
	const [evalBusy, setEvalBusy] = useState(false);
	const [evalOutput, setEvalOutput] = useState<
		Array<{ expr: string; result: string; error?: boolean }>
	>([]);

	const [networkSearch, setNetworkSearch] = useState("");
	const [networkErrorsOnly, setNetworkErrorsOnly] = useState(false);
	const [storage, setStorage] = useState<BrowserStorageSnapshot | null>(null);
	const [storageBusy, setStorageBusy] = useState(false);

	const filteredConsole = useMemo(() => {
		const needle = consoleSearch.trim().toLowerCase();
		return consoleLogs.filter((entry) => {
			if (consoleFilter === "error" && entry.level !== "error") return false;
			if (consoleFilter === "warn" && entry.level !== "warn") return false;
			if (!needle) return true;
			return (
				entry.text.toLowerCase().includes(needle) ||
				(entry.url?.toLowerCase().includes(needle) ?? false)
			);
		});
	}, [consoleFilter, consoleLogs, consoleSearch]);

	const filteredNetwork = useMemo(() => {
		const needle = networkSearch.trim().toLowerCase();
		return networkLogs.filter((entry) => {
			const failed =
				Boolean(entry.error || entry.corsError || entry.blockedReason) ||
				entry.status === 0 ||
				entry.status >= 400;
			if (networkErrorsOnly && !failed) return false;
			if (!needle) return true;
			return (
				entry.url.toLowerCase().includes(needle) ||
				entry.method.toLowerCase().includes(needle) ||
				String(entry.status).includes(needle) ||
				(entry.error?.toLowerCase().includes(needle) ?? false) ||
				(entry.corsError?.toLowerCase().includes(needle) ?? false)
			);
		});
	}, [networkErrorsOnly, networkLogs, networkSearch]);

	const loadStorage = useCallback(async () => {
		setStorageBusy(true);
		try {
			const snapshot = await getTransport().request("browser.storage", { workspaceId });
			setStorage(snapshot);
			setStorageBusy(false);
		} catch (error) {
			setStorageBusy(false);
			toast.error(errorText(error, t("browser.requestFailed")));
		}
	}, [t, workspaceId]);

	useEffect(() => {
		if (tab === "storage") {
			void loadStorage();
		}
	}, [tab, loadStorage, activeUrl]);

	const runEval = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const expr = evalExpr.trim();
		if (!expr || evalBusy) return;
		setEvalBusy(true);
		try {
			const res = await getTransport().request("browser.evaluate", {
				workspaceId,
				expression: expr,
			});
			setEvalOutput((prev) => [
				...prev.slice(-24),
				res.error
					? { expr, result: res.error, error: true }
					: {
							expr,
							result:
								typeof res.value === "string" ? res.value : JSON.stringify(res.value, null, 2),
						},
			]);
			setEvalExpr("");
			setEvalBusy(false);
		} catch (error) {
			setEvalBusy(false);
			toast.error(errorText(error, t("browser.requestFailed")));
		}
	};

	const askConsoleEntry = (entry: BrowserConsoleEntry) => {
		const location = entry.url ? ` (${entry.url}${entry.line ? `:${entry.line}` : ""})` : "";
		onAskAi(
			`Browser console ${entry.level} on ${activeUrl}${location}:\n\`\`\`\n${entry.text}\n\`\`\``,
		);
	};

	const askNetworkEntry = (entry: BrowserNetworkEntry) => {
		const detail = entry.corsError ?? entry.blockedReason ?? entry.error;
		const statusLabel = detail ? `ERROR: ${detail}` : `HTTP ${entry.status}`;
		const corsNote = isCorsOrBlocked(entry)
			? "\nNote: Request failed at browser level (possible CORS or blocked origin)."
			: "";
		onAskAi(
			`Inspect this failed browser network request on ${activeUrl}:\n${entry.method} ${entry.url}\nStatus: ${statusLabel}${corsNote}`,
		);
	};

	return (
		<section
			data-testid="browser-devtools"
			aria-label={t("browser.devtools")}
			className="flex h-[42%] min-h-[14rem] shrink-0 flex-col border-border-default border-t bg-container-elevated-bg"
		>
			<div className="flex shrink-0 items-center gap-4 border-border-default border-b px-8 py-4">
				<Button
					variant="ghost"
					size="s"
					selected={tab === "console"}
					onClick={() => setTab("console")}
					data-testid="browser-devtools-tab-console"
				>
					{t("browser.console.tab", { count: consoleLogs.length })}
				</Button>
				<Button
					variant="ghost"
					size="s"
					selected={tab === "network"}
					onClick={() => setTab("network")}
					data-testid="browser-devtools-tab-network"
				>
					{t("browser.network.tab", { count: networkLogs.length })}
				</Button>
				<Button
					variant="ghost"
					size="s"
					selected={tab === "storage"}
					onClick={() => setTab("storage")}
					data-testid="browser-devtools-tab-storage"
				>
					{t("browser.storage.tab")}
				</Button>
				<div className="ml-auto">
					<IconButton
						icon={RiCloseLine}
						label={t("common.close")}
						variant="ghost"
						size="s"
						onClick={onClose}
					/>
				</div>
			</div>

			{tab === "console" ? (
				<div className="flex min-h-0 flex-1 flex-col">
					<div className="flex shrink-0 flex-wrap items-center gap-4 border-border-muted border-b px-8 py-4">
						{(["all", "error", "warn"] as const).map((filter) => (
							<Button
								key={filter}
								variant="ghost"
								size="s"
								selected={consoleFilter === filter}
								onClick={() => setConsoleFilter(filter)}
							>
								{filter === "all"
									? t("browser.console.filterAll")
									: filter === "error"
										? t("browser.console.filterErrors")
										: t("browser.console.filterWarnings")}
							</Button>
						))}
						<input
							value={consoleSearch}
							onChange={(event) => setConsoleSearch(event.currentTarget.value)}
							placeholder={t("browser.console.filterPlaceholder")}
							aria-label={t("browser.console.filterPlaceholder")}
							className={cn(INPUT_CLASS, "flex-1")}
						/>
						<IconButton
							icon={RiDeleteBinLine}
							label={t("browser.console.clear")}
							variant="ghost"
							size="s"
							onClick={onClearConsole}
						/>
					</div>
					<div className="min-h-0 flex-1 overflow-auto p-8">
						{filteredConsole.length === 0 && evalOutput.length === 0 ? (
							<p className="py-12 text-center text-text-subtle tr-text-metadata">
								{t("browser.console.empty")}
							</p>
						) : (
							<ul className="flex flex-col gap-4">
								{filteredConsole.map((entry) => (
									<li
										key={entry.id}
										className="group flex items-start gap-8 rounded-sm border border-border-muted bg-container-content-bg px-8 py-4"
									>
										<span
											className={cn(
												"shrink-0 uppercase tr-code-text",
												levelBadgeClass(entry.level),
											)}
										>
											{entry.level}
										</span>
										<div className="min-w-0 flex-1">
											<pre className="whitespace-pre-wrap break-all tr-code-text text-text-default">
												{entry.text}
											</pre>
											{entry.url ? (
												<p className="truncate text-text-subtle tr-text-metadata">
													{entry.url}
													{entry.line ? `:${entry.line}` : ""}
												</p>
											) : null}
										</div>
										<Button
											variant="ghost"
											size="s"
											iconLeft={RiSparklingLine}
											onClick={() => askConsoleEntry(entry)}
											className="shrink-0 opacity-80 hover:opacity-100"
										>
											{t("browser.console.askAi")}
										</Button>
									</li>
								))}
								{evalOutput.map((item, idx) => (
									<li
										key={`${idx}-${item.expr}`}
										className="flex flex-col gap-2 rounded-sm border border-border-muted bg-container-content-bg px-8 py-4 tr-code-text"
									>
										<span className="text-text-muted">{`> ${item.expr}`}</span>
										<pre
											className={cn(
												"whitespace-pre-wrap break-all tr-code-text",
												item.error ? "text-feedback-error" : "text-text-default",
											)}
										>
											{item.result}
										</pre>
									</li>
								))}
							</ul>
						)}
					</div>
					<form
						onSubmit={(event) => void runEval(event)}
						className="flex shrink-0 items-center gap-4 border-border-default border-t px-8 py-4"
					>
						<input
							data-testid="browser-console-eval"
							value={evalExpr}
							onChange={(event) => setEvalExpr(event.currentTarget.value)}
							placeholder={t("browser.console.evalPlaceholder")}
							aria-label={t("browser.console.evalPlaceholder")}
							spellCheck={false}
							autoComplete="off"
							className={cn(INPUT_CLASS, "flex-1")}
						/>
						<Button type="submit" size="s" loading={evalBusy} disabled={!evalExpr.trim()}>
							{t("browser.console.run")}
						</Button>
					</form>
				</div>
			) : null}

			{tab === "network" ? (
				<div className="flex min-h-0 flex-1 flex-col">
					<div className="flex shrink-0 flex-wrap items-center gap-4 border-border-muted border-b px-8 py-4">
						<Button
							variant="ghost"
							size="s"
							selected={networkErrorsOnly}
							onClick={() => setNetworkErrorsOnly((v) => !v)}
						>
							{t("browser.network.failedOnly")}
						</Button>
						<input
							value={networkSearch}
							onChange={(event) => setNetworkSearch(event.currentTarget.value)}
							placeholder={t("browser.network.filterPlaceholder")}
							aria-label={t("browser.network.filterPlaceholder")}
							className={cn(INPUT_CLASS, "flex-1")}
						/>
						<IconButton
							icon={RiDeleteBinLine}
							label={t("browser.network.clear")}
							variant="ghost"
							size="s"
							onClick={onClearNetwork}
						/>
					</div>
					<div className="min-h-0 flex-1 overflow-auto p-8">
						{filteredNetwork.length === 0 ? (
							<p className="py-12 text-center text-text-subtle tr-text-metadata">
								{t("browser.network.empty")}
							</p>
						) : (
							<ul className="flex flex-col gap-4">
								{filteredNetwork.map((entry) => (
									<li
										key={entry.id}
										className="flex flex-wrap items-center gap-8 rounded-sm border border-border-muted bg-container-content-bg px-8 py-4"
									>
										<span className="shrink-0 tr-code-text text-text-muted">{entry.method}</span>
										<span className={cn("shrink-0 tr-code-text", networkStatusClass(entry))}>
											{entry.error || entry.corsError || entry.blockedReason || entry.status === 0
												? t("browser.network.statusError")
												: entry.status}
										</span>
										<span
											className="min-w-0 flex-1 truncate tr-code-text text-text-default"
											title={entry.url}
										>
											{entry.url}
										</span>
										{entry.durationMs !== undefined ? (
											<span className="shrink-0 text-text-subtle tr-text-metadata">
												{t("browser.network.durationMs", { ms: entry.durationMs })}
											</span>
										) : null}
										{isCorsOrBlocked(entry) ? (
											<span className="shrink-0 rounded-sm bg-feedback-error-subtle px-4 py-2 text-feedback-error tr-text-metadata">
												{t("browser.network.corsSuspect")}
											</span>
										) : null}
										<IconButton
											icon={RiFileCopyLine}
											label={t("browser.network.copyCurl")}
											variant="ghost"
											size="s"
											onClick={() => {
												void copyText(buildCurlCommand(entry)).then((copied) => {
													if (copied) toast.success(t("browser.network.curlCopied"));
												});
											}}
										/>
										<Button
											variant="ghost"
											size="s"
											iconLeft={RiSparklingLine}
											onClick={() => askNetworkEntry(entry)}
										>
											{t("browser.network.askAi")}
										</Button>
									</li>
								))}
							</ul>
						)}
					</div>
				</div>
			) : null}

			{tab === "storage" ? (
				<div className="flex min-h-0 flex-1 flex-col">
					<div className="flex shrink-0 items-center justify-between border-border-muted border-b px-8 py-4">
						<span className="truncate text-text-muted tr-text-metadata">{activeUrl}</span>
						<Button
							variant="ghost"
							size="s"
							iconLeft={RiRefreshLine}
							loading={storageBusy}
							onClick={() => void loadStorage()}
						>
							{t("browser.storage.refresh")}
						</Button>
					</div>
					<div className="min-h-0 flex-1 overflow-auto p-8">
						{!storage || (storage.local.length === 0 && storage.session.length === 0) ? (
							<p className="py-12 text-center text-text-subtle tr-text-metadata">
								{t("browser.storage.empty")}
							</p>
						) : (
							<div className="flex flex-col gap-12">
								<div>
									<h4 className="mb-4 text-text-muted tr-title-compact">
										{t("browser.storage.local", { count: storage.local.length })}
									</h4>
									<ul className="flex flex-col gap-2">
										{storage.local.map((item) => (
											<li
												key={item.key}
												className="flex gap-8 rounded-sm border border-border-muted bg-container-content-bg px-8 py-4 tr-code-text"
											>
												<span className="shrink-0 text-text-muted">{item.key}</span>
												<span className="min-w-0 flex-1 break-all text-text-default">
													{item.value}
												</span>
											</li>
										))}
									</ul>
								</div>
								<div>
									<h4 className="mb-4 text-text-muted tr-title-compact">
										{t("browser.storage.session", { count: storage.session.length })}
									</h4>
									<ul className="flex flex-col gap-2">
										{storage.session.map((item) => (
											<li
												key={item.key}
												className="flex gap-8 rounded-sm border border-border-muted bg-container-content-bg px-8 py-4 tr-code-text"
											>
												<span className="shrink-0 text-text-muted">{item.key}</span>
												<span className="min-w-0 flex-1 break-all text-text-default">
													{item.value}
												</span>
											</li>
										))}
									</ul>
								</div>
							</div>
						)}
					</div>
				</div>
			) : null}
		</section>
	);
}
