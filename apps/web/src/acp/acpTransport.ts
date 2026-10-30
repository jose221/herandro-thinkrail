import type { AcpSessionEvent } from "@thinkrail/contracts";
import { ACP_PROTOCOL_VERSION } from "@thinkrail/contracts";
import { useAppStore } from "../store";
import { subscribeAcpWireEvents } from "../transport";
import { useAcpStore } from "./acpStore";

let stopListening: (() => void) | null = null;
const ACP_DELTA_BATCH_MS = 16;
const ACP_DELTA_BATCH_EVENT_LIMIT = 256;
type AcpMessageDeltaEvent = Extract<AcpSessionEvent, { type: "messageDelta" }>;

export function initAcpStoreProjection(): void {
	if (stopListening) return;
	let pendingDeltas: Array<{
		event: AcpMessageDeltaEvent;
		generation: number;
	}> = [];
	let deltaTimer: ReturnType<typeof setTimeout> | null = null;
	const flushDeltas = (): void => {
		if (deltaTimer) clearTimeout(deltaTimer);
		deltaTimer = null;
		const events = pendingDeltas;
		pendingDeltas = [];
		const byGeneration = new Map<number, typeof events>();
		for (const pending of events) {
			const generationEvents = byGeneration.get(pending.generation) ?? [];
			generationEvents.push(pending);
			byGeneration.set(pending.generation, generationEvents);
		}
		for (const [generation, generationEvents] of byGeneration) {
			useAcpStore.getState().applyMessageDeltas(
				generationEvents.map((pending) => pending.event),
				generation,
			);
		}
	};
	const unsubscribe = subscribeAcpWireEvents((notice) => {
		const store = useAcpStore.getState();
		switch (notice.kind) {
			case "welcome":
				flushDeltas();
				store.setConnectionGeneration(notice.connectionGeneration);
				if (notice.protocolVersion < ACP_PROTOCOL_VERSION) store.clear();
				break;
			case "workspaceRemoved":
				flushDeltas();
				store.removeWorkspace(notice.workspaceId);
				break;
			case "event": {
				const event = notice.event;
				if (event.type === "messageDelta") {
					pendingDeltas.push({ event, generation: notice.connectionGeneration });
					if (pendingDeltas.length >= ACP_DELTA_BATCH_EVENT_LIMIT) {
						flushDeltas();
					} else {
						deltaTimer ??= setTimeout(flushDeltas, ACP_DELTA_BATCH_MS);
					}
					break;
				}
				flushDeltas();
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
	stopListening = () => {
		unsubscribe();
		flushDeltas();
		stopListening = null;
	};
}
