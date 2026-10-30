import type { AcpSessionSnapshot } from "@thinkrail/contracts";
import { ACP_PROTOCOL_VERSION } from "@thinkrail/contracts";
import {
	acpChatTabId,
	isCenterNavigationCurrent,
	layoutOpenOptionsForNavigation,
	useAppStore,
} from "../store";
import { getTransport } from "../transport";
import { useAcpStore } from "./acpStore";

function canOpenAcpChat(): boolean {
	const { protocolVersion, status } = useAppStore.getState();
	return (
		status === "connected" && protocolVersion !== null && protocolVersion >= ACP_PROTOCOL_VERSION
	);
}

function placeAcpChat(
	workspaceId: string,
	snapshot: AcpSessionSnapshot,
	generation: number,
	navigation: ReturnType<ReturnType<typeof useAppStore.getState>["beginCenterNavigation"]>,
): boolean {
	const state = useAppStore.getState();
	if (
		state.connectionGeneration !== generation ||
		!canOpenAcpChat() ||
		state.removedWorkspaceIds[workspaceId] ||
		snapshot.summary.workspaceId !== workspaceId
	) {
		return false;
	}
	useAcpStore.getState().installSnapshot(snapshot, generation);
	if (!isCenterNavigationCurrent(state, workspaceId, navigation)) return false;
	state.openTab(
		{
			kind: "acp-chat",
			id: acpChatTabId(workspaceId, snapshot.summary.id),
			workspaceId,
			name: snapshot.summary.title,
			acpSessionId: snapshot.summary.id,
		},
		"keep",
		true,
		layoutOpenOptionsForNavigation(state, workspaceId, navigation),
	);
	return true;
}

export async function openAcpChatInTab(
	workspaceId: string,
	acpSessionId: string,
	targetGroupId?: string,
): Promise<boolean> {
	if (!canOpenAcpChat()) return false;
	const state = useAppStore.getState();
	const generation = state.connectionGeneration;
	const navigation = state.beginCenterNavigation(workspaceId, targetGroupId);
	useAcpStore.getState().beginSnapshotHydration(acpSessionId, generation);
	try {
		const snapshot = await getTransport().request("acp.session.get", {
			workspaceId,
			sessionId: acpSessionId,
		});
		if (snapshot.summary.id !== acpSessionId) {
			useAcpStore.getState().cancelSnapshotHydration(acpSessionId, generation);
			return false;
		}
		const opened = placeAcpChat(workspaceId, snapshot, generation, navigation);
		if (!opened) useAcpStore.getState().cancelSnapshotHydration(acpSessionId, generation);
		return opened;
	} catch {
		useAcpStore.getState().cancelSnapshotHydration(acpSessionId, generation);
		return false;
	}
}

export async function createAcpChatInTab(
	workspaceId: string,
	clientId: string,
	targetGroupId?: string,
	initialModel?: { configId: string; value: string },
): Promise<boolean> {
	if (!canOpenAcpChat()) return false;
	const state = useAppStore.getState();
	const generation = state.connectionGeneration;
	const navigation = state.beginCenterNavigation(workspaceId, targetGroupId);
	let createdSessionId: string | null = null;
	try {
		let snapshot = await getTransport().request("acp.session.create", {
			workspaceId,
			clientId,
		});
		createdSessionId = snapshot.summary.id;
		if (snapshot.summary.workspaceId !== workspaceId) {
			await discardCreatedAcpChat(workspaceId, createdSessionId);
			return false;
		}
		if (initialModel) {
			const option = snapshot.configOptions.find(
				(candidate) =>
					candidate.id === initialModel.configId &&
					candidate.category === "model" &&
					candidate.options.some((choice) => choice.value === initialModel.value),
			);
			if (!option) {
				await discardCreatedAcpChat(workspaceId, createdSessionId);
				return false;
			}
			await getTransport().request("acp.session.setConfigOption", {
				workspaceId,
				sessionId: createdSessionId,
				configId: initialModel.configId,
				value: initialModel.value,
			});
			snapshot = await getTransport().request("acp.session.get", {
				workspaceId,
				sessionId: createdSessionId,
			});
			if (
				snapshot.summary.id !== createdSessionId ||
				snapshot.summary.workspaceId !== workspaceId
			) {
				await discardCreatedAcpChat(workspaceId, createdSessionId);
				return false;
			}
		}
		const placed = await placeAcpChat(workspaceId, snapshot, generation, navigation);
		if (!placed) await discardCreatedAcpChat(workspaceId, createdSessionId);
		return placed;
	} catch {
		if (createdSessionId) await discardCreatedAcpChat(workspaceId, createdSessionId);
		return false;
	}
}

async function discardCreatedAcpChat(workspaceId: string, sessionId: string): Promise<void> {
	await getTransport()
		.request("acp.session.delete", { workspaceId, sessionId })
		.catch(() => {});
}
