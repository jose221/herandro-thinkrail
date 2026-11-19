import {
	isModelExtraParams,
	isProviderModelDefinitions,
	type ProviderModelDefinition,
} from "@thinkrail/contracts";
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
import { Textarea } from "@thinkrail/ui/textarea";
import { useEffect, useRef, useState } from "react";
import { toast } from "@/store";
import { getTransport } from "@/transport";

function formatDefinitions(definitions: ProviderModelDefinition[]): string {
	return JSON.stringify(definitions, null, 2);
}

const EFFORT_SUFFIX_RE = /\s+\((?:minimal|low|medium|high|xhigh|max)\)$/;

function convertOpenAiModelsList(text: string): ProviderModelDefinition[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	const list = (parsed as { data?: unknown }).data;
	if (!Array.isArray(list)) return null;
	const rawIds = new Set(
		list
			.filter(
				(entry): entry is Record<string, unknown> =>
					typeof entry === "object" &&
					entry !== null &&
					typeof (entry as Record<string, unknown>).id === "string",
			)
			.map((entry) => entry.id as string),
	);
	const seen = new Set<string>();
	const converted: ProviderModelDefinition[] = [];
	for (const entry of list) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
		const item = entry as Record<string, unknown>;
		if (typeof item.id !== "string" || item.id.trim() === "") continue;
		const id = item.id.trim();
		const baseCandidate = id.replace(EFFORT_SUFFIX_RE, "");
		if (baseCandidate !== id && rawIds.has(baseCandidate)) continue;
		if (seen.has(id)) continue;
		seen.add(id);
		const name =
			typeof item.display_name === "string" && item.display_name.trim()
				? item.display_name.trim()
				: typeof item.name === "string" && item.name.trim()
					? item.name.trim()
					: id;
		const reasoning =
			item.supports_reasoning_effort === true ||
			(Array.isArray(item.reasoning_effort_options) && item.reasoning_effort_options.length > 0) ||
			item.reasoning === true;
		const input: Array<"text" | "image"> =
			item.is_multimodal === true ? ["text", "image"] : ["text"];
		const rawExtra = item.extra_params ?? item.extraParams;
		converted.push({
			id,
			name,
			reasoning,
			input,
			contextWindow: 1_000_000,
			maxTokens: 131_072,
			cost: {
				input: typeof item.input_price_per_mtok === "number" ? item.input_price_per_mtok : 0,
				output: typeof item.output_price_per_mtok === "number" ? item.output_price_per_mtok : 0,
				cacheRead:
					typeof item.input_cache_price_per_mtok === "number" ? item.input_cache_price_per_mtok : 0,
				cacheWrite: 0,
			},
			...(isModelExtraParams(rawExtra) && rawExtra.length > 0 ? { extra_params: rawExtra } : {}),
		});
	}
	return isProviderModelDefinitions(converted) ? converted : null;
}

function parseDefinitions(text: string): ProviderModelDefinition[] | null {
	try {
		const value: unknown = JSON.parse(text);
		return isProviderModelDefinitions(value) ? value : null;
	} catch {
		return null;
	}
}

function newDefinitionId(definitions: ProviderModelDefinition[]): string {
	const ids = new Set(definitions.map((definition) => definition.id));
	let suffix = 1;
	let id = "new-model";
	while (ids.has(id)) {
		suffix++;
		id = `new-model-${suffix}`;
	}
	return id;
}

export function ProviderModelsDialog({
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
	const [definitions, setDefinitions] = useState<ProviderModelDefinition[]>([]);
	const [draft, setDraft] = useState("[]");
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [loadFailed, setLoadFailed] = useState(false);
	const [saveFailed, setSaveFailed] = useState(false);
	const requestSequence = useRef(0);
	const parsed = parseDefinitions(draft);
	const importable = parsed === null ? convertOpenAiModelsList(draft) : null;
	const valid = parsed !== null;
	const dirty = draft !== formatDefinitions(definitions);

	useEffect(() => {
		if (!open) return;
		const sequence = ++requestSequence.current;
		setLoading(true);
		setLoadFailed(false);
		setSaveFailed(false);
		getTransport()
			.request("provider.models.list", { providerId })
			.then((result) => {
				if (sequence !== requestSequence.current) return;
				setDefinitions(result);
				setDraft(formatDefinitions(result));
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

	const addModel = () => {
		if (parsed === null) return;
		const next = [
			...parsed,
			{
				id: newDefinitionId(parsed),
				name: t("settings.providers.newModelName"),
				reasoning: false,
				input: ["text"] as Array<"text" | "image">,
				contextWindow: 128_000,
				maxTokens: 16_384,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		];
		setDraft(formatDefinitions(next));
		setSaveFailed(false);
	};

	const convertImportedList = () => {
		if (!importable) {
			toast.error(t("settings.providers.importModelsInvalid"));
			return;
		}
		const merged = [...definitions];
		const existingIds = new Set(merged.map((m) => m.id));
		for (const item of importable) {
			const idx = merged.findIndex((m) => m.id === item.id);
			if (idx >= 0) merged[idx] = { ...merged[idx], ...item };
			else if (!existingIds.has(item.id)) {
				merged.push(item);
				existingIds.add(item.id);
			}
		}
		setDraft(formatDefinitions(merged));
		setSaveFailed(false);
		toast.success(t("settings.providers.importModelsSuccess", { count: importable.length }));
	};

	const save = () => {
		if (parsed === null || !dirty || saving || loading) return;
		setSaving(true);
		setSaveFailed(false);
		void getTransport()
			.request("provider.models.save", {
				providerId,
				models: parsed,
			})
			.then((result) => {
				setDefinitions(result);
				setDraft(formatDefinitions(result));
				toast.success(t("settings.providers.modelsSaved"));
			})
			.catch(() => {
				setSaveFailed(true);
				toast.error(t("settings.providers.modelsSaveFailed"));
			})
			.finally(() => setSaving(false));
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				data-testid="provider-models-dialog"
				className="max-h-[90dvh] max-w-[44rem] overflow-y-auto"
			>
				<DialogHeader>
					<DialogTitle>{t("settings.providers.modelsTitle", { name: providerName })}</DialogTitle>
					<DialogDescription>{t("settings.providers.modelsDescription")}</DialogDescription>
				</DialogHeader>

				<div className="flex min-w-0 flex-col gap-8">
					<label htmlFor="provider-models-json" className="tr-text-ui text-text-default">
						{t("settings.providers.modelsJsonLabel")}
					</label>
					<p
						id="provider-models-json-hint"
						className="break-words text-text-muted tr-text-metadata"
					>
						{t("settings.providers.modelsJsonHint")}
					</p>
					<Textarea
						id="provider-models-json"
						data-testid="provider-models-json"
						aria-describedby="provider-models-json-hint"
						aria-invalid={!valid}
						rows={18}
						value={draft}
						disabled={loading || loadFailed}
						spellCheck={false}
						onChange={(event) => {
							setDraft(event.currentTarget.value);
							setSaveFailed(false);
						}}
						className="min-h-192 w-full min-w-0 resize-y px-8 py-8 tr-code-text"
					/>
					{loading ? (
						<p className="text-text-muted tr-text-metadata">
							{t("settings.providers.modelsLoading")}
						</p>
					) : null}
					{loadFailed ? (
						<p role="alert" className="text-feedback-error tr-text-metadata">
							{t("settings.providers.modelsLoadFailed")}
						</p>
					) : null}
					{!valid && !loadFailed ? (
						<p role="alert" className="text-feedback-error tr-text-metadata">
							{t("settings.providers.modelsInvalid")}
						</p>
					) : null}
					{saveFailed ? (
						<p role="alert" className="text-feedback-error tr-text-metadata">
							{t("settings.providers.modelsSaveFailed")}
						</p>
					) : null}
				</div>

				<DialogFooter className="flex-col-reverse sm:flex-row sm:justify-between">
					<div className="flex flex-wrap gap-8">
						<Button
							type="button"
							variant="outline"
							size="m"
							disabled={!valid || loading || saving}
							onClick={addModel}
						>
							{t("settings.providers.addModel")}
						</Button>
						{importable ? (
							<Button
								type="button"
								variant="outline"
								size="m"
								disabled={loading || saving}
								onClick={convertImportedList}
								data-testid="provider-models-convert-list"
							>
								{t("settings.providers.importModelsList")}
							</Button>
						) : null}
					</div>
					<div className="flex flex-col-reverse gap-8 sm:flex-row">
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
							data-testid="provider-models-save"
							disabled={!valid || !dirty || saving || loading || loadFailed}
							onClick={() => void save()}
						>
							{saving ? t("settings.providers.modelsSaving") : t("settings.providers.saveModels")}
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
