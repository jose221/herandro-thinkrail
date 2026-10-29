import { ACP_PROTOCOL_VERSION } from "@thinkrail/contracts";
import { useAppStore } from "../store";
import { subscribeAcpWireEvents } from "../transport";
import { useAcpStore } from "./acpStore";

let stopListening: (() => void) | null = null;

export function initAcpStoreProjection(): void {
	if (stopListening) return;
	stopListening = subscribeAcpWireEvents((notice) => {
		const store = useAcpStore.getState();
		switch (notice.kind) {
			case "welcome":
				store.setConnectionGeneration(notice.connectionGeneration);
				if (notice.protocolVersion < ACP_PROTOCOL_VERSION) store.clear();
				break;
			case "workspaceRemoved":
				store.removeWorkspace(notice.workspaceId);
				break;
			case "event": {
				const event = notice.event;
				store.applyEvent(event, notice.connectionGeneration);
				if (event.type === "deleted") {
					const sessionId = event.sessionId;
					const workspaceWithTab = Object.entries(useAppStore.getState().tabsByWorkspace).find(
						([, tabs]) =>
							tabs.some((tab) => tab.kind === "acp-chat" && tab.acpSessionId === sessionId),
					);
					if (workspaceWithTab) {
						const [workspaceId, tabs] = workspaceWithTab;
						const tab = tabs.find(
							(candidate) => candidate.kind === "acp-chat" && candidate.acpSessionId === sessionId,
						);
						if (tab) useAppStore.getState().closeTab(tab.id, true, true, workspaceId);
					}
				}
				break;
			}
		}
	});
}
