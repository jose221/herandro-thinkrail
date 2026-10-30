import {
	RiArrowDownSLine,
	RiCheckboxCircleLine,
	RiCloseLine,
	RiDeleteBinLine,
	RiErrorWarningLine,
	RiImageAddLine,
	RiLoader4Line,
	RiPlayLine,
	RiRobot2Line,
	RiSendPlane2Line,
	RiStopLine,
	RiToolsLine,
} from "@remixicon/react";
import type {
	AcpConfigOption,
	AcpPermissionOption,
	AcpToolCallSummary,
	AcpTranscriptEntry,
} from "@thinkrail/contracts";
import { ACP_CONFIG_OPTIONS_PROTOCOL_VERSION, ACP_PROTOCOL_VERSION } from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { Button, IconButton } from "@thinkrail/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@thinkrail/ui/dialog";
import { Textarea } from "@thinkrail/ui/textarea";
import { cn } from "@thinkrail/ui/utils";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { QuietScrollArea } from "../components/QuietScrollArea";
import { toast, useAppStore } from "../store";
import { errorText, getTransport } from "../transport";
import { useAcpStore } from "./acpStore";
import { acpSessionStateKey as statusKey } from "./sessionState";
import {
	type AcpPromptImagesController,
	acpImagePasteDropHandlers,
	useAcpImages,
} from "./useAcpImages";

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
			className={cn(
				"flex min-w-0 flex-col gap-4 rounded-lg border px-12 py-8",
				user
					? "ml-auto w-fit max-w-[85%] border-border-default bg-control-bg"
					: "mr-auto w-full max-w-full border-border-default bg-container-sidebar-bg",
			)}
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

function PillSelect({
	label,
	value,
	options,
	onChange,
	testId,
	disabled = false,
}: {
	label: string;
	value: string;
	options: Array<{ value: string; label: string }>;
	onChange: (value: string) => void;
	testId: string;
	disabled?: boolean;
}) {
	return (
		<label className="flex min-h-32 min-w-0 items-center gap-6 rounded-full border border-border-default bg-control-bg py-2 pr-8 pl-8">
			<span className="shrink-0 text-text-muted tr-text-metadata">{label}</span>
			<span className="relative min-w-0">
				<select
					aria-label={label}
					data-testid={testId}
					value={value}
					disabled={disabled}
					onChange={(event) => onChange(event.currentTarget.value)}
					className="max-w-224 min-w-0 appearance-none truncate bg-transparent pr-16 text-text-default tr-text-ui outline-none disabled:text-control-disabled-text"
				>
					{options.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
				<RiArrowDownSLine
					aria-hidden
					className="pointer-events-none absolute top-1/2 right-0 size-14 -translate-y-1/2 text-text-muted"
				/>
			</span>
		</label>
	);
}

function AcpImageChips({ controller }: { controller: AcpPromptImagesController }) {
	const t = useT();
	const { images, pending, errors, removeImage, dismissError } = controller;
	if (images.length === 0 && pending === 0 && errors.length === 0) return null;
	return (
		<div data-testid="acp-prompt-images" className="flex min-w-0 flex-wrap gap-6">
			{errors.map((error) => (
				<div
					key={error.id}
					role="status"
					className="flex max-w-full items-center gap-4 rounded-sm border border-feedback-error bg-control-bg px-8 py-4 text-feedback-error tr-text-metadata"
				>
					<RiErrorWarningLine className="size-14 shrink-0" />
					<span className="max-w-160 truncate">{error.name}</span>
					<span className="shrink-0">
						·{" "}
						{t(
							error.reason === "unsupported" ? "acp.chat.imageUnsupported" : "acp.chat.imageLimit",
						)}
					</span>
					<IconButton
						icon={RiCloseLine}
						size="s"
						label={t("common.dismiss")}
						onClick={() => dismissError(error.id)}
					/>
				</div>
			))}
			{images.map((image) => (
				<div
					key={image.id}
					data-testid="acp-prompt-image"
					className="flex w-80 min-w-0 flex-col gap-2"
				>
					<div className="relative size-64 overflow-hidden rounded-sm border border-border-default bg-control-bg">
						<img
							src={`data:${image.content.mimeType};base64,${image.content.data}`}
							alt={image.name}
							className="size-full object-cover"
						/>
						<IconButton
							icon={RiCloseLine}
							size="s"
							label={t("acp.chat.removeImage")}
							onClick={() => removeImage(image.id)}
							className="absolute top-2 right-2"
						/>
					</div>
					<span className="truncate text-text-muted tr-text-metadata">{image.name}</span>
				</div>
			))}
			{pending > 0 ? (
				<div className="flex size-64 items-center justify-center rounded-sm border border-border-default bg-control-bg text-text-muted">
					<RiLoader4Line className="size-16 animate-spin" />
				</div>
			) : null}
		</div>
	);
}

function ToolCallRow({ toolCall }: { toolCall: AcpToolCallSummary }) {
	const t = useT();
	const failed = toolCall.status === "failed";
	const completed = toolCall.status === "completed";
	return (
		<li
			data-testid={`acp-tool-${toolCall.id}`}
			className="flex min-w-0 items-center gap-8 rounded-sm border border-border-default bg-control-bg px-8 py-6"
		>
			{failed ? (
				<RiErrorWarningLine className="size-14 shrink-0 text-feedback-error" />
			) : completed ? (
				<RiCheckboxCircleLine className="size-14 shrink-0 text-feedback-success" />
			) : (
				<RiToolsLine className="size-14 shrink-0 text-text-muted" />
			)}
			<span className="min-w-0 flex-1 truncate text-text-default tr-text-ui">{toolCall.title}</span>
			<span
				className={cn(
					"shrink-0 tr-text-metadata",
					failed ? "text-feedback-error" : completed ? "text-feedback-success" : "text-text-muted",
				)}
			>
				{t(toolStateKey(toolCall.status))}
			</span>
		</li>
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
	const messageRows = useMemo(
		() => snapshot?.messages.map((entry) => <MessageRow key={entry.id} entry={entry} />),
		[snapshot?.messages],
	);
	const attachments = useAcpImages();
	const imageInputRef = useRef<HTMLInputElement>(null);
	const [text, setText] = useState("");
	const [loading, setLoading] = useState(false);
	const [loadFailed, setLoadFailed] = useState(false);
	const [sending, setSending] = useState(false);
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const supported =
		status === "connected" && protocolVersion !== null && protocolVersion >= ACP_PROTOCOL_VERSION;
	const configOptions =
		protocolVersion !== null && protocolVersion >= ACP_CONFIG_OPTIONS_PROTOCOL_VERSION
			? (snapshot?.configOptions ?? [])
			: [];
	const modelOptions = configOptions.filter(
		(option) => option.category === "model" && option.options.length > 0,
	);
	const effortOptions = configOptions.filter(
		(option) => option.category === "thought_level" && option.options.length > 0,
	);
	const otherConfigOptions = configOptions.filter(
		(option) =>
			option.category !== "model" &&
			option.category !== "thought_level" &&
			option.category !== "mode",
	);
	const hasContent = text.trim().length > 0 || attachments.images.length > 0;
	const isRunning = snapshot?.summary.state === "running";
	const isInterrupted = snapshot?.summary.state === "interrupted";
	const isBlocked =
		isRunning ||
		isInterrupted ||
		snapshot?.permission !== null ||
		sending ||
		attachments.pending > 0;
	const isEmpty =
		!!snapshot &&
		snapshot.messages.length === 0 &&
		!draft?.assistantText &&
		!draft?.thoughtText &&
		snapshot.toolCalls.length === 0;

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
		if (!snapshot || !hasContent || isBlocked) return;
		const images = attachments.images.map((image) => image.content);
		setSending(true);
		void getTransport()
			.request("acp.session.prompt", {
				workspaceId,
				sessionId,
				text: message,
				...(images.length > 0 ? { images } : {}),
			})
			.then(() => {
				setText("");
				attachments.reset();
			})
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

	const setConfigOption = async (option: AcpConfigOption, value: string) => {
		try {
			await getTransport().request("acp.session.setConfigOption", {
				workspaceId,
				sessionId,
				configId: option.id,
				value,
			});
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

	const imageHandlers = acpImagePasteDropHandlers(attachments);

	return (
		<section
			data-testid="acp-chat-pane"
			data-acp-session-id={sessionId}
			className="flex h-full min-h-0 min-w-0 flex-col bg-container-content-bg"
		>
			<header className="border-b border-border-default bg-container-content-bg px-16 py-12">
				<div className="mx-auto flex w-full max-w-896 min-w-0 flex-col gap-8">
					<div className="flex min-w-0 items-start justify-between gap-12">
						<div className="flex min-w-0 items-center gap-8">
							<span className="flex size-36 shrink-0 items-center justify-center rounded-sm border border-border-default bg-control-bg text-text-muted">
								<RiRobot2Line className="size-18" />
							</span>
							<div className="min-w-0">
								<h2 className="truncate tr-title-compact text-text-default">
									{snapshot?.summary.title || t("acp.chat.title")}
								</h2>
								<p className="truncate text-text-muted tr-text-metadata">
									{snapshot ? (
										<>
											<span
												aria-hidden
												className={cn(
													"mr-4",
													snapshot.summary.state === "failed"
														? "text-feedback-error"
														: snapshot.summary.state === "running"
															? "text-feedback-info"
															: "text-feedback-success",
												)}
											>
												●
											</span>
											{snapshot.summary.clientName} · {t(statusKey(snapshot.summary.state))}
										</>
									) : (
										t("acp.chat.subtitle")
									)}
								</p>
							</div>
						</div>
						<div className="flex shrink-0 flex-wrap items-center justify-end gap-4">
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
							<IconButton
								icon={RiDeleteBinLine}
								label={t("acp.chat.delete")}
								onClick={() => setDeleteOpen(true)}
								disabled={!snapshot || !supported}
								data-testid="acp-delete-chat"
							/>
						</div>
					</div>
					{snapshot ? (
						<div className="flex min-w-0 flex-wrap items-center gap-6">
							{modelOptions.map((option) => (
								<PillSelect
									key={option.id}
									label={t("acp.chat.model")}
									value={option.currentValue}
									options={option.options.map((choice) => ({
										value: choice.value,
										label: choice.name,
									}))}
									onChange={(value) => void setConfigOption(option, value)}
									testId="acp-model-select"
								/>
							))}
							{effortOptions.map((option) => (
								<PillSelect
									key={option.id}
									label={t("acp.chat.effort")}
									value={option.currentValue}
									options={option.options.map((choice) => ({
										value: choice.value,
										label: choice.name,
									}))}
									onChange={(value) => void setConfigOption(option, value)}
									testId="acp-effort-select"
								/>
							))}
							{snapshot.modes.length ? (
								<PillSelect
									label={t("acp.chat.mode")}
									value={snapshot.currentMode ?? ""}
									options={snapshot.modes.map((mode) => ({
										value: mode.id,
										label: mode.name,
									}))}
									onChange={(value) => void setMode(value)}
									testId="acp-mode-select"
								/>
							) : null}
							{otherConfigOptions.map((option) => (
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
					<QuietScrollArea className="min-h-0 flex-1" viewportClassName="px-16 py-16">
						<div className="mx-auto flex min-h-full w-full max-w-896 min-w-0 flex-col gap-16">
							{isEmpty ? (
								<div
									data-testid="acp-empty-state"
									className="flex flex-1 flex-col items-center justify-center gap-12 px-16 py-24 text-center"
								>
									<span className="flex size-56 items-center justify-center rounded-sm border border-border-default bg-control-bg text-text-muted">
										<RiRobot2Line className="size-28" />
									</span>
									<div className="flex max-w-[30rem] flex-col gap-4">
										<h3 className="tr-title-section text-text-default">
											{t("acp.chat.emptyTitle", { client: snapshot.summary.clientName })}
										</h3>
										<p className="text-text-muted tr-text-ui">
											{t("acp.chat.emptyDescription", { client: snapshot.summary.clientName })}
										</p>
									</div>
									{snapshot.availableCommands.length > 0 ? (
										<ul className="flex min-w-0 flex-wrap justify-center gap-6">
											{snapshot.availableCommands.map((command) => (
												<li
													key={command.name}
													className="max-w-full break-words rounded-full border border-border-default bg-control-bg px-8 py-4 tr-code-text text-text-muted"
												>
													{command.name}
												</li>
											))}
										</ul>
									) : null}
								</div>
							) : (
								<>
									{messageRows}
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
													<ToolCallRow key={toolCall.id} toolCall={toolCall} />
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
										<details className="rounded-sm border border-border-default px-12 py-8">
											<summary className="cursor-pointer text-text-muted tr-text-metadata">
												{t("acp.chat.commands")}
											</summary>
											<ul className="mt-8 flex min-w-0 flex-wrap gap-6">
												{snapshot.availableCommands.map((command) => (
													<li
														key={command.name}
														className="max-w-full break-words rounded-full border border-border-default bg-control-bg px-8 py-4 tr-code-text text-text-muted"
													>
														{command.name}
													</li>
												))}
											</ul>
										</details>
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
								</>
							)}
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

					<div className="border-t border-border-default bg-container-content-bg px-16 py-12">
						<form
							onSubmit={(event) => {
								event.preventDefault();
								void send();
							}}
							className="mx-auto flex w-full max-w-896 min-w-0 flex-col gap-8 rounded-sm border border-border-default bg-control-bg p-8 focus-within:border-control-border-active"
						>
							<AcpImageChips controller={attachments} />
							<input
								ref={imageInputRef}
								type="file"
								accept="image/png,image/jpeg,image/gif,image/webp"
								multiple
								hidden
								onChange={(event) => {
									const files = [...(event.currentTarget.files ?? [])];
									event.currentTarget.value = "";
									attachments.addFiles(files);
								}}
							/>
							<label htmlFor={`acp-prompt-${tabId}`} className="sr-only">
								{t("acp.chat.promptLabel")}
							</label>
							<Textarea
								id={`acp-prompt-${tabId}`}
								data-testid="acp-prompt"
								value={text}
								onChange={(event) => setText(event.currentTarget.value)}
								onKeyDown={submitOnShortcut}
								onPaste={imageHandlers.onPaste}
								onDrop={imageHandlers.onDrop}
								onDragOver={(event) => event.preventDefault()}
								rows={3}
								maxLength={100_000}
								disabled={!supported || isBlocked}
								placeholder={t("acp.chat.promptPlaceholder")}
								className="max-h-192 min-h-64 w-full min-w-0 resize-none border-0 bg-transparent px-0 py-0 shadow-none focus-visible:ring-0 tr-text-ui"
							/>
							<div className="flex flex-col-reverse gap-8 sm:flex-row sm:items-center sm:justify-between">
								<div className="flex min-w-0 items-center gap-6">
									<IconButton
										icon={RiImageAddLine}
										label={t("acp.chat.attachImage")}
										onClick={() => imageInputRef.current?.click()}
										disabled={!supported || isBlocked}
										data-testid="acp-attach-image"
									/>
									<p className="truncate text-text-muted tr-text-metadata">
										{t("acp.chat.promptHint")}
									</p>
								</div>
								<Button
									type="submit"
									variant="primary"
									size="m"
									iconLeft={RiSendPlane2Line}
									disabled={!supported || isBlocked || !hasContent}
								>
									{sending ? t("acp.chat.sending") : t("acp.chat.send")}
								</Button>
							</div>
						</form>
					</div>
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
