import { complete, type Message, type Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadEnabledModelPatterns, modelMatchesEnabledPatterns } from "../summary-model-scope.js";
import type { QueryResultData } from "../storage.js";
import {
	buildSummaryPrompt,
	buildDeterministicSummary,
	type SummaryMeta,
} from "./summary-prompt.js";

// Re-export the pure prompt-building helpers + types so existing callers
// (index.ts) keep importing from "./curator/summary-review.js" unchanged.
// The pure logic lives in summary-prompt.ts (no host imports) so it is
// unit-testable under tsx; this module owns only the host-dependent
// `complete()` dispatch and model resolution.
export { buildSummaryPrompt, buildDeterministicSummary } from "./summary-prompt.js";
export type { SummaryMeta } from "./summary-prompt.js";

const PREFERRED_SUMMARY_MODELS = [
	{ provider: "anthropic", id: "claude-haiku-4-5" },
	{ provider: "openai-codex", id: "gpt-5.3-codex-spark" },
] as const;

export type SummaryGenerationContext = Pick<ExtensionContext, "model" | "modelRegistry" | "cwd" | "isProjectTrusted">;

function estimateTokens(text: string): number {
	const trimmed = text.trim();
	if (trimmed.length === 0) return 0;
	return Math.max(1, Math.ceil(trimmed.length / 4));
}

function parseModelSelector(value: string): { provider: string; id: string } {
	const slashIndex = value.indexOf("/");
	if (slashIndex <= 0 || slashIndex >= value.length - 1) {
		throw new Error(`Invalid summary model: ${value}. Use provider/model-id.`);
	}
	return {
		provider: value.slice(0, slashIndex),
		id: value.slice(slashIndex + 1),
	};
}

async function resolveSummaryModelCandidates(
	ctx: SummaryGenerationContext,
	modelOverride?: string,
): Promise<{ candidates: Array<{ model: Model; apiKey: string; headers?: Record<string, string> }>; errors: string[] }> {
	const enabledModelPatterns = loadEnabledModelPatterns(ctx);
	const specs: Array<{ provider: string; id: string }> = [];
	const normalizedOverride = typeof modelOverride === "string" ? modelOverride.trim() : "";
	if (normalizedOverride.length > 0) specs.push(parseModelSelector(normalizedOverride));
	specs.push(...PREFERRED_SUMMARY_MODELS);

	const candidates: Array<{ model: Model; apiKey: string; headers?: Record<string, string> }> = [];
	const errors: string[] = [];
	const seen = new Set<string>();
	for (const spec of specs) {
		const value = `${spec.provider}/${spec.id}`;
		if (seen.has(value)) continue;
		seen.add(value);

		const model = ctx.modelRegistry.find(spec.provider, spec.id);
		if (!model) {
			errors.push(`Summary model not found: ${value}`);
			continue;
		}
		if (!modelMatchesEnabledPatterns(model, enabledModelPatterns)) {
			errors.push(`Summary model is not enabled: ${value}`);
			continue;
		}
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			errors.push(`No API key available for summary model ${value}`);
			continue;
		}
		candidates.push({ model, apiKey: auth.apiKey, headers: auth.headers });
	}
	return { candidates, errors };
}

function buildFallbackSummary(results: QueryResultData[], fallbackReason: string): { summary: string; meta: SummaryMeta } {
	const deterministic = buildDeterministicSummary(results);
	return {
		summary: deterministic.summary,
		meta: {
			...deterministic.meta,
			fallbackReason,
		},
	};
}

function isAbortError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const name = (err as { name?: unknown }).name;
	const message = (err as { message?: unknown }).message;
	return name === "AbortError" || (typeof message === "string" && message.toLowerCase().includes("abort"));
}

function getTextFromContentPart(part: unknown): string {
	if (!part || typeof part !== "object") return "";
	const value = part as Record<string, unknown>;
	if (typeof value.text === "string") return value.text;
	if (typeof value.refusal === "string") return value.refusal;
	return "";
}

function getContentPartType(part: unknown): string {
	if (!part || typeof part !== "object") return "unknown";
	const value = part as Record<string, unknown>;
	return typeof value.type === "string" ? value.type : "unknown";
}

export async function generateSummaryDraft(
	results: QueryResultData[],
	ctx: SummaryGenerationContext,
	signal?: AbortSignal,
	modelOverride?: string,
	feedback?: string,
): Promise<{ summary: string; meta: SummaryMeta }> {
	if (!ctx || !ctx.modelRegistry) {
		throw new Error("Summary generation context unavailable");
	}

	const prompt = buildSummaryPrompt(results, feedback);
	let resolved: Awaited<ReturnType<typeof resolveSummaryModelCandidates>>;
	try {
		resolved = await resolveSummaryModelCandidates(ctx, modelOverride);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return buildFallbackSummary(results, `summary-model-settings-error: ${message}`);
	}

	let lastError = resolved.errors.at(-1);
	for (const { model, apiKey, headers } of resolved.candidates) {
		const startedAt = Date.now();
		try {
			const userMessage: Message = {
				role: "user",
				content: [{ type: "text", text: prompt }],
				timestamp: Date.now(),
			};

			const response = await complete(model, { messages: [userMessage] }, { apiKey, headers, signal });
			if (response.stopReason === "aborted") {
				throw new Error("Aborted");
			}

			const contentParts = Array.isArray(response.content) ? response.content : [];
			const summary = contentParts
				.map(part => getTextFromContentPart(part))
				.filter(text => text.trim().length > 0)
				.join("\n")
				.trim();

			if (summary.length === 0) {
				const partTypes = contentParts.map(part => getContentPartType(part));
				const typesLabel = partTypes.length > 0 ? partTypes.join(", ") : "none";
				throw new Error(`Summary model returned empty response (content parts: ${typesLabel})`);
			}

			return {
				summary,
				meta: {
					model: `${model.provider}/${model.id}`,
					durationMs: Math.max(0, Date.now() - startedAt),
					tokenEstimate: estimateTokens(summary),
					fallbackUsed: false,
					edited: false,
				},
			};
		} catch (err) {
			if (isAbortError(err)) throw err;
			lastError = err instanceof Error ? err.message : String(err);
		}
	}

	return buildFallbackSummary(results, lastError ? `summary-model-unavailable: ${lastError}` : "summary-model-unavailable");
}
