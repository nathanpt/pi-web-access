import { loadWebSearchConfig, normalizeApiKey, normalizeOptionalString } from "../config.js";
import { activityMonitor } from "../activity.js";
import type { ExtractedContent } from "../extract.js";
import type { SearchOptions, SearchResult, SearchResponse } from "./perplexity.js";
import { getWebSearchConfigPath } from "../utils.js";

// Bright Data: an optional, key-gated provider spanning three surfaces — SERP
// search (this module), a Web Unlocker `fetch_content` fallback (this module),
// and structured platform feeds (brightdata-feeds.ts). Ports upstream #124
// (mo-root) onto our tree.
//
// Fork changes from the upstream source:
//  - Config access routes through the centralized `config.ts` (no local
//    `loadConfig`/`normalizeApiKey` clone). The shared `normalizeApiKey` also
//    treats placeholders (`"your-key"`, `<...>`) as missing, so a leftover doc
//    value can't 401 mid-fallback — consistent with every other provider here.
//  - Zones resolve through the shared `normalizeOptionalString`.
//  - Search types come from `./perplexity.js` (our tree's shared search-types
//    home).
//
// Opt-in by design: NOT in `DEFAULT_AUTO_ORDER` (Bright Data needs a paid API
// token — this fork's policy keeps paid-key providers out of the silent `auto`
// chain). Reachable via explicit `provider: "brightdata"` or a
// `providerPriority` listing.
//
// Bright Data exposes both SERP search and the Web Unlocker (scrape) through a
// single endpoint: POST /request with { url, zone, format, data_format }.

const BRIGHTDATA_REQUEST_URL = "https://api.brightdata.com/request";
const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_ZONE = "mcp_unlocker";
const MIN_USEFUL_CONTENT = 200;

/** Resolve the API token: env (`BRIGHTDATA_API_TOKEN`, legacy
 * `BRIGHTDATA_API_KEY`) takes precedence over the resolved config
 * (`brightdataApiKey`), matching our global precedence. Placeholders fall
 * through (treated as missing) via the shared `normalizeApiKey`. */
export function getBrightDataApiKey(): string | null {
	return normalizeApiKey(process.env.BRIGHTDATA_API_TOKEN)
		?? normalizeApiKey(process.env.BRIGHTDATA_API_KEY)
		?? normalizeApiKey(loadWebSearchConfig().brightdataApiKey);
}

// Bright Data uses distinct zone types: a Web Unlocker zone for scraping and a
// SERP zone for search. Both flow through POST /request with the zone name.
export function getBrightDataUnlockerZone(): string {
	return normalizeOptionalString(process.env.BRIGHTDATA_UNLOCKER_ZONE)
		?? normalizeOptionalString(process.env.BRIGHTDATA_ZONE)
		?? normalizeOptionalString(loadWebSearchConfig().brightdataUnlockerZone)
		?? normalizeOptionalString(loadWebSearchConfig().brightdataZone)
		?? DEFAULT_ZONE;
}

// SERP falls back to the Unlocker zone when no dedicated SERP zone is set
// (matches the Bright Data MCP, which routes search through the unlocker zone).
export function getBrightDataSerpZone(): string {
	return normalizeOptionalString(process.env.BRIGHTDATA_SERP_ZONE)
		?? normalizeOptionalString(loadWebSearchConfig().brightdataSerpZone)
		?? getBrightDataUnlockerZone();
}

export function isBrightDataAvailable(): boolean {
	return !!getBrightDataApiKey();
}

function missingKeyError(): Error {
	return new Error("Bright Data API token not found. Set brightdataApiKey in " + getWebSearchConfigPath() + ' (e.g. { "brightdataApiKey": "brd-..." }) or the BRIGHTDATA_API_TOKEN env var.');
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Shared POST /request call. Returns the raw response body as text so callers
 * can parse JSON (SERP) or use the markdown directly (Unlocker).
 */
async function brightdataRequest(
	body: Record<string, unknown>,
	signal: AbortSignal | undefined,
	query: string,
): Promise<string> {
	const apiKey = getBrightDataApiKey();
	if (!apiKey) throw missingKeyError();

	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		const response = await fetch(BRIGHTDATA_REQUEST_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${apiKey}`,
			},
			body: JSON.stringify(body),
			signal: requestSignal(signal),
		});

		if (!response.ok) {
			const errorText = await response.text();
			activityMonitor.logError(activityId, `HTTP ${response.status}`);
			throw new Error(`Bright Data request error ${response.status}: ${errorText.slice(0, 300)}`);
		}

		const text = await response.text();
		activityMonitor.logComplete(activityId, response.status);
		return text;
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

function normalizeCount(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 5;
	return Math.max(1, Math.min(Math.floor(value), 20));
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

interface NormalizedDomainFilters {
	allowed: string[];
	blocked: string[];
}

function normalizeDomainFilters(domainFilter: string[] | undefined): NormalizedDomainFilters {
	const filters: NormalizedDomainFilters = { allowed: [], blocked: [] };
	if (!domainFilter?.length) return filters;

	for (const raw of domainFilter) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? filters.blocked : filters.allowed;
		if (!target.includes(domain)) target.push(domain);
	}

	return filters;
}

function buildSearchQuery(query: string, filters: NormalizedDomainFilters): string {
	const parts = [query];
	if (filters.allowed.length === 1) {
		parts.push(`site:${filters.allowed[0]}`);
	} else if (filters.allowed.length > 1) {
		parts.push(filters.allowed.map(domain => `site:${domain}`).join(" OR "));
	}
	for (const domain of filters.blocked) {
		parts.push(`-site:${domain}`);
	}
	return parts.join(" ");
}

const RECENCY_TBS: Record<string, string> = {
	day: "qdr:d",
	week: "qdr:w",
	month: "qdr:m",
	year: "qdr:y",
};

function buildGoogleSearchUrl(query: string, options: SearchOptions): string {
	const filters = normalizeDomainFilters(options.domainFilter);
	const params = new URLSearchParams({ q: buildSearchQuery(query, filters) });
	const numResults = normalizeCount(options.numResults);
	// Ask Google for a little headroom so post-filtering still leaves enough.
	params.set("num", String(Math.min(numResults + 5, 20)));
	if (options.recencyFilter && RECENCY_TBS[options.recencyFilter]) {
		params.set("tbs", RECENCY_TBS[options.recencyFilter]);
	}
	return `https://www.google.com/search?${params.toString()}`;
}

function hostMatchesDomain(hostname: string, domain: string): boolean {
	return hostname === domain || hostname.endsWith(`.${domain}`);
}

function matchesDomainFilters(url: string, filters: NormalizedDomainFilters): boolean {
	if (filters.allowed.length === 0 && filters.blocked.length === 0) return true;
	let hostname = "";
	try {
		hostname = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (filters.allowed.length > 0 && !filters.allowed.some(domain => hostMatchesDomain(hostname, domain))) {
		return false;
	}
	return !filters.blocked.some(domain => hostMatchesDomain(hostname, domain));
}

/**
 * SERP search via the Bright Data Web Unlocker. Google is returned as parsed
 * JSON (`brd_json=1`), from which we read the `organic` array. Returns `null`
 * when no API key is configured (so the fallback chain advances).
 */
export async function searchWithBrightData(
	query: string,
	options: SearchOptions = {},
): Promise<SearchResponse | null> {
	if (!isBrightDataAvailable()) return null;

	const numResults = normalizeCount(options.numResults);
	const filters = normalizeDomainFilters(options.domainFilter);
	const searchUrl = buildGoogleSearchUrl(query, options);

	const raw = await brightdataRequest(
		{
			url: `${searchUrl}&brd_json=1`,
			zone: getBrightDataSerpZone(),
			format: "raw",
			data_format: "parsed_light",
		},
		options.signal,
		`brightdata serp: ${query}`,
	);

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Bright Data returned a non-JSON SERP response: ${message}`);
	}

	// Narrow without an unchecked cast: a valid Google SERP payload is an
	// object with an `organic` array.
	const organic: unknown[] =
		typeof parsed === "object" && parsed !== null && "organic" in parsed && Array.isArray(parsed.organic)
			? parsed.organic
			: [];
	const results: SearchResult[] = [];
	for (const entry of organic) {
		if (typeof entry !== "object" || entry === null) continue;
		const link = "link" in entry && typeof entry.link === "string" ? entry.link.trim() : "";
		const title = "title" in entry && typeof entry.title === "string" ? entry.title.trim() : "";
		if (!link || !title || !matchesDomainFilters(link, filters)) continue;
		const snippet = "description" in entry && typeof entry.description === "string" ? entry.description.trim() : "";
		results.push({ title, url: link, snippet });
		if (results.length >= numResults) break;
	}

	const answer = results
		.map((result) => {
			if (result.snippet) return `${result.snippet}\nSource: ${result.title} (${result.url})`;
			return `Source: ${result.title} (${result.url})`;
		})
		.join("\n\n");

	return { answer, results };
}

function titleFromMarkdown(markdown: string, url: string): string {
	const match = markdown.match(/^#{1,6}\s+(.+)/m);
	if (match) {
		const cleaned = match[1].replace(/[*`]+/g, "").trim();
		if (cleaned) return cleaned;
	}
	try {
		return new URL(url).pathname.split("/").filter(Boolean).pop() || url;
	} catch {
		return url;
	}
}

/**
 * Fetch a page through the Web Unlocker as a fetch_content fallback. Bypasses
 * bot detection / CAPTCHAs that defeat the direct-HTTP and Jina paths. Returns
 * null (never throws) so the caller can fall through to the next extractor.
 */
export async function scrapeWithBrightData(
	url: string,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	if (!isBrightDataAvailable()) return null;

	try {
		const markdown = await brightdataRequest(
			{
				url,
				zone: getBrightDataUnlockerZone(),
				format: "raw",
				data_format: "markdown",
			},
			signal,
			`brightdata unlocker: ${url}`,
		);

		const trimmed = markdown.trim();
		if (trimmed.length < MIN_USEFUL_CONTENT) return null;

		return { url, title: titleFromMarkdown(trimmed, url), content: trimmed, error: null };
	} catch {
		// Fall through to the next extractor in the chain.
		return null;
	}
}
