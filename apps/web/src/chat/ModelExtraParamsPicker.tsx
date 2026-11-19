import { RiCheckLine, RiEqualizerLine } from "@remixicon/react";
import type {
	ExtraParamPrimitive,
	ModelExtraParam,
	ModelExtraParamOption,
	ModelExtraParamValues,
} from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@thinkrail/ui/popover";
import { cn } from "@thinkrail/ui/utils";
import { useState } from "react";

function formatParamLabel(name: string): string {
	return name.replace(/[_-]+/g, " ");
}

function pricingBadgeText(
	option: ModelExtraParamOption,
	t: ReturnType<typeof useT>,
): string | null {
	const rule = option.pricing?.all ?? option.pricing?.input ?? option.pricing?.output;
	if (!rule) return null;
	if (rule.operator === "multiply") {
		return t("chat.extraParams.multiplier", { value: String(rule.value) });
	}
	return t("chat.extraParams.add", { value: String(rule.value) });
}

function activeCount(params: readonly ModelExtraParam[], values: ModelExtraParamValues): number {
	let count = 0;
	for (const param of params) {
		const effective = Object.hasOwn(values, param.name)
			? values[param.name]
			: (param.default ?? null);
		if (effective !== null && effective !== undefined && effective !== "") count++;
	}
	return count;
}

function choiceEntries(param: ModelExtraParam): ModelExtraParamOption[] {
	if (param.options && param.options.length > 0) return param.options;
	if (param.values && param.values.length > 0) {
		return param.values.map((value) => ({ label: String(value), value }));
	}
	if (param.type === "boolean") {
		return [
			{ label: "true", value: true },
			{ label: "false", value: false },
		];
	}
	return [];
}

export function ModelExtraParamsPicker({
	params,
	values,
	onChange,
	disabled = false,
	container,
}: {
	params: readonly ModelExtraParam[];
	values: ModelExtraParamValues;
	onChange: (next: ModelExtraParamValues) => void;
	disabled?: boolean;
	container?: HTMLElement | null;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);

	if (params.length === 0) return null;

	const count = activeCount(params, values);
	const single = params.length === 1 ? params[0] : undefined;
	const singleEffective = single
		? Object.hasOwn(values, single.name)
			? values[single.name]
			: (single.default ?? null)
		: null;
	const triggerLabel =
		single && singleEffective !== null && singleEffective !== undefined
			? `${formatParamLabel(single.name)}: ${String(singleEffective)}`
			: count > 0
				? t("chat.extraParams.buttonCount", { count })
				: t("chat.extraParams.button");

	const updateValue = (name: string, value: ExtraParamPrimitive) => {
		const next: ModelExtraParamValues = { ...values };
		if (value === null) next[name] = null;
		else next[name] = value;
		onChange(next);
	};

	const resetAll = () => {
		const next: ModelExtraParamValues = {};
		for (const param of params) next[param.name] = null;
		onChange(next);
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="s"
					iconLeft={RiEqualizerLine}
					selected={count > 0}
					disabled={disabled}
					data-testid="composer-extra-params"
					className="max-w-[14rem] truncate"
					aria-label={t("chat.extraParams.title")}
				>
					<span className="truncate">{triggerLabel}</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				side="top"
				container={container}
				className="w-256 p-12"
				data-testid="composer-extra-params-popover"
			>
				<div className="mb-8 flex items-center justify-between gap-8">
					<span className="tr-title-compact text-text-default">{t("chat.extraParams.title")}</span>
					{count > 0 ? (
						<button
							type="button"
							onClick={resetAll}
							className="rounded-sm px-4 py-2 tr-text-metadata text-text-muted hover:bg-control-bg-hovered hover:text-text-default focus-visible:focus-ring"
						>
							{t("chat.extraParams.reset")}
						</button>
					) : null}
				</div>
				<div className="flex flex-col gap-12">
					{params.map((param) => {
						const current = Object.hasOwn(values, param.name)
							? values[param.name]
							: (param.default ?? null);
						const choices = choiceEntries(param);
						return (
							<div key={param.name} className="flex flex-col gap-4">
								<span className="tr-text-metadata text-text-muted">
									{formatParamLabel(param.name)}
								</span>
								{choices.length > 0 ? (
									<div className="flex flex-col gap-2">
										<button
											type="button"
											data-testid={`extra-param-${param.name}-default`}
											onClick={() => updateValue(param.name, null)}
											className={cn(
												"flex items-center justify-between gap-8 rounded-sm px-8 py-4 text-left tr-text-ui focus-visible:focus-ring",
												current === null || current === undefined
													? "bg-primary-subtle text-text-default"
													: "text-text-muted hover:bg-control-bg-hovered hover:text-text-default",
											)}
										>
											<span>{t("chat.extraParams.default")}</span>
											{current === null || current === undefined ? (
												<RiCheckLine className="size-14 shrink-0 text-primary" />
											) : null}
										</button>
										{choices.map((option) => {
											const selected = current === option.value;
											const badge = pricingBadgeText(option, t);
											return (
												<button
													key={String(option.value)}
													type="button"
													data-testid={`extra-param-${param.name}-${String(option.value)}`}
													onClick={() => updateValue(param.name, option.value)}
													className={cn(
														"flex items-center justify-between gap-8 rounded-sm px-8 py-4 text-left tr-text-ui focus-visible:focus-ring",
														selected
															? "bg-primary-subtle text-text-default"
															: "text-text-default hover:bg-control-bg-hovered",
													)}
												>
													<span className="flex min-w-0 items-center gap-6">
														<span className="truncate">{option.label}</span>
														{badge ? (
															<span className="rounded-sm bg-control-bg px-4 py-2 tr-code-text text-text-muted">
																{badge}
															</span>
														) : null}
													</span>
													{selected ? (
														<RiCheckLine className="size-14 shrink-0 text-primary" />
													) : null}
												</button>
											);
										})}
									</div>
								) : (
									<input
										type={
											param.type === "number" || param.type === "integer" || param.type === "float"
												? "number"
												: "text"
										}
										value={current === null || current === undefined ? "" : String(current)}
										placeholder={t("chat.extraParams.placeholder")}
										onChange={(event) => {
											const raw = event.currentTarget.value;
											if (raw === "") {
												updateValue(param.name, null);
												return;
											}
											if (
												param.type === "number" ||
												param.type === "integer" ||
												param.type === "float"
											) {
												const num = Number(raw);
												if (Number.isFinite(num)) updateValue(param.name, num);
												return;
											}
											updateValue(param.name, raw);
										}}
										className="min-h-28 w-full rounded-sm border border-control-border-default bg-control-bg px-8 tr-text-ui text-text-default placeholder:text-text-muted focus-visible:border-control-border-active focus-visible:focus-ring"
									/>
								)}
							</div>
						);
					})}
				</div>
			</PopoverContent>
		</Popover>
	);
}
