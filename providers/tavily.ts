import { loadWebSearchConfig, normalizeApiKey } from "../config.js";
import { activityMonitor } from "../activity.js";
import type { ExtractedContent } from "../extract.js";
import type { SearchOptions, SearchResponse } from "./perplexity.js";

// Tavily: an optional, key-gated web_search provider (Tavily Search API).
// Ports upstream `7e633a8` (#78, smithyyang / "youngshine") onto our tree. Two
// changes from the upstream source: config access routes through the
// centralized `config.ts` (no local `loadConfig`/`normalizeApiKey` clone — the
// shared `normalizeApiKey` also treats placeholders as missing, so a leftover
// doc value can't 401 mid-fallback), and search types are imported from
// `perplexity.js` (our tree's shared search-types home).
//
// Opt-in by design: NOT in `DEFAULT_AUTO_ORDER`. Reachable via explicit
// `provider: "tavily"` or a `providerPriority` listing.
//
// Tavily is the one provider in this batch that returns a native synthesized
// answer AND can populate inlineContent (each result's raw_content → markdown).

const TAVILY_API_URL = "https://api.tavily.com/search";
const SEARCH_TIMEOUT_MS = 60_000;

interface TavilyResult {
	title?: string;
	url?: string;
	content?: string;
	raw_content?: string | null;
}

interface TavilyResponse {
	answer?: string;
	results?: TavilyResult[];
}

/** Tavily-specific options. `includeContent` controls include_raw_content
 * (markdown) so each result's raw_content can populate inlineContent. The
 * shared `search()` passes FullSearchOptions, which carries includeContent. */
interface TavilySearchOptions extends SearchOptions {
	includeContent?: boolean;
}

/** Resolve the API key: env (`TAVILY_API_KEY`) takes precedence over the
 * resolved config (`tavilyApiKey`), matching our global precedence. Placeholders
 * fall through (treated as missing) via the shared `normalizeApiKey`. */
function getApiKey(): string | null {
	return normalizeApiKey(process.env.TAVILY_API_KEY) ?? normalizeApiKey(loadWebSearchConfig().tavilyApiKey);
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function normalizeDomain(value: string): string | null {
	let input = value.trim().toLowerCase();
	if (!input) return null;
	if (input.startsWith("-")) input = input.slice(1).trim();
	if (!input) return null;
	try {
		const parsed = input.includes("://") ? new URL(input) : new URL(`https://${input}`);
		input = parsed.hostname;
	} catch {
		input = input.split("/")[0]?.split(":")[0] ?? "";
	}
	input = input.replace(/^\.+|\.+$/g, "");
	return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(input) ? input : null;
}

/** Map domainFilter (incl. `-`-prefixed excludes) to Tavily's
 * include_domains / exclude_domains body fields. */
function mapDomainFilter(domainFilter: string[] | undefined): { include_domains?: string[]; exclude_domains?: string[] } {
	if (!domainFilter?.length) return {};
	const include_domains: string[] = [];
	const exclude_domains: string[] = [];
	for (const raw of domainFilter) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? exclude_domains : include_domains;
		if (!target.includes(domain)) target.push(domain);
	}
	return {
		...(include_domains.length > 0 ? { include_domains } : {}),
		...(exclude_domains.length > 0 ? { exclude_domains } : {}),
	};
}

function mapResults(results: TavilyResult[] | undefined, numResults: number): SearchResponse["results"] {
	if (!Array.isArray(results)) return [];
	const mapped: SearchResponse["results"] = [];
	for (const item of results) {
		if (!item?.url) continue;
		mapped.push({
			title: item.title || `Source ${mapped.length + 1}`,
			url: item.url,
			snippet: typeof item.content === "string" ? item.content.replace(/\s+/g, " ").trim() : "",
		});
		if (mapped.length >= numResults) break;
	}
	return mapped;
}

/** Build inline content from each result's raw_content (markdown), when the
 * caller asked for includeContent. Tavily is the only batch provider that
 * populates inlineContent. */
function mapInlineContent(results: TavilyResult[] | undefined): ExtractedContent[] {
	if (!Array.isArray(results)) return [];
	return results.flatMap((item) => {
		if (!item?.url || typeof item.raw_content !== "string" || item.raw_content.trim().length === 0) return [];
		return [{
			url: item.url,
			title: item.title || "",
			content: item.raw_content,
			error: null,
		}];
	});
}

export function isTavilyAvailable(): boolean {
	return !!getApiKey();
}

/**
 * Search via the Tavily Search API. Returns `null` when no API key is
 * configured (so the fallback loop skips it); throws on a real request error.
 * The `runFallbackProvider` dispatch never calls this without a key
 * (`isCandidateAvailable` gates), and the explicit `provider === "tavily"`
 * block throws a helpful key-missing message when this returns null.
 */
export async function searchWithTavily(query: string, options: TavilySearchOptions = {}): Promise<SearchResponse | null> {
	const apiKey = getApiKey();
	if (!apiKey) return null;

	const numResults = typeof options.numResults === "number" && Number.isFinite(options.numResults)
		? Math.max(1, Math.min(Math.floor(options.numResults), 20))
		: 5;

	const body: Record<string, unknown> = {
		query,
		search_depth: "basic",
		max_results: numResults,
		include_answer: "basic",
		include_raw_content: options.includeContent ? "markdown" : false,
		...(options.recencyFilter ? { time_range: options.recencyFilter } : {}),
		...mapDomainFilter(options.domainFilter),
	};

	const activityId = activityMonitor.logStart({ type: "api", query });

	let response: Response;
	try {
		response = await fetch(TAVILY_API_URL, {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: requestSignal(options.signal),
		});
	} catch (err) {
		const message = errorMessage(err);
		if (message.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, message);
		throw err;
	}

	if (!response.ok) {
		activityMonitor.logError(activityId, `HTTP ${response.status}`);
		const errorText = await response.text();
		throw new Error(`Tavily API error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	let data: TavilyResponse;
	try {
		data = await response.json() as TavilyResponse;
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		throw new Error(`Tavily API returned invalid JSON: ${errorMessage(err)}`);
	}

	activityMonitor.logComplete(activityId, response.status);

	const result: SearchResponse = {
		answer: typeof data.answer === "string" ? data.answer : "",
		results: mapResults(data.results, numResults),
	};
	if (options.includeContent) {
		const inlineContent = mapInlineContent(data.results);
		if (inlineContent.length > 0) result.inlineContent = inlineContent;
	}
	return result;
}
