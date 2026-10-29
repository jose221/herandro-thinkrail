import type { AcpClientCheckResult, AcpConfigOption } from "@thinkrail/contracts";
import { ACP_MODEL_CATALOG_PROTOCOL_VERSION, isAcpClientCatalog } from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import { Textarea } from "@thinkrail/ui/textarea";
import { useEffect, useState } from "react";
import { toast, useAppStore } from "@/store";
import { getTransport } from "@/transport";

function catalogJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

export function AcpSettings() {
	const t = useT();
	const clients = useAppStore((state) => state.acpClients);
	const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId);
	const protocolVersion = useAppStore((state) => state.protocolVersion);
	const canListModels =
		protocolVersion !== null && protocolVersion >= ACP_MODEL_CATALOG_PROTOCOL_VERSION;
	const [draft, setDraft] = useState(() => catalogJson(clients));
	const [saving, setSaving] = useState(false);
	const [checkingId, setCheckingId] = useState<string | null>(null);
	const [checkResults, setCheckResults] = useState<Record<string, AcpClientCheckResult>>({});
	const [loadingModelsId, setLoadingModelsId] = useState<string | null>(null);
	const [modelCatalogs, setModelCatalogs] = useState<
		Record<string, { workspaceId: string; options: AcpConfigOption[] }>
	>({});
	const [modelCatalogErrors, setModelCatalogErrors] = useState<Record<string, string>>({});
	const [saveFailed, setSaveFailed] = useState(false);

	useEffect(() => {
		setDraft(catalogJson(clients));
		setCheckResults({});
		setModelCatalogs({});
		setModelCatalogErrors({});
	}, [clients]);

	let parsed: unknown;
	let valid = false;
	try {
		parsed = JSON.parse(draft);
		valid = isAcpClientCatalog(parsed);
	} catch {
		valid = false;
	}
	const dirty = draft !== catalogJson(clients);

	const save = () => {
		if (!valid || !dirty || saving || checkingId || loadingModelsId) return;
		setSaving(true);
		setSaveFailed(false);
		void getTransport()
			.request("settings.update", {
				config: { acpClients: parsed as typeof clients },
			})
			.catch(() => {
				setSaveFailed(true);
				toast.error(t("settings.acp.saveFailed"));
			})
			.finally(() => setSaving(false));
	};

	const check = (clientId: string) => {
		if (dirty || checkingId || loadingModelsId) return;
		setCheckingId(clientId);
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

	const listModels = (clientId: string) => {
		if (dirty || checkingId || loadingModelsId || !activeWorkspaceId || !canListModels) return;
		const workspaceId = activeWorkspaceId;
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
	};

	return (
		<section data-testid="settings-acp" className="flex min-w-0 flex-col gap-16">
			<div className="flex flex-col gap-4">
				<h3 className="tr-title-section text-text-default">{t("settings.acp.title")}</h3>
				<p className="text-text-muted tr-text-metadata">{t("settings.acp.description")}</p>
				<p className="text-text-muted tr-text-metadata">{t("settings.acp.installHint")}</p>
			</div>

			<div className="flex min-w-0 flex-col gap-8">
				<label htmlFor="acp-clients-json" className="tr-text-ui text-text-default">
					{t("settings.acp.jsonLabel")}
				</label>
				<p id="acp-clients-json-hint" className="text-text-muted tr-text-metadata">
					{t("settings.acp.jsonHint")}
				</p>
				<Textarea
					id="acp-clients-json"
					data-testid="acp-clients-json"
					data-settings-draft-input
					aria-describedby="acp-clients-json-hint"
					aria-invalid={!valid}
					rows={16}
					value={draft}
					spellCheck={false}
					onChange={(event) => {
						setDraft(event.currentTarget.value);
						setSaveFailed(false);
					}}
					className="min-h-192 w-full min-w-0 resize-y px-8 py-8 tr-code-text"
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

			<ul className="flex min-w-0 flex-col divide-y divide-border-default rounded-sm border border-border-default bg-control-bg">
				{clients.map((client) => {
					const result = checkResults[client.id];
					const clientModelCatalog = modelCatalogs[client.id];
					return (
						<li
							key={client.id}
							data-testid={`acp-client-${client.id}`}
							className="flex min-w-0 flex-col gap-8 px-12 py-8 sm:flex-row sm:items-center sm:justify-between"
						>
							<div className="flex min-w-0 flex-col gap-2">
								<span className="truncate tr-title-compact text-text-default">{client.name}</span>
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
											: t(
													result.issue === "executable"
														? "settings.acp.checkExecutableFailed"
														: result.issue === "protocol"
															? "settings.acp.checkProtocolFailed"
															: "settings.acp.checkFailed",
												)}
									</span>
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
										className="flex min-w-0 flex-col gap-4 rounded-sm border border-border-default p-8"
									>
										<span className="tr-text-label-pill text-text-muted">
											{t("settings.acp.modelsTitle")}
										</span>
										{clientModelCatalog.options.length === 0 ? (
											<p className="break-words tr-text-metadata text-text-muted">
												{t("settings.acp.modelsEmpty")}
											</p>
										) : (
											<ul className="flex min-w-0 flex-col gap-4">
												{clientModelCatalog.options.map((option) => (
													<li key={option.id} className="min-w-0 break-words tr-text-metadata">
														<span className="text-text-default">{option.name}: </span>
														<span className="text-text-muted">
															{option.options.map(({ value, name }) => name || value).join(", ")}
														</span>
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
									disabled={dirty || checkingId !== null || loadingModelsId !== null}
									onClick={() => void check(client.id)}
									data-testid={`acp-client-check-${client.id}`}
								>
									{checkingId === client.id ? t("settings.acp.checking") : t("settings.acp.check")}
								</Button>
								{canListModels ? (
									<Button
										type="button"
										variant="outline"
										size="m"
										disabled={
											dirty ||
											checkingId !== null ||
											loadingModelsId !== null ||
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
					disabled={!valid || !dirty || saving || checkingId !== null || loadingModelsId !== null}
					onClick={() => void save()}
					data-testid="acp-clients-save"
				>
					{saving ? t("settings.acp.saving") : t("settings.acp.save")}
				</Button>
			</div>
		</section>
	);
}
