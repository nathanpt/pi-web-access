import { getWebSearchConfigPath } from "../utils.js";
import { loadWebSearchConfig, normalizeApiKey } from "../config.js";
import { activityMonitor } from "../activity.js";
import type { SearchOptions, SearchResponse } from "./perplexity.js";
import type { ExtractedContent } from "../extract.js";

const PARALLEL_API_URL = "https://api.parallel.ai/v1/search";
const PARALLEL_EXTRACT_URL = "https://api.parallel.ai/v1/extract";
// Explicit excerpt budget so synthesized search answers have enough context.
const SEARCH_MAX_CHARS_TOTAL = 40000;
// Reject extracts shorter than this — they're almost always junk (nav bars,
// cookie banners, error stubs) and would just pollute the fallback chain.
const MIN_USEFUL_CONTENT = 100;
const CONFIG_PATH = getWebSearchConfigPath();

// Common English stopwords dropped so an objective is turned into concise
// keyword queries (the Parallel `basic` mode is tuned for 2–3 such queries,
// per the API docs) rather than echoed verbatim.
const STOP_WORDS = new Set([
	"a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from",
	"has", "have", "how", "i", "in", "is", "it", "its", "of", "on", "or",
	"that", "the", "their", "there", "this", "to", "was", "were", "what",
	"when", "where", "which", "who", "why", "will", "with", "you", "your",
	"me", "my", "we", "our", "us", "do", "does", "did", "can", "could",
	"would", "should", "find", "get", "getting", "about", "into", "than",
	"then", "them", "these", "those", "also", "any", "all", "if", "so",
]);

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

export function isParallelAvailable(): boolean {
	const config = loadWebSearchConfig();
	return !!(normalizeApiKey(process.env.PARALLEL_API_KEY) ?? normalizeApiKey(config.parallelApiKey));
}

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

interface ParallelSearchResult {
	url: string;
	title?: string | null;
	publish_date?: string | null;
	excerpts?: string[];
}

interface ParallelSearchResponse {
	search_id?: string;
	results?: ParallelSearchResult[];
	warnings?: Array<{ type?: string; message?: string }> | null;
}

/** Keep only non-empty string excerpts; tolerate non-array / mixed input from the API. */
function nonEmptyExcerpts(excerpts: unknown): string[] {
	if (!Array.isArray(excerpts)) return [];
	return excerpts.filter((e): e is string => typeof e === "string" && e.trim().length > 0);
}

/** Lowercase alphanumeric tokens from arbitrary text. */
function tokenize(text: string): string[] {
	return text.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
}

/**
 * Turn a natural-language objective into 2–3 concise, diverse keyword queries.
 *
 * The Parallel `basic` search mode is documented to work best with 2–3
 * high-quality keyword queries rather than a single echoed phrase. We drop
 * stopwords, then emit the full keyword phrase plus first/second-half subsets
 * so the API recalls different pages per query instead of one redundant pass.
 *
 * Returns 1 query when the objective is too short to subdivide, and `[]` when
 * it is blank. Pure + deterministic so it is unit-testable in isolation.
 */
export function buildSearchQueriesFromObjective(objective: string): string[] {
	const trimmed = objective.trim();
	if (!trimmed) return [];

	const tokens = tokenize(trimmed).filter(t => !STOP_WORDS.has(t));
	// If every token was a stopword, fall back to the raw tokens so we still
	// return something usable (e.g. objective "the and of").
	const base = tokens.length > 0 ? tokens : tokenize(trimmed);
	if (base.length === 0) return [];
	if (base.length <= 2) return [base.join(" ")];

	const queries: string[] = [base.join(" ")];

	const firstHalf = base.slice(0, Math.ceil(base.length / 2));
	if (firstHalf.length >= 2) queries.push(firstHalf.join(" "));

	const secondHalf = base.slice(Math.floor(base.length / 2));
	if (secondHalf.length >= 2) queries.push(secondHalf.join(" "));

	// Dedupe (preserving order) and cap at 3.
	return [...new Set(queries)].slice(0, 3);
}

function buildAnswerFromResults(results: ParallelSearchResult[]): string {
	return results
		.map((item, index) => {
			if (!item?.url) return null;
			const content = nonEmptyExcerpts(item.excerpts).join(" ").trim();
			if (!content) return null;
			const sourceTitle = item.title || `Source ${index + 1}`;
			return `${content}\nSource: ${sourceTitle} (${item.url})`;
		})
		.filter((part): part is string => part !== null)
		.join("\n\n");
}

/**
 * Surface each result's excerpt content as structured inline content (a peer
 * to Exa/Gemini), so the consuming model sees per-source text instead of only
 * the synthesized `answer`. The Parallel search API returns excerpts (not full
 * page text — that's the extract endpoint's job), so the content here is the
 * joined excerpts per URL. Results without usable excerpt text are dropped.
 */
function mapInlineContent(results: ParallelSearchResult[]): ExtractedContent[] {
	if (!Array.isArray(results)) return [];
	return results
		.filter((r): r is ParallelSearchResult & { url: string } => typeof r?.url === "string" && r.url.length > 0)
		.map(r => {
			const content = nonEmptyExcerpts(r.excerpts).join(" ").trim();
			return {
				url: r.url,
				title: typeof r.title === "string" && r.title.trim() ? r.title.trim() : "",
				content,
				error: null,
			};
		})
		.filter(item => item.content.length > 0);
}

export async function searchWithParallel(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const apiKey = getApiKey();
	const numResults = Math.min(options.numResults ?? 5, 20);

	const advancedSettings: Record<string, unknown> = { max_results: numResults };

	const sourcePolicy: Record<string, unknown> = {};
	const domainFilters = mapDomainFilter(options.domainFilter);
	if (domainFilters.includeDomains) sourcePolicy.include_domains = domainFilters.includeDomains;
	if (domainFilters.excludeDomains) sourcePolicy.exclude_domains = domainFilters.excludeDomains;
	if (options.recencyFilter) {
		sourcePolicy.after_date = recencyToStartDate(options.recencyFilter);
	}
	if (Object.keys(sourcePolicy).length > 0) {
		advancedSettings.source_policy = sourcePolicy;
	}

	const searchQueries = buildSearchQueriesFromObjective(query);
	const requestBody: Record<string, unknown> = {
		objective: query,
		// `basic` mode is documented to work best with 2–3 keyword queries;
		// buildSearchQueriesFromObjective derives those from the objective.
		// Fall back to the raw query if expansion produced nothing (blank input).
		search_queries: searchQueries.length > 0 ? searchQueries : [query],
		mode: "basic",
		max_chars_total: SEARCH_MAX_CHARS_TOTAL,
		advanced_settings: advancedSettings,
	};

	const activityId = activityMonitor.logStart({ type: "api", query });

	let response: Response;
	try {
		response = await fetch(PARALLEL_API_URL, {
			method: "POST",
			headers: {
				"x-api-key": apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(requestBody),
			signal: requestSignal(options.signal),
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

	let data: ParallelSearchResponse;
	try {
		data = await response.json() as ParallelSearchResponse;
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		throw new Error(`Parallel API returned invalid JSON: ${errorMessage(err)}`);
	}

	activityMonitor.logComplete(activityId, response.status);

	const results = Array.isArray(data.results) ? data.results : [];
	const mapped = results.map((item, index) => ({
		title: item?.title || `Source ${index + 1}`,
		url: item?.url || "",
		snippet: nonEmptyExcerpts(item?.excerpts).join(" ").trim().slice(0, 1000),
	})).filter(item => item.url.length > 0);

	const searchResponse: SearchResponse = {
		answer: buildAnswerFromResults(results),
		results: mapped,
	};
	const inlineContent = mapInlineContent(results);
	if (inlineContent.length > 0) searchResponse.inlineContent = inlineContent;
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
