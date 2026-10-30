import {
	RiAddLine,
	RiCheckLine,
	RiDeleteBinLine,
	RiFileCopyLine,
	RiPlayFill,
	RiRefreshLine,
	RiSaveLine,
	RiSendPlaneFill,
	RiSparklingLine,
} from "@remixicon/react";
import {
	HTTP_REQUEST_LIMITS,
	type HttpBodyType,
	type HttpHistoryDetail,
	type HttpHistoryEntry,
	type HttpResponseResult,
	type SavedHttpRequest,
	WORKSPACE_TOOLS_PROTOCOL_VERSION,
} from "@thinkrail/contracts";
import type { MessageKey } from "@thinkrail/locales";
import { useT } from "@thinkrail/locales/react";
import { Button, IconButton } from "@thinkrail/ui/button";
import { cn } from "@thinkrail/ui/utils";
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copyText, randomId } from "../lib";
import { toast, useAppStore } from "../store";
import { errorText, getTransport } from "../transport";
import { ConfirmDialog } from "./ConfirmDialog";

type AuthType = "none" | "bearer" | "basic" | "apiKey";
type RequestTab = "params" | "headers" | "body" | "auth";
type View = "request" | "history" | "saved";

interface Row {
	id: string;
	key: string;
	value: string;
}

interface Draft {
	method: string;
	url: string;
	headers: Row[];
	params: Row[];
	bodyType: HttpBodyType;
	body: string;
	authType: AuthType;
	authValue: string;
	authUser: string;
	authPassword: string;
	authHeader: string;
}

interface JsonIssue {
	message: string;
	line: number;
	column: number;
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

const REQUEST_TABS: Record<RequestTab, MessageKey> = {
	params: "requests.params",
	headers: "requests.headers",
	body: "requests.body",
	auth: "requests.auth",
};

const BODY_TYPES: Record<HttpBodyType, MessageKey> = {
	none: "requests.bodyNone",
	json: "requests.bodyJson",
	text: "requests.bodyText",
	urlencoded: "requests.bodyUrlencoded",
};

const AUTH_TYPES: Record<AuthType, MessageKey> = {
	none: "requests.authNone",
	bearer: "requests.authBearer",
	basic: "requests.authBasic",
	apiKey: "requests.authApiKey",
};

const VIEW_LABELS: Record<View, MessageKey> = {
	request: "requests.requestTab",
	history: "requests.history",
	saved: "requests.collections",
};

const INPUT_CLASS =
	"min-h-28 min-w-0 rounded-sm border border-control-border-default bg-control-bg px-8 tr-text-ui text-text-default outline-none placeholder:text-text-muted focus-visible:border-control-border-active disabled:border-control-disabled-border disabled:bg-control-disabled-bg disabled:text-control-disabled-text";

function row(): Row {
	return { id: randomId("row"), key: "", value: "" };
}

function emptyDraft(): Draft {
	return {
		method: "GET",
		url: "",
		headers: [row()],
		params: [row()],
		bodyType: "none",
		body: "",
		authType: "none",
		authValue: "",
		authUser: "",
		authPassword: "",
		authHeader: "X-API-Key",
	};
}

function pair(rows: Row[]): Record<string, string> {
	const record: Record<string, string> = {};
	for (const item of rows) {
		if (item.key.trim() !== "") record[item.key.trim()] = item.value;
	}
	return record;
}

function rowsFrom(record: Record<string, string>): Row[] {
	const entries = Object.entries(record ?? {}).filter(([, value]) => value !== "[redacted]");
	return entries.length === 0
		? [row()]
		: entries.map(([key, value]) => ({ id: randomId("row"), key, value }));
}

function bodyTypeFromHeaders(headers: Record<string, string>): HttpBodyType {
	const contentType = Object.entries(headers).find(
		([key]) => key.toLowerCase() === "content-type",
	)?.[1];
	if (!contentType) return "none";
	if (contentType.includes("json")) return "json";
	if (contentType.includes("urlencoded")) return "urlencoded";
	return "text";
}

function buildRequest(draft: Draft) {
	const headers = pair(draft.headers);
	if (draft.authType === "bearer" && draft.authValue.trim()) {
		headers.Authorization = `Bearer ${draft.authValue.trim()}`;
	} else if (draft.authType === "basic") {
		headers.Authorization = `Basic ${btoa(`${draft.authUser}:${draft.authPassword}`)}`;
	} else if (draft.authType === "apiKey" && draft.authValue.trim()) {
		headers[draft.authHeader.trim() || "X-API-Key"] = draft.authValue.trim();
	}
	return {
		method: draft.method,
		url: draft.url,
		headers,
		query: pair(draft.params),
		...(draft.bodyType === "none" ? {} : { body: draft.body, bodyType: draft.bodyType }),
	};
}

function statusTone(status: number): string {
	if (status === 0) return "text-feedback-error";
	if (status >= 200 && status < 300) return "text-feedback-success";
	if (status >= 300 && status < 400) return "text-primary";
	if (status >= 400 && status < 500) return "text-feedback-warning";
	return "text-feedback-error";
}

function contentTypeOf(headers: Record<string, string>): string {
	return Object.entries(headers).find(([key]) => key.toLowerCase() === "content-type")?.[1] ?? "";
}

function prettyBody(body: string, contentType: string): string {
	if (!/json/i.test(contentType)) return body;
	try {
		return JSON.stringify(JSON.parse(body), null, 2);
	} catch {
		return body;
	}
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${bytes} B`;
}

function jsonIssue(value: string): JsonIssue | null {
	if (value.trim() === "") return null;
	const errors: ParseError[] = [];
	parse(value, errors, { allowTrailingComma: false, disallowComments: true });
	const first = errors[0];
	if (!first) return null;
	const before = value.slice(0, first.offset);
	const line = before.split("\n").length;
	const column = first.offset - before.lastIndexOf("\n");
	return { message: printParseErrorCode(first.error), line, column };
}

function formatJson(value: string): string | null {
	const errors: ParseError[] = [];
	const parsed: unknown = parse(value, errors, {
		allowTrailingComma: false,
		disallowComments: true,
	});
	if (errors.length > 0) return null;
	return JSON.stringify(parsed, null, 2) ?? null;
}

async function curlFor(draft: Draft): Promise<string> {
	const request = buildRequest(draft);
	const url = new URL(request.url);
	for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value);
	const lines = [`curl -sS -X ${request.method} '${url.toString()}'`];
	for (const [key, value] of Object.entries(request.headers ?? {})) {
		lines.push(`  -H '${key}: ${value.replaceAll("'", "'\\''")}'`);
	}
	if (request.body) lines.push(`  --data '${request.body.replaceAll("'", "'\\''")}'`);
	return lines.join(" \\\n");
}

function KeyValueRows({
	rows,
	onChange,
	keyPlaceholder,
	valuePlaceholder,
	addLabel,
}: {
	rows: Row[];
	onChange: (rows: Row[]) => void;
	keyPlaceholder: string;
	valuePlaceholder: string;
	addLabel: string;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-4">
			{rows.map((item) => (
				<div key={item.id} className="flex min-w-0 items-center gap-4">
					<input
						className={cn(INPUT_CLASS, "min-h-24 flex-1")}
						value={item.key}
						placeholder={keyPlaceholder}
						onChange={(event) =>
							onChange(
								rows.map((candidate) =>
									candidate.id === item.id
										? { ...candidate, key: event.currentTarget.value }
										: candidate,
								),
							)
						}
					/>
					<input
						className={cn(INPUT_CLASS, "min-h-24 flex-[2]")}
						value={item.value}
						placeholder={valuePlaceholder}
						onChange={(event) =>
							onChange(
								rows.map((candidate) =>
									candidate.id === item.id
										? { ...candidate, value: event.currentTarget.value }
										: candidate,
								),
							)
						}
					/>
					<IconButton
						icon={RiDeleteBinLine}
						label={addLabel}
						variant="ghost"
						size="s"
						onClick={() => onChange(rows.filter((candidate) => candidate.id !== item.id))}
					/>
				</div>
			))}
			<div>
				<Button
					variant="ghost"
					size="s"
					iconLeft={RiAddLine}
					onClick={() => onChange([...rows, row()])}
				>
					{addLabel}
				</Button>
			</div>
		</div>
	);
}

export function RequestsPane({ workspaceId }: { workspaceId: string }) {
	const t = useT();
	const protocolVersion = useAppStore((state) => state.protocolVersion);
	const supported = protocolVersion !== null && protocolVersion >= WORKSPACE_TOOLS_PROTOCOL_VERSION;
	const [draft, setDraft] = useState<Draft>(emptyDraft);
	const [tab, setTab] = useState<RequestTab>("params");
	const [view, setView] = useState<View>("request");
	const [history, setHistory] = useState<HttpHistoryEntry[]>([]);
	const [saved, setSaved] = useState<SavedHttpRequest[]>([]);
	const [historyQuery, setHistoryQuery] = useState("");
	const [savedQuery, setSavedQuery] = useState("");
	const [response, setResponse] = useState<HttpResponseResult | null>(null);
	const [sending, setSending] = useState(false);
	const [sendFailed, setSendFailed] = useState(false);
	const [loadingList, setLoadingList] = useState(false);
	const [clearOpen, setClearOpen] = useState(false);
	const [saveName, setSaveName] = useState("");
	const [saveCollection, setSaveCollection] = useState("");
	const [savedId, setSavedId] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [urlOpen, setUrlOpen] = useState(false);
	const [urlActive, setUrlActive] = useState(0);
	const urlInput = useRef<HTMLInputElement>(null);
	const bodyRef = useRef<HTMLTextAreaElement>(null);
	const caretTarget = useRef<number | null>(null);

	const patch = (value: Partial<Draft>) => setDraft((current) => ({ ...current, ...value }));
	const bodyIssue = useMemo(
		() => (draft.bodyType === "json" ? jsonIssue(draft.body) : null),
		[draft.body, draft.bodyType],
	);

	const loadLists = useCallback(async () => {
		if (!supported) return;
		setLoadingList(true);
		try {
			const [nextHistory, nextSaved] = await Promise.all([
				getTransport().request("http.request.history", {
					workspaceId,
					limit: HTTP_REQUEST_LIMITS.historyPerWorkspace,
				}),
				getTransport().request("http.request.saved.list", { workspaceId }),
			]);
			setHistory(nextHistory);
			setSaved(nextSaved);
		} catch {}
		setLoadingList(false);
	}, [supported, workspaceId]);

	useEffect(() => {
		if (!supported) return;
		void loadLists();
	}, [loadLists, supported]);

	useEffect(() => {
		const target = caretTarget.current;
		const element = bodyRef.current;
		if (target === null || element === null) return;
		element.selectionStart = target;
		element.selectionEnd = target;
		caretTarget.current = null;
	}, [draft.body]);

	const urlOptions = useMemo(() => {
		const seen = new Set<string>();
		for (const entry of history) {
			if (entry.url) seen.add(entry.url);
		}
		for (const entry of saved) {
			if (entry.request.url) seen.add(entry.request.url);
		}
		return [...seen].slice(0, 50);
	}, [history, saved]);

	const urlSuggestions = useMemo(() => {
		const query = draft.url.trim().toLowerCase();
		return urlOptions
			.filter((url) => query === "" || url.toLowerCase().includes(query))
			.slice(0, 8);
	}, [draft.url, urlOptions]);

	const filteredHistory = useMemo(() => {
		const query = historyQuery.trim().toLowerCase();
		return history.filter(
			(entry) =>
				query === "" ||
				entry.url.toLowerCase().includes(query) ||
				entry.method.toLowerCase().includes(query),
		);
	}, [history, historyQuery]);

	const filteredSaved = useMemo(() => {
		const query = savedQuery.trim().toLowerCase();
		return saved.filter(
			(entry) =>
				query === "" ||
				entry.name.toLowerCase().includes(query) ||
				entry.collection.toLowerCase().includes(query) ||
				entry.request.url.toLowerCase().includes(query),
		);
	}, [saved, savedQuery]);

	const send = async () => {
		if (!supported || sending || draft.url.trim() === "") return;
		setSending(true);
		setSendFailed(false);
		setResponse(null);
		try {
			const result = await getTransport().request("http.request.send", {
				workspaceId,
				request: buildRequest(draft),
				source: "user",
			});
			setResponse(result);
			await loadLists();
		} catch (error) {
			setSendFailed(true);
			toast.error(errorText(error, t("requests.sendFailed")));
		}
		setSending(false);
	};

	const openDetail = async (entry: HttpHistoryEntry) => {
		try {
			const detail: HttpHistoryDetail = await getTransport().request("http.request.historyDetail", {
				workspaceId,
				id: entry.id,
			});
			setDraft({
				method: detail.method,
				url: detail.url,
				headers: rowsFrom(detail.requestHeaders),
				params: [row()],
				bodyType: bodyTypeFromHeaders(detail.requestHeaders),
				body: detail.requestBody,
				authType: "none",
				authValue: "",
				authUser: "",
				authPassword: "",
				authHeader: "X-API-Key",
			});
			setResponse({
				id: detail.id,
				status: detail.status,
				statusText: detail.statusText,
				headers: detail.responseHeaders,
				cookies: [],
				body: detail.responseBody,
				bodyTruncated: detail.bodyTruncated,
				sizeBytes: detail.sizeBytes,
				durationMs: detail.durationMs,
				contentType: contentTypeOf(detail.responseHeaders),
				at: detail.at,
			});
			setView("request");
			setTab("params");
			setSavedId(null);
		} catch (error) {
			toast.error(errorText(error, t("requests.loadFailed")));
		}
	};

	const openSaved = (entry: SavedHttpRequest) => {
		const request = entry.request;
		setDraft({
			method: request.method,
			url: request.url,
			headers: rowsFrom(request.headers ?? {}),
			params: rowsFrom(request.query ?? {}),
			bodyType: request.bodyType ?? "none",
			body: request.body ?? "",
			authType: "none",
			authValue: "",
			authUser: "",
			authPassword: "",
			authHeader: "X-API-Key",
		});
		setSaveName(entry.name);
		setSaveCollection(entry.collection);
		setSavedId(entry.id);
		setResponse(null);
		setView("request");
		setTab("params");
	};

	const save = async () => {
		if (!supported || saving) return;
		const name = saveName.trim();
		const collection = saveCollection.trim() || t("requests.defaultCollection");
		if (name === "") return;
		const idParam = savedId ? { id: savedId } : {};
		setSaving(true);
		try {
			const record = await getTransport().request("http.request.saved.save", {
				workspaceId,
				collection,
				name,
				...idParam,
				request: buildRequest(draft),
			});
			setSaved((current) => [record, ...current.filter((entry) => entry.id !== record.id)]);
			setSaveName(record.name);
			setSavedId(record.id);
			toast.success(t("requests.savedToast"));
		} catch (error) {
			toast.error(errorText(error, t("requests.saveFailed")));
		}
		setSaving(false);
	};

	const removeSaved = async (entry: SavedHttpRequest) => {
		try {
			await getTransport().request("http.request.saved.delete", {
				workspaceId,
				id: entry.id,
			});
			setSaved((current) => current.filter((candidate) => candidate.id !== entry.id));
		} catch (error) {
			toast.error(errorText(error, t("requests.deleteFailed")));
		}
	};

	const removeHistory = async (entry: HttpHistoryEntry) => {
		try {
			await getTransport().request("http.request.historyClear", {
				workspaceId,
				id: entry.id,
			});
			setHistory((current) => current.filter((candidate) => candidate.id !== entry.id));
		} catch (error) {
			toast.error(errorText(error, t("requests.deleteFailed")));
		}
	};

	const clearHistory = async () => {
		try {
			await getTransport().request("http.request.historyClear", { workspaceId });
			setHistory([]);
		} catch (error) {
			toast.error(errorText(error, t("requests.deleteFailed")));
		}
	};

	const copyCurl = async () => {
		try {
			if (await copyText(await curlFor(draft))) toast.success(t("requests.copied"));
		} catch {
			toast.error(t("requests.copyFailed"));
		}
	};

	const chooseUrl = (url: string) => {
		patch({ url });
		setUrlOpen(false);
		urlInput.current?.focus();
	};

	const newRequest = () => {
		setDraft(emptyDraft());
		setResponse(null);
		setSavedId(null);
		setSaveName("");
		setSaveCollection("");
		setView("request");
		setTab("params");
	};

	const onUrlKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
		if (urlOpen && urlSuggestions.length > 0) {
			if (event.key === "ArrowDown") {
				event.preventDefault();
				setUrlActive((current) => (current + 1) % urlSuggestions.length);
				return;
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				setUrlActive((current) => (current - 1 + urlSuggestions.length) % urlSuggestions.length);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				setUrlOpen(false);
				return;
			}
			if (event.key === "Enter") {
				const suggestion = urlSuggestions[urlActive];
				if (suggestion && suggestion !== draft.url) {
					event.preventDefault();
					chooseUrl(suggestion);
					return;
				}
			}
		}
		if (event.key === "Enter") void send();
	};

	const onBodyKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (draft.bodyType !== "json") return;
		const element = event.currentTarget;
		if (element.selectionStart !== element.selectionEnd) return;
		const start = element.selectionStart;
		const next = element.value[start];
		const insertPair = (opening: string, closing: string) => {
			event.preventDefault();
			caretTarget.current = start + opening.length;
			patch({
				body: `${element.value.slice(0, start)}${opening}${closing}${element.value.slice(start)}`,
			});
		};
		if (event.key === '"' && next === '"') {
			event.preventDefault();
			element.selectionStart = start + 1;
			element.selectionEnd = start + 1;
			return;
		}
		if ((event.key === "}" && next === "}") || (event.key === "]" && next === "]")) {
			event.preventDefault();
			element.selectionStart = start + 1;
			element.selectionEnd = start + 1;
			return;
		}
		if (event.key === '"') insertPair('"', '"');
		else if (event.key === "{") insertPair("{", "}");
		else if (event.key === "[") insertPair("[", "]");
	};

	const formatBody = () => {
		const formatted = formatJson(draft.body);
		if (formatted !== null) patch({ body: formatted });
	};

	const responseHeaders = useMemo(
		() => Object.entries(response?.headers ?? {}).sort(([a], [b]) => a.localeCompare(b)),
		[response],
	);

	return (
		<div
			data-testid="requests-pane"
			className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
		>
			<header className="flex h-panel-header-row shrink-0 items-center gap-8 border-border-default border-b px-12">
				<RiSendPlaneFill className="size-16 shrink-0 text-text-muted" aria-hidden="true" />
				<h2 className="min-w-0 flex-1 truncate tr-title-compact text-text-default">
					{t("requests.title")}
				</h2>
				<Button
					variant="ghost"
					size="m"
					iconLeft={RiRefreshLine}
					disabled={!supported || loadingList}
					onClick={() => void loadLists()}
				>
					{t("requests.refresh")}
				</Button>
			</header>

			{!supported ? (
				<div className="min-h-0 min-w-0 flex-1 overflow-auto p-panel-inset">
					<p className="text-text-muted tr-text-ui">
						{protocolVersion === null ? t("requests.loading") : t("requests.hostTooOld")}
					</p>
				</div>
			) : (
				<div className="flex min-h-0 min-w-0 flex-1 flex-col">
					<div role="tablist" className="flex shrink-0 gap-2 border-border-default border-b px-8">
						{(["request", "history", "saved"] as const).map((candidate) => {
							const count =
								candidate === "history"
									? history.length
									: candidate === "saved"
										? saved.length
										: null;
							return (
								<button
									key={candidate}
									type="button"
									role="tab"
									aria-selected={view === candidate}
									data-testid={`requests-view-${candidate}`}
									onClick={() => setView(candidate)}
									className={cn(
										"flex items-center gap-4 border-b-2 px-8 py-6 tr-text-metadata",
										view === candidate
											? "border-primary text-text-default"
											: "border-transparent text-text-muted hover:text-text-default",
									)}
								>
									{t(VIEW_LABELS[candidate])}
									{count === null ? null : (
										<span className="rounded-full bg-control-bg-selected px-4 tr-text-metadata text-text-muted">
											{count}
										</span>
									)}
								</button>
							);
						})}
						<Button variant="ghost" size="s" className="my-2 ml-auto shrink-0" onClick={newRequest}>
							{t("requests.new")}
						</Button>
					</div>

					{view === "request" ? (
						<div className="min-h-0 min-w-0 flex-1 overflow-auto p-panel-inset">
							<div className="flex min-w-0 flex-col gap-12">
								<div className="flex min-w-0 flex-wrap items-center gap-4">
									<select
										className={cn(INPUT_CLASS, "min-h-32 w-[6.5rem] shrink-0 tr-code-text")}
										value={draft.method}
										onChange={(event) => patch({ method: event.currentTarget.value })}
										aria-label={t("requests.method")}
									>
										{METHODS.map((method) => (
											<option key={method} value={method}>
												{method}
											</option>
										))}
									</select>
									<div className="relative min-w-0 flex-1">
										<input
											ref={urlInput}
											className={cn(INPUT_CLASS, "min-h-32 w-full tr-code-text")}
											value={draft.url}
											onChange={(event) => {
												patch({ url: event.currentTarget.value });
												setUrlOpen(true);
												setUrlActive(0);
											}}
											onFocus={() => {
												setUrlOpen(true);
												setUrlActive(0);
											}}
											onBlur={() => window.setTimeout(() => setUrlOpen(false), 120)}
											onKeyDown={onUrlKeyDown}
											placeholder={t("requests.urlPlaceholder")}
											aria-label={t("requests.url")}
											role="combobox"
											aria-autocomplete="list"
											aria-controls="requests-url-suggestions"
											aria-expanded={urlOpen && urlSuggestions.length > 0}
											data-testid="requests-url"
											spellCheck={false}
											maxLength={HTTP_REQUEST_LIMITS.urlLength}
										/>
										{urlOpen && urlSuggestions.length > 0 ? (
											<div
												id="requests-url-suggestions"
												role="listbox"
												aria-label={t("requests.urlSuggestions")}
												className="absolute inset-x-0 top-full z-20 mt-2 max-h-48 overflow-auto rounded-sm border border-border-default bg-container-elevated-bg shadow-lg"
											>
												{urlSuggestions.map((url, index) => (
													<button
														key={url}
														type="button"
														role="option"
														aria-selected={index === urlActive}
														onMouseDown={(event) => {
															event.preventDefault();
															chooseUrl(url);
														}}
														onMouseEnter={() => setUrlActive(index)}
														className={cn(
															"block w-full truncate px-8 py-4 text-left tr-code-text",
															index === urlActive
																? "bg-primary-subtle text-text-default"
																: "text-text-muted",
														)}
														title={url}
													>
														{url}
													</button>
												))}
											</div>
										) : null}
									</div>
									<Button
										variant="primary"
										size="m"
										iconLeft={RiPlayFill}
										loading={sending}
										disabled={sending || draft.url.trim() === ""}
										onClick={() => void send()}
										data-testid="requests-send"
									>
										{sending ? t("requests.sending") : t("requests.send")}
									</Button>
									<IconButton
										icon={RiFileCopyLine}
										label={t("requests.copyCurl")}
										variant="ghost"
										size="m"
										onClick={() => void copyCurl()}
									/>
								</div>

								<div className="flex min-w-0 flex-wrap gap-2 border-border-default border-b">
									{(Object.keys(REQUEST_TABS) as RequestTab[]).map((candidate) => (
										<button
											key={candidate}
											type="button"
											className={cn(
												"border-b-2 px-8 py-4 tr-text-metadata",
												tab === candidate
													? "border-primary text-text-default"
													: "border-transparent text-text-muted hover:text-text-default",
											)}
											onClick={() => setTab(candidate)}
										>
											{t(REQUEST_TABS[candidate])}
										</button>
									))}
								</div>

								<div className="min-w-0">
									{tab === "params" ? (
										<KeyValueRows
											rows={draft.params}
											onChange={(params) => patch({ params })}
											keyPlaceholder={t("requests.key")}
											valuePlaceholder={t("requests.value")}
											addLabel={t("requests.addParam")}
										/>
									) : null}
									{tab === "headers" ? (
										<KeyValueRows
											rows={draft.headers}
											onChange={(headers) => patch({ headers })}
											keyPlaceholder={t("requests.key")}
											valuePlaceholder={t("requests.value")}
											addLabel={t("requests.addHeader")}
										/>
									) : null}
									{tab === "body" ? (
										<div className="flex min-w-0 flex-col gap-4">
											<div className="flex flex-wrap items-center gap-2">
												{(Object.keys(BODY_TYPES) as HttpBodyType[]).map((candidate) => (
													<Button
														key={candidate}
														variant="ghost"
														size="s"
														selected={draft.bodyType === candidate}
														onClick={() => patch({ bodyType: candidate })}
													>
														{t(BODY_TYPES[candidate])}
													</Button>
												))}
												{draft.bodyType === "json" ? (
													<Button
														variant="ghost"
														size="s"
														iconLeft={RiSparklingLine}
														disabled={draft.body.trim() === "" || bodyIssue !== null}
														onClick={formatBody}
													>
														{t("requests.formatJson")}
													</Button>
												) : null}
											</div>
											{draft.bodyType !== "none" ? (
												<>
													<textarea
														ref={bodyRef}
														className={cn(
															INPUT_CLASS,
															"min-h-[12rem] w-full py-4 tr-code-text",
															bodyIssue ? "border-feedback-error" : "",
														)}
														value={draft.body}
														onChange={(event) => patch({ body: event.currentTarget.value })}
														onKeyDown={onBodyKeyDown}
														onBlur={() => {
															if (draft.bodyType === "json" && bodyIssue === null) formatBody();
														}}
														aria-invalid={bodyIssue !== null}
														placeholder={
															draft.bodyType === "json" ? t("requests.jsonPlaceholder") : ""
														}
														spellCheck={false}
														maxLength={HTTP_REQUEST_LIMITS.bodyChars}
													/>
													{bodyIssue ? (
														<p role="alert" className="text-feedback-error tr-text-metadata">
															{t("requests.jsonError", {
																line: bodyIssue.line,
																column: bodyIssue.column,
																message: bodyIssue.message,
															})}
														</p>
													) : draft.body.trim() !== "" && draft.bodyType === "json" ? (
														<p className="flex items-center gap-2 text-feedback-success tr-text-metadata">
															<RiCheckLine className="size-12" /> {t("requests.jsonValid")}
														</p>
													) : null}
												</>
											) : (
												<p className="text-text-muted tr-text-metadata">{t("requests.noBody")}</p>
											)}
										</div>
									) : null}
									{tab === "auth" ? (
										<div className="flex min-w-0 flex-col gap-8">
											<div className="flex flex-wrap gap-2">
												{(Object.keys(AUTH_TYPES) as AuthType[]).map((candidate) => (
													<Button
														key={candidate}
														variant="ghost"
														size="s"
														selected={draft.authType === candidate}
														onClick={() => patch({ authType: candidate })}
													>
														{t(AUTH_TYPES[candidate])}
													</Button>
												))}
											</div>
											{draft.authType === "bearer" || draft.authType === "apiKey" ? (
												<div className="flex min-w-0 flex-col gap-4">
													{draft.authType === "apiKey" ? (
														<input
															className={INPUT_CLASS}
															value={draft.authHeader}
															onChange={(event) => patch({ authHeader: event.currentTarget.value })}
															placeholder={t("requests.apiKeyHeaderPlaceholder")}
															aria-label={t("requests.authHeader")}
														/>
													) : null}
													<input
														className={INPUT_CLASS}
														type="password"
														value={draft.authValue}
														onChange={(event) => patch({ authValue: event.currentTarget.value })}
														placeholder={t("requests.authToken")}
														aria-label={t("requests.authToken")}
														autoComplete="off"
													/>
												</div>
											) : null}
											{draft.authType === "basic" ? (
												<div className="flex min-w-0 flex-wrap gap-4">
													<input
														className={cn(INPUT_CLASS, "flex-1")}
														value={draft.authUser}
														onChange={(event) => patch({ authUser: event.currentTarget.value })}
														placeholder={t("requests.authUser")}
														aria-label={t("requests.authUser")}
														autoComplete="off"
													/>
													<input
														className={cn(INPUT_CLASS, "flex-1")}
														type="password"
														value={draft.authPassword}
														onChange={(event) => patch({ authPassword: event.currentTarget.value })}
														placeholder={t("requests.authPassword")}
														aria-label={t("requests.authPassword")}
														autoComplete="off"
													/>
												</div>
											) : null}
											{draft.authType === "none" ? (
												<p className="text-text-muted tr-text-metadata">
													{t("requests.authNoneHint")}
												</p>
											) : null}
										</div>
									) : null}
								</div>

								<div className="flex min-w-0 flex-wrap items-center gap-4 border-border-default border-t pt-8">
									<input
										className={cn(INPUT_CLASS, "min-h-28 flex-[2]")}
										value={saveName}
										onChange={(event) => setSaveName(event.currentTarget.value)}
										placeholder={t("requests.saveName")}
										aria-label={t("requests.saveName")}
										maxLength={160}
									/>
									<input
										className={cn(INPUT_CLASS, "min-h-28 flex-1")}
										value={saveCollection}
										onChange={(event) => setSaveCollection(event.currentTarget.value)}
										placeholder={t("requests.defaultCollection")}
										aria-label={t("requests.saveCollection")}
										maxLength={120}
									/>
									<Button
										variant="outline"
										size="m"
										iconLeft={RiSaveLine}
										loading={saving}
										disabled={saving || saveName.trim() === "" || draft.url.trim() === ""}
										onClick={() => void save()}
									>
										{t("requests.save")}
									</Button>
								</div>

								{sendFailed ? (
									<p role="alert" className="text-feedback-error tr-text-metadata">
										{t("requests.sendFailed")}
									</p>
								) : null}

								<section
									aria-label={t("requests.response")}
									className="flex min-w-0 flex-col gap-8 rounded-sm border border-border-default"
								>
									<div className="flex min-w-0 flex-wrap items-center gap-8 border-border-default border-b px-8 py-4">
										<h3 className="tr-title-compact text-text-default">{t("requests.response")}</h3>
										{response ? (
											<>
												<span
													data-testid="requests-status"
													className={cn("tr-code-text", statusTone(response.status))}
												>
													{response.status || "—"} {response.statusText}
												</span>
												<span className="text-text-subtle tr-text-metadata">
													{t("requests.timing", {
														ms: response.durationMs,
														size: formatBytes(response.sizeBytes),
													})}
												</span>
												{response.bodyTruncated ? (
													<span className="text-feedback-warning tr-text-metadata">
														{t("requests.truncated")}
													</span>
												) : null}
											</>
										) : (
											<span className="text-text-subtle tr-text-metadata">
												{t("requests.emptyResponse")}
											</span>
										)}
									</div>
									{response ? (
										<div className="min-w-0 px-8 pb-8">
											<pre className="max-h-[24rem] min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-sunken p-8 tr-code-text text-text-default">
												{prettyBody(response.body, response.contentType)}
											</pre>
											{responseHeaders.length > 0 ? (
												<details className="mt-8">
													<summary className="cursor-pointer text-text-muted tr-text-metadata">
														{t("requests.responseHeaders")} ({responseHeaders.length})
													</summary>
													<dl className="mt-4 grid min-w-0 grid-cols-[minmax(8rem,auto)_1fr] gap-x-8 gap-y-2">
														{responseHeaders.map(([key, value]) => (
															<div key={key} className="contents">
																<dt className="truncate tr-code-text text-text-muted">{key}</dt>
																<dd className="break-all tr-code-text text-text-default">
																	{value}
																</dd>
															</div>
														))}
													</dl>
												</details>
											) : null}
											{response.cookies.length > 0 ? (
												<p className="mt-8 text-text-subtle tr-text-metadata">
													{t("requests.cookies", { count: response.cookies.length })}
												</p>
											) : null}
										</div>
									) : null}
								</section>
							</div>
						</div>
					) : view === "history" ? (
						<div className="min-h-0 min-w-0 flex-1 overflow-auto">
							<div className="flex min-w-0 flex-wrap items-center gap-4 border-border-default border-b p-8">
								<input
									className={cn(INPUT_CLASS, "min-h-28 flex-1")}
									value={historyQuery}
									onChange={(event) => setHistoryQuery(event.currentTarget.value)}
									placeholder={t("requests.searchHistory")}
									aria-label={t("requests.searchHistory")}
								/>
								{history.length > 0 ? (
									<Button variant="ghost" size="m" tone="danger" onClick={() => setClearOpen(true)}>
										{t("requests.clear")}
									</Button>
								) : null}
							</div>
							{filteredHistory.length === 0 ? (
								<p className="p-12 text-text-muted tr-text-metadata">
									{history.length === 0 ? t("requests.emptyHistory") : t("requests.emptySearch")}
								</p>
							) : (
								<div className="flex min-w-0 flex-col">
									{filteredHistory.map((entry) => (
										<div
											key={entry.id}
											className="flex min-w-0 items-center gap-4 border-border-default border-b px-8 py-4 last:border-b-0 hover:bg-control-bg-hovered"
										>
											<span className="w-40 shrink-0 tr-code-text text-text-muted">
												{entry.method}
											</span>
											<button
												type="button"
												className="min-w-0 flex-1 truncate text-left tr-text-metadata hover:text-primary"
												onClick={() => void openDetail(entry)}
												title={entry.url}
											>
												{entry.url}
											</button>
											<span className={cn("shrink-0 tr-text-metadata", statusTone(entry.status))}>
												{entry.status || "—"}
											</span>
											<span className="shrink-0 text-text-subtle tr-text-metadata">
												{t("requests.timing", {
													ms: entry.durationMs,
													size: formatBytes(entry.sizeBytes),
												})}
											</span>
											<IconButton
												icon={RiDeleteBinLine}
												label={t("requests.deleteEntry")}
												variant="ghost"
												size="s"
												onClick={() => void removeHistory(entry)}
											/>
										</div>
									))}
								</div>
							)}
						</div>
					) : (
						<div className="min-h-0 min-w-0 flex-1 overflow-auto">
							<div className="border-border-default border-b p-8">
								<input
									className={cn(INPUT_CLASS, "min-h-28 w-full")}
									value={savedQuery}
									onChange={(event) => setSavedQuery(event.currentTarget.value)}
									placeholder={t("requests.searchSaved")}
									aria-label={t("requests.searchSaved")}
								/>
							</div>
							{filteredSaved.length === 0 ? (
								<p className="p-12 text-text-muted tr-text-metadata">
									{saved.length === 0 ? t("requests.emptySaved") : t("requests.emptySearch")}
								</p>
							) : (
								<div className="flex min-w-0 flex-col">
									{filteredSaved.map((entry) => (
										<div
											key={entry.id}
											className="flex min-w-0 items-center gap-4 border-border-default border-b px-8 py-4 last:border-b-0 hover:bg-control-bg-hovered"
										>
											<span className="w-32 shrink-0 truncate text-text-subtle tr-text-metadata">
												{entry.collection}
											</span>
											<button
												type="button"
												className="min-w-0 flex-1 truncate text-left tr-text-metadata hover:text-primary"
												onClick={() => openSaved(entry)}
												title={entry.request.url}
											>
												{entry.name}
											</button>
											<span className="shrink-0 tr-code-text text-text-subtle">
												{entry.request.method}
											</span>
											<IconButton
												icon={RiDeleteBinLine}
												label={t("requests.delete")}
												variant="ghost"
												size="s"
												onClick={() => void removeSaved(entry)}
											/>
										</div>
									))}
								</div>
							)}
						</div>
					)}
				</div>
			)}

			<ConfirmDialog
				open={clearOpen}
				onOpenChange={setClearOpen}
				title={t("requests.clearTitle")}
				description={t("requests.clearDescription")}
				confirmLabel={t("requests.clear")}
				destructive
				confirmTestId="requests-clear-confirm"
				onConfirm={() => void clearHistory()}
			/>
		</div>
	);
}
