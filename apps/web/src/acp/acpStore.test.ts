import { beforeEach, expect, test } from "bun:test";
import type { AcpSessionEvent, AcpSessionSnapshot, AcpSessionSummary } from "@thinkrail/contracts";
import { useAcpStore } from "./acpStore";

const summary: AcpSessionSummary = {
	id: "acp-1",
	workspaceId: "ws-1",
	clientId: "droid",
	clientName: "Droid",
	title: "Agent session",
	state: "running",
	resumable: true,
	createdAt: 1,
	updatedAt: 1,
};

function snapshot(): AcpSessionSnapshot {
	return {
		summary,
		messages: [],
		toolCalls: [],
		plan: [],
		modes: [],
		currentMode: null,
		configOptions: [],
		availableCommands: [],
		usage: null,
		permission: null,
	};
}

beforeEach(() => {
	useAcpStore.setState({
		connectionGeneration: 0,
		sessionsByWorkspace: {},
		snapshotsBySession: {},
		snapshotGenerationBySession: {},
		hydratingGenerationBySession: {},
		pendingEventsBySession: {},
		draftsBySession: {},
	});
});

test("replays ACP events buffered during snapshot hydration", () => {
	const store = useAcpStore.getState();
	store.setConnectionGeneration(4);
	store.beginSnapshotHydration(summary.id, 4);
	store.applyEvent(
		{ type: "messageDelta", sessionId: summary.id, role: "assistant", delta: "working" },
		4,
	);
	store.applyEvent(
		{
			type: "toolCall",
			sessionId: summary.id,
			toolCall: { id: "tool-1", title: "Read file", kind: "read", status: "in-progress" },
		},
		4,
	);

	useAcpStore.getState().installSnapshot(snapshot(), 4);

	expect(useAcpStore.getState().draftsBySession[summary.id]?.assistantText).toBe("working");
	expect(useAcpStore.getState().snapshotsBySession[summary.id]?.toolCalls).toEqual([
		{ id: "tool-1", title: "Read file", kind: "read", status: "in-progress" },
	]);
	expect(useAcpStore.getState().pendingEventsBySession[summary.id]).toBeUndefined();
});

test("stale generations cannot overwrite the current ACP snapshot or transcript", () => {
	const store = useAcpStore.getState();
	store.setConnectionGeneration(4);
	store.installSnapshot(snapshot(), 4);
	store.setConnectionGeneration(5);

	store.applyEvent(
		{
			type: "message",
			sessionId: summary.id,
			entry: { id: "late", role: "assistant", text: "late event", createdAt: 2 },
		} satisfies AcpSessionEvent,
		4,
	);
	store.installSnapshot(
		{
			...snapshot(),
			messages: [{ id: "stale", role: "assistant", text: "stale snapshot", createdAt: 2 }],
		},
		4,
	);

	expect(useAcpStore.getState().snapshotsBySession[summary.id]?.messages).toEqual([]);
	expect(useAcpStore.getState().snapshotGenerationBySession[summary.id]).toBe(4);
});

test("ACP config option snapshots replace removed and changed options", () => {
	const store = useAcpStore.getState();
	store.setConnectionGeneration(4);
	store.installSnapshot(
		{
			...snapshot(),
			configOptions: [
				{
					id: "model",
					name: "Model",
					category: "model",
					currentValue: "model-a",
					options: [{ value: "model-a", name: "Model A" }],
				},
				{
					id: "obsolete",
					name: "Old setting",
					currentValue: "old",
					options: [{ value: "old", name: "Old" }],
				},
			],
		},
		4,
	);

	store.applyEvent(
		{
			type: "configOptions",
			sessionId: summary.id,
			options: [
				{
					id: "model",
					name: "Model",
					category: "model",
					currentValue: "model-b",
					options: [{ value: "model-b", name: "Model B" }],
				},
			],
		},
		4,
	);

	expect(useAcpStore.getState().snapshotsBySession[summary.id]?.configOptions).toEqual([
		{
			id: "model",
			name: "Model",
			category: "model",
			currentValue: "model-b",
			options: [{ value: "model-b", name: "Model B" }],
		},
	]);
});

test("ACP deletion clears only its separate workspace projection", () => {
	const store = useAcpStore.getState();
	store.setConnectionGeneration(4);
	store.installSnapshot(snapshot(), 4);
	store.applyEvent({ type: "deleted", sessionId: summary.id }, 4);

	expect(useAcpStore.getState().snapshotsBySession[summary.id]).toBeUndefined();
	expect(useAcpStore.getState().sessionsByWorkspace["ws-1"]).toEqual([]);
});

test("workspace removal clears only that workspace's ACP sessions", () => {
	const store = useAcpStore.getState();
	store.setConnectionGeneration(4);
	store.installSnapshot(snapshot(), 4);
	store.installSnapshot(
		{
			...snapshot(),
			summary: { ...summary, id: "acp-2", workspaceId: "ws-2" },
		},
		4,
	);
	store.removeWorkspace("ws-1");

	expect(useAcpStore.getState().snapshotsBySession["acp-1"]).toBeUndefined();
	expect(useAcpStore.getState().snapshotsBySession["acp-2"]).toBeDefined();
	expect(useAcpStore.getState().sessionsByWorkspace["ws-1"]).toBeUndefined();
});
