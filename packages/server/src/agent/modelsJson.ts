import {
	accessSync,
	constants,
	mkdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	type Stats,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	isModelContextWindow,
	isProviderModelDefinitions,
	isSharedModelContextTarget,
	MODEL_CONTEXT_WINDOW_LIMITS,
	type ModelContextSetting,
	type ModelContextTarget,
	type ProviderModelDefinition,
} from "@thinkrail/contracts";
import {
	applyEdits,
	findNodeAtLocation,
	modify,
	type Node,
	type ParseError,
	parseTree,
} from "jsonc-parser";
import { usePiRuntime } from "./agentSessionManager";
import type { PiRuntimeGeneration } from "./piRuntime";
import { type AvailableModelsRuntime, settledAvailableModels } from "./piRuntime";

const OPENAI_RESPONSES_APIS = new Set(["openai-responses", "openai-codex-responses"]);
const PARSE = { allowTrailingComma: true };
const FORMATTING = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } };
const EMPTY_CONFIG = '{\n  "providers": {}\n}\n';
const SAVE_FAILURE =
	"Couldn't save pi's models.json. Check the file and its permissions, then retry.";
const MODEL_FIELDS = [
	"id",
	"name",
	"reasoning",
	"input",
	"contextWindow",
	"maxTokens",
	"cost",
] as const;

let publishModelsJsonChange: (() => void) | null = null;

export function setModelsJsonPublisher(publisher: (() => void) | null): void {
	publishModelsJsonChange = publisher;
}

function modelsPath(): string {
	return join(getAgentDir(), "models.json");
}

function readSource(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw new Error("Couldn't read pi's models.json. Fix the file and retry.");
	}
}

function parseConfig(source: string | undefined): Node | undefined {
	if (source === undefined) return undefined;
	const errors: ParseError[] = [];
	const root = parseTree(source.replace(/^\uFEFF/, ""), errors, PARSE);
	if (errors.length > 0)
		throw new Error("Pi's models.json isn't valid JSON. Fix the file and retry.");
	return root;
}

function overridePath(model: Pick<ModelContextSetting, "provider" | "id">): string[] {
	return ["providers", model.provider, "modelOverrides", model.id, "contextWindow"];
}

function providerModelsPath(providerId: string): string[] {
	return ["providers", providerId, "models"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectModelDefinition(value: unknown): ProviderModelDefinition | null {
	if (!isRecord(value) || typeof value.id !== "string") return null;
	const projected: Record<string, unknown> = { id: value.id };
	for (const key of MODEL_FIELDS.slice(1)) {
		if (Object.hasOwn(value, key)) projected[key] = value[key];
	}
	const definitions: unknown = [projected];
	return isProviderModelDefinitions(definitions) ? (definitions[0] ?? null) : null;
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

function assertEditableProvider(
	runtime: PiRuntimeGeneration["runtime"],
	opaqueProviderIds: ReadonlySet<string>,
	providerId: string,
): void {
	if (
		typeof providerId !== "string" ||
		providerId.length === 0 ||
		providerId.length > 256 ||
		providerId.includes("\0")
	) {
		throw new Error("Provider models are unavailable");
	}
	const auth = runtime.getProviderAuthStatus(providerId);
	if (
		opaqueProviderIds.has(providerId) ||
		(auth.source !== "models_json_key" && auth.source !== "models_json_command")
	)
		throw new Error("Provider models are not editable from models.json");
}

function providerModelDefinitions(
	config: Node | undefined,
	providerId: string,
): { definitions: ProviderModelDefinition[]; stored: unknown[] } {
	const node = config && findNodeAtLocation(config, providerModelsPath(providerId));
	if (!node) return { definitions: [], stored: [] };
	const value = valueFromNode(node);
	if (node.type !== "array" || !Array.isArray(value))
		throw new Error("Provider model definitions are invalid");
	const stored = value;
	const definitions = stored.map(projectModelDefinition);
	if (definitions.some((definition) => definition === null)) {
		throw new Error("Provider model definitions are invalid");
	}
	const result = definitions as ProviderModelDefinition[];
	if (!isProviderModelDefinitions(result))
		throw new Error("Provider model definitions are invalid");
	return { definitions: result, stored };
}

function mergeModelDefinitions(
	stored: unknown[],
	definitions: ProviderModelDefinition[],
): Record<string, unknown>[] {
	const previousById = new Map(
		stored.flatMap((entry) =>
			isRecord(entry) && typeof entry.id === "string" ? [[entry.id, entry] as const] : [],
		),
	);
	return definitions.map((definition) => {
		const merged = { ...(previousById.get(definition.id) ?? {}) };
		for (const key of MODEL_FIELDS) {
			if (Object.hasOwn(definition, key)) merged[key] = definition[key];
			else delete merged[key];
		}
		return merged;
	});
}

function listSettings(
	runtime: AvailableModelsRuntime,
	config: Node | undefined,
): ModelContextSetting[] {
	return settledAvailableModels(runtime).flatMap((model) => {
		if (!OPENAI_RESPONSES_APIS.has(model.api)) return [];
		const node = config && findNodeAtLocation(config, overridePath(model));
		const override: number | null = node?.type === "number" ? node.value : null;
		if (override === null && model.contextWindow !== MODEL_CONTEXT_WINDOW_LIMITS.min) return [];
		return [
			{
				provider: model.provider,
				id: model.id,
				name: model.name,
				contextWindow: model.contextWindow,
				override,
			},
		];
	});
}

function patch(source: string, path: string[], contextWindow: number | null): string {
	if (contextWindow !== null)
		return applyEdits(source, modify(source, path, contextWindow, FORMATTING));
	let current = path;
	while (current.length > 1) {
		source = applyEdits(source, modify(source, current, undefined, FORMATTING));
		const parent = current.slice(0, -1);
		const root = parseTree(source, [], PARSE);
		const node = root && findNodeAtLocation(root, parent);
		if (node?.type !== "object" || node.children?.length) break;
		current = parent;
	}
	return source;
}

function resolveModelsFile(path: string): string {
	try {
		return realpathSync(path);
	} catch {}
	const seen = new Set<string>();
	let current = path;
	while (!seen.has(current)) {
		seen.add(current);
		try {
			current = resolve(dirname(current), readlinkSync(current));
		} catch {
			return current;
		}
	}
	throw new Error(SAVE_FAILURE);
}

function writeModelsFile(path: string, source: string): void {
	const target = resolveModelsFile(path);
	let existing: Stats | undefined;
	try {
		existing = statSync(target);
	} catch {
		mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
	}
	const temp = join(dirname(target), `.models.json.${process.pid}.tmp`);
	try {
		if (existing) accessSync(target, constants.W_OK);
		writeFileSync(temp, source, { mode: existing ? existing.mode & 0o777 : 0o600 });
		renameSync(temp, target);
	} catch {
		rmSync(temp, { force: true });
		throw new Error(SAVE_FAILURE);
	}
}

export function openModelsJson(): string {
	const path = modelsPath();
	try {
		accessSync(path, constants.F_OK);
	} catch {
		writeModelsFile(path, EMPTY_CONFIG);
	}
	const command =
		process.platform === "darwin"
			? ["open", path]
			: process.platform === "win32"
				? ["notepad", path]
				: ["xdg-open", path];
	try {
		Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	} catch {}
	return path;
}

export function listModelContextSettings(): Promise<ModelContextSetting[]> {
	return usePiRuntime(async (runtime) => {
		await runtime.refresh({ allowNetwork: false });
		return listSettings(runtime, parseConfig(readSource(modelsPath())));
	});
}

let saving: Promise<unknown> = Promise.resolve();

export function setModelContextWindow(
	target: ModelContextTarget,
	contextWindow: number | null,
): Promise<ModelContextSetting[]> {
	if (contextWindow !== null && !isModelContextWindow(contextWindow)) {
		return Promise.reject(
			new Error(
				`Context window must be a whole number between ${MODEL_CONTEXT_WINDOW_LIMITS.min.toLocaleString("en-US")} and ${MODEL_CONTEXT_WINDOW_LIMITS.max.toLocaleString("en-US")} tokens`,
			),
		);
	}
	return serializeSave(() => save(target, contextWindow));
}

export function listProviderModelDefinitions(
	providerId: string,
): Promise<ProviderModelDefinition[]> {
	return usePiRuntime(async (runtime, generation) => {
		await runtime.refresh({ allowNetwork: false });
		assertEditableProvider(runtime, generation.opaqueProviderIds, providerId);
		return providerModelDefinitions(parseConfig(readSource(modelsPath())), providerId).definitions;
	});
}

export function saveProviderModelDefinitions(
	providerId: string,
	definitions: ProviderModelDefinition[],
): Promise<ProviderModelDefinition[]> {
	if (!isProviderModelDefinitions(definitions)) {
		return Promise.reject(new Error("Provider model definitions are invalid"));
	}
	return serializeSave(() => saveProviderModelDefinitionsToFile(providerId, definitions));
}

function serializeSave<T>(operation: () => Promise<T>): Promise<T> {
	const run = saving.catch(() => undefined).then(operation);
	saving = run;
	return run;
}

function saveProviderModelDefinitionsToFile(
	providerId: string,
	definitions: ProviderModelDefinition[],
): Promise<ProviderModelDefinition[]> {
	return usePiRuntime(async (runtime, generation) => {
		await runtime.refresh({ allowNetwork: false });
		assertEditableProvider(runtime, generation.opaqueProviderIds, providerId);
		const path = modelsPath();
		const source = readSource(path);
		if (source === undefined) throw new Error("Provider models are not editable from models.json");
		const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
		const content = source.slice(bom.length);
		const config = parseConfig(source);
		const { stored } = providerModelDefinitions(config, providerId);
		const merged = mergeModelDefinitions(stored, definitions);
		const next = applyEdits(
			content,
			modify(content, providerModelsPath(providerId), merged, FORMATTING),
		);
		if (bom + next !== source) {
			writeModelsFile(path, bom + next);
			await runtime.refresh({ allowNetwork: false });
			publishModelsJsonChange?.();
		}
		return definitions;
	});
}

function save(
	target: ModelContextTarget,
	contextWindow: number | null,
): Promise<ModelContextSetting[]> {
	return usePiRuntime(async (runtime) => {
		await runtime.refresh({ allowNetwork: false });
		const path = modelsPath();
		const source = readSource(path);
		const settings = listSettings(runtime, parseConfig(source));
		const targets =
			target === "available"
				? settings.filter(isSharedModelContextTarget)
				: settings.filter((model) => model.provider === target.provider && model.id === target.id);
		if (targets.length === 0) throw new Error("Unknown, unavailable or ineligible context target");
		const bom = source?.startsWith("\uFEFF") ? "\uFEFF" : "";
		let next = source === undefined ? EMPTY_CONFIG : source.slice(bom.length);
		for (const model of targets) next = patch(next, overridePath(model), contextWindow);
		if (bom + next !== source) {
			writeModelsFile(path, bom + next);
			await runtime.refresh({ allowNetwork: false });
			publishModelsJsonChange?.();
		}
		return listSettings(runtime, parseConfig(bom + next));
	});
}
