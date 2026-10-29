import { isProviderModelDefinitions, type ProviderModelDefinition } from "@thinkrail/contracts";
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
					<Button
						type="button"
						variant="outline"
						size="m"
						disabled={!valid || loading || saving}
						onClick={addModel}
					>
						{t("settings.providers.addModel")}
					</Button>
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
