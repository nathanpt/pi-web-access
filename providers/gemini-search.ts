import { getWebSearchConfigPath } from "../utils.js";
import { loadWebSearchConfig } from "../config.js";
import { activityMonitor } from "../activity.js";
import { getApiKey, getVersionedApiBase, buildKeyParam, buildAuthHeaders, isGatewayConfigured, isGeminiApiAvailable, DEFAULT_MODEL } from "./gemini-api.js";
import { isGeminiWebAvailable, queryWithCookies } from "./gemini-web.js";
import { isPerplexityAvailable, searchWithPerplexity, type SearchResult, type SearchResponse, type SearchOptions } from "./perplexity.js";
import { hasExaApiKey, isExaAvailable, searchWithExa } from "./exa.js";
import { isParallelAvailable, searchWithParallel } from "./parallel.js";

export type SearchProvider = "auto" | "priority" | "perplexity" | "gemini" | "exa" | "parallel";
export type ResolvedSearchProvider = Exclude<SearchProvider, "auto" | "priority">;

/**
 * Built-in order used by `provider: "auto"` and as the fallback when
 * `provider: "priority"` is selected but no `providerPriority` list is
 * configured. `parallel` is intentionally NOT here (opt-in only; see
 * ROADMAP item #2).
 */
const DEFAULT_AUTO_ORDER: ResolvedSearchProvider[] = ["exa", "perplexity", "gemini"];

const ALL_PROVIDERS: ReadonlySet<ResolvedSearchProvider> = new Set(["exa", "perplexity", "gemini", "parallel"]);

const PROVIDER_LABELS: Record<ResolvedSearchProvider, string> = {
	exa: "Exa",
	perplexity: "Perplexity",
	gemini: "Gemini",
	parallel: "Parallel",
};

export interface AttributedSearchResponse extends SearchResponse {
	provider: ResolvedSearchProvider;
}

const CONFIG_PATH = getWebSearchConfigPath();

export interface SearchConfig {
	searchProvider: SearchProvider;
	searchModel?: string;
	providerPriority?: ResolvedSearchProvider[];
}

/**
 * Validate a user-supplied provider-priority list. Drops unknown names,
 * meta-values (`auto`/`priority`), duplicates, and non-strings; preserves
 * order. Returns `null` for a missing/empty/invalid list so callers can fall
 * back to `DEFAULT_AUTO_ORDER`. Exported for testing.
 */
export function normalizeProviderPriority(value: unknown): ResolvedSearchProvider[] | null {
	if (!Array.isArray(value)) return null;
	const out: ResolvedSearchProvider[] = [];
	const seen = new Set<ResolvedSearchProvider>();
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const normalized = entry.trim().toLowerCase();
		if (normalized === "auto" || normalized === "priority") continue;
		if (!ALL_PROVIDERS.has(normalized as ResolvedSearchProvider)) continue;
		const p = normalized as ResolvedSearchProvider;
		if (seen.has(p)) continue;
		seen.add(p);
		out.push(p);
	}
	return out.length > 0 ? out : null;
}

function getSearchConfig(): SearchConfig {
	const raw = loadWebSearchConfig();
	return {
		searchProvider: normalizeSearchProvider(raw.searchProvider ?? raw.provider),
		searchModel: normalizeSearchModel(raw.searchModel),
		providerPriority: normalizeProviderPriority(raw.providerPriority),
	};
}

function normalizeSearchModel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeSearchProvider(value: unknown): SearchProvider {
	const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
	return normalized === "auto" || normalized === "priority" || normalized === "perplexity" || normalized === "gemini" || normalized === "exa" || normalized === "parallel"
		? normalized
		: "auto";
}

export interface FullSearchOptions extends SearchOptions {
	provider?: SearchProvider;
	includeContent?: boolean;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

async function searchWithGemini(
	query: string,
	options: SearchOptions,
	strictErrors: boolean,
): Promise<SearchResponse | null> {
	const errors: string[] = [];

	try {
		const apiResult = await searchWithGeminiApi(query, options);
		if (apiResult) return apiResult;
	} catch (err) {
		if (isAbortError(err)) throw err;
		errors.push(`Gemini API: ${errorMessage(err)}`);
	}

	try {
		const webResult = await searchWithGeminiWeb(query, options);
		if (webResult) return webResult;
	} catch (err) {
		if (isAbortError(err)) throw err;
		errors.push(`Gemini Web: ${errorMessage(err)}`);
	}

	if (strictErrors && errors.length > 0) {
		throw new Error(`Gemini search failed:\n  - ${errors.join("\n  - ")}`);
	}

	return null;
}

export async function search(query: string, options: FullSearchOptions = {}): Promise<AttributedSearchResponse> {
	const config = getSearchConfig();
	const provider = options.provider ?? config.searchProvider;

	if (provider === "perplexity") {
		const result = await searchWithPerplexity(query, options);
		return { ...result, provider: "perplexity" };
	}

	if (provider === "gemini") {
		const result = await searchWithGemini(query, options, true);
		if (result) return { ...result, provider: "gemini" };
		throw new Error(
			"Gemini search unavailable. Either:\n" +
			`  1. Set GEMINI_API_KEY in ${CONFIG_PATH}\n` +
			"  2. Set GOOGLE_GEMINI_BASE_URL + CLOUDFLARE_API_KEY for Cloudflare AI Gateway routing\n" +
			"  3. Sign into gemini.google.com in a supported Chromium-based browser"
		);
	}

	if (provider === "parallel") {
		const result = await searchWithParallel(query, options);
		return { ...result, provider: "parallel" };
	}

	if (provider === "exa") {
		const exaApiKeyConfigured = hasExaApiKey();
		try {
			const result = await searchWithExa(query, options);
			if (result && "exhausted" in result) {
				throw new Error(
					"Exa monthly free tier exhausted (1,000 requests). Resets next month.\n" +
					"  Use provider: 'perplexity' or 'gemini', or upgrade at exa.ai/pricing"
				);
			}
			if (result && "answer" in result) return { ...result, provider: "exa" };
			if (exaApiKeyConfigured) {
				throw new Error("Exa search returned no results.");
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (message.toLowerCase().includes("abort")) throw err;
			if (exaApiKeyConfigured) throw err;
			// No API key: allow provider fallback.
		}
	}

	// Shared fallback loop for `auto`, `priority`, and the fall-through from
	// an explicit `exa` selection that had no API key (don't retry exa there).
	const order = resolveFallbackOrder(provider, config);
	const fallbackErrors: string[] = [];

	for (const candidate of order) {
		if (!(await isCandidateAvailable(candidate))) continue;
		try {
			const result = await runFallbackProvider(candidate, query, options);
			if (result) return { ...result, provider: candidate };
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`${PROVIDER_LABELS[candidate]}: ${errorMessage(err)}`);
		}
	}

	if (fallbackErrors.length > 0) {
		throw new Error(`Auto provider search failed:\n  - ${fallbackErrors.join("\n  - ")}`);
	}

	throw new Error(
		"No search provider available. Either:\n" +
		`  1. Set perplexityApiKey in ${CONFIG_PATH}\n` +
		`  2. Set EXA_API_KEY (or exaApiKey) in ${CONFIG_PATH}\n` +
		`  3. Set GEMINI_API_KEY in ${CONFIG_PATH}\n` +
		"  4. Set GOOGLE_GEMINI_BASE_URL + CLOUDFLARE_API_KEY for Cloudflare AI Gateway routing\n" +
		"  5. Sign into gemini.google.com in a supported Chromium-based browser"
	);
}

/**
 * Resolve the ordered provider list for the shared fallback loop. `auto` uses
 * the built-in order; `priority` uses the configured `providerPriority`
 * (falling back to the built-in order if unset/invalid); an explicit `exa`
 * that fell through (no key) retries the remaining built-in providers only.
 */
function resolveFallbackOrder(provider: SearchProvider, config: SearchConfig): ResolvedSearchProvider[] {
	if (provider === "priority") {
		return config.providerPriority ?? DEFAULT_AUTO_ORDER;
	}
	if (provider === "exa") {
		return DEFAULT_AUTO_ORDER.filter(p => p !== "exa");
	}
	return DEFAULT_AUTO_ORDER;
}

async function isCandidateAvailable(p: ResolvedSearchProvider): Promise<boolean> {
	switch (p) {
		case "exa":
			return isExaAvailable();
		case "perplexity":
			return isPerplexityAvailable();
		case "gemini":
			return isGeminiApiAvailable() || !!(await isGeminiWebAvailable());
		case "parallel":
			return isParallelAvailable();
	}
}

/** Execute a single provider in fallback mode. Returns null when the provider
 * produced no usable result; throws on error. Mirrors the prior inline blocks. */
async function runFallbackProvider(
	p: ResolvedSearchProvider,
	query: string,
	options: SearchOptions,
): Promise<SearchResponse | null> {
	switch (p) {
		case "exa": {
			const result = await searchWithExa(query, options);
			return result && "answer" in result ? result : null;
		}
		case "perplexity":
			return await searchWithPerplexity(query, options);
		case "gemini":
			return await searchWithGemini(query, options, false);
		case "parallel":
			return await searchWithParallel(query, options);
	}
}

async function searchWithGeminiApi(query: string, options: SearchOptions = {}): Promise<SearchResponse | null> {
	const apiKey = getApiKey();
	if (!apiKey && !isGatewayConfigured()) return null;

	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		const model = getSearchConfig().searchModel ?? DEFAULT_MODEL;
		const body = {
			contents: [{ role: "user", parts: [{ text: query }] }],
			tools: [{ google_search: {} }],
		};

		const res = await fetch(`${getVersionedApiBase()}/models/${model}:generateContent${buildKeyParam(apiKey)}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...buildAuthHeaders() },
			body: JSON.stringify(body),
			signal: AbortSignal.any([
				AbortSignal.timeout(60000),
				...(options.signal ? [options.signal] : []),
			]),
		});

		if (!res.ok) {
			const errorText = await res.text();
			throw new Error(`Gemini API error ${res.status}: ${errorText.slice(0, 300)}`);
		}

		const data = await res.json() as GeminiSearchResponse;
		activityMonitor.logComplete(activityId, res.status);

		const answer = data.candidates?.[0]?.content?.parts
			?.map(p => p.text).filter(Boolean).join("\n") ?? "";

		const metadata = data.candidates?.[0]?.groundingMetadata;
		const results = await resolveGroundingChunks(metadata?.groundingChunks, options.signal);

		if (!answer && results.length === 0) return null;
		return { answer, results };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}
}

async function searchWithGeminiWeb(query: string, options: SearchOptions = {}): Promise<SearchResponse | null> {
	const cookies = await isGeminiWebAvailable();
	if (!cookies) return null;

	const prompt = buildSearchPrompt(query, options);
	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		const text = await queryWithCookies(prompt, cookies, {
			model: "gemini-3-flash-preview",
			signal: options.signal,
			timeoutMs: 60000,
		});

		activityMonitor.logComplete(activityId, 200);

		const results = extractSourceUrls(text);
		return { answer: text, results };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}
}

function buildSearchPrompt(query: string, options: SearchOptions): string {
	let prompt = `Search the web and answer the following question. Include source URLs for your claims.\nFormat your response as:\n1. A direct answer to the question\n2. Cited sources as markdown links\n\nQuestion: ${query}`;

	if (options.recencyFilter) {
		const labels: Record<string, string> = {
			day: "past 24 hours",
			week: "past week",
			month: "past month",
			year: "past year",
		};
		prompt += `\n\nOnly include results from the ${labels[options.recencyFilter]}.`;
	}

	if (options.domainFilter?.length) {
		const includes = options.domainFilter.filter(d => !d.startsWith("-"));
		const excludes = options.domainFilter.filter(d => d.startsWith("-")).map(d => d.slice(1));
		if (includes.length) prompt += `\n\nOnly cite sources from: ${includes.join(", ")}`;
		if (excludes.length) prompt += `\n\nDo not cite sources from: ${excludes.join(", ")}`;
	}

	return prompt;
}

function extractSourceUrls(markdown: string): SearchResult[] {
	const results: SearchResult[] = [];
	const seen = new Set<string>();
	const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
	for (const match of markdown.matchAll(linkRegex)) {
		const url = match[2];
		if (seen.has(url)) continue;
		seen.add(url);
		results.push({ title: match[1], url, snippet: "" });
	}
	return results;
}

async function resolveGroundingChunks(
	chunks: GroundingChunk[] | undefined,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	if (!chunks?.length) return [];

	const results: SearchResult[] = [];
	for (const chunk of chunks) {
		if (!chunk.web) continue;
		const title = chunk.web.title || "";
		let url = chunk.web.uri || "";

		if (url.includes("vertexaisearch.cloud.google.com/grounding-api-redirect")) {
			const resolved = await resolveRedirect(url, signal);
			if (resolved) url = resolved;
		}

		if (url) results.push({ title, url, snippet: "" });
	}
	return results;
}

async function resolveRedirect(proxyUrl: string, signal?: AbortSignal): Promise<string | null> {
	try {
		const res = await fetch(proxyUrl, {
			method: "HEAD",
			redirect: "manual",
			signal: AbortSignal.any([
				AbortSignal.timeout(5000),
				...(signal ? [signal] : []),
			]),
		});
		return res.headers.get("location") || null;
	} catch {
		return null;
	}
}

interface GeminiSearchResponse {
	candidates?: Array<{
		content?: { parts?: Array<{ text?: string }> };
		groundingMetadata?: {
			webSearchQueries?: string[];
			groundingChunks?: GroundingChunk[];
			groundingSupports?: Array<{
				segment?: { startIndex?: number; endIndex?: number; text?: string };
				groundingChunkIndices?: number[];
			}>;
		};
	}>;
}

interface GroundingChunk {
	web?: { uri?: string; title?: string };
}
