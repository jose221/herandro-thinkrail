import type { AcpSessionEvent, AcpSessionSnapshot, AcpSessionSummary } from "@thinkrail/contracts";
import { create } from "zustand";

export interface AcpStreamingDraft {
	assistantText: string;
	thoughtText: string;
	assistantImages: Array<{ mimeType: string; data: string }>;
	thoughtImages: Array<{ mimeType: string; data: string }>;
}

const ACP_EVENT_BUFFER_LIMIT = 1024;

interface AcpStoreState {
	connectionGeneration: number;
	sessionsByWorkspace: Record<string, AcpSessionSummary[]>;
	snapshotsBySession: Record<string, AcpSessionSnapshot>;
	snapshotGenerationBySession: Record<string, number>;
	hydratingGenerationBySession: Record<string, number>;
	pendingEventsBySession: Record<string, AcpSessionEvent[]>;
	draftsBySession: Record<string, AcpStreamingDraft>;
	setConnectionGeneration: (generation: number) => void;
	beginSnapshotHydration: (sessionId: string, generation: number) => void;
	cancelSnapshotHydration: (sessionId: string, generation: number) => void;
	installSessions: (workspaceId: string, sessions: AcpSessionSummary[], generation: number) => void;
	installSnapshot: (snapshot: AcpSessionSnapshot, generation: number) => void;
	applyEvent: (event: AcpSessionEvent, generation: number) => void;
	invalidateSnapshot: (sessionId: string) => void;
	removeSession: (workspaceId: string, sessionId: string) => void;
	removeWorkspace: (workspaceId: string) => void;
	clear: () => void;
}

const emptyDraft = (): AcpStreamingDraft => ({
	assistantText: "",
	thoughtText: "",
	assistantImages: [],
	thoughtImages: [],
});

function upsertSummary(
	sessions: AcpSessionSummary[],
	summary: AcpSessionSummary,
): AcpSessionSummary[] {
	return [summary, ...sessions.filter((session) => session.id !== summary.id)].sort(
		(left, right) => right.updatedAt - left.updatedAt,
	);
}

function appendDelta(current: string, delta: string): string {
	return `${current}${delta}`.slice(-100_000);
}

export const useAcpStore = create<AcpStoreState>((set, get) => ({
	connectionGeneration: 0,
	sessionsByWorkspace: {},
	snapshotsBySession: {},
	snapshotGenerationBySession: {},
	hydratingGenerationBySession: {},
	pendingEventsBySession: {},
	draftsBySession: {},
	setConnectionGeneration: (generation) =>
		set((state) =>
			state.connectionGeneration === generation
				? {}
				: {
						connectionGeneration: generation,
						hydratingGenerationBySession: {},
						pendingEventsBySession: {},
					},
		),
	beginSnapshotHydration: (sessionId, generation) =>
		set((state) =>
			state.connectionGeneration !== generation
				? {}
				: {
						hydratingGenerationBySession: {
							...state.hydratingGenerationBySession,
							[sessionId]: generation,
						},
						pendingEventsBySession: {
							...state.pendingEventsBySession,
							[sessionId]: [],
						},
					},
		),
	cancelSnapshotHydration: (sessionId, generation) => {
		let pendingEvents: AcpSessionEvent[] = [];
		let replay = false;
		set((state) => {
			if (state.hydratingGenerationBySession[sessionId] !== generation) return {};
			replay = state.snapshotGenerationBySession[sessionId] === generation;
			pendingEvents = replay ? (state.pendingEventsBySession[sessionId] ?? []) : [];
			return {
				hydratingGenerationBySession: Object.fromEntries(
					Object.entries(state.hydratingGenerationBySession).filter(([id]) => id !== sessionId),
				),
				pendingEventsBySession: Object.fromEntries(
					Object.entries(state.pendingEventsBySession).filter(([id]) => id !== sessionId),
				),
			};
		});
		if (replay) {
			for (const event of pendingEvents) get().applyEvent(event, generation);
		}
	},
	installSessions: (workspaceId, sessions, generation) =>
		set((state) => {
			if (state.connectionGeneration !== generation) return {};
			return {
				sessionsByWorkspace: {
					...state.sessionsByWorkspace,
					[workspaceId]: [...sessions].sort((left, right) => right.updatedAt - left.updatedAt),
				},
			};
		}),
	installSnapshot: (snapshot, generation) => {
		let pendingEvents: AcpSessionEvent[] = [];
		set((state) => {
			if (state.connectionGeneration !== generation) return {};
			pendingEvents = state.pendingEventsBySession[snapshot.summary.id] ?? [];
			const workspaceSessions = state.sessionsByWorkspace[snapshot.summary.workspaceId] ?? [];
			return {
				snapshotsBySession: {
					...state.snapshotsBySession,
					[snapshot.summary.id]: snapshot,
				},
				snapshotGenerationBySession: {
					...state.snapshotGenerationBySession,
					[snapshot.summary.id]: generation,
				},
				hydratingGenerationBySession: Object.fromEntries(
					Object.entries(state.hydratingGenerationBySession).filter(
						([id]) => id !== snapshot.summary.id,
					),
				),
				pendingEventsBySession: Object.fromEntries(
					Object.entries(state.pendingEventsBySession).filter(([id]) => id !== snapshot.summary.id),
				),
				draftsBySession: {
					...state.draftsBySession,
					[snapshot.summary.id]: emptyDraft(),
				},
				sessionsByWorkspace: {
					...state.sessionsByWorkspace,
					[snapshot.summary.workspaceId]: upsertSummary(workspaceSessions, snapshot.summary),
				},
			};
		});
		for (const event of pendingEvents) get().applyEvent(event, generation);
	},
	applyEvent: (event, generation) =>
		set((state) => {
			if (state.connectionGeneration !== generation) return {};
			if (event.type === "created") {
				const workspaceSessions = state.sessionsByWorkspace[event.session.workspaceId] ?? [];
				return {
					sessionsByWorkspace: {
						...state.sessionsByWorkspace,
						[event.session.workspaceId]: upsertSummary(workspaceSessions, event.session),
					},
				};
			}
			if (event.type === "deleted") {
				const summary = Object.values(state.sessionsByWorkspace)
					.flat()
					.find((session) => session.id === event.sessionId);
				return {
					snapshotsBySession: Object.fromEntries(
						Object.entries(state.snapshotsBySession).filter(([id]) => id !== event.sessionId),
					),
					snapshotGenerationBySession: Object.fromEntries(
						Object.entries(state.snapshotGenerationBySession).filter(
							([id]) => id !== event.sessionId,
						),
					),
					hydratingGenerationBySession: Object.fromEntries(
						Object.entries(state.hydratingGenerationBySession).filter(
							([id]) => id !== event.sessionId,
						),
					),
					pendingEventsBySession: Object.fromEntries(
						Object.entries(state.pendingEventsBySession).filter(([id]) => id !== event.sessionId),
					),
					draftsBySession: Object.fromEntries(
						Object.entries(state.draftsBySession).filter(([id]) => id !== event.sessionId),
					),
					sessionsByWorkspace: summary
						? {
								...state.sessionsByWorkspace,
								[summary.workspaceId]: (
									state.sessionsByWorkspace[summary.workspaceId] ?? []
								).filter((session) => session.id !== event.sessionId),
							}
						: state.sessionsByWorkspace,
				};
			}
			if (state.hydratingGenerationBySession[event.sessionId] === generation) {
				const pending = state.pendingEventsBySession[event.sessionId] ?? [];
				return {
					pendingEventsBySession: {
						...state.pendingEventsBySession,
						[event.sessionId]: [...pending, event].slice(-ACP_EVENT_BUFFER_LIMIT),
					},
				};
			}
			const snapshot = state.snapshotsBySession[event.sessionId];
			if (!snapshot || state.snapshotGenerationBySession[event.sessionId] !== generation) {
				return {};
			}
			const snapshotsBySession = { ...state.snapshotsBySession };
			const draftsBySession = { ...state.draftsBySession };
			const draft = { ...(draftsBySession[event.sessionId] ?? emptyDraft()) };
			let next = snapshot;
			switch (event.type) {
				case "message": {
					const entryIndex = snapshot.messages.findIndex((entry) => entry.id === event.entry.id);
					const messages =
						entryIndex < 0
							? [...snapshot.messages, event.entry]
							: snapshot.messages.with(entryIndex, event.entry);
					if (event.entry.role === "assistant") {
						draft.assistantText = "";
						draft.assistantImages = [];
					}
					if (event.entry.role === "thought") {
						draft.thoughtText = "";
						draft.thoughtImages = [];
					}
					next = { ...snapshot, messages };
					break;
				}
				case "messageDelta":
					if (event.role === "assistant")
						draft.assistantText = appendDelta(draft.assistantText, event.delta);
					else draft.thoughtText = appendDelta(draft.thoughtText, event.delta);
					break;
				case "image":
					if (event.role === "assistant")
						draft.assistantImages = [...draft.assistantImages, event.image];
					else draft.thoughtImages = [...draft.thoughtImages, event.image];
					break;
				case "toolCall": {
					const index = snapshot.toolCalls.findIndex((call) => call.id === event.toolCall.id);
					next = {
						...snapshot,
						toolCalls:
							index < 0
								? [...snapshot.toolCalls, event.toolCall]
								: snapshot.toolCalls.with(index, event.toolCall),
					};
					break;
				}
				case "permission":
					next = { ...snapshot, permission: event.permission };
					break;
				case "plan":
					next = { ...snapshot, plan: event.entries };
					break;
				case "mode":
					next = { ...snapshot, currentMode: event.mode };
					break;
				case "configOption": {
					const index = snapshot.configOptions.findIndex((option) => option.id === event.option.id);
					next = {
						...snapshot,
						configOptions:
							index < 0
								? [...snapshot.configOptions, event.option]
								: snapshot.configOptions.with(index, event.option),
					};
					break;
				}
				case "configOptions":
					next = { ...snapshot, configOptions: event.options };
					break;
				case "availableCommands":
					next = { ...snapshot, availableCommands: event.commands };
					break;
				case "usage":
					next = { ...snapshot, usage: event.usage };
					break;
				case "state":
					next = {
						...snapshot,
						summary: { ...snapshot.summary, state: event.state, updatedAt: Date.now() },
					};
					break;
				case "error":
					next = {
						...snapshot,
						messages: [
							...snapshot.messages,
							{
								id: `error-${Date.now()}`,
								role: "notice",
								text: event.message,
								createdAt: Date.now(),
							},
						],
					};
					break;
			}
			snapshotsBySession[event.sessionId] = next;
			draftsBySession[event.sessionId] = draft;
			const workspaceSessions = state.sessionsByWorkspace[snapshot.summary.workspaceId] ?? [];
			const summary = next.summary === snapshot.summary ? snapshot.summary : next.summary;
			return {
				snapshotsBySession,
				draftsBySession,
				sessionsByWorkspace:
					next.summary === snapshot.summary
						? state.sessionsByWorkspace
						: {
								...state.sessionsByWorkspace,
								[snapshot.summary.workspaceId]: upsertSummary(workspaceSessions, summary),
							},
			};
		}),
	invalidateSnapshot: (sessionId) =>
		set((state) => ({
			snapshotGenerationBySession: {
				...state.snapshotGenerationBySession,
				[sessionId]: -1,
			},
		})),
	removeSession: (workspaceId, sessionId) =>
		set((state) => ({
			sessionsByWorkspace: {
				...state.sessionsByWorkspace,
				[workspaceId]: (state.sessionsByWorkspace[workspaceId] ?? []).filter(
					(session) => session.id !== sessionId,
				),
			},
			snapshotsBySession: Object.fromEntries(
				Object.entries(state.snapshotsBySession).filter(([id]) => id !== sessionId),
			),
			snapshotGenerationBySession: Object.fromEntries(
				Object.entries(state.snapshotGenerationBySession).filter(([id]) => id !== sessionId),
			),
			hydratingGenerationBySession: Object.fromEntries(
				Object.entries(state.hydratingGenerationBySession).filter(([id]) => id !== sessionId),
			),
			pendingEventsBySession: Object.fromEntries(
				Object.entries(state.pendingEventsBySession).filter(([id]) => id !== sessionId),
			),
			draftsBySession: Object.fromEntries(
				Object.entries(state.draftsBySession).filter(([id]) => id !== sessionId),
			),
		})),
	removeWorkspace: (workspaceId) =>
		set((state) => {
			const sessionIds = new Set(
				(state.sessionsByWorkspace[workspaceId] ?? []).map((session) => session.id),
			);
			return {
				sessionsByWorkspace: Object.fromEntries(
					Object.entries(state.sessionsByWorkspace).filter(([id]) => id !== workspaceId),
				),
				snapshotsBySession: Object.fromEntries(
					Object.entries(state.snapshotsBySession).filter(([id]) => !sessionIds.has(id)),
				),
				snapshotGenerationBySession: Object.fromEntries(
					Object.entries(state.snapshotGenerationBySession).filter(([id]) => !sessionIds.has(id)),
				),
				hydratingGenerationBySession: Object.fromEntries(
					Object.entries(state.hydratingGenerationBySession).filter(([id]) => !sessionIds.has(id)),
				),
				pendingEventsBySession: Object.fromEntries(
					Object.entries(state.pendingEventsBySession).filter(([id]) => !sessionIds.has(id)),
				),
				draftsBySession: Object.fromEntries(
					Object.entries(state.draftsBySession).filter(([id]) => !sessionIds.has(id)),
				),
			};
		}),
	clear: () =>
		set({
			sessionsByWorkspace: {},
			snapshotsBySession: {},
			snapshotGenerationBySession: {},
			hydratingGenerationBySession: {},
			pendingEventsBySession: {},
			draftsBySession: {},
		}),
}));
