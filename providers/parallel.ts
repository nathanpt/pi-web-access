import { getWebSearchConfigPath } from "../utils.js";
import { loadWebSearchConfig, normalizeApiKey } from "../config.js";
import { activityMonitor } from "../activity.js";
import type { SearchOptions, SearchResponse, SearchResult } from "./perplexity.js";
import type { ExtractedContent } from "../extract.js";

// Parallel's OpenAI-Responses-compatible endpoint (v0.19.0 cutover from the
// legacy /v1/search). Returns a synthesized answer grounded in live web
// research + `url_citation` annotations — the same wire format OpenAI's
// Responses API uses. Auth is `Authorization: Bearer <key>`, grounding is
// automatic (no tools/web_search entry sent).
const PARALLEL_RESPONSES_URL = "https://api.parallel.ai/v1/responses";
const PARALLEL_EXTRACT_URL = "https://api.parallel.ai/v1/extract";
// Headroom for `reasoning.effort: "high"` (can reach ~60s per the docs); the
// default `low`/`medium` tiers finish well under this. The extract endpoint
// keeps its own shorter signal (`requestSignal`, 60s) below.
const SEARCH_TIMEOUT_MS = 90_000;
// Default reasoning effort for agent-facing web_search — snappy (~5–10s).
// Override via PARALLEL_REASONING_EFFORT / parallelReasoningEffort. The API
// itself defaults to `medium`; we prefer `low` for latency.
const DEFAULT_PARALLEL_EFFORT = "low";
// Reject extracts shorter than this — they're almost always junk (nav bars,
// cookie banners, error stubs) and would just pollute the fallback chain.
const MIN_USEFUL_CONTENT = 100;
const CONFIG_PATH = getWebSearchConfigPath();

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

function getApiKey(): string {
	const config = loadWebSearchConfig();
	const key = normalizeApiKey(process.env.PARALLEL_API_KEY) ?? normalizeApiKey(config.parallelApiKey);
	if (!key) {
		throw new Error(
			"Parallel API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "parallelApiKey": "your-key" }\n` +
			"  2. Set PARALLEL_API_KEY environment variable\n" +
			"Get a key at https://parallel.ai"
		);
	}
	return key;
}

/** Effective reasoning effort: env (`PARALLEL_REASONING_EFFORT`) > config
 * (`parallelReasoningEffort`) > default `low`. Any value other than `medium`/
 * `high` falls back to `low` (this extension's default tier). Mirrors the
 * `getOpenAISearchModel` precedence pattern. */
function getParallelEffort(): "low" | "medium" | "high" {
	const raw = normalizeApiKey(process.env.PARALLEL_REASONING_EFFORT)
		?? normalizeApiKey(loadWebSearchConfig().parallelReasoningEffort)
		?? DEFAULT_PARALLEL_EFFORT;
	return raw === "medium" || raw === "high" ? raw : "low";
}

export function isParallelAvailable(): boolean {
	const config = loadWebSearchConfig();
	return !!(normalizeApiKey(process.env.PARALLEL_API_KEY) ?? normalizeApiKey(config.parallelApiKey));
}

/** Abort signal for the search path — 90s headroom for `high` effort. */
function searchRequestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Abort signal for the extract path — 60s (unchanged). */
function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(60000);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function mapDomainFilter(domainFilter: string[] | undefined): { includeDomains?: string[]; excludeDomains?: string[] } {
	if (!domainFilter?.length) return {};
	const includeDomains = domainFilter
		.filter(d => !d.startsWith("-") && d.trim().length > 0)
		.map(d => d.trim());
	const excludeDomains = domainFilter
		.filter(d => d.startsWith("-"))
		.map(d => d.slice(1).trim())
		.filter(Boolean);
	return {
		...(includeDomains.length ? { includeDomains } : {}),
		...(excludeDomains.length ? { excludeDomains } : {}),
	};
}

/** Start date (YYYY-MM-DD) for a recency filter. Reused by `buildInstructions`
 * to derive the "last N days" phrasing from the offset. */
function recencyToStartDate(filter: string): string {
	const now = new Date();
	const offsets: Record<string, number> = {
		day: 1,
		week: 7,
		month: 30,
		year: 365,
	};
	const days = offsets[filter] ?? 0;
	return new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
}

/** Weave domain/recency/count hints into the Responses-API `instructions`
 * field. Parallel has no tool config (grounding is automatic), so ALL search
 * hints live here. Returns "" when no hints are present so `instructions` is
 * omitted from the request body entirely. Structure mirrors
 * `openai-search.ts`'s `buildInstructions`. */
function buildInstructions(options: SearchOptions): string {
	const hints: string[] = [];
	if (options.recencyFilter) {
		// Derive "within the last N days" from the offset (week -> 7 days, etc.)
		// via the shared recencyToStartDate helper.
		const start = recencyToStartDate(options.recencyFilter);
		const startMs = Date.parse(`${start}T00:00:00Z`);
		if (Number.isFinite(startMs)) {
			const days = Math.max(1, Math.round((Date.now() - startMs) / 86400000));
			hints.push(`Prefer sources published within the last ${days} days.`);
		}
	}
	const domainFilters = mapDomainFilter(options.domainFilter);
	if (domainFilters.includeDomains?.length) hints.push(`Focus on these domains: ${domainFilters.includeDomains.join(", ")}.`);
	if (domainFilters.excludeDomains?.length) hints.push(`Exclude these domains: ${domainFilters.excludeDomains.join(", ")}.`);
	if (typeof options.numResults === "number" && Number.isFinite(options.numResults) && options.numResults > 0) {
		hints.push(`Cite up to ${Math.min(Math.floor(options.numResults), 20)} distinct sources.`);
	}
	if (hints.length === 0) return "";
	return `Answer the user's query using current web sources. ${hints.join(" ")}`;
}

/** Extract a snippet window around an annotation's text span (mirrors
 * `openai-search.ts`'s helper). Falls back to "" when indices are unusable. */
function extractSnippetAround(text: string, start: unknown, end: unknown): string {
	if (typeof start !== "number" || typeof end !== "number" || !text) return "";
	const before = Math.max(0, start - 100);
	const after = Math.min(text.length, end + 100);
	const snippet = text.slice(before, after).replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
	return snippet.length > 300 ? `${snippet.slice(0, 297)}...` : snippet;
}

/** Concatenate all message-part text as the synthesized answer. Tolerates
 * non-array `content` / missing text. */
function extractAnswer(output: unknown[]): string {
	const parts: string[] = [];
	for (const item of output) {
		if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "message") continue;
		const content = (item as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string" && text.trim().length > 0) parts.push(text);
		}
	}
	return parts.join("\n").trim();
}

/** Pull `url_citation` annotations out of the message output items (SINGLE
 * pass — Parallel returns citations only as annotations, no `web_search_call`
 * items unlike OpenAI). Dedupes by URL and caps at `cap`. */
function extractCitations(output: unknown[], cap: number): SearchResult[] {
	const results: SearchResult[] = [];
	if (cap <= 0) return results;
	const seen = new Set<string>();
	for (const item of output) {
		if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "message") continue;
		const content = (item as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const text = typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "";
			const annotations = (part as { annotations?: unknown }).annotations;
			if (!Array.isArray(annotations)) continue;
			for (const annotation of annotations) {
				if (!annotation || typeof annotation !== "object" || (annotation as { type?: unknown }).type !== "url_citation") continue;
				const url = (annotation as { url?: unknown }).url;
				if (typeof url !== "string" || url.trim().length === 0) continue;
				if (seen.has(url)) continue;
				seen.add(url);
				const title = (annotation as { title?: unknown }).title;
				results.push({
					title: typeof title === "string" && title.trim().length > 0 ? title : url,
					url,
					snippet: extractSnippetAround(text, (annotation as { start_index?: unknown }).start_index, (annotation as { end_index?: unknown }).end_index),
				});
				if (results.length >= cap) return results;
			}
		}
	}
	return results;
}

/**
 * Search via the Parallel Responses API (`POST /v1/responses`). Returns a
 * synthesized answer grounded in live web research, with `url_citation`
 * sources as `results` — the same wire format OpenAI's Responses API uses.
 *
 * - Auth: `Authorization: Bearer <key>` (NOT the legacy `x-api-key`).
 * - Grounding is automatic — no `tools`/`web_search` entry is sent.
 * - `reasoning.effort` defaults to `low` for latency; override via
 *   `PARALLEL_REASONING_EFFORT` / `parallelReasoningEffort`.
 *
 * No `inlineContent` is populated (Responses returns citations, not excerpts);
 * the curator fetches primary sources independently via `fetch_content`.
 */
export async function searchWithParallel(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const apiKey = getApiKey();
	const numResults = Math.min(options.numResults ?? 5, 20);
	const instructions = buildInstructions(options);

	const requestBody: Record<string, unknown> = {
		model: "parallel",
		input: query,
		reasoning: { effort: getParallelEffort() },
	};
	if (instructions) requestBody.instructions = instructions;

	const activityId = activityMonitor.logStart({ type: "api", query });

	let response: Response;
	try {
		response = await fetch(PARALLEL_RESPONSES_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(requestBody),
			signal: searchRequestSignal(options.signal),
		});
	} catch (err) {
		if (isAbortError(err)) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, errorMessage(err));
		throw err;
	}

	if (!response.ok) {
		activityMonitor.logComplete(activityId, response.status);
		const errorText = await response.text();
		throw new Error(`Parallel API error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	let parsed: Record<string, unknown>;
	try {
		parsed = await response.json() as Record<string, unknown>;
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		throw new Error(`Parallel API returned invalid JSON: ${errorMessage(err)}`);
	}

	activityMonitor.logComplete(activityId, response.status);

	const output = Array.isArray(parsed.output) ? parsed.output : [];
	const answer = extractAnswer(output);
	const results = extractCitations(output, numResults);
	const searchResponse: SearchResponse = { answer, results };
	return searchResponse;
}

interface ParallelExtractResult {
	url?: string;
	title?: string | null;
	publish_date?: string | null;
	excerpts?: string[];
	full_content?: string | null;
}

interface ParallelExtractResponse {
	extract_id?: string;
	results?: ParallelExtractResult[];
	errors?: unknown[];
	warnings?: unknown[] | null;
	usage?: unknown[];
}

function deriveTitle(url: string, fallback?: string | null): string {
	const trimmed = fallback?.trim();
	if (trimmed) return trimmed;
	try {
		const last = new URL(url).pathname.split("/").filter(Boolean).pop();
		return last || url;
	} catch {
		return url;
	}
}

/** Keep only non-empty string excerpts; tolerate non-array / mixed input from the API. */
function nonEmptyExcerpts(excerpts: unknown): string[] {
	if (!Array.isArray(excerpts)) return [];
	return excerpts.filter((e): e is string => typeof e === "string" && e.trim().length > 0);
}

/**
 * Extract a single URL via the Parallel Extract API (`/v1/extract`).
 *
 * Plugs into the fetch_content fallback chain as a server-side renderer that
 * handles JavaScript-heavy pages and PDFs — a peer to Jina Reader / Gemini.
 *
 * - With `options.prompt`: returns focused excerpts aligned to that objective.
 * - Without a prompt: enables `full_content` to return the whole page (mirrors
 *   Readability's full-page behavior).
 *
 * Returns null when unavailable or on any failure so the caller falls through
 * to the next provider in the chain.
 */
export async function extractWithParallel(
	url: string,
	signal?: AbortSignal,
	options?: { prompt?: string },
): Promise<ExtractedContent | null> {
	if (!isParallelAvailable()) return null;
	const apiKey = getApiKey();

	const objective = options?.prompt?.trim();
	const advancedSettings: Record<string, unknown> = {};
	if (objective) {
		// Focused excerpts aligned to the objective.
		advancedSettings.excerpt_settings = { max_chars_per_result: 10000 };
	} else {
		// No objective: return the whole page, like Readability would.
		advancedSettings.full_content = true;
	}

	const requestBody: Record<string, unknown> = {
		urls: [url],
		...(objective ? { objective } : {}),
		advanced_settings: advancedSettings,
	};

	const activityId = activityMonitor.logStart({ type: "api", query: `parallel-extract: ${url}` });

	let response: Response;
	try {
		response = await fetch(PARALLEL_EXTRACT_URL, {
			method: "POST",
			headers: {
				"x-api-key": apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(requestBody),
			signal: requestSignal(signal),
		});
	} catch (err) {
		if (isAbortError(err)) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, errorMessage(err));
		return null;
	}

	if (!response.ok) {
		activityMonitor.logComplete(activityId, response.status);
		return null;
	}

	let data: ParallelExtractResponse;
	try {
		data = await response.json() as ParallelExtractResponse;
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		activityMonitor.logError(activityId, `invalid JSON: ${errorMessage(err)}`);
		return null;
	}

	activityMonitor.logComplete(activityId, response.status);

	const results = Array.isArray(data.results) ? data.results : [];
	// Prefer the result whose URL matches the requested one; fall back to the first.
	const result = results.find(r => r?.url === url) ?? results[0];
	if (!result) return null;

	const fullContent = typeof result.full_content === "string" ? result.full_content.trim() : "";
	const content = fullContent || nonEmptyExcerpts(result.excerpts).join("\n\n").trim();
	if (!content) return null;
	if (content.length < MIN_USEFUL_CONTENT) return null;

	return {
		url,
		title: deriveTitle(url, result.title),
		content,
		error: null,
	};
}
