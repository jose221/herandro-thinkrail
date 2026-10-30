import type { AcpSessionEvent, AcpSessionSnapshot, AcpSessionSummary } from "@thinkrail/contracts";
import { create } from "zustand";

export interface AcpStreamingDraft {
	assistantText: string;
	thoughtText: string;
	assistantImages: Array<{ mimeType: string; data: string }>;
	thoughtImages: Array<{ mimeType: string; data: string }>;
}

const ACP_EVENT_BUFFER_LIMIT = 1024;
type AcpMessageDeltaEvent = Extract<AcpSessionEvent, { type: "messageDelta" }>;

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
	applyMessageDeltas: (events: AcpMessageDeltaEvent[], generation: number) => void;
	invalidateSnapshot: (sessionId: string) => void;
	removeSession: (workspaceId: string, sessionId: string) => void;
	removeWorkspace: (workspaceId: string) => void;
	clear: () => void;
}

type SessionStateSlices = Pick<
	AcpStoreState,
	| "snapshotsBySession"
	| "snapshotGenerationBySession"
	| "hydratingGenerationBySession"
	| "pendingEventsBySession"
	| "draftsBySession"
>;

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

function withoutSessionState(
	state: SessionStateSlices,
	sessionIds: Set<string>,
): SessionStateSlices {
	const retain = <T>(records: Record<string, T>): Record<string, T> =>
		Object.fromEntries(Object.entries(records).filter(([id]) => !sessionIds.has(id)));
	return {
		snapshotsBySession: retain(state.snapshotsBySession),
		snapshotGenerationBySession: retain(state.snapshotGenerationBySession),
		hydratingGenerationBySession: retain(state.hydratingGenerationBySession),
		pendingEventsBySession: retain(state.pendingEventsBySession),
		draftsBySession: retain(state.draftsBySession),
	};
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
				? state
				: {
						connectionGeneration: generation,
						hydratingGenerationBySession: {},
						pendingEventsBySession: {},
					},
		),
	beginSnapshotHydration: (sessionId, generation) =>
		set((state) =>
			state.connectionGeneration !== generation
				? state
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
			if (state.hydratingGenerationBySession[sessionId] !== generation) return state;
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
			if (state.connectionGeneration !== generation) return state;
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
			if (state.connectionGeneration !== generation) return state;
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
			if (state.connectionGeneration !== generation) return state;
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
					...withoutSessionState(state, new Set([event.sessionId])),
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
				return state;
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
				case "title":
					next = {
						...snapshot,
						summary: { ...snapshot.summary, title: event.title, updatedAt: Date.now() },
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
	applyMessageDeltas: (events, generation) =>
		set((state) => {
			if (state.connectionGeneration !== generation) return state;
			let draftsBySession = state.draftsBySession;
			let pendingEventsBySession = state.pendingEventsBySession;
			let draftsChanged = false;
			let pendingEventsChanged = false;
			const grouped = new Map<string, { assistant: string[]; thought: string[] }>();

			for (const event of events) {
				if (state.hydratingGenerationBySession[event.sessionId] === generation) {
					if (!pendingEventsChanged) {
						pendingEventsBySession = { ...state.pendingEventsBySession };
						pendingEventsChanged = true;
					}
					const pending = pendingEventsBySession[event.sessionId] ?? [];
					pendingEventsBySession[event.sessionId] = [...pending, event].slice(
						-ACP_EVENT_BUFFER_LIMIT,
					);
					continue;
				}
				if (
					!state.snapshotsBySession[event.sessionId] ||
					state.snapshotGenerationBySession[event.sessionId] !== generation
				) {
					continue;
				}
				let deltas = grouped.get(event.sessionId);
				if (!deltas) {
					deltas = { assistant: [], thought: [] };
					grouped.set(event.sessionId, deltas);
				}
				deltas[event.role].push(event.delta);
			}

			for (const [sessionId, deltas] of grouped) {
				const current = draftsBySession[sessionId] ?? emptyDraft();
				const draft = { ...current };
				if (deltas.assistant.length > 0) {
					draft.assistantText = appendDelta(current.assistantText, deltas.assistant.join(""));
				}
				if (deltas.thought.length > 0) {
					draft.thoughtText = appendDelta(current.thoughtText, deltas.thought.join(""));
				}
				if (!draftsChanged) {
					draftsBySession = { ...state.draftsBySession };
					draftsChanged = true;
				}
				draftsBySession[sessionId] = draft;
			}

			if (!draftsChanged && !pendingEventsChanged) return state;
			return {
				...(draftsChanged ? { draftsBySession } : {}),
				...(pendingEventsChanged ? { pendingEventsBySession } : {}),
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
			...withoutSessionState(state, new Set([sessionId])),
			sessionsByWorkspace: {
				...state.sessionsByWorkspace,
				[workspaceId]: (state.sessionsByWorkspace[workspaceId] ?? []).filter(
					(session) => session.id !== sessionId,
				),
			},
		})),
	removeWorkspace: (workspaceId) =>
		set((state) => {
			const sessionIds = new Set(
				(state.sessionsByWorkspace[workspaceId] ?? []).map((session) => session.id),
			);
			return {
				...withoutSessionState(state, sessionIds),
				sessionsByWorkspace: Object.fromEntries(
					Object.entries(state.sessionsByWorkspace).filter(([id]) => id !== workspaceId),
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
