import {
	RiAddLine,
	RiArrowDownSLine,
	RiCheckLine,
	RiFileCopyLine,
	RiGitBranchLine,
	RiRefreshLine,
	RiSubtractLine,
	RiUploadLine,
} from "@remixicon/react";
import {
	type GitControlBranches,
	type GitControlCommitFile,
	type GitControlFile,
	type GitControlLogEntry,
	type GitControlStatus,
	WORKSPACE_TOOLS_PROTOCOL_VERSION,
} from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { Button, IconButton } from "@thinkrail/ui/button";
import { cn } from "@thinkrail/ui/utils";
import { useCallback, useEffect, useMemo, useState } from "react";
import { copyText } from "../lib";
import { toast, useAppStore } from "../store";
import { errorText, getTransport } from "../transport";
import { PatchLinesView, PatchView, parsePatch } from "./GitPatch";

const INPUT_CLASS =
	"min-h-28 min-w-0 rounded-sm border border-control-border-default bg-control-bg px-8 tr-text-ui text-text-default outline-none placeholder:text-text-muted focus-visible:border-control-border-active disabled:border-control-disabled-border disabled:bg-control-disabled-bg disabled:text-control-disabled-text";

const STATUS_LABEL: Record<GitControlFile["status"], string> = {
	added: "A",
	modified: "M",
	deleted: "D",
	renamed: "R",
	untracked: "U",
};

const STATUS_CLASS: Record<GitControlFile["status"], string> = {
	added: "text-feedback-success",
	modified: "text-feedback-warning",
	deleted: "text-feedback-error",
	renamed: "text-primary",
	untracked: "text-text-muted",
};

interface DiffSelection {
	path: string;
	staged: boolean;
	diff: string;
	truncated: boolean;
}

interface CommitDetail {
	output: string;
	truncated: boolean;
	files: GitControlCommitFile[];
}

function relativeTime(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	const diff = Date.now() - date.getTime();
	const minutes = Math.floor(diff / 60_000);
	if (minutes < 1) return "0m";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d`;
	return date.toLocaleDateString();
}

function fileBase(path: string): string {
	return path.split("/").at(-1) ?? path;
}

export function GitPane({ workspaceId }: { workspaceId: string }) {
	const t = useT();
	const protocolVersion = useAppStore((state) => state.protocolVersion);
	const supported = protocolVersion !== null && protocolVersion >= WORKSPACE_TOOLS_PROTOCOL_VERSION;
	const [status, setStatus] = useState<GitControlStatus | null>(null);
	const [branches, setBranches] = useState<GitControlBranches | null>(null);
	const [log, setLog] = useState<GitControlLogEntry[]>([]);
	const [view, setView] = useState<"changes" | "history">("changes");
	const [selectedFile, setSelectedFile] = useState<{ path: string; staged: boolean } | null>(null);
	const [diff, setDiff] = useState<DiffSelection | null>(null);
	const [selectedCommit, setSelectedCommit] = useState<GitControlLogEntry | null>(null);
	const [selectedCommitPath, setSelectedCommitPath] = useState<string | null>(null);
	const [commitDetail, setCommitDetail] = useState<CommitDetail | null>(null);
	const [commitMessage, setCommitMessage] = useState("");
	const [branchName, setBranchName] = useState("");
	const [createOpen, setCreateOpen] = useState(false);
	const [filter, setFilter] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [failed, setFailed] = useState(false);

	const load = useCallback(async () => {
		if (!supported) return;
		setLoading(true);
		try {
			const [nextStatus, nextBranches, nextLog] = await Promise.all([
				getTransport().request("git.control.status", { workspaceId }),
				getTransport().request("git.control.branches", { workspaceId }),
				getTransport().request("git.control.log", { workspaceId, limit: 50 }),
			]);
			setStatus(nextStatus);
			setBranches(nextBranches);
			setLog(nextLog);
			setFailed(false);
		} catch {
			setFailed(true);
		}
		setLoading(false);
	}, [supported, workspaceId]);

	useEffect(() => {
		if (!supported) {
			setLoading(protocolVersion === null);
			return;
		}
		void load();
	}, [load, protocolVersion, supported]);

	const run = async (key: string, action: () => Promise<void>) => {
		if (busy) return;
		setBusy(key);
		try {
			await action();
		} catch (error) {
			toast.error(errorText(error, t("git.actionFailed")));
		}
		setBusy(null);
	};

	const stage = (paths: string[]) =>
		run("stage", async () => {
			setStatus(await getTransport().request("git.control.stage", { workspaceId, paths }));
			setSelectedFile(null);
			setDiff(null);
		});

	const unstage = (paths: string[]) =>
		run("unstage", async () => {
			setStatus(await getTransport().request("git.control.unstage", { workspaceId, paths }));
			setSelectedFile(null);
			setDiff(null);
		});

	const openDiff = (file: GitControlFile, staged: boolean) =>
		run("diff", async () => {
			setSelectedFile({ path: file.path, staged });
			setDiff(null);
			const result = await getTransport().request("git.control.diff", {
				workspaceId,
				path: file.path,
				staged,
			});
			setDiff({ ...result, path: file.path });
		});

	const openCommit = (entry: GitControlLogEntry) =>
		run("commit-detail", async () => {
			setSelectedCommit(entry);
			setSelectedCommitPath(null);
			setCommitDetail(null);
			const result = await getTransport().request("git.control.showCommit", {
				workspaceId,
				sha: entry.sha,
			});
			setCommitDetail(result);
			const sections = parsePatch(result.output);
			const matched = result.files.find((file) =>
				sections.some((section) => section.path === file.path),
			);
			setSelectedCommitPath(matched?.path ?? sections[0]?.path ?? result.files[0]?.path ?? null);
		});

	const commitStaged = () =>
		run("commit", async () => {
			const result = await getTransport().request("git.control.commit", {
				workspaceId,
				message: commitMessage,
			});
			setCommitMessage("");
			setSelectedFile(null);
			setDiff(null);
			toast.success(t("git.committed", { sha: result.sha.slice(0, 7) }));
			await load();
		});

	const network = (kind: "fetch" | "pull" | "push") =>
		run(kind, async () => {
			const result =
				kind === "fetch"
					? await getTransport().request("git.control.fetch", { workspaceId })
					: kind === "pull"
						? await getTransport().request("git.control.pull", { workspaceId })
						: await getTransport().request("git.control.push", { workspaceId });
			toast.success(result.output || t("git.actionDone"));
			await load();
		});

	const switchBranch = (name: string) => {
		if (!name || name === branches?.current) return;
		void run("switch", async () => {
			await getTransport().request("git.control.switchBranch", { workspaceId, name });
			setSelectedFile(null);
			setDiff(null);
			setSelectedCommit(null);
			setSelectedCommitPath(null);
			setCommitDetail(null);
			await load();
		});
	};

	const createBranch = () =>
		run("create", async () => {
			await getTransport().request("git.control.createBranch", {
				workspaceId,
				name: branchName.trim(),
			});
			setBranchName("");
			setCreateOpen(false);
			await load();
		});

	const copySha = (sha: string) => {
		void copyText(sha).then((copied) => {
			if (copied) toast.success(t("git.shaCopied"));
		});
	};

	const staged = status?.files.filter((file) => file.staged) ?? [];
	const unstaged = status?.files.filter((file) => !file.staged || file.unstaged) ?? [];
	const filteredLog = useMemo(() => {
		const query = filter.trim().toLowerCase();
		if (query === "") return log;
		return log.filter(
			(entry) =>
				entry.subject.toLowerCase().includes(query) ||
				entry.author.toLowerCase().includes(query) ||
				entry.shortSha.toLowerCase().includes(query),
		);
	}, [filter, log]);
	const commitSections = useMemo(() => parsePatch(commitDetail?.output ?? ""), [commitDetail]);
	const commitFiles = useMemo<GitControlCommitFile[]>(() => {
		const hostFiles = commitDetail?.files ?? [];
		if (hostFiles.length > 0) return hostFiles;
		return commitSections.map((section) => ({
			path: section.path,
			status: "modified",
			added: section.added,
			removed: section.removed,
		}));
	}, [commitDetail, commitSections]);
	const activeCommitSection = useMemo(() => {
		if (commitSections.length === 0) return null;
		if (!selectedCommitPath) return commitSections[0] ?? null;
		return commitSections.find((section) => section.path === selectedCommitPath) ?? null;
	}, [commitSections, selectedCommitPath]);
	const canCommit = commitMessage.trim() !== "" && staged.length > 0 && busy === null;

	return (
		<div
			data-testid="git-pane"
			className="@container flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
		>
			<header className="flex h-panel-header-row shrink-0 items-center gap-8 border-border-default border-b px-12">
				<RiGitBranchLine className="size-16 shrink-0 text-text-muted" aria-hidden="true" />
				<h2 className="min-w-0 flex-1 truncate tr-title-compact text-text-default">
					{t("git.title")}
				</h2>
				<IconButton
					icon={RiRefreshLine}
					label={t("git.refresh")}
					variant="ghost"
					size="m"
					disabled={!supported || loading}
					onClick={() => void load()}
				/>
			</header>

			{!supported ? (
				<div className="min-h-0 min-w-0 flex-1 overflow-auto p-panel-inset">
					<p className="text-text-muted tr-text-ui">
						{protocolVersion === null ? t("git.loading") : t("git.hostTooOld")}
					</p>
				</div>
			) : loading && !status ? (
				<div className="min-h-0 min-w-0 flex-1 overflow-auto p-panel-inset">
					<p className="text-text-muted tr-text-ui">{t("git.loading")}</p>
				</div>
			) : failed && !status ? (
				<div className="min-h-0 min-w-0 flex-1 overflow-auto p-panel-inset">
					<p className="text-feedback-error tr-text-ui">{t("git.loadFailed")}</p>
				</div>
			) : status && branches ? (
				<div className="flex min-h-0 min-w-0 flex-1 flex-col">
					<div className="flex shrink-0 flex-wrap items-center gap-4 border-border-default border-b px-8 py-4">
						<select
							className={cn(INPUT_CLASS, "min-h-28 min-w-0 max-w-[12rem] flex-1 tr-code-text")}
							value={branches.current}
							onChange={(event) => switchBranch(event.currentTarget.value)}
							disabled={busy !== null}
							aria-label={t("git.currentBranch")}
						>
							{branches.local.map((name) => (
								<option key={name} value={name}>
									{name}
								</option>
							))}
						</select>
						<IconButton
							icon={createOpen ? RiArrowDownSLine : RiAddLine}
							label={t("git.newBranch")}
							variant="ghost"
							size="s"
							selected={createOpen}
							onClick={() => setCreateOpen((open) => !open)}
						/>
						<div className="flex-1" />
						<Button
							variant="ghost"
							size="s"
							loading={busy === "fetch"}
							disabled={busy !== null}
							onClick={() => network("fetch")}
						>
							{t("git.fetch")}
						</Button>
						<Button
							variant="ghost"
							size="s"
							loading={busy === "pull"}
							disabled={busy !== null}
							onClick={() => network("pull")}
						>
							{t("git.pull")}
						</Button>
						<Button
							variant="outline"
							size="s"
							iconLeft={RiUploadLine}
							loading={busy === "push"}
							disabled={busy !== null}
							onClick={() => network("push")}
						>
							{t("git.push")}
						</Button>
					</div>

					{createOpen ? (
						<form
							className="flex shrink-0 items-center gap-4 border-border-default border-b px-8 py-4"
							onSubmit={(event) => {
								event.preventDefault();
								if (branchName.trim()) void createBranch();
							}}
						>
							<input
								className={cn(INPUT_CLASS, "flex-1 tr-code-text")}
								value={branchName}
								onChange={(event) => setBranchName(event.currentTarget.value)}
								placeholder={t("git.branchCreatePlaceholder")}
								aria-label={t("git.branchCreatePlaceholder")}
								maxLength={200}
							/>
							<Button
								type="submit"
								variant="primary"
								size="s"
								loading={busy === "create"}
								disabled={busy !== null || branchName.trim() === ""}
							>
								{t("git.createBranch")}
							</Button>
						</form>
					) : null}

					<div className="flex min-h-0 min-w-0 flex-1 flex-col @xl:flex-row">
						<aside className="flex min-h-0 max-h-[45%] w-full shrink-0 flex-col border-border-default border-b @xl:max-h-none @xl:w-[42%] @xl:border-r @xl:border-b-0">
							<div className="flex shrink-0 gap-2 border-border-default border-b px-8">
								<button
									type="button"
									role="tab"
									aria-selected={view === "history"}
									className={cn(
										"border-b-2 px-8 py-6 tr-text-metadata",
										view === "history"
											? "border-primary text-text-default"
											: "border-transparent text-text-muted hover:text-text-default",
									)}
									onClick={() => setView("history")}
								>
									{t("git.history")} ({log.length})
								</button>
								<button
									type="button"
									role="tab"
									aria-selected={view === "changes"}
									className={cn(
										"border-b-2 px-8 py-6 tr-text-metadata",
										view === "changes"
											? "border-primary text-text-default"
											: "border-transparent text-text-muted hover:text-text-default",
									)}
									onClick={() => setView("changes")}
								>
									{t("git.changes")} ({status.files.length})
								</button>
							</div>

							{view === "history" ? (
								<>
									<div className="shrink-0 border-border-default border-b p-8">
										<input
											className={cn(INPUT_CLASS, "min-h-28 w-full")}
											value={filter}
											onChange={(event) => setFilter(event.currentTarget.value)}
											placeholder={t("git.filterCommits")}
											aria-label={t("git.filterCommits")}
										/>
									</div>
									<div className="min-h-0 flex-1 overflow-auto">
										{filteredLog.length === 0 ? (
											<p className="p-8 text-text-muted tr-text-metadata">{t("git.noCommits")}</p>
										) : (
											filteredLog.map((entry) => (
												<button
													key={entry.sha}
													type="button"
													data-testid="git-commit-entry"
													className={cn(
														"flex w-full min-w-0 flex-col gap-2 border-border-default border-b px-8 py-4 text-left last:border-b-0",
														selectedCommit?.sha === entry.sha
															? "bg-primary-subtle"
															: "hover:bg-control-bg-hovered",
													)}
													onClick={() => void openCommit(entry)}
													title={entry.subject}
												>
													<span className="flex w-full min-w-0 items-center gap-4">
														<span className="min-w-0 flex-1 truncate text-text-default tr-text-metadata">
															{entry.subject}
														</span>
														<span className="shrink-0 tr-code-text text-primary">
															{entry.shortSha}
														</span>
													</span>
													<span className="w-full min-w-0 truncate text-text-subtle tr-text-metadata">
														{entry.author} · {relativeTime(entry.committedAt)}
													</span>
												</button>
											))
										)}
									</div>
								</>
							) : (
								<div className="min-h-0 flex-1 overflow-auto">
									{status.files.length === 0 ? (
										<p className="p-8 text-text-muted tr-text-metadata">{t("git.noChanges")}</p>
									) : (
										<>
											<section className="flex min-w-0 flex-col">
												<div className="flex items-center gap-4 px-8 py-4">
													<h3 className="flex-1 tr-text-eyebrow text-text-muted">
														{t("git.staged")} ({staged.length})
													</h3>
													{staged.length > 0 ? (
														<Button
															variant="ghost"
															size="s"
															disabled={busy !== null}
															onClick={() => void unstage(staged.map((file) => file.path))}
														>
															{t("git.unstageAll")}
														</Button>
													) : null}
												</div>
												{staged.length === 0 ? (
													<p className="px-8 pb-4 text-text-subtle tr-text-metadata">
														{t("git.noneStaged")}
													</p>
												) : (
													staged.map((file) => (
														<div
															key={`staged:${file.path}`}
															className={cn(
																"flex min-w-0 items-center gap-4 px-8 py-4",
																selectedFile?.path === file.path && selectedFile.staged
																	? "bg-primary-subtle"
																	: "hover:bg-control-bg-hovered",
															)}
														>
															<button
																type="button"
																className="flex min-w-0 flex-1 items-center gap-4 text-left"
																onClick={() => void openDiff(file, true)}
																title={file.path}
															>
																<span
																	className={cn(
																		"w-12 shrink-0 tr-code-text",
																		STATUS_CLASS[file.status],
																	)}
																>
																	{STATUS_LABEL[file.status]}
																</span>
																<span className="truncate text-text-default tr-text-metadata">
																	{file.path}
																</span>
															</button>
															<IconButton
																icon={RiSubtractLine}
																label={t("git.unstage")}
																variant="ghost"
																size="s"
																disabled={busy !== null}
																onClick={() => void unstage([file.path])}
															/>
														</div>
													))
												)}
											</section>

											<section className="flex min-w-0 flex-col border-border-default border-t">
												<div className="flex items-center gap-4 px-8 py-4">
													<h3 className="flex-1 tr-text-eyebrow text-text-muted">
														{t("git.unstaged")} ({unstaged.length})
													</h3>
													{unstaged.length > 0 ? (
														<Button
															variant="ghost"
															size="s"
															disabled={busy !== null}
															onClick={() => void stage(unstaged.map((file) => file.path))}
														>
															{t("git.stageAll")}
														</Button>
													) : null}
												</div>
												{unstaged.length === 0 ? (
													<p className="px-8 pb-4 text-text-subtle tr-text-metadata">
														{t("git.noneUnstaged")}
													</p>
												) : (
													unstaged.map((file) => (
														<div
															key={`unstaged:${file.path}`}
															className={cn(
																"flex min-w-0 items-center gap-4 px-8 py-4",
																selectedFile?.path === file.path && !selectedFile.staged
																	? "bg-primary-subtle"
																	: "hover:bg-control-bg-hovered",
															)}
														>
															<button
																type="button"
																className="flex min-w-0 flex-1 items-center gap-4 text-left"
																onClick={() => void openDiff(file, false)}
																title={file.path}
															>
																<span
																	className={cn(
																		"w-12 shrink-0 tr-code-text",
																		STATUS_CLASS[file.status],
																	)}
																>
																	{STATUS_LABEL[file.status]}
																</span>
																<span className="truncate text-text-default tr-text-metadata">
																	{file.path}
																</span>
															</button>
															<IconButton
																icon={RiAddLine}
																label={t("git.stage")}
																variant="ghost"
																size="s"
																disabled={busy !== null}
																onClick={() => void stage([file.path])}
															/>
														</div>
													))
												)}
											</section>
										</>
									)}
								</div>
							)}
						</aside>

						<section className="flex min-h-0 min-w-0 flex-1 flex-col bg-sunken">
							{view === "history" ? (
								selectedCommit ? (
									<>
										<div className="shrink-0 border-border-default border-b bg-container-elevated-bg p-8">
											<div className="flex min-w-0 items-center gap-4">
												<span className="rounded-sm bg-primary-subtle px-4 py-2 tr-code-text text-primary">
													{selectedCommit.shortSha}
												</span>
												<IconButton
													icon={RiFileCopyLine}
													label={t("git.copySha")}
													variant="ghost"
													size="s"
													onClick={() => copySha(selectedCommit.sha)}
												/>
												<span className="min-w-0 flex-1" />
												<span className="shrink-0 text-text-subtle tr-text-metadata">
													{relativeTime(selectedCommit.committedAt)}
												</span>
											</div>
											<p className="mt-4 text-text-default tr-text-ui">{selectedCommit.subject}</p>
											<p className="mt-2 text-text-subtle tr-text-metadata">
												{selectedCommit.author} · {selectedCommit.committedAt}
											</p>
										</div>
										{commitFiles.length > 0 ? (
											<div
												data-testid="git-commit-files"
												className="flex shrink-0 gap-4 overflow-x-auto border-border-default border-b bg-container-elevated-bg px-8 py-4"
											>
												{commitFiles.map((file) => {
													const active = file.path === activeCommitSection?.path;
													return (
														<button
															key={file.path}
															type="button"
															data-testid="git-commit-file"
															aria-pressed={active}
															className={cn(
																"flex shrink-0 items-center gap-4 rounded-sm border px-4 py-2 tr-text-metadata",
																active
																	? "border-primary bg-primary-subtle text-text-default"
																	: "border-border-default text-text-default hover:bg-control-bg-hovered",
															)}
															onClick={() => setSelectedCommitPath(file.path)}
															title={file.path}
														>
															<span className={cn("tr-code-text", STATUS_CLASS[file.status])}>
																{STATUS_LABEL[file.status]}
															</span>
															<span className="max-w-[12rem] truncate">{fileBase(file.path)}</span>
															{file.added !== undefined ? (
																<span className="text-feedback-success">+{file.added}</span>
															) : null}
															{file.removed !== undefined ? (
																<span className="text-feedback-error">-{file.removed}</span>
															) : null}
														</button>
													);
												})}
											</div>
										) : null}
										{activeCommitSection ? (
											<>
												<div className="flex shrink-0 items-center gap-4 border-border-default border-b bg-container-elevated-bg px-8 py-4">
													<span className="min-w-0 flex-1 truncate tr-code-text text-text-default">
														{activeCommitSection.path}
													</span>
													<span className="shrink-0 text-feedback-success tr-code-text">
														+{activeCommitSection.added}
													</span>
													<span className="shrink-0 text-feedback-error tr-code-text">
														-{activeCommitSection.removed}
													</span>
													{commitDetail?.truncated ? (
														<span className="text-feedback-warning tr-text-metadata">
															{t("git.diffTruncated")}
														</span>
													) : null}
												</div>
												<PatchLinesView lines={activeCommitSection.lines} />
											</>
										) : (
											<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-12 text-center text-text-subtle">
												<RiGitBranchLine className="size-24" aria-hidden="true" />
												<p className="tr-text-metadata">
													{!commitDetail
														? t("git.loading")
														: commitFiles.length > 0
															? t("git.commitFileUnavailable")
															: t("git.noCommitChanges")}
												</p>
											</div>
										)}
									</>
								) : (
									<div className="flex h-full flex-col items-center justify-center gap-4 p-12 text-center text-text-subtle">
										<RiGitBranchLine className="size-24" aria-hidden="true" />
										<p className="tr-text-metadata">{t("git.selectCommit")}</p>
									</div>
								)
							) : diff ? (
								<>
									<div className="flex shrink-0 items-center gap-4 border-border-default border-b bg-container-elevated-bg px-8 py-4">
										<span className="min-w-0 flex-1 truncate tr-code-text text-text-default">
											{diff.path}
										</span>
										<span className="shrink-0 text-text-subtle tr-text-metadata">
											{diff.staged ? t("git.staged") : t("git.unstaged")}
										</span>
										{diff.truncated ? (
											<span className="text-feedback-warning tr-text-metadata">
												{t("git.diffTruncated")}
											</span>
										) : null}
									</div>
									{diff.diff ? (
										<PatchView text={diff.diff} />
									) : (
										<div className="flex min-h-0 flex-1 items-center justify-center p-12 text-center text-text-subtle">
											<p className="tr-text-metadata">{t("git.noDiff")}</p>
										</div>
									)}
								</>
							) : (
								<div className="flex h-full flex-col items-center justify-center gap-4 p-12 text-center text-text-subtle">
									<RiGitBranchLine className="size-24" aria-hidden="true" />
									<p className="tr-text-metadata">{t("git.selectFile")}</p>
								</div>
							)}
						</section>
					</div>

					{view === "changes" ? (
						<div className="shrink-0 border-border-default border-t bg-container-elevated-bg p-8">
							<div className="flex min-w-0 items-end gap-4">
								<textarea
									className={cn(INPUT_CLASS, "min-h-[3.5rem] flex-1 py-4")}
									value={commitMessage}
									onChange={(event) => setCommitMessage(event.currentTarget.value)}
									placeholder={t("git.commitPlaceholder")}
									data-testid="git-commit-message"
									maxLength={4_000}
								/>
								<Button
									variant="primary"
									size="s"
									iconLeft={RiCheckLine}
									loading={busy === "commit"}
									disabled={!canCommit}
									onClick={() => void commitStaged()}
								>
									{t("git.commit")}
								</Button>
							</div>
							<p className="mt-2 text-text-subtle tr-text-metadata">{t("git.commitHint")}</p>
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}
