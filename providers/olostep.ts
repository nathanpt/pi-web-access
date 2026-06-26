import { loadWebSearchConfig, normalizeApiKey } from "../config.js";
import { activityMonitor } from "../activity.js";
import type { ExtractedContent } from "../extract.js";
import type { SearchOptions, SearchResponse } from "./perplexity.js";

// Olostep: an optional, key-gated provider contributing BOTH a `web_search`
// answers API and a `fetch_content` scrape fallback (single URL → markdown).
// Ports upstream #106 (Olostep-devs / Zeeshan Adil) onto our tree. Two changes
// from the upstream source: config access routes through the centralized
// `config.ts` (no local `loadConfig`/`normalizeApiKey` clone — the shared
// `normalizeApiKey` also treats placeholders as missing, so a leftover doc
// value can't 401 mid-fallback), and search types are imported from
// `perplexity.js` (our tree's shared search-types home, per exa/parallel/searxng).
//
// Opt-in by design: NOT in `DEFAULT_AUTO_ORDER`. Reachable via explicit
// `provider: "olostep"` or a `providerPriority` listing. A configured key never
// silently routes paid queries into the auto chain.

const OLOSTEP_ANSWERS_URL = "https://api.olostep.com/v1/answers";
const OLOSTEP_SCRAPES_URL = "https://api.olostep.com/v1/scrapes";
const REQUEST_TIMEOUT_MS = 30_000;

interface OlostepAnswerResult {
	url: string;
	title: string;
	description?: string;
}

interface OlostepAnswerResponse {
	answer?: string;
	results?: OlostepAnswerResult[];
}

interface OlostepScrapeResponse {
	markdown_content?: string;
	page_title?: string;
	url?: string;
	error?: string;
}

/** Resolve the API key: env (`OLOSTEP_API_KEY`) takes precedence over the
 * resolved config (`olostepApiKey`), matching our global precedence. Placeholders
 * fall through (treated as missing) via the shared `normalizeApiKey`. */
function getApiKey(): string | null {
	return normalizeApiKey(process.env.OLOSTEP_API_KEY) ?? normalizeApiKey(loadWebSearchConfig().olostepApiKey);
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function mapResults(results: OlostepAnswerResult[] | undefined): SearchResponse["results"] {
	if (!Array.isArray(results)) return [];
	const mapped: SearchResponse["results"] = [];
	for (let i = 0; i < results.length; i++) {
		const item = results[i];
		if (!item?.url) continue;
		mapped.push({
			title: item.title || `Source ${i + 1}`,
			url: item.url,
			snippet: item.description || "",
		});
	}
	return mapped;
}

export function isOlostepAvailable(): boolean {
	return !!getApiKey();
}

/**
 * Search via the Olostep answers API. Returns `null` when no API key is
 * configured (so the fallback loop skips it); throws on a real request error.
 * The `runFallbackProvider` dispatch never calls this without a key
 * (`isCandidateAvailable` gates), and the explicit `provider === "olostep"`
 * block throws a helpful key-missing message when this returns null.
 */
export async function searchWithOlostep(query: string, options: SearchOptions = {}): Promise<SearchResponse | null> {
	const apiKey = getApiKey();
	if (!apiKey) return null;

	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		const body: Record<string, unknown> = { query };
		if (options.numResults && options.numResults !== 5) {
			body.numResults = options.numResults;
		}
		if (options.recencyFilter) {
			const filterMap: Record<string, string> = {
				day: "day",
				week: "week",
				month: "month",
				year: "year",
			};
			const mapped = filterMap[options.recencyFilter];
			if (mapped) body.recencyFilter = mapped;
		}
		if (options.domainFilter?.length) {
			const include = options.domainFilter
				.filter(d => !d.startsWith("-") && d.trim().length > 0)
				.map(d => d.trim());
			const exclude = options.domainFilter
				.filter(d => d.startsWith("-"))
				.map(d => d.slice(1).trim())
				.filter(Boolean);
			if (include.length) body.domainFilter = include;
			if (exclude.length) body.excludeDomains = exclude;
		}

		const response = await fetch(OLOSTEP_ANSWERS_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: requestSignal(options.signal),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Olostep API error ${response.status}: ${errorText.slice(0, 300)}`);
		}

		const data = await response.json() as OlostepAnswerResponse;
		activityMonitor.logComplete(activityId, response.status);

		return {
			answer: data.answer || "",
			results: mapResults(data.results),
		};
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

/**
 * Scrape a single URL to clean markdown via the Olostep scrapes API. Returns
 * `null` when no key is configured or on any failure — that IS our fallback-
 * chain convention (`extractWithJinaReader`/`extractWithParallel` return null to
 * yield to the next provider; a truthy result would short-circuit the chain).
 * Errors are logged to the activity widget before returning null so failures
 * stay diagnosable.
 */
export async function extractWithOlostep(
	url: string,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	const apiKey = getApiKey();
	if (!apiKey) return null;

	const activityId = activityMonitor.logStart({ type: "api", query: `olostep-scrape: ${url}` });

	try {
		const response = await fetch(OLOSTEP_SCRAPES_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				url,
				formats: ["markdown"],
			}),
			signal: requestSignal(signal),
		});

		if (!response.ok) {
			const errorText = await response.text();
			activityMonitor.logError(activityId, `Olostep scrape error ${response.status}: ${errorText.slice(0, 200)}`);
			return null;
		}

		const data = await response.json() as OlostepScrapeResponse;
		activityMonitor.logComplete(activityId, response.status);

		const content = data.markdown_content?.trim() || "";
		if (!content) return null;

		return {
			url: data.url || url,
			title: data.page_title || "",
			content,
			error: null,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return null;
	}
}
