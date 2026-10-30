import { PROVIDER_CONFIG_LIMITS, type ProviderConfig } from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@thinkrail/ui/dialog";
import { cn } from "@thinkrail/ui/utils";
import { useEffect, useRef, useState } from "react";
import { toast } from "@/store";
import { getTransport } from "@/transport";

const INPUT_CLASS =
	"w-full min-w-0 rounded-sm border border-control-border-default bg-control-bg px-8 py-4 tr-text-ui text-text-default outline-none placeholder:text-text-muted focus-visible:border-control-border-active disabled:border-control-disabled-border disabled:bg-control-disabled-bg disabled:text-control-disabled-text";

function isValidBaseUrl(value: string): boolean {
	const trimmed = value.trim();
	if (trimmed === "") return true;
	try {
		const parsed = new URL(trimmed);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

export function ProviderConfigDialog({
	providerId,
	providerName,
	open,
	onOpenChange,
}: {
	providerId: string;
	providerName: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const t = useT();
	const [config, setConfig] = useState<ProviderConfig | null>(null);
	const [api, setApi] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [loadFailed, setLoadFailed] = useState(false);
	const [saveFailed, setSaveFailed] = useState(false);
	const requestSequence = useRef(0);
	const valid = isValidBaseUrl(baseUrl);
	const dirty =
		config !== null &&
		(api.trim() !== config.api.trim() ||
			baseUrl.trim() !== config.baseUrl.trim() ||
			apiKey.trim() !== "");

	useEffect(() => {
		if (!open) return;
		const sequence = ++requestSequence.current;
		setLoading(true);
		setLoadFailed(false);
		setSaveFailed(false);
		setConfig(null);
		setApi("");
		setBaseUrl("");
		setApiKey("");
		getTransport()
			.request("provider.config.get", { providerId })
			.then((result) => {
				if (sequence !== requestSequence.current) return;
				setConfig(result);
				setApi(result.api);
				setBaseUrl(result.baseUrl);
			})
			.catch(() => {
				if (sequence === requestSequence.current) setLoadFailed(true);
			})
			.finally(() => {
				if (sequence === requestSequence.current) setLoading(false);
			});
		return () => {
			if (sequence === requestSequence.current) requestSequence.current++;
		};
	}, [open, providerId]);

	const save = () => {
		if (!config || !dirty || !valid || saving || loading || loadFailed) return;
		setSaving(true);
		setSaveFailed(false);
		const replacementKey = apiKey.trim() === "" ? undefined : apiKey.trim();
		void getTransport()
			.request("provider.config.save", {
				providerId,
				api: api.trim(),
				baseUrl: baseUrl.trim(),
				...(replacementKey === undefined ? {} : { apiKey: replacementKey }),
			})
			.then((result) => {
				setConfig(result);
				setApi(result.api);
				setBaseUrl(result.baseUrl);
				setApiKey("");
				toast.success(t("settings.providers.configSaved"));
			})
			.catch(() => {
				setSaveFailed(true);
				toast.error(t("settings.providers.configSaveFailed"));
			})
			.finally(() => setSaving(false));
	};

	const disabled = loading || loadFailed || saving;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				data-testid="provider-config-dialog"
				className="max-h-[90dvh] max-w-[40rem] overflow-y-auto"
			>
				<DialogHeader>
					<DialogTitle>{t("settings.providers.configTitle", { name: providerName })}</DialogTitle>
					<DialogDescription>{t("settings.providers.configDescription")}</DialogDescription>
				</DialogHeader>

				<div className="flex min-w-0 flex-col gap-16">
					<div className="flex min-w-0 flex-col gap-4">
						<label htmlFor="provider-config-api" className="tr-text-ui text-text-default">
							{t("settings.providers.configApiLabel")}
						</label>
						<input
							id="provider-config-api"
							data-testid="provider-config-api"
							className={cn(INPUT_CLASS, "tr-code-text")}
							value={api}
							maxLength={PROVIDER_CONFIG_LIMITS.apiLength}
							disabled={disabled}
							spellCheck={false}
							autoComplete="off"
							aria-describedby="provider-config-api-hint"
							placeholder={t("settings.providers.configApiPlaceholder")}
							onChange={(event) => {
								setApi(event.currentTarget.value);
								setSaveFailed(false);
							}}
						/>
						<p
							id="provider-config-api-hint"
							className="break-words text-text-muted tr-text-metadata"
						>
							{t("settings.providers.configApiHint")}
						</p>
					</div>

					<div className="flex min-w-0 flex-col gap-4">
						<label htmlFor="provider-config-base-url" className="tr-text-ui text-text-default">
							{t("settings.providers.configBaseUrlLabel")}
						</label>
						<input
							id="provider-config-base-url"
							data-testid="provider-config-base-url"
							className={cn(INPUT_CLASS, "tr-code-text")}
							value={baseUrl}
							maxLength={PROVIDER_CONFIG_LIMITS.baseUrlLength}
							disabled={disabled}
							spellCheck={false}
							autoComplete="off"
							aria-invalid={!valid}
							aria-describedby="provider-config-base-url-hint"
							placeholder={t("settings.providers.configBaseUrlPlaceholder")}
							onChange={(event) => {
								setBaseUrl(event.currentTarget.value);
								setSaveFailed(false);
							}}
						/>
						<p
							id="provider-config-base-url-hint"
							className="break-words text-text-muted tr-text-metadata"
						>
							{valid
								? t("settings.providers.configBaseUrlHint")
								: t("settings.providers.configBaseUrlInvalid")}
						</p>
					</div>

					<div className="flex min-w-0 flex-col gap-4">
						<label htmlFor="provider-config-api-key" className="tr-text-ui text-text-default">
							{t("settings.providers.configApiKeyLabel")}
						</label>
						<input
							id="provider-config-api-key"
							data-testid="provider-config-api-key"
							type="password"
							className={cn(INPUT_CLASS, "tr-code-text")}
							value={apiKey}
							maxLength={PROVIDER_CONFIG_LIMITS.apiKeyLength}
							disabled={disabled}
							spellCheck={false}
							autoComplete="new-password"
							aria-describedby="provider-config-api-key-hint"
							placeholder={
								config?.hasApiKey
									? t("settings.providers.configApiKeyKeep")
									: t("settings.providers.configApiKeyPlaceholder")
							}
							onChange={(event) => {
								setApiKey(event.currentTarget.value);
								setSaveFailed(false);
							}}
						/>
						<p
							id="provider-config-api-key-hint"
							className="break-words text-text-muted tr-text-metadata"
						>
							{config?.hasApiKey
								? t("settings.providers.configApiKeyHint")
								: t("settings.providers.configApiKeyMissing")}
						</p>
					</div>

					{loading ? (
						<p className="text-text-muted tr-text-metadata">
							{t("settings.providers.configLoading")}
						</p>
					) : null}
					{config ? (
						<p className="text-text-muted tr-text-metadata">
							{t("settings.providers.configModelCount", { count: config.modelCount })}
						</p>
					) : null}
					{loadFailed ? (
						<p role="alert" className="text-feedback-error tr-text-metadata">
							{t("settings.providers.configLoadFailed")}
						</p>
					) : null}
					{saveFailed ? (
						<p role="alert" className="text-feedback-error tr-text-metadata">
							{t("settings.providers.configSaveFailed")}
						</p>
					) : null}
				</div>

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						size="m"
						disabled={saving}
						onClick={() => onOpenChange(false)}
					>
						{t("common.cancel")}
					</Button>
					<Button
						type="button"
						variant="primary"
						size="m"
						data-testid="provider-config-save"
						disabled={!config || !dirty || !valid || disabled}
						onClick={() => void save()}
					>
						{saving ? t("settings.providers.configSaving") : t("settings.providers.configSave")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
