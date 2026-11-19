import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelExtraParam } from "@thinkrail/contracts";
import {
	effectiveCostForExtraParams,
	getModelExtraParams,
	parseOpenAiModelsListPayload,
	sanitizeExtraParamSelections,
	withExtraParams,
} from "./extraParams";

let directory: string;
let priorAgentDir: string | undefined;

beforeEach(() => {
	priorAgentDir = process.env.PI_CODING_AGENT_DIR;
	directory = mkdtempSync(join(tmpdir(), "thinkrail-extra-params-"));
	process.env.PI_CODING_AGENT_DIR = directory;
});

afterEach(() => {
	if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
	rmSync(directory, { recursive: true, force: true });
});

const serviceTierParam: ModelExtraParam = {
	name: "service_tier",
	type: "list[string]",
	values: ["priority", "flex"],
	default: null,
	options: [
		{
			label: "priority",
			value: "priority",
			pricing: { all: { value: 1.5, operator: "multiply" } },
		},
		{
			label: "flex",
			value: "flex",
			pricing: { all: { value: 0.8, operator: "multiply" } },
		},
	],
};

const sampleModel: Model<string> = {
	id: "deepinfra/XiaomiMiMo/MiMo-V2.6-Flash",
	name: "XiaomiMiMo/MiMo-Flash",
	api: "openai-completions",
	provider: "herandro",
	baseUrl: "https://example.invalid/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0.14, output: 0.28, cacheRead: 0.003, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 131_072,
};

test("reads dynamic extra_params from models.json", () => {
	writeFileSync(
		join(directory, "models.json"),
		JSON.stringify({
			providers: {
				herandro: {
					api: "openai-completions",
					baseUrl: "https://example.invalid/v1",
					apiKey: "fixture-key",
					models: [
						{
							id: sampleModel.id,
							name: sampleModel.name,
							extra_params: [serviceTierParam],
						},
					],
				},
			},
		}),
	);
	expect(getModelExtraParams("herandro", sampleModel.id)).toEqual([serviceTierParam]);
	expect(getModelExtraParams("herandro", "unknown")).toBeUndefined();
});

test("withExtraParams merges active values into samplingParams and scales pricing dynamically", () => {
	const priority = withExtraParams(sampleModel, [serviceTierParam], { service_tier: "priority" });
	expect(priority.samplingParams).toEqual({ service_tier: "priority" });
	expect(priority.cost).toEqual({
		input: 0.21,
		output: 0.42,
		cacheRead: 0.0045,
		cacheWrite: 0,
	});

	const flex = withExtraParams(sampleModel, [serviceTierParam], { service_tier: "flex" });
	expect(flex.samplingParams).toEqual({ service_tier: "flex" });
	expect(flex.cost).toEqual({
		input: 0.112,
		output: 0.224,
		cacheRead: 0.0024,
		cacheWrite: 0,
	});

	const unset = withExtraParams(sampleModel, [serviceTierParam], { service_tier: null });
	expect(unset.samplingParams).toBeUndefined();
	expect(unset.cost).toEqual(sampleModel.cost);
});

test("supports arbitrary dynamic extra_params and add pricing operator", () => {
	const customParams: ModelExtraParam[] = [
		{
			name: "fast_mode",
			type: "boolean",
			default: true,
			options: [
				{
					label: "enabled",
					value: true,
					pricing: { output: { value: 0.2, operator: "add" } },
				},
			],
		},
		{ name: "routing_tag", type: "string", default: "low-latency" },
	];
	const effective = withExtraParams(sampleModel, customParams, undefined);
	expect(effective.samplingParams).toEqual({ fast_mode: true, routing_tag: "low-latency" });
	expect(effectiveCostForExtraParams(sampleModel.cost, customParams, undefined)).toEqual({
		input: 0.14,
		output: 0.48,
		cacheRead: 0.003,
		cacheWrite: 0,
	});
	expect(
		sanitizeExtraParamSelections(customParams, {
			fast_mode: false,
			unknown_key: "drop-me",
		}),
	).toEqual({ fast_mode: false });
});

test("parseOpenAiModelsListPayload collapses effort variants and keeps extra_params", () => {
	const parsed = parseOpenAiModelsListPayload({
		object: "list",
		data: [
			{
				id: "deepinfra/XiaomiMiMo/MiMo-V2.6-Flash",
				display_name: "XiaomiMiMo/MiMo-Flash",
				input_price_per_mtok: 0.14,
				input_cache_price_per_mtok: 0.003,
				output_price_per_mtok: 0.28,
				supports_reasoning_effort: true,
				is_multimodal: true,
				extra_params: [serviceTierParam],
			},
			{
				id: "deepinfra/XiaomiMiMo/MiMo-V2.6-Flash (high)",
				display_name: "XiaomiMiMo/MiMo-Flash (high)",
				reasoning_effort: "high",
			},
		],
	});
	expect(parsed).toEqual([
		{
			id: "deepinfra/XiaomiMiMo/MiMo-V2.6-Flash",
			name: "XiaomiMiMo/MiMo-Flash",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_000_000,
			maxTokens: 131_072,
			cost: { input: 0.14, output: 0.28, cacheRead: 0.003, cacheWrite: 0 },
			extra_params: [serviceTierParam],
		},
	]);
});
