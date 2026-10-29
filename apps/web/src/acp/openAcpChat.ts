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
): Promise<boolean> {
	if (!canOpenAcpChat()) return false;
	const state = useAppStore.getState();
	const generation = state.connectionGeneration;
	const navigation = state.beginCenterNavigation(workspaceId, targetGroupId);
	try {
		const snapshot = await getTransport().request("acp.session.create", {
			workspaceId,
			clientId,
		});
		if (snapshot.summary.workspaceId !== workspaceId) return false;
		return placeAcpChat(workspaceId, snapshot, generation, navigation);
	} catch {
		return false;
	}
}
