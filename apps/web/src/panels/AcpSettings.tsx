import type {
	AcpAuthMethodSummary,
	AcpClientCheckResult,
	AcpClientConfig,
	AcpConfigOption,
} from "@thinkrail/contracts";
import {
	ACP_AUTH_PROTOCOL_VERSION,
	ACP_MODEL_CATALOG_PROTOCOL_VERSION,
	ACP_START_TIMEOUT_MAX_MS,
	ACP_START_TIMEOUT_MIN_MS,
	ACP_START_TIMEOUT_PROTOCOL_VERSION,
	isAcpClientCatalog,
	isAcpStartTimeoutMs,
} from "@thinkrail/contracts";
import type { MessageKey } from "@thinkrail/locales";
import { useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import { Textarea } from "@thinkrail/ui/textarea";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { toast, useAppStore } from "@/store";
import { getTransport } from "@/transport";
import { fileName } from "../lib/utils";
import { SettingsNotice } from "./SettingsNotice";

const AcpAuthTerminal = lazy(() => import("./AcpAuthTerminal"));

function catalogJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

function checkFailureKey(client: AcpClientConfig, result: AcpClientCheckResult): MessageKey {
	const executable = fileName(client.command);
	if (executable === "agy" && result.issue !== "executable") {
		return "settings.acp.antigravityCliNotAcp";
	}
	if (
		client.id === "antigravity" &&
		executable === "antigravity-acp" &&
		result.issue === "executable"
	) {
		return "settings.acp.antigravityAdapterMissing";
	}
	if (result.issue === "executable") return "settings.acp.checkExecutableFailed";
	if (result.issue === "protocol") return "settings.acp.checkProtocolFailed";
	if (result.issue === "timeout") return "settings.acp.checkTimeout";
	return "settings.acp.checkFailed";
}

export function AcpSettings() {
	const t = useT();
	const clients = useAppStore((state) => state.acpClients);
	const acpStartTimeoutMs = useAppStore((state) => state.acpStartTimeoutMs);
	const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId);
	const protocolVersion = useAppStore((state) => state.protocolVersion);
	const canListModels =
		protocolVersion !== null && protocolVersion >= ACP_MODEL_CATALOG_PROTOCOL_VERSION;
	const canLoginInline = protocolVersion !== null && protocolVersion >= ACP_AUTH_PROTOCOL_VERSION;
	const canConfigureStartTimeout =
		protocolVersion !== null && protocolVersion >= ACP_START_TIMEOUT_PROTOCOL_VERSION;
	const savedStartTimeoutSeconds = Math.round(acpStartTimeoutMs / 1000);
	const minStartTimeoutSeconds = Math.ceil(ACP_START_TIMEOUT_MIN_MS / 1000);
	const maxStartTimeoutSeconds = Math.floor(ACP_START_TIMEOUT_MAX_MS / 1000);
	const [draft, setDraft] = useState(() => catalogJson(clients));
	const [startTimeoutDraft, setStartTimeoutDraft] = useState(() =>
		String(savedStartTimeoutSeconds),
	);
	const [saving, setSaving] = useState(false);
	const [checkingId, setCheckingId] = useState<string | null>(null);
	const [authenticating, setAuthenticating] = useState<{
		clientId: string;
		methodId: string;
	} | null>(null);
	const [authTerminal, setAuthTerminal] = useState<{
		clientId: string;
		methodId: string;
		workspaceId?: string;
	} | null>(null);
	const [authResults, setAuthResults] = useState<Record<string, "success" | "failed">>({});
	const [checkResults, setCheckResults] = useState<Record<string, AcpClientCheckResult>>({});
	const [loadingModelsId, setLoadingModelsId] = useState<string | null>(null);
	const [modelCatalogs, setModelCatalogs] = useState<
		Record<string, { workspaceId: string; options: AcpConfigOption[] }>
	>({});
	const [modelCatalogErrors, setModelCatalogErrors] = useState<Record<string, string>>({});
	const [saveFailed, setSaveFailed] = useState(false);

	useEffect(() => {
		setDraft(catalogJson(clients));
		setStartTimeoutDraft(String(savedStartTimeoutSeconds));
		setCheckResults({});
		setAuthenticating(null);
		setAuthTerminal(null);
		setAuthResults({});
		setModelCatalogs({});
		setModelCatalogErrors({});
	}, [clients, savedStartTimeoutSeconds]);

	let parsed: unknown;
	let valid = false;
	try {
		parsed = JSON.parse(draft);
		valid = isAcpClientCatalog(parsed);
	} catch {
		valid = false;
	}
	const parsedStartTimeoutSeconds = /^\d+$/.test(startTimeoutDraft)
		? Number(startTimeoutDraft)
		: null;
	const startTimeoutMs =
		parsedStartTimeoutSeconds === null ? null : parsedStartTimeoutSeconds * 1000;
	const startTimeoutInvalid = startTimeoutMs === null || !isAcpStartTimeoutMs(startTimeoutMs);
	const dirty =
		draft !== catalogJson(clients) ||
		(canConfigureStartTimeout && startTimeoutDraft !== String(savedStartTimeoutSeconds));

	const save = () => {
		if (
			!valid ||
			(canConfigureStartTimeout && (startTimeoutInvalid || startTimeoutMs === null)) ||
			!dirty ||
			saving ||
			checkingId ||
			loadingModelsId ||
			authenticating ||
			authTerminal
		) {
			return;
		}
		setSaving(true);
		setSaveFailed(false);
		void getTransport()
			.request("settings.update", {
				config: {
					acpClients: parsed as typeof clients,
					...(canConfigureStartTimeout && startTimeoutMs !== null
						? { acpStartTimeoutMs: startTimeoutMs }
						: {}),
				},
			})
			.catch(() => {
				setSaveFailed(true);
				toast.error(t("settings.acp.saveFailed"));
			})
			.finally(() => setSaving(false));
	};

	const check = (clientId: string) => {
		if (dirty || checkingId || loadingModelsId || authenticating || authTerminal) return;
		setCheckingId(clientId);
		setAuthResults((current) => {
			const next = { ...current };
			delete next[clientId];
			return next;
		});
		void getTransport()
			.request("acp.client.check", { clientId })
			.then((result) => setCheckResults((current) => ({ ...current, [clientId]: result })))
			.catch(() =>
				setCheckResults((current) => ({
					...current,
					[clientId]: { available: false, issue: "handshake" },
				})),
			)
			.finally(() => setCheckingId(null));
	};

	const listModels = useCallback(
		(clientId: string) => {
			const workspaceId = useAppStore.getState().activeWorkspaceId;
			if (dirty || checkingId || loadingModelsId || !workspaceId || !canListModels) {
				return;
			}
			setLoadingModelsId(clientId);
			setModelCatalogErrors((current) => ({ ...current, [clientId]: "" }));
			void getTransport()
				.request("acp.client.models", { workspaceId, clientId })
				.then((options) =>
					setModelCatalogs((current) => ({
						...current,
						[clientId]: { workspaceId, options },
					})),
				)
				.catch(() =>
					setModelCatalogErrors((current) => ({
						...current,
						[clientId]: workspaceId,
					})),
				)
				.finally(() => setLoadingModelsId(null));
		},
		[canListModels, checkingId, dirty, loadingModelsId],
	);

	const loginWithAgent = (clientId: string, methodId: string) => {
		if (dirty || authenticating || authTerminal || checkingId || loadingModelsId) return;
		setAuthenticating({ clientId, methodId });
		setAuthResults((current) => {
			const next = { ...current };
			delete next[clientId];
			return next;
		});
		let succeeded = false;
		void getTransport()
			.request("acp.client.authenticate", { clientId, methodId }, { timeoutMs: 11 * 60 * 1000 })
			.then(() => {
				succeeded = true;
				setAuthResults((current) => ({ ...current, [clientId]: "success" }));
			})
			.catch(() => setAuthResults((current) => ({ ...current, [clientId]: "failed" })))
			.finally(() => {
				setAuthenticating(null);
				if (succeeded) listModels(clientId);
			});
	};

	const cancelAgentLogin = () => {
		if (!authenticating) return;
		const clientId = authenticating.clientId;
		void getTransport()
			.request("acp.client.authenticate.cancel", { clientId })
			.catch(() => {});
	};

	const showTerminalLogin = (clientId: string, methodId: string) => {
		if (dirty || authenticating || authTerminal || checkingId || loadingModelsId) return;
		setAuthResults((current) => {
			const next = { ...current };
			delete next[clientId];
			return next;
		});
		setAuthTerminal({
			clientId,
			methodId,
			...(activeWorkspaceId ? { workspaceId: activeWorkspaceId } : {}),
		});
	};

	const completeTerminalLogin = useCallback(
		(success: boolean) => {
			if (!authTerminal) return;
			const { clientId } = authTerminal;
			setAuthTerminal(null);
			setAuthResults((current) => ({
				...current,
				[clientId]: success ? "success" : "failed",
			}));
			if (success) listModels(clientId);
		},
		[authTerminal, listModels],
	);

	return (
		<section data-testid="settings-acp" className="flex min-w-0 flex-col gap-16">
			<div className="flex flex-col gap-4">
				<h3 className="tr-title-section text-text-default">{t("settings.acp.title")}</h3>
				<p className="text-text-muted tr-text-metadata">{t("settings.acp.description")}</p>
				<p className="text-text-muted tr-text-metadata">{t("settings.acp.installHint")}</p>
			</div>

			<SettingsNotice variant="warning" testId="settings-acp-v2-warning">
				{t("settings.acp.v2Warning")}
			</SettingsNotice>

			{canConfigureStartTimeout ? (
				<div className="flex min-w-0 flex-col gap-4">
					<label htmlFor="acp-start-timeout" className="tr-text-ui text-text-default">
						{t("settings.acp.startTimeoutLabel")}
					</label>
					<p id="acp-start-timeout-hint" className="text-text-muted tr-text-metadata">
						{t("settings.acp.startTimeoutHint")}
					</p>
					<input
						id="acp-start-timeout"
						type="number"
						min={minStartTimeoutSeconds}
						max={maxStartTimeoutSeconds}
						step={1}
						inputMode="numeric"
						value={startTimeoutDraft}
						aria-invalid={startTimeoutInvalid}
						aria-describedby={
							startTimeoutInvalid
								? "acp-start-timeout-hint acp-start-timeout-error"
								: "acp-start-timeout-hint"
						}
						disabled={
							saving ||
							checkingId !== null ||
							loadingModelsId !== null ||
							!!authenticating ||
							!!authTerminal
						}
						onChange={(event) => {
							setStartTimeoutDraft(event.currentTarget.value);
							setSaveFailed(false);
						}}
						data-testid="acp-start-timeout-input"
						data-settings-draft-input
						className="h-32 w-80 rounded-sm border border-control-border-default bg-control-bg px-8 tr-text-ui text-text-default outline-none focus:border-control-border-active focus-visible:ring-2 focus-visible:ring-primary aria-invalid:border-feedback-error"
					/>
					{startTimeoutInvalid ? (
						<p
							id="acp-start-timeout-error"
							role="alert"
							className="text-feedback-error tr-text-metadata"
						>
							{t("settings.acp.startTimeoutInvalid", {
								min: minStartTimeoutSeconds,
								max: maxStartTimeoutSeconds,
							})}
						</p>
					) : null}
				</div>
			) : null}

			<div className="flex min-w-0 flex-col gap-8">
				<label htmlFor="acp-clients-json" className="tr-text-ui text-text-default">
					{t("settings.acp.jsonLabel")}
				</label>
				<p id="acp-clients-json-hint" className="text-text-muted tr-text-metadata">
					{t("settings.acp.jsonHint")}
				</p>
				<SettingsNotice variant="warning" testId="settings-acp-args-security">
					{t("settings.acp.argsSecurityHint")}
				</SettingsNotice>
				<Textarea
					id="acp-clients-json"
					data-testid="acp-clients-json"
					data-settings-draft-input
					aria-describedby="acp-clients-json-hint"
					aria-invalid={!valid}
					rows={8}
					value={draft}
					spellCheck={false}
					disabled={
						saving ||
						checkingId !== null ||
						loadingModelsId !== null ||
						!!authenticating ||
						!!authTerminal
					}
					onChange={(event) => {
						setDraft(event.currentTarget.value);
						setSaveFailed(false);
					}}
					className="min-h-128 w-full min-w-0 resize-y px-8 py-8 tr-code-text"
				/>
				{!valid ? (
					<p role="alert" className="text-feedback-error tr-text-metadata">
						{t("settings.acp.invalidJson")}
					</p>
				) : null}
				{saveFailed ? (
					<p role="alert" className="text-feedback-error tr-text-metadata">
						{t("settings.acp.saveFailed")}
					</p>
				) : null}
			</div>

			<ul className="flex min-w-0 flex-col gap-8">
				{clients.map((client) => {
					const result = checkResults[client.id];
					const authMethods: AcpAuthMethodSummary[] = result?.authMethods ?? [];
					const clientModelCatalog = modelCatalogs[client.id];
					return (
						<li
							key={client.id}
							data-testid={`acp-client-${client.id}`}
							className="grid min-w-0 grid-cols-1 gap-12 rounded-sm border border-border-default bg-control-bg px-12 py-12 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"
						>
							<div className="flex min-w-0 flex-col gap-2">
								<span className="break-words tr-title-compact text-text-default">
									{client.name}
								</span>
								<code className="break-all tr-code-text text-text-muted">
									{[client.command, ...client.args].join(" ")}
								</code>
								{result ? (
									<span
										data-testid={`acp-client-status-${client.id}`}
										className={
											result.available
												? "text-feedback-success tr-text-metadata"
												: "text-feedback-error tr-text-metadata"
										}
									>
										{result.available
											? t("settings.acp.checkSuccess")
											: t(checkFailureKey(client, result))}
									</span>
								) : null}
								{canLoginInline && result?.available && result.authMethods ? (
									<div
										data-testid={`acp-client-auth-${client.id}`}
										className="flex min-w-0 flex-col gap-8 rounded-sm border border-border-default p-8"
									>
										<span className="tr-text-label-pill text-text-muted">
											{t("settings.acp.authMethodsTitle")}
										</span>
										{authMethods.length === 0 ? (
											<p className="break-words tr-text-metadata text-text-muted">
												{t("settings.acp.noAuthMethods")}
											</p>
										) : (
											<ul className="flex min-w-0 flex-col gap-8">
												{authMethods.map((method) => (
													<li
														key={method.id}
														className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
													>
														<div className="flex min-w-0 flex-col gap-2">
															<span className="break-words tr-text-ui text-text-default">
																{method.name}
															</span>
															{method.description ? (
																<span className="break-words tr-text-metadata text-text-muted">
																	{method.description}
																</span>
															) : null}
														</div>
														<Button
															type="button"
															variant="outline"
															size="m"
															disabled={
																dirty ||
																!client.enabled ||
																checkingId !== null ||
																loadingModelsId !== null ||
																authenticating !== null ||
																authTerminal !== null
															}
															onClick={() =>
																method.type === "terminal"
																	? showTerminalLogin(client.id, method.id)
																	: loginWithAgent(client.id, method.id)
															}
															data-testid={`acp-client-auth-method-${client.id}-${method.id}`}
														>
															{method.type === "terminal"
																? t("settings.acp.loginInTerminal")
																: t("settings.acp.loginWithAgent")}
														</Button>
													</li>
												))}
											</ul>
										)}
										{authenticating?.clientId === client.id ? (
											<div className="flex flex-wrap items-center justify-between gap-4">
												<p role="status" className="tr-text-metadata text-text-muted">
													{t("settings.acp.loginWorking")}
												</p>
												<Button
													type="button"
													variant="outline"
													size="s"
													onClick={cancelAgentLogin}
													data-testid={`acp-client-auth-cancel-${client.id}`}
												>
													{t("settings.acp.cancelLogin")}
												</Button>
											</div>
										) : null}
										{authTerminal?.clientId === client.id ? (
											<div className="flex min-w-0 flex-col gap-4">
												<Suspense
													fallback={
														<p role="status" className="tr-text-metadata text-text-muted">
															{t("settings.acp.terminalLoading")}
														</p>
													}
												>
													<AcpAuthTerminal
														clientId={client.id}
														methodId={authTerminal.methodId}
														{...(authTerminal.workspaceId
															? { workspaceId: authTerminal.workspaceId }
															: {})}
														onExit={completeTerminalLogin}
													/>
												</Suspense>
												<Button
													type="button"
													variant="outline"
													size="s"
													className="self-start"
													onClick={() => setAuthTerminal(null)}
													data-testid={`acp-client-auth-terminal-cancel-${client.id}`}
												>
													{t("settings.acp.cancelLogin")}
												</Button>
											</div>
										) : null}
										{authResults[client.id] ? (
											<p
												role={authResults[client.id] === "failed" ? "alert" : "status"}
												data-testid={`acp-client-auth-result-${client.id}`}
												className={
													authResults[client.id] === "success"
														? "text-feedback-success tr-text-metadata"
														: "text-feedback-error tr-text-metadata"
												}
											>
												{authResults[client.id] === "success"
													? t("settings.acp.loginSucceeded")
													: t("settings.acp.loginFailed")}
											</p>
										) : null}
									</div>
								) : null}
								{modelCatalogErrors[client.id] === activeWorkspaceId ? (
									<span
										role="alert"
										data-testid={`acp-client-models-error-${client.id}`}
										className="text-feedback-error tr-text-metadata"
									>
										{t("settings.acp.modelsFailed")}
									</span>
								) : null}
								{clientModelCatalog?.workspaceId === activeWorkspaceId ? (
									<div
										data-testid={`acp-client-models-${client.id}`}
										className="flex min-w-0 flex-col gap-8 rounded-sm border border-border-default p-8"
									>
										<span className="tr-text-label-pill text-text-muted">
											{t("settings.acp.modelsTitle")}
										</span>
										{clientModelCatalog.options.length === 0 ? (
											<p className="break-words tr-text-metadata text-text-muted">
												{t("settings.acp.modelsEmpty")}
											</p>
										) : (
											<ul className="grid min-w-0 grid-cols-1 gap-8 sm:grid-cols-2">
												{clientModelCatalog.options.map((option) => (
													<li
														key={option.id}
														className="flex min-w-0 flex-col gap-4 rounded-sm bg-container-content-bg p-8"
													>
														<span className="break-words text-text-default tr-text-metadata">
															{option.name}
														</span>
														<div className="flex min-w-0 flex-wrap gap-4">
															{option.options.map(({ value, name }) => (
																<span
																	key={value}
																	className="max-w-full break-words rounded-sm border border-border-default px-8 py-4 text-text-muted tr-text-metadata"
																>
																	{name || value}
																</span>
															))}
														</div>
													</li>
												))}
											</ul>
										)}
									</div>
								) : null}
							</div>
							<div className="flex flex-wrap gap-4 sm:shrink-0">
								<Button
									type="button"
									variant="outline"
									size="m"
									disabled={
										dirty ||
										checkingId !== null ||
										loadingModelsId !== null ||
										authenticating !== null ||
										authTerminal !== null
									}
									onClick={() => void check(client.id)}
									data-testid={`acp-client-check-${client.id}`}
								>
									{checkingId === client.id ? t("settings.acp.checking") : t("settings.acp.check")}
								</Button>
								{canLoginInline ? (
									<Button
										type="button"
										variant="outline"
										size="m"
										disabled={
											dirty ||
											!client.enabled ||
											checkingId !== null ||
											loadingModelsId !== null ||
											authenticating !== null ||
											authTerminal !== null
										}
										onClick={() => void check(client.id)}
										data-testid={`acp-client-login-${client.id}`}
									>
										{t("settings.acp.login")}
									</Button>
								) : null}
								{canListModels ? (
									<Button
										type="button"
										variant="outline"
										size="m"
										disabled={
											dirty ||
											checkingId !== null ||
											loadingModelsId !== null ||
											authenticating !== null ||
											authTerminal !== null ||
											!activeWorkspaceId ||
											!client.enabled
										}
										onClick={() => void listModels(client.id)}
										data-testid={`acp-client-models-button-${client.id}`}
									>
										{loadingModelsId === client.id
											? t("settings.acp.modelsLoading")
											: t("settings.acp.models")}
									</Button>
								) : null}
							</div>
						</li>
					);
				})}
			</ul>
			<p className="text-text-muted tr-text-metadata">{t("settings.acp.modelCatalogHint")}</p>

			<div className="flex justify-end">
				<Button
					type="button"
					variant="primary"
					size="m"
					disabled={
						!valid ||
						startTimeoutInvalid ||
						!dirty ||
						saving ||
						checkingId !== null ||
						loadingModelsId !== null ||
						authenticating !== null ||
						authTerminal !== null
					}
					onClick={() => void save()}
					data-testid="acp-clients-save"
				>
					{saving ? t("settings.acp.saving") : t("settings.acp.save")}
				</Button>
			</div>
		</section>
	);
}
