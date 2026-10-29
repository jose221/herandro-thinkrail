import { RiDeleteBinLine, RiLoader4Line, RiPlayLine, RiStopLine } from "@remixicon/react";
import type {
	AcpConfigOption,
	AcpPermissionOption,
	AcpSessionSnapshot,
	AcpTranscriptEntry,
} from "@thinkrail/contracts";
import { ACP_PROTOCOL_VERSION } from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@thinkrail/ui/dialog";
import { Textarea } from "@thinkrail/ui/textarea";
import { type KeyboardEvent, useEffect, useState } from "react";
import { QuietScrollArea } from "../components/QuietScrollArea";
import { toast, useAppStore } from "../store";
import { errorText, getTransport } from "../transport";
import { useAcpStore } from "./acpStore";

const SAFE_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function roleKey(role: AcpTranscriptEntry["role"]) {
	switch (role) {
		case "user":
			return "acp.chat.role.user";
		case "assistant":
			return "acp.chat.role.assistant";
		case "thought":
			return "acp.chat.role.thought";
		case "notice":
			return "acp.chat.role.notice";
	}
}

function statusKey(status: AcpSessionSnapshot["summary"]["state"]) {
	switch (status) {
		case "idle":
			return "acp.chat.state.idle";
		case "running":
			return "acp.chat.state.running";
		case "needs-input":
			return "acp.chat.state.needsInput";
		case "failed":
			return "acp.chat.state.failed";
		case "interrupted":
			return "acp.chat.state.interrupted";
	}
}

function permissionOptionKey(option: AcpPermissionOption) {
	switch (option.kind) {
		case "allow_once":
			return "acp.chat.permission.allowOnce";
		case "allow_always":
			return "acp.chat.permission.allowAlways";
		case "reject_once":
			return "acp.chat.permission.rejectOnce";
		case "reject_always":
			return "acp.chat.permission.rejectAlways";
	}
}

function toolStateKey(status: "pending" | "in-progress" | "completed" | "failed") {
	switch (status) {
		case "pending":
			return "acp.chat.toolState.pending";
		case "in-progress":
			return "acp.chat.toolState.inProgress";
		case "completed":
			return "acp.chat.toolState.completed";
		case "failed":
			return "acp.chat.toolState.failed";
	}
}

function planStateKey(status: "pending" | "in_progress" | "completed") {
	switch (status) {
		case "pending":
			return "acp.chat.planState.pending";
		case "in_progress":
			return "acp.chat.planState.inProgress";
		case "completed":
			return "acp.chat.planState.completed";
	}
}

function ImageList({ images }: { images: AcpTranscriptEntry["images"] }) {
	const t = useT();
	if (!images?.length) return null;
	return (
		<div className="flex min-w-0 flex-wrap gap-8">
			{images.map((image, index) =>
				SAFE_IMAGE_MIME_TYPES.has(image.mimeType) ? (
					<img
						key={`${image.mimeType}-${index}`}
						src={`data:${image.mimeType};base64,${image.data}`}
						alt={t("acp.chat.imageAlt")}
						className="h-auto max-w-full rounded-sm border border-border-default"
					/>
				) : null,
			)}
		</div>
	);
}

function MessageRow({ entry }: { entry: AcpTranscriptEntry }) {
	const t = useT();
	const user = entry.role === "user";
	return (
		<article
			data-testid={`acp-message-${entry.id}`}
			className={`flex min-w-0 flex-col gap-4 rounded-sm border px-12 py-8 ${
				user
					? "ml-auto w-fit max-w-full border-border-default bg-control-bg"
					: "mr-auto w-full max-w-full border-border-default bg-container-sidebar-bg"
			}`}
		>
			<span className="text-text-muted tr-text-metadata">{t(roleKey(entry.role))}</span>
			{entry.text ? (
				<p className="min-w-0 whitespace-pre-wrap break-words text-text-default tr-text-ui">
					{entry.text}
				</p>
			) : null}
			<ImageList images={entry.images} />
		</article>
	);
}

function ConfigControl({
	workspaceId,
	sessionId,
	option,
	onError,
	displayAsModel = false,
}: {
	workspaceId: string;
	sessionId: string;
	option: AcpConfigOption;
	onError: () => void;
	displayAsModel?: boolean;
}) {
	const t = useT();
	const label = displayAsModel ? t("acp.chat.model") : option.name || t("acp.chat.configOption");
	const setOption = async (value: string) => {
		try {
			await getTransport().request("acp.session.setConfigOption", {
				workspaceId,
				sessionId,
				configId: option.id,
				value,
			});
		} catch {
			onError();
		}
	};
	return (
		<label
			className={displayAsModel ? "flex min-w-0 items-center gap-4" : "flex min-w-0 flex-col gap-2"}
		>
			<span className={displayAsModel ? "sr-only" : "truncate text-text-muted tr-text-metadata"}>
				{label}
			</span>
			<select
				aria-label={label}
				data-testid={displayAsModel ? "acp-model-select" : undefined}
				value={option.currentValue}
				onChange={(event) => void setOption(event.currentTarget.value)}
				className="min-h-40 max-w-full min-w-0 rounded-sm border border-border-default bg-control-bg px-8 text-text-default tr-text-metadata"
			>
				{option.options.map((choice) => (
					<option key={choice.value} value={choice.value}>
						{choice.name}
					</option>
				))}
			</select>
		</label>
	);
}

export function AcpChatPane({
	workspaceId,
	sessionId,
	tabId,
}: {
	workspaceId: string;
	sessionId: string;
	tabId: string;
}) {
	const t = useT();
	const status = useAppStore((state) => state.status);
	const protocolVersion = useAppStore((state) => state.protocolVersion);
	const connectionGeneration = useAppStore((state) => state.connectionGeneration);
	const snapshot = useAcpStore((state) => state.snapshotsBySession[sessionId]);
	const snapshotGeneration = useAcpStore((state) => state.snapshotGenerationBySession[sessionId]);
	const draft = useAcpStore((state) => state.draftsBySession[sessionId]);
	const [text, setText] = useState("");
	const [loading, setLoading] = useState(false);
	const [loadFailed, setLoadFailed] = useState(false);
	const [sending, setSending] = useState(false);
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const supported =
		status === "connected" && protocolVersion !== null && protocolVersion >= ACP_PROTOCOL_VERSION;

	useEffect(() => {
		if (!supported || connectionGeneration === 0 || snapshotGeneration === connectionGeneration)
			return;
		let current = true;
		useAcpStore.getState().beginSnapshotHydration(sessionId, connectionGeneration);
		setLoading(true);
		setLoadFailed(false);
		void getTransport()
			.request("acp.session.get", { workspaceId, sessionId })
			.then((nextSnapshot) => {
				const currentState = useAppStore.getState();
				if (
					!current ||
					currentState.connectionGeneration !== connectionGeneration ||
					currentState.removedWorkspaceIds[workspaceId]
				) {
					return;
				}
				useAcpStore.getState().installSnapshot(nextSnapshot, connectionGeneration);
			})
			.catch(() => {
				if (current) setLoadFailed(true);
				useAcpStore.getState().cancelSnapshotHydration(sessionId, connectionGeneration);
			})
			.finally(() => {
				if (current) setLoading(false);
			});
		return () => {
			current = false;
			useAcpStore.getState().cancelSnapshotHydration(sessionId, connectionGeneration);
		};
	}, [connectionGeneration, sessionId, snapshotGeneration, supported, workspaceId]);

	const actionFailed = () => {
		toast.error(t("acp.chat.actionFailed"));
	};

	const send = () => {
		const message = text.trim();
		if (
			!message ||
			sending ||
			snapshot?.summary.state === "running" ||
			snapshot?.summary.state === "interrupted" ||
			snapshot?.permission !== null
		) {
			return;
		}
		setSending(true);
		void getTransport()
			.request("acp.session.prompt", { workspaceId, sessionId, text: message })
			.then(() => setText(""))
			.catch((error: unknown) => {
				toast.error(errorText(error), t("acp.chat.actionFailed"));
			})
			.finally(() => setSending(false));
	};

	const cancel = async () => {
		try {
			await getTransport().request("acp.session.cancel", { workspaceId, sessionId });
		} catch {
			actionFailed();
		}
	};

	const resume = async () => {
		useAcpStore.getState().beginSnapshotHydration(sessionId, connectionGeneration);
		try {
			const nextSnapshot = await getTransport().request("acp.session.resume", {
				workspaceId,
				sessionId,
			});
			useAcpStore.getState().installSnapshot(nextSnapshot, connectionGeneration);
		} catch {
			useAcpStore.getState().cancelSnapshotHydration(sessionId, connectionGeneration);
			actionFailed();
		}
	};

	const remove = () => {
		setDeleting(true);
		void getTransport()
			.request("acp.session.delete", { workspaceId, sessionId })
			.then(() => {
				useAcpStore.getState().removeSession(workspaceId, sessionId);
				useAppStore.getState().closeTab(tabId, true, true, workspaceId);
			})
			.catch(actionFailed)
			.finally(() => {
				setDeleting(false);
				setDeleteOpen(false);
			});
	};

	const setMode = async (modeId: string) => {
		try {
			await getTransport().request("acp.session.setMode", { workspaceId, sessionId, modeId });
		} catch {
			actionFailed();
		}
	};

	const replyToPermission = async (option: AcpPermissionOption) => {
		if (!snapshot?.permission) return;
		try {
			await getTransport().request("acp.permission.reply", {
				workspaceId,
				sessionId,
				requestId: snapshot.permission.requestId,
				optionId: option.optionId,
			});
		} catch {
			actionFailed();
		}
	};

	const submitOnShortcut = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
		event.preventDefault();
		void send();
	};

	return (
		<section
			data-testid="acp-chat-pane"
			data-acp-session-id={sessionId}
			className="flex h-full min-h-0 min-w-0 flex-col bg-container-content-bg"
		>
			<header className="flex min-w-0 flex-wrap items-center gap-8 border-b border-border-default px-12 py-8">
				<div className="min-w-0 flex-1">
					<h2 className="truncate tr-title-compact text-text-default">
						{snapshot?.summary.title || t("acp.chat.title")}
					</h2>
					<p className="truncate text-text-muted tr-text-metadata">
						{snapshot
							? `${snapshot.summary.clientName} · ${t(statusKey(snapshot.summary.state))}`
							: t("acp.chat.subtitle")}
					</p>
				</div>
				<div className="flex min-w-0 flex-wrap items-center gap-4">
					{snapshot?.configOptions
						.filter((option) => option.category === "model" && option.options.length > 0)
						.map((option) => (
							<ConfigControl
								key={option.id}
								workspaceId={workspaceId}
								sessionId={sessionId}
								option={option}
								onError={actionFailed}
								displayAsModel
							/>
						))}
					{snapshot?.modes.length ? (
						<label className="flex min-w-0 items-center gap-4">
							<span className="sr-only">{t("acp.chat.mode")}</span>
							<select
								aria-label={t("acp.chat.mode")}
								value={snapshot.currentMode ?? ""}
								onChange={(event) => void setMode(event.currentTarget.value)}
								className="min-h-40 max-w-full rounded-sm border border-border-default bg-control-bg px-8 text-text-default tr-text-metadata"
							>
								{snapshot.modes.map((mode) => (
									<option key={mode.id} value={mode.id}>
										{mode.name}
									</option>
								))}
							</select>
						</label>
					) : null}
					{snapshot?.summary.resumable ? (
						<Button
							type="button"
							variant="outline"
							size="s"
							iconLeft={RiPlayLine}
							onClick={() => void resume()}
							disabled={!supported}
						>
							{t("acp.chat.resume")}
						</Button>
					) : null}
					{snapshot?.summary.state === "running" ? (
						<Button
							type="button"
							variant="outline"
							size="s"
							iconLeft={RiStopLine}
							onClick={() => void cancel()}
						>
							{t("acp.chat.stop")}
						</Button>
					) : null}
					<Button
						type="button"
						variant="ghost"
						size="s"
						iconLeft={RiDeleteBinLine}
						onClick={() => setDeleteOpen(true)}
						disabled={!snapshot || !supported}
					>
						{t("acp.chat.delete")}
					</Button>
				</div>
			</header>

			{!supported ? (
				<p role="status" className="m-12 text-text-muted tr-text-metadata">
					{t("acp.chat.connectionRequired")}
				</p>
			) : null}
			{supported && loading && !snapshot ? (
				<div className="flex min-h-0 flex-1 items-center justify-center gap-8 text-text-muted tr-text-ui">
					<RiLoader4Line className="size-16 animate-spin" />
					{t("acp.chat.loading")}
				</div>
			) : null}
			{supported && loadFailed && !snapshot ? (
				<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-8 px-12 text-center">
					<p role="alert" className="text-feedback-error tr-text-ui">
						{t("acp.chat.loadFailed")}
					</p>
					<Button
						type="button"
						variant="outline"
						size="m"
						onClick={() => {
							useAcpStore.getState().invalidateSnapshot(sessionId);
						}}
					>
						{t("common.retry")}
					</Button>
				</div>
			) : null}
			{snapshot ? (
				<>
					<QuietScrollArea className="min-h-0 flex-1" viewportClassName="px-12 py-12">
						<div className="mx-auto flex w-full max-w-768 min-w-0 flex-col gap-12">
							{snapshot.messages.map((entry) => (
								<MessageRow key={entry.id} entry={entry} />
							))}
							{draft?.thoughtText || draft?.thoughtImages.length ? (
								<article
									data-testid="acp-thought-draft"
									className="mr-auto flex w-full min-w-0 flex-col gap-4 rounded-sm border border-border-default bg-container-sidebar-bg px-12 py-8"
								>
									<span className="text-text-muted tr-text-metadata">
										{t("acp.chat.role.thought")}
									</span>
									<p className="whitespace-pre-wrap break-words text-text-muted tr-text-ui">
										{draft.thoughtText}
									</p>
									<ImageList images={draft.thoughtImages} />
								</article>
							) : null}
							{draft?.assistantText || draft?.assistantImages.length ? (
								<article
									data-testid="acp-assistant-draft"
									aria-live="polite"
									className="mr-auto flex w-full min-w-0 flex-col gap-4 rounded-sm border border-border-default bg-container-sidebar-bg px-12 py-8"
								>
									<span className="text-text-muted tr-text-metadata">
										{t("acp.chat.role.assistant")}
									</span>
									<p className="whitespace-pre-wrap break-words text-text-default tr-text-ui">
										{draft.assistantText}
									</p>
									<ImageList images={draft.assistantImages} />
								</article>
							) : null}
							{snapshot.toolCalls.length > 0 ? (
								<section className="flex min-w-0 flex-col gap-8">
									<h3 className="tr-title-compact text-text-default">{t("acp.chat.tools")}</h3>
									<ul className="flex min-w-0 flex-col gap-4">
										{snapshot.toolCalls.map((toolCall) => (
											<li
												key={toolCall.id}
												className="min-w-0 break-words rounded-sm border border-border-default bg-container-sidebar-bg px-12 py-8"
											>
												<span className="tr-text-ui text-text-default">{toolCall.title}</span>
												<span className="ml-8 text-text-muted tr-text-metadata">
													{t(toolStateKey(toolCall.status))}
												</span>
											</li>
										))}
									</ul>
								</section>
							) : null}
							{snapshot.plan.length > 0 ? (
								<section className="flex min-w-0 flex-col gap-8">
									<h3 className="tr-title-compact text-text-default">{t("acp.chat.plan")}</h3>
									<ul className="flex min-w-0 flex-col gap-4">
										{snapshot.plan.map((entry, index) => (
											<li
												key={`${index}-${entry.content}`}
												className="flex min-w-0 flex-wrap items-start gap-8 rounded-sm border border-border-default px-12 py-8"
											>
												<span className="min-w-0 flex-1 break-words whitespace-pre-wrap tr-text-ui text-text-default">
													{entry.content}
												</span>
												<span className="shrink-0 text-text-muted tr-text-metadata">
													{t(planStateKey(entry.status))}
												</span>
											</li>
										))}
									</ul>
								</section>
							) : null}
							{snapshot.availableCommands.length > 0 ? (
								<section className="flex min-w-0 flex-col gap-8">
									<h3 className="tr-title-compact text-text-default">{t("acp.chat.commands")}</h3>
									<ul className="flex min-w-0 flex-wrap gap-8">
										{snapshot.availableCommands.map((command) => (
											<li
												key={command.name}
												className="max-w-full break-words rounded-sm border border-border-default px-8 py-4 tr-code-text"
											>
												{command.name}
											</li>
										))}
									</ul>
								</section>
							) : null}
							{snapshot.usage ? (
								<p className="text-text-muted tr-text-metadata">
									{snapshot.usage.cost
										? t("acp.chat.usageCost", {
												used: snapshot.usage.used.toLocaleString(),
												size: snapshot.usage.size.toLocaleString(),
												cost: `${snapshot.usage.cost.amount.toLocaleString()} ${snapshot.usage.cost.currency}`,
											})
										: t("acp.chat.usage", {
												used: snapshot.usage.used.toLocaleString(),
												size: snapshot.usage.size.toLocaleString(),
											})}
								</p>
							) : null}
						</div>
					</QuietScrollArea>

					{snapshot.permission ? (
						<section
							data-testid="acp-permission-prompt"
							className="flex min-w-0 flex-col gap-8 border-t border-border-default bg-control-bg px-12 py-8"
						>
							<div className="min-w-0">
								<h3 className="tr-title-compact text-text-default">
									{t("acp.chat.permission.title")}
								</h3>
								<p className="break-words text-text-muted tr-text-metadata">
									{snapshot.permission.title}
								</p>
							</div>
							<div className="flex min-w-0 flex-wrap gap-4">
								{snapshot.permission.options.map((option) => (
									<Button
										key={option.optionId}
										type="button"
										variant={option.kind.startsWith("reject") ? "outline" : "primary"}
										size="m"
										onClick={() => void replyToPermission(option)}
									>
										{t(permissionOptionKey(option))}
									</Button>
								))}
							</div>
						</section>
					) : null}

					{snapshot.configOptions.some((option) => option.category !== "model") ? (
						<div className="flex min-w-0 flex-wrap gap-8 border-t border-border-default px-12 py-8">
							{snapshot.configOptions
								.filter((option) => option.category !== "model")
								.map((option) => (
									<ConfigControl
										key={option.id}
										workspaceId={workspaceId}
										sessionId={sessionId}
										option={option}
										onError={actionFailed}
									/>
								))}
						</div>
					) : null}

					<form
						onSubmit={(event) => {
							event.preventDefault();
							void send();
						}}
						className="flex min-w-0 flex-col gap-8 border-t border-border-default px-12 py-8"
					>
						<label htmlFor={`acp-prompt-${tabId}`} className="sr-only">
							{t("acp.chat.promptLabel")}
						</label>
						<Textarea
							id={`acp-prompt-${tabId}`}
							data-testid="acp-prompt"
							value={text}
							onChange={(event) => setText(event.currentTarget.value)}
							onKeyDown={submitOnShortcut}
							rows={3}
							maxLength={100_000}
							disabled={
								!supported ||
								snapshot.summary.state === "running" ||
								snapshot.summary.state === "interrupted" ||
								snapshot.permission !== null ||
								sending
							}
							placeholder={t("acp.chat.promptPlaceholder")}
							className="max-h-192 min-h-64 w-full min-w-0 resize-y px-8 py-8 tr-text-ui"
						/>
						<div className="flex flex-col-reverse gap-8 sm:flex-row sm:items-center sm:justify-between">
							<p className="text-text-muted tr-text-metadata">{t("acp.chat.promptHint")}</p>
							<Button
								type="submit"
								variant="primary"
								size="m"
								disabled={
									!supported ||
									snapshot.summary.state === "running" ||
									snapshot.summary.state === "interrupted" ||
									snapshot.permission !== null ||
									sending ||
									text.trim().length === 0
								}
							>
								{sending ? t("acp.chat.sending") : t("acp.chat.send")}
							</Button>
						</div>
					</form>
				</>
			) : null}

			<Dialog open={deleteOpen} onOpenChange={(open) => !deleting && setDeleteOpen(open)}>
				<DialogContent role="alertdialog" className="max-w-[24rem]" hideClose>
					<DialogHeader>
						<DialogTitle>{t("acp.chat.deleteTitle")}</DialogTitle>
						<DialogDescription>{t("acp.chat.deleteDescription")}</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => setDeleteOpen(false)}>
							{t("common.cancel")}
						</Button>
						<Button
							type="button"
							variant="destructive"
							disabled={deleting}
							onClick={() => void remove()}
						>
							{deleting ? t("acp.chat.deleting") : t("acp.chat.delete")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</section>
	);
}
