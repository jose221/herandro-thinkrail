import type { Model } from "@earendil-works/pi-ai";
import {
	type ExtraParamPrimitive,
	isModelExtraParams,
	type ModelExtraParam,
	type ModelExtraParamPricingRule,
	type ModelExtraParamValues,
	type ProviderModelDefinition,
} from "@thinkrail/contracts";
import { type Node, parseTree } from "jsonc-parser";
import { MODELS_JSON_PARSE, modelsPath, readModelsSource } from "./modelsFile";

export const EXTRA_PARAMS_CUSTOM_TYPE = "thinkrail_extra_params";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueFromNode(node: Node): unknown {
	if (node.type === "array") return (node.children ?? []).map(valueFromNode);
	if (node.type === "object") {
		const result: Record<string, unknown> = {};
		for (const property of node.children ?? []) {
			const [key, value] = property.children ?? [];
			if (key?.type === "string" && value) result[String(key.value)] = valueFromNode(value);
		}
		return result;
	}
	return node.value;
}

export function normalizeModelExtraParams(raw: unknown): ModelExtraParam[] | undefined {
	if (raw === undefined) return undefined;
	if (!Array.isArray(raw)) return undefined;
	const normalized: unknown[] = [];
	for (const entry of raw) {
		if (!isRecord(entry)) continue;
		const item: Record<string, unknown> = {};
		if (typeof entry.name === "string") item.name = entry.name;
		if (typeof entry.type === "string") item.type = entry.type;
		if (entry.values !== undefined) item.values = entry.values;
		if (entry.default !== undefined) item.default = entry.default;
		if (entry.options !== undefined) item.options = entry.options;
		normalized.push(item);
	}
	return isModelExtraParams(normalized) ? normalized : undefined;
}

let cachedSource: string | undefined;
let cachedMap = new Map<string, ModelExtraParam[]>();

function modelKey(provider: string, id: string): string {
	return `${provider}\0${id}`;
}

export function readModelsJsonExtraParamsMap(): ReadonlyMap<string, ModelExtraParam[]> {
	let source: string | undefined;
	try {
		source = readModelsSource(modelsPath());
	} catch {
		return cachedMap;
	}
	if (source === undefined) {
		cachedSource = undefined;
		cachedMap = new Map();
		return cachedMap;
	}
	if (source === cachedSource) return cachedMap;
	const root = parseTree(source.replace(/^\uFEFF/, ""), [], MODELS_JSON_PARSE);
	const next = new Map<string, ModelExtraParam[]>();
	const parsed = root ? valueFromNode(root) : undefined;
	if (isRecord(parsed) && isRecord(parsed.providers)) {
		for (const [providerId, providerValue] of Object.entries(parsed.providers)) {
			if (!isRecord(providerValue) || !Array.isArray(providerValue.models)) continue;
			for (const entry of providerValue.models) {
				if (!isRecord(entry) || typeof entry.id !== "string") continue;
				const params = normalizeModelExtraParams(entry.extra_params ?? entry.extraParams);
				if (params && params.length > 0) {
					next.set(modelKey(providerId, entry.id), params);
				}
			}
		}
	}
	cachedSource = source;
	cachedMap = next;
	return next;
}

export function getModelExtraParams(provider: string, id: string): ModelExtraParam[] | undefined {
	return readModelsJsonExtraParamsMap().get(modelKey(provider, id));
}

function isAllowedParamValue(def: ModelExtraParam, value: ExtraParamPrimitive): boolean {
	if (value === null) return true;
	if (def.values && def.values.length > 0) {
		return def.values.includes(value);
	}
	if (def.type === "boolean") return typeof value === "boolean";
	if (def.options && def.options.length > 0) {
		return def.options.some((option) => option.value === value);
	}
	if (def.type === "number" || def.type === "integer" || def.type === "float") {
		return typeof value === "number" && Number.isFinite(value);
	}
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

export function resolveActiveExtraParams(
	defs: readonly ModelExtraParam[] | undefined,
	selected: ModelExtraParamValues | undefined,
): Record<string, string | number | boolean> {
	if (!defs || defs.length === 0) return {};
	const resolved: Record<string, string | number | boolean> = {};
	for (const def of defs) {
		const rawValue =
			selected && Object.hasOwn(selected, def.name) ? selected[def.name] : (def.default ?? null);
		if (rawValue === undefined || rawValue === null) continue;
		if (!isAllowedParamValue(def, rawValue)) continue;
		resolved[def.name] = rawValue;
	}
	return resolved;
}

export function sanitizeExtraParamSelections(
	defs: readonly ModelExtraParam[] | undefined,
	selected: ModelExtraParamValues | undefined,
): ModelExtraParamValues {
	if (!defs || defs.length === 0 || !selected) return {};
	const result: ModelExtraParamValues = {};
	for (const def of defs) {
		if (!Object.hasOwn(selected, def.name)) continue;
		const value = selected[def.name];
		if (value === undefined) continue;
		if (isAllowedParamValue(def, value)) result[def.name] = value;
	}
	return result;
}

function applyPricingRule(base: number, rule: ModelExtraParamPricingRule): number {
	const value = rule.operator === "multiply" ? base * rule.value : base + rule.value;
	return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

export function effectiveCostForExtraParams(
	baseCost: Model<string>["cost"],
	defs: readonly ModelExtraParam[] | undefined,
	selected: ModelExtraParamValues | undefined,
): Model<string>["cost"] {
	if (!defs || defs.length === 0) return baseCost;
	const active = resolveActiveExtraParams(defs, selected);
	const next: Model<string>["cost"] = { ...baseCost };
	for (const def of defs) {
		const activeValue = active[def.name];
		if (activeValue === undefined) continue;
		const option = def.options?.find((candidate) => candidate.value === activeValue);
		const pricing = option?.pricing;
		if (!pricing) continue;
		const allRule = pricing.all;
		if (allRule) {
			next.input = applyPricingRule(next.input, allRule);
			next.output = applyPricingRule(next.output, allRule);
			next.cacheRead = applyPricingRule(next.cacheRead, allRule);
			next.cacheWrite = applyPricingRule(next.cacheWrite, allRule);
		}
		if (pricing.input) next.input = applyPricingRule(next.input, pricing.input);
		if (pricing.output) next.output = applyPricingRule(next.output, pricing.output);
		const cacheReadRule = pricing.cacheRead ?? pricing.cache_read;
		if (cacheReadRule) next.cacheRead = applyPricingRule(next.cacheRead, cacheReadRule);
		const cacheWriteRule = pricing.cacheWrite ?? pricing.cache_write;
		if (cacheWriteRule) next.cacheWrite = applyPricingRule(next.cacheWrite, cacheWriteRule);
	}
	return next;
}

export function withExtraParams(
	model: Model<string>,
	defs: readonly ModelExtraParam[] | undefined,
	selected: ModelExtraParamValues | undefined,
): Model<string> {
	if (!defs || defs.length === 0) return model;
	const active = resolveActiveExtraParams(defs, selected);
	const cost = effectiveCostForExtraParams(model.cost, defs, selected);
	const activeKeys = Object.keys(active);
	if (activeKeys.length === 0) {
		return { ...model, cost };
	}
	return {
		...model,
		cost,
		samplingParams: {
			...(model.samplingParams ?? {}),
			...active,
		},
	};
}

const EFFORT_SUFFIX_RE = /\s+\((?:minimal|low|medium|high|xhigh|max)\)$/;

export function parseOpenAiModelsListPayload(payload: unknown): ProviderModelDefinition[] | null {
	if (!isRecord(payload) || !Array.isArray(payload.data)) return null;
	const rawIds = new Set(
		payload.data
			.filter(
				(entry): entry is Record<string, unknown> =>
					isRecord(entry) && typeof entry.id === "string",
			)
			.map((entry) => entry.id as string),
	);
	const seen = new Set<string>();
	const result: ProviderModelDefinition[] = [];
	for (const entry of payload.data) {
		if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.trim() === "") continue;
		const id = entry.id.trim();
		const baseCandidate = id.replace(EFFORT_SUFFIX_RE, "");
		if (baseCandidate !== id && rawIds.has(baseCandidate)) continue;
		if (seen.has(id)) continue;
		seen.add(id);
		const name =
			typeof entry.display_name === "string" && entry.display_name.trim()
				? entry.display_name.trim()
				: typeof entry.name === "string" && entry.name.trim()
					? entry.name.trim()
					: id;
		const reasoning =
			entry.supports_reasoning_effort === true ||
			(Array.isArray(entry.reasoning_effort_options) &&
				entry.reasoning_effort_options.length > 0) ||
			entry.reasoning === true;
		const input: Array<"text" | "image"> =
			entry.is_multimodal === true ? ["text", "image"] : ["text"];
		const inputCost =
			typeof entry.input_price_per_mtok === "number" && Number.isFinite(entry.input_price_per_mtok)
				? entry.input_price_per_mtok
				: 0;
		const outputCost =
			typeof entry.output_price_per_mtok === "number" &&
			Number.isFinite(entry.output_price_per_mtok)
				? entry.output_price_per_mtok
				: 0;
		const cacheCost =
			typeof entry.input_cache_price_per_mtok === "number" &&
			Number.isFinite(entry.input_cache_price_per_mtok)
				? entry.input_cache_price_per_mtok
				: 0;
		const extraParams = normalizeModelExtraParams(entry.extra_params ?? entry.extraParams);
		result.push({
			id,
			name,
			reasoning,
			input,
			contextWindow: 1_000_000,
			maxTokens: 131_072,
			cost: {
				input: inputCost,
				output: outputCost,
				cacheRead: cacheCost,
				cacheWrite: 0,
			},
			...(extraParams ? { extra_params: extraParams } : {}),
		});
	}
	return result;
}
