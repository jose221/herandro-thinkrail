import { useAppStore } from "../store";

export function activeChatSessionId(workspaceId: string): string | null {
	const state = useAppStore.getState();
	const tabId = state.activeTabByWorkspace[workspaceId];
	const tab = (state.tabsByWorkspace[workspaceId] ?? []).find(
		(candidate) => candidate.id === tabId,
	);
	return tab?.kind === "chat" ? tab.sessionId : null;
}
