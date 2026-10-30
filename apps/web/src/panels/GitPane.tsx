import {
	RiAddLine,
	RiArrowDownSLine,
	RiGitBranchLine,
	RiRefreshLine,
	RiUploadLine,
} from "@remixicon/react";
import {
	type GitControlBranches,
	type GitControlFile,
	type GitControlLogEntry,
	type GitControlStatus,
	WORKSPACE_TOOLS_PROTOCOL_VERSION,
} from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { Button, IconButton } from "@thinkrail/ui/button";
import { cn } from "@thinkrail/ui/utils";
import { useCallback, useEffect, useState } from "react";
import { toast, useAppStore } from "../store";
import { errorText, getTransport } from "../transport";

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

function relativeTime(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	const diff = Date.now() - date.getTime();
	const minutes = Math.floor(diff / 60_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d`;
	return date.toLocaleDateString();
}

export function GitPane({ workspaceId }: { workspaceId: string }) {
	const t = useT();
	const protocolVersion = useAppStore((state) => state.protocolVersion);
	const supported = protocolVersion !== null && protocolVersion >= WORKSPACE_TOOLS_PROTOCOL_VERSION;
	const [status, setStatus] = useState<GitControlStatus | null>(null);
	const [branches, setBranches] = useState<GitControlBranches | null>(null);
	const [log, setLog] = useState<GitControlLogEntry[]>([]);
	const [tab, setTab] = useState<"changes" | "history">("changes");
	const [selected, setSelected] = useState<{ path: string; staged: boolean } | null>(null);
	const [diff, setDiff] = useState<string | null>(null);
	const [diffTruncated, setDiffTruncated] = useState(false);
	const [commit, setCommit] = useState<GitControlLogEntry | null>(null);
	const [commitText, setCommitText] = useState<string | null>(null);
	const [message, setMessage] = useState("");
	const [branchName, setBranchName] = useState("");
	const [createOpen, setCreateOpen] = useState(false);
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
				getTransport().request("git.control.log", { workspaceId, limit: 30 }),
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

	const run = async (key: string, action: () => Promise<void>, done?: string) => {
		if (busy) return;
		setBusy(key);
		try {
			await action();
			if (done) toast.success(done);
		} catch (error) {
			toast.error(errorText(error, t("git.actionFailed")));
		}
		setBusy(null);
	};

	const stage = (paths: string[]) =>
		run("stage", async () => {
			setStatus(await getTransport().request("git.control.stage", { workspaceId, paths }));
			setSelected(null);
			setDiff(null);
		});

	const unstage = (paths: string[]) =>
		run("unstage", async () => {
			setStatus(await getTransport().request("git.control.unstage", { workspaceId, paths }));
			setSelected(null);
			setDiff(null);
		});

	const openDiff = (file: GitControlFile, staged: boolean) =>
		run("diff", async () => {
			setSelected({ path: file.path, staged });
			setDiff(null);
			const result = await getTransport().request("git.control.diff", {
				workspaceId,
				path: file.path,
				staged,
			});
			setDiff(result.diff || t("git.noDiff"));
			setDiffTruncated(result.truncated);
		});

	const showCommit = (entry: GitControlLogEntry) =>
		run("commit", async () => {
			setCommit(entry);
			setCommitText(null);
			const result = await getTransport().request("git.control.showCommit", {
				workspaceId,
				sha: entry.sha,
			});
			setCommitText(result.output);
		});

	const commitStaged = () =>
		run("commit", async () => {
			const result = await getTransport().request("git.control.commit", {
				workspaceId,
				message,
			});
			setMessage("");
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

	const staged = status?.files.filter((file) => file.staged) ?? [];
	const unstaged = status?.files.filter((file) => !file.staged || file.unstaged) ?? [];
	const canCommit = message.trim() !== "" && staged.length > 0 && busy === null;

	return (
		<div data-testid="git-pane" className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
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

			<div className="min-h-0 min-w-0 flex-1 overflow-auto p-panel-inset">
				{!supported ? (
					<p className="text-text-muted tr-text-ui">
						{protocolVersion === null ? t("git.loading") : t("git.hostTooOld")}
					</p>
				) : loading && !status ? (
					<p className="text-text-muted tr-text-ui">{t("git.loading")}</p>
				) : failed && !status ? (
					<p className="text-feedback-error tr-text-ui">{t("git.loadFailed")}</p>
				) : status && branches ? (
					<div className="flex min-w-0 flex-col gap-12">
						<div className="flex min-w-0 flex-wrap items-center gap-4">
							<select
								className={cn(INPUT_CLASS, "min-h-28 max-w-[14rem] flex-1 tr-code-text")}
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
								className="flex min-w-0 items-center gap-4"
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

						<div className="flex min-w-0 gap-2 border-border-default border-b">
							<button
								type="button"
								className={cn(
									"border-b-2 px-8 py-4 tr-text-metadata",
									tab === "changes"
										? "border-primary text-text-default"
										: "border-transparent text-text-muted hover:text-text-default",
								)}
								onClick={() => setTab("changes")}
							>
								{t("git.changes")} ({status.files.length})
							</button>
							<button
								type="button"
								className={cn(
									"border-b-2 px-8 py-4 tr-text-metadata",
									tab === "history"
										? "border-primary text-text-default"
										: "border-transparent text-text-muted hover:text-text-default",
								)}
								onClick={() => setTab("history")}
							>
								{t("git.history")} ({log.length})
							</button>
						</div>

						{tab === "changes" ? (
							<div className="flex min-w-0 flex-col gap-8">
								{status.files.length === 0 ? (
									<p className="text-text-muted tr-text-metadata">{t("git.noChanges")}</p>
								) : (
									<>
										<section className="flex min-w-0 flex-col gap-4">
											<div className="flex items-center gap-4">
												<h3 className="flex-1 text-text-muted tr-text-metadata">
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
												<p className="text-text-subtle tr-text-metadata">{t("git.noneStaged")}</p>
											) : (
												staged.map((file) => (
													<div
														key={`staged:${file.path}`}
														className={cn(
															"flex min-w-0 items-center gap-4 rounded-sm px-4 py-4",
															selected?.path === file.path && selected.staged
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
														<Button
															variant="ghost"
															size="s"
															disabled={busy !== null}
															onClick={() => void unstage([file.path])}
														>
															{t("git.unstage")}
														</Button>
													</div>
												))
											)}
										</section>

										<section className="flex min-w-0 flex-col gap-4">
											<div className="flex items-center gap-4">
												<h3 className="flex-1 text-text-muted tr-text-metadata">
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
												<p className="text-text-subtle tr-text-metadata">{t("git.noneUnstaged")}</p>
											) : (
												unstaged.map((file) => (
													<div
														key={`unstaged:${file.path}`}
														className={cn(
															"flex min-w-0 items-center gap-4 rounded-sm px-4 py-4",
															selected?.path === file.path && !selected.staged
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
														<Button
															variant="ghost"
															size="s"
															disabled={busy !== null}
															onClick={() => void stage([file.path])}
														>
															{t("git.stage")}
														</Button>
													</div>
												))
											)}
										</section>

										<div className="flex min-w-0 flex-col gap-4 border-border-default border-t pt-8">
											<textarea
												className={cn(INPUT_CLASS, "min-h-[4rem] w-full py-4")}
												value={message}
												onChange={(event) => setMessage(event.currentTarget.value)}
												placeholder={t("git.commitPlaceholder")}
												data-testid="git-commit-message"
												maxLength={4_000}
											/>
											<div className="flex items-center gap-4">
												<p className="flex-1 text-text-subtle tr-text-metadata">
													{t("git.commitHint")}
												</p>
												<Button
													variant="primary"
													size="s"
													loading={busy === "commit"}
													disabled={!canCommit}
													onClick={() => void commitStaged()}
												>
													{t("git.commit")}
												</Button>
											</div>
										</div>

										{diff !== null ? (
											<section className="flex min-w-0 flex-col gap-4 border-border-default border-t pt-8">
												<div className="flex items-center gap-4">
													<h3 className="min-w-0 flex-1 truncate tr-code-text text-text-default">
														{selected?.path}
													</h3>
													{diffTruncated ? (
														<span className="text-feedback-warning tr-text-metadata">
															{t("git.diffTruncated")}
														</span>
													) : null}
												</div>
												<pre className="max-h-[24rem] min-w-0 overflow-auto whitespace-pre rounded-sm bg-sunken p-8 tr-code-text text-text-default">
													{diff}
												</pre>
											</section>
										) : null}
									</>
								)}
							</div>
						) : (
							<div className="flex min-w-0 flex-col gap-8">
								{log.length === 0 ? (
									<p className="text-text-muted tr-text-metadata">{t("git.noCommits")}</p>
								) : (
									<div className="flex min-w-0 flex-col">
										{log.map((entry) => (
											<button
												key={entry.sha}
												type="button"
												className={cn(
													"flex min-w-0 items-center gap-8 border-border-default border-b px-4 py-4 text-left last:border-b-0",
													commit?.sha === entry.sha
														? "bg-primary-subtle"
														: "hover:bg-control-bg-hovered",
												)}
												onClick={() => void showCommit(entry)}
												title={entry.subject}
											>
												<span className="shrink-0 tr-code-text text-primary">{entry.shortSha}</span>
												<span className="min-w-0 flex-1 truncate text-text-default tr-text-metadata">
													{entry.subject}
												</span>
												<span className="shrink-0 text-text-subtle tr-text-metadata">
													{entry.author} · {relativeTime(entry.committedAt)}
												</span>
											</button>
										))}
									</div>
								)}
								{commitText !== null ? (
									<pre className="max-h-[28rem] min-w-0 overflow-auto whitespace-pre rounded-sm bg-sunken p-8 tr-code-text text-text-default">
										{commitText}
									</pre>
								) : null}
							</div>
						)}
					</div>
				) : null}
			</div>
		</div>
	);
}
