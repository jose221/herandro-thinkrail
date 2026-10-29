import type { AcpEventPayload } from "@thinkrail/contracts";

export type AcpWireNotice =
	| {
			kind: "welcome";
			protocolVersion: number;
			connectionGeneration: number;
	  }
	| {
			kind: "event";
			event: AcpEventPayload;
			connectionGeneration: number;
	  }
	| {
			kind: "workspaceRemoved";
			workspaceId: string;
	  };

const listeners = new Set<(notice: AcpWireNotice) => void>();

export function subscribeAcpWireEvents(listener: (notice: AcpWireNotice) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function publishAcpWireEvent(notice: AcpWireNotice): void {
	for (const listener of listeners) listener(notice);
}
