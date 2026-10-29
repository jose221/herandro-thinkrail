import {
	RiLockLine as Lock,
	RiLogoutBoxLine as LogOut,
	RiSettings3Line as ModelSettings,
	RiRefreshLine as RefreshCw,
} from "@remixicon/react";
import {
	type AppConfigUpdate,
	JBCENTRAL_QUOTA_PROTOCOL_VERSION,
	PROVIDER_MODELS_PROTOCOL_VERSION,
	type ProviderStatus,
} from "@thinkrail/contracts";
import { t as translate, useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import { SkeletonRows } from "@thinkrail/ui/skeleton";
import { useCallback, useState } from "react";
import { AUTH_KIND_LABEL } from "@/chat/modelPicker";
import { toast, useAppStore } from "@/store";
import { errorText, getTransport } from "@/transport";
import { JetBrainsAiCard } from "./JetBrainsAiCard";
import { ProviderModelsDialog } from "./ProviderModelsDialog";
import { ProviderRow } from "./ProviderRow";
import { SettingsGroup, SettingsPageContainer } from "./SettingsGroup";
import { useProviderAuth } from "./useProviderAuth";

const API_KEY_VISIBLE = 8;
const MAX_REST_NAMES = 5;

export function ProvidersSettings() {
	const t = useT();
	const [showAllKeys, setShowAllKeys] = useState(false);
	const [modelsProvider, setModelsProvider] = useState<ProviderStatus | null>(null);
	const {
		report,
		failed,
		refreshing,
		load,
		startLogin,
		logout,
		busyProvider,
		rowBusy,
		loginDialog,
	} = useProviderAuth({ ownsLoginDialog: true });
	const protocolVersion = useAppStore((s) => s.protocolVersion);
	const modelsEditorAvailable =
		protocolVersion !== null && protocolVersion >= PROVIDER_MODELS_PROTOCOL_VERSION;
	const quotaEnabled = useAppStore((s) => s.jbcentralQuotaEnabled);
	const quotaRefreshSeconds = useAppStore((s) => s.jbcentralQuotaRefreshSeconds);

	const saveQuotaSetting = useCallback(async (config: AppConfigUpdate) => {
		try {
			await getTransport().request("settings.update", { config });
		} catch (error) {
			toast.error(errorText(error), translate("settings.providers.quotaSaveFailed"));
			throw error;
		}
	}, []);

	const quotaSettings =
		protocolVersion !== null && protocolVersion >= JBCENTRAL_QUOTA_PROTOCOL_VERSION
			? {
					enabled: quotaEnabled,
					refreshSeconds: quotaRefreshSeconds,
					onEnabledChange: (enabled: boolean) =>
						saveQuotaSetting({ jbcentralQuotaEnabled: enabled }),
					onRefreshSecondsChange: (seconds: number) =>
						saveQuotaSetting({ jbcentralQuotaRefreshSeconds: seconds }),
				}
			: null;
	const providers = report?.providers ?? [];
	const configured = providers.filter((p) => p.configured);
	const unconfigured = providers.filter((p) => !p.configured);
	const subscriptionRows = unconfigured.filter((p) => p.canOAuth);
	const apiKeyRows = unconfigured.filter((p) => p.canApiKey && !p.canOAuth);
	const shownKeys = showAllKeys ? apiKeyRows : apiKeyRows.slice(0, API_KEY_VISIBLE);
	const hiddenKeyCount = apiKeyRows.length - shownKeys.length;
	const noInApp = unconfigured.filter((p) => !p.canOAuth && !p.canApiKey);

	return (
		<div data-testid="settings-providers" className="flex flex-col gap-24">
			<div className="flex items-center justify-between gap-12">
				<p className="tr-text-metadata text-text-muted">{t("settings.providers.intro")}</p>
				<Button
					variant="ghost"
					size="m"
					iconLeft={RefreshCw}
					loading={refreshing}
					spinIcon
					data-testid="providers-refresh"
					aria-label={t("settings.providers.refreshLabel")}
					onClick={() => void load()}
				>
					{t("settings.providers.refresh")}
				</Button>
			</div>

			{report == null && !failed ? (
				<SkeletonRows rows={3} />
			) : failed ? (
				<p data-testid="providers-error" className="text-text-muted tr-text-ui">
					{t("settings.providers.loadFailed")}
				</p>
			) : (
				<SettingsPageContainer>
					{configured.length > 0 ? (
						<SettingsGroup title={t("settings.providers.connectedGroup")}>
							{configured.map((p) => (
								<ConnectedRow
									key={p.id}
									provider={p}
									busy={busyProvider === p.id}
									onSignOut={() => void logout(p.id)}
									canEditModels={modelsEditorAvailable && p.canEditModelsJson === true}
									onEditModels={() => setModelsProvider(p)}
								/>
							))}
						</SettingsGroup>
					) : null}

					{report ? (
						<JetBrainsAiCard
							status={report.jbcentral}
							install={report.jbcentralInstall}
							onChanged={load}
							{...(quotaSettings ? { quotaSettings } : {})}
						/>
					) : null}

					{subscriptionRows.length > 0 ? (
						<SettingsGroup
							title={t("settings.providers.subscriptionsGroup")}
							description={t("settings.providers.subscriptionsDescription")}
						>
							{subscriptionRows.map((p) => (
								<ProviderRow
									key={p.id}
									provider={p}
									busy={rowBusy(p.id)}
									onSignIn={() => void startLogin(p.id, "oauth")}
									onApiKey={() => void startLogin(p.id, "api_key")}
								/>
							))}
						</SettingsGroup>
					) : null}

					{apiKeyRows.length > 0 ? (
						<SettingsGroup
							title={t("settings.providers.availableGroup", { count: apiKeyRows.length })}
						>
							{shownKeys.map((p) => (
								<ProviderRow
									key={p.id}
									provider={p}
									busy={rowBusy(p.id)}
									onSignIn={() => void startLogin(p.id, "oauth")}
									onApiKey={() => void startLogin(p.id, "api_key")}
								/>
							))}
							{hiddenKeyCount > 0 ? (
								<div className="pt-8">
									<Button
										variant="outline"
										size="m"
										data-testid="providers-show-more"
										onClick={() => setShowAllKeys(true)}
									>
										{t("settings.providers.showMore", { count: hiddenKeyCount })}
									</Button>
								</div>
							) : null}
						</SettingsGroup>
					) : null}

					{noInApp.length > 0 ? (
						<p data-testid="providers-more" className="text-text-muted tr-text-metadata">
							{noInApp.length > MAX_REST_NAMES
								? t("settings.providers.outsideAppTruncated", {
										count: noInApp.length,
										names: noInApp
											.slice(0, MAX_REST_NAMES)
											.map((p) => p.name)
											.join(", "),
									})
								: t("settings.providers.outsideApp", {
										count: noInApp.length,
										names: noInApp.map((p) => p.name).join(", "),
									})}
						</p>
					) : null}
				</SettingsPageContainer>
			)}

			{loginDialog}
			{modelsProvider ? (
				<ProviderModelsDialog
					providerId={modelsProvider.id}
					providerName={modelsProvider.name}
					open
					onOpenChange={(open) => {
						if (!open) setModelsProvider(null);
					}}
				/>
			) : null}
		</div>
	);
}

function ConnectedRow({
	provider,
	busy,
	onSignOut,
	canEditModels,
	onEditModels,
}: {
	provider: ProviderStatus;
	busy: boolean;
	onSignOut: () => void;
	canEditModels: boolean;
	onEditModels: () => void;
}) {
	const t = useT();
	const label = t(AUTH_KIND_LABEL[provider.kind ?? "other"]);
	const managedTitle =
		provider.kind === "central"
			? t("settings.providers.managedCentral")
			: t("settings.providers.managedOutside");

	return (
		<div
			data-testid="provider-row"
			data-provider={provider.id}
			data-configured="true"
			data-kind={provider.kind}
			className="flex min-w-0 flex-col gap-8 border-border-muted border-b py-12 sm:flex-row sm:items-center"
		>
			<span className="min-w-0 flex-1 truncate tr-text-ui text-text-default">{provider.name}</span>
			<div className="flex min-w-0 flex-wrap items-center gap-8 sm:justify-end">
				<span className="max-w-full truncate text-text-muted tr-text-metadata">
					{provider.detail
						? t("settings.providers.kindDetail", { kind: label, detail: provider.detail })
						: label}
				</span>
				{provider.canLogout ? (
					<Button
						variant="soft-primary"
						size="m"
						iconLeft={LogOut}
						data-testid="provider-signout"
						data-provider={provider.id}
						disabled={busy}
						onClick={onSignOut}
					>
						{t("settings.providers.signOut")}
					</Button>
				) : (
					<span
						className="flex shrink-0 items-center gap-4 text-text-muted tr-text-metadata"
						title={managedTitle}
					>
						<Lock className="size-12" />
						{t("settings.providers.managed")}
					</span>
				)}
				{canEditModels ? (
					<Button
						variant="outline"
						size="m"
						iconLeft={ModelSettings}
						data-testid="provider-edit-models"
						data-provider={provider.id}
						onClick={onEditModels}
					>
						{t("settings.providers.editModels")}
					</Button>
				) : null}
			</div>
		</div>
	);
}
