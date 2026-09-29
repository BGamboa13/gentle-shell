import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const NAN_PROVIDER_ID = "nan";
export const NAN_PROVIDER_BASE_URL = "https://api.nan.builders/v1";
export const NAN_MODELS_TIMEOUT_MS = 3_000;

export interface NanProviderOptions {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

// Pi requires numeric rates; NaN access is quota-based, so zero avoids inventing per-token pricing.
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// Maintained chat subset from https://nan.builders/docs/models.
// Decimal bounds conservatively interpret the documented 1M/262K/131K labels.
// Pi models text/image inputs only; MiMo's documented audio input is not advertised.
// Where no output maximum is published, 8,192 is our conservative configured cap for coding with reasoning, not NaN's limit.
const CHAT_MODELS: ProviderModelConfig[] = [
	{ id: "glm5.3", name: "GLM 5.3", input: ["text"], contextWindow: 1_000_000 },
	{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", input: ["text", "image"], contextWindow: 1_000_000 },
	{ id: "glm5.3-flash", name: "GLM 5.3 Flash", input: ["text", "image"], contextWindow: 1_000_000 },
	{ id: "qwen3.8-flash", name: "Qwen 3.8 Flash", input: ["text", "image"], contextWindow: 1_048_576, maxTokens: 131_000 },
	{ id: "mimo-v2.6-flash", name: "MiMo V2.6 Flash", input: ["text", "image"], contextWindow: 1_000_000 },
	{ id: "gemma4", name: "Gemma 4", input: ["text", "image"], contextWindow: 262_000 },
	{ id: "qwen3.6", name: "Qwen 3.6", input: ["text", "image"], contextWindow: 262_000 },
].map((model) => ({
	...model,
	input: model.input as ProviderModelConfig["input"],
	api: "openai-completions",
	reasoning: true,
	cost: ZERO_COST,
	maxTokens: model.maxTokens ?? 8_192,
}));

// Offline discovery advertises only this known chat model, not the entire allowlist.
const OFFLINE_MODELS = CHAT_MODELS.filter((model) => model.id === "deepseek-v4-flash");

function cloneModel(model: ProviderModelConfig): ProviderModelConfig {
	return { ...model, input: [...model.input], cost: { ...model.cost } };
}

function knownChatModels(ids: readonly string[]): ProviderModelConfig[] {
	return ids.flatMap((id) => {
		const known = CHAT_MODELS.find((model) => model.id === id);
		return known ? [cloneModel(known)] : [];
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns undefined on an unusable response; an empty data array is authoritative. */
async function fetchLiveModelIds(options: {
	apiKey?: string;
	signal: AbortSignal;
	fetchImpl: typeof fetch;
	timeoutMs: number;
}): Promise<string[] | undefined> {
	const { apiKey, signal, fetchImpl, timeoutMs } = options;
	if (signal.aborted) return undefined;

	const controller = new AbortController();
	const abort = () => controller.abort(signal.reason);
	if (signal.aborted) abort();
	else signal.addEventListener("abort", abort, { once: true });
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
		const response = await fetchImpl(`${NAN_PROVIDER_BASE_URL}/models`, {
			method: "GET",
			headers,
			signal: controller.signal,
			redirect: "error",
			cache: "no-store",
		});
		if (!response.ok) return undefined;

		const payload: unknown = await response.json();
		if (!isRecord(payload) || !Array.isArray(payload.data)) return undefined;
		if (payload.data.length === 0) return [];

		const ids = new Set<string>();
		for (const row of payload.data) {
			if (!isRecord(row) || typeof row.id !== "string") continue;
			const id = row.id.trim();
			if (id) ids.add(id);
		}
		return ids.size > 0 ? [...ids] : undefined;
	} catch {
		// Discovery is best-effort. Never log request or response data: it may contain credentials.
		return undefined;
	} finally {
		clearTimeout(timeout);
		signal.removeEventListener("abort", abort);
	}
}

function cloneCatalog(models: readonly ProviderModelConfig[]): ProviderModelConfig[] {
	return models.map(cloneModel);
}

export function createNanProviderConfig(options: NanProviderOptions = {}): ProviderConfig {
	let catalog = cloneCatalog(OFFLINE_MODELS);
	let catalogKey: string | undefined;
	let credentialRevision = 0;
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;

	return {
		name: "NaN",
		baseUrl: NAN_PROVIDER_BASE_URL,
		api: "openai-completions",
		apiKey: "$NAN_API_KEY",
		authHeader: true,
		models: cloneCatalog(catalog),
		refreshModels: async (context: RefreshModelsContext) => {
			const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
			if (apiKey !== catalogKey) {
				// A live catalog is authoritative only for the credential that discovered it.
				catalogKey = apiKey;
				credentialRevision++;
				catalog = cloneCatalog(OFFLINE_MODELS);
			}
			const revision = credentialRevision;
			if (!context.allowNetwork || context.signal.aborted || typeof fetchImpl !== "function") {
				return cloneCatalog(catalog);
			}

			const ids = await fetchLiveModelIds({
				apiKey,
				signal: context.signal,
				fetchImpl,
				timeoutMs: options.timeoutMs ?? NAN_MODELS_TIMEOUT_MS,
			});
			if (revision !== credentialRevision || ids === undefined || context.signal.aborted) {
				return cloneCatalog(catalog);
			}

			catalog = knownChatModels(ids);
			return cloneCatalog(catalog);
		},
	};
}
