import type { AcpSessionState, AcpSessionSummary } from "@thinkrail/contracts";
import { ACP_PROTOCOL_VERSION } from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@thinkrail/ui/dialog";
import { useEffect, useState } from "react";
import { useAppStore } from "../store";
import { getTransport } from "../transport";
import { useAcpStore } from "./acpStore";
import { createAcpChatInTab, openAcpChatInTab } from "./openAcpChat";

const EMPTY_SESSIONS: readonly AcpSessionSummary[] = [];

function sessionStateKey(state: AcpSessionState) {
	switch (state) {
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

export function AcpNewChatDialog({
	open,
	onOpenChange,
	workspaceId,
	targetGroupId,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	workspaceId: string;
	targetGroupId: string | null;
}) {
	const t = useT();
	const status = useAppStore((state) => state.status);
	const protocolVersion = useAppStore((state) => state.protocolVersion);
	const connectionGeneration = useAppStore((state) => state.connectionGeneration);
	const clients = useAppStore((state) => state.acpClients);
	const sessions = useAcpStore((state) => state.sessionsByWorkspace[workspaceId] ?? EMPTY_SESSIONS);
	const [busyKey, setBusyKey] = useState<string | null>(null);
	const [listFailed, setListFailed] = useState(false);
	const [openFailed, setOpenFailed] = useState(false);
	const supported =
		status === "connected" && protocolVersion !== null && protocolVersion >= ACP_PROTOCOL_VERSION;
	const enabledClients = clients.filter((client) => client.enabled);

	useEffect(() => {
		if (!open || !supported) return;
		let current = true;
		setListFailed(false);
		void getTransport()
			.request("acp.session.list", { workspaceId })
			.then((nextSessions) => {
				const currentState = useAppStore.getState();
				if (
					!current ||
					currentState.connectionGeneration !== connectionGeneration ||
					currentState.removedWorkspaceIds[workspaceId]
				) {
					return;
				}
				useAcpStore.getState().installSessions(workspaceId, nextSessions, connectionGeneration);
			})
			.catch(() => {
				if (current) setListFailed(true);
			});
		return () => {
			current = false;
		};
	}, [connectionGeneration, open, supported, workspaceId]);

	const chooseClient = async (clientId: string) => {
		if (busyKey) return;
		setBusyKey(clientId);
		setOpenFailed(false);
		const opened = await createAcpChatInTab(workspaceId, clientId, targetGroupId ?? undefined);
		setBusyKey(null);
		if (opened) onOpenChange(false);
		else setOpenFailed(true);
	};

	const chooseSession = async (session: AcpSessionSummary) => {
		if (busyKey) return;
		setBusyKey(session.id);
		setOpenFailed(false);
		const opened = await openAcpChatInTab(workspaceId, session.id, targetGroupId ?? undefined);
		setBusyKey(null);
		if (opened) onOpenChange(false);
		else setOpenFailed(true);
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (!busyKey) onOpenChange(nextOpen);
			}}
		>
			<DialogContent
				data-testid="acp-new-chat-dialog"
				className="max-h-[calc(100dvh-2rem)] max-w-[32rem] overflow-y-auto"
			>
				<DialogHeader>
					<DialogTitle>{t("acp.chat.new.title")}</DialogTitle>
					<DialogDescription>{t("acp.chat.new.description")}</DialogDescription>
				</DialogHeader>

				{!supported ? (
					<p role="status" className="text-text-muted tr-text-metadata">
						{t("acp.chat.connectionRequired")}
					</p>
				) : null}
				{supported ? (
					<section className="flex min-w-0 flex-col gap-8">
						<h3 className="tr-title-compact text-text-default">{t("acp.chat.new.agents")}</h3>
						{enabledClients.length > 0 ? (
							<ul className="flex min-w-0 flex-col gap-8">
								{enabledClients.map((client) => (
									<li key={client.id} className="flex min-w-0 flex-col gap-8 sm:flex-row">
										<div className="min-w-0 flex-1">
											<p className="break-words tr-text-ui text-text-default">{client.name}</p>
										</div>
										<Button
											type="button"
											variant="outline"
											size="m"
											disabled={busyKey !== null}
											data-testid={`acp-start-${client.id}`}
											onClick={() => void chooseClient(client.id)}
											className="shrink-0"
										>
											{busyKey === client.id ? t("acp.chat.new.starting") : t("acp.chat.new.start")}
										</Button>
									</li>
								))}
							</ul>
						) : (
							<p className="text-text-muted tr-text-metadata">{t("acp.chat.new.noAgents")}</p>
						)}
					</section>
				) : null}

				{supported ? (
					<section className="flex min-w-0 flex-col gap-8 border-t border-border-default pt-12">
						<h3 className="tr-title-compact text-text-default">{t("acp.chat.new.recent")}</h3>
						{listFailed ? (
							<p role="alert" className="text-feedback-error tr-text-metadata">
								{t("acp.chat.new.listFailed")}
							</p>
						) : sessions.length > 0 ? (
							<ul className="flex min-w-0 flex-col gap-8">
								{sessions.map((session) => (
									<li key={session.id} className="min-w-0">
										<Button
											type="button"
											variant="outline"
											size="m"
											disabled={busyKey !== null}
											data-testid={`acp-open-${session.id}`}
											onClick={() => void chooseSession(session)}
											className="w-full min-w-0"
										>
											<span className="min-w-0 flex-1 truncate text-left">
												{session.title || session.clientName}
											</span>
											{busyKey === session.id ? <span>{t("acp.chat.new.opening")}</span> : null}
										</Button>
										<p className="break-words px-8 text-text-muted tr-text-metadata">
											{session.clientName} · {t(sessionStateKey(session.state))}
										</p>
									</li>
								))}
							</ul>
						) : (
							<p className="text-text-muted tr-text-metadata">{t("acp.chat.new.empty")}</p>
						)}
					</section>
				) : null}
				{openFailed ? (
					<p role="alert" className="text-feedback-error tr-text-metadata">
						{t("acp.chat.new.openFailed")}
					</p>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
