import { loadWebSearchConfig, normalizeApiKey } from "../config.js";
import { activityMonitor } from "../activity.js";
import { getWebSearchConfigPath } from "../utils.js";
import type { ExtractedContent, ExtractOptions } from "../extract.js";
import type { SearchOptions, SearchResult, SearchResponse } from "./perplexity.js";

// Firecrawl: an optional, self-hosted search + scrape provider. Like SearXNG,
// it is base-URL-driven (`firecrawlBaseUrl` config or `FIRECRAWL_BASE_URL`
// env), needs no third-party cloud account, and suits privacy / air-gapped /
// homelab setups with zero per-query billing. Unlike SearXNG it also exposes
// a `/v1/scrape` endpoint, so Firecrawl contributes BOTH a `web_search` SERP
// provider and a `fetch_content` scrape fallback. Ports upstream #123 (fank)
// onto our tree: config access routes through the centralized `config.ts`
// (no local config clone/cache), and search types are imported from
// `perplexity.js` (our tree's shared search-types home).
//
// Opt-in by design: NOT in `DEFAULT_AUTO_ORDER`. Reachable via explicit
// `provider: "firecrawl"` or a `providerPriority` listing. A set-and-forget
// Firecrawl instance therefore never silently becomes a first-choice fallback
// (same policy as SearXNG/Olostep/Brave/Tavily/OpenAI/Bright Data).
//
// Auth: Bearer by default (`FIRECRAWL_API_KEY` / `firecrawlApiKey`). Reverse-
// proxy deployments often front Firecrawl with HTTP Basic auth — that path is
// supported via `FIRECRAWL_BASIC_AUTH=user:pass` (we base64-encode). Basic
// takes precedence when set, matching typical reverse-proxy precedence.

const SEARCH_TIMEOUT_MS = 60_000;
const EXTRACT_TIMEOUT_MS = 60_000;
const CONFIG_PATH = getWebSearchConfigPath();

interface NormalizedDomainFilters {
	allowed: string[];
	blocked: string[];
}

interface FirecrawlSearchResult {
	title?: string;
	url?: string;
	description?: string;
}

interface FirecrawlSearchResponse {
	success?: boolean;
	data?: FirecrawlSearchResult[];
	error?: string;
}

interface FirecrawlScrapeDocument {
	title?: string;
	url?: string;
	markdown?: string;
	metadata?: {
		title?: string;
		[key: string]: unknown;
	};
}

interface FirecrawlScrapeResponse {
	success?: boolean;
	data?: FirecrawlScrapeDocument;
	error?: string;
}

/**
 * Normalize a base URL for Firecrawl: accept only http/https, strip trailing
 * slashes, and clear any query/hash — but PRESERVE the pathname (Firecrawl may
 * deploy at a subpath, e.g. behind a reverse proxy at `/firecrawl`). Returns
 * null for non-strings, empty, or invalid input so availability gating treats
 * them as "not configured" (SSRF/parse safety).
 *
 * This is the strict normalizer; the shared `normalizeBaseUrl` in `config.ts`
 * is the LOOSE one (trailing-slash strip only, no protocol check) used by the
 * gateway providers. SearXNG keeps its own strict local copy too (path/query/
 * hash stripped); the loose/strict split is intentional and documented at
 * `config.ts`'s `normalizeBaseUrl` docstring. Firecrawl's variant is the third
 * strict copy in the tree — consolidating them is NOT a refactor, it would
 * silently change SSRF-safety semantics for three call sites at once.
 */
function normalizeBaseUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	try {
		const url = new URL(trimmed);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		url.pathname = url.pathname.replace(/\/+$/, "");
		url.search = "";
		url.hash = "";
		return url.toString().replace(/\/+$/, "");
	} catch {
		return null;
	}
}

/** Resolve the Firecrawl base URL: env (`FIRECRAWL_BASE_URL`) takes precedence
 * over the resolved config (`firecrawlBaseUrl`), matching our global precedence. */
function getBaseUrl(): string | null {
	return normalizeBaseUrl(process.env.FIRECRAWL_BASE_URL) ?? normalizeBaseUrl(loadWebSearchConfig().firecrawlBaseUrl);
}

function requireBaseUrl(): string {
	const baseUrl = getBaseUrl();
	if (!baseUrl) {
		throw new Error(
			"Firecrawl base URL not found. Either:\n" +
			`  1. Set firecrawlBaseUrl in ${CONFIG_PATH} (e.g. { "firecrawlBaseUrl": "http://localhost:3002" })\n` +
			"  2. Set FIRECRAWL_BASE_URL environment variable",
		);
	}
	return baseUrl;
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
	if (filters.allowed.length > 0 && !filters.allowed.some(domain => hostMatchesDomain(hostname, domain))) return false;
	return !filters.blocked.some(domain => hostMatchesDomain(hostname, domain));
}

/**
 * Build the request headers. Basic auth (reverse-proxy setups) takes
 * precedence if set; otherwise a Bearer token is attached when an API key is
 * configured. `FIRECRAWL_BASIC_AUTH` is the raw `user:pass` — we base64-encode
 * it here so the env value matches what a human would type.
 */
function buildHeaders(): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	const basic = process.env.FIRECRAWL_BASIC_AUTH?.trim();
	if (basic) {
		headers["Authorization"] = `Basic ${Buffer.from(basic).toString("base64")}`;
		return headers;
	}
	const bearer = normalizeApiKey(process.env.FIRECRAWL_API_KEY) ?? normalizeApiKey(loadWebSearchConfig().firecrawlApiKey);
	if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
	return headers;
}

export function isFirecrawlAvailable(): boolean {
	return !!getBaseUrl();
}

export async function searchWithFirecrawl(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const baseUrl = requireBaseUrl();
	const numResults = normalizeCount(options.numResults);
	const domainFilters = normalizeDomainFilters(options.domainFilter);
	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		const response = await fetch(`${baseUrl}/v1/search`, {
			method: "POST",
			headers: buildHeaders(),
			body: JSON.stringify({
				query,
				limit: numResults,
				scrapeOptions: { formats: [] },
			}),
			signal: options.signal
				? AbortSignal.any([AbortSignal.timeout(SEARCH_TIMEOUT_MS), options.signal])
				: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
		});

		if (!response.ok) {
			activityMonitor.logError(activityId, `HTTP ${response.status}`);
			const errorText = await response.text();
			throw new Error(`Firecrawl search error ${response.status}: ${errorText.slice(0, 300)}`);
		}

		let data: FirecrawlSearchResponse;
		try {
			data = await response.json() as FirecrawlSearchResponse;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`Firecrawl returned invalid JSON: ${message}`);
		}

		activityMonitor.logComplete(activityId, response.status);

		if (!data.success) {
			const message = data.error?.trim() || "Firecrawl search returned success: false";
			throw new Error(`Firecrawl search error: ${message}`);
		}

		const results: SearchResult[] = [];
		for (const item of data.data ?? []) {
			if (!item.url) continue;
			if (!matchesDomainFilters(item.url, domainFilters)) continue;
			results.push({
				title: item.title ?? "",
				url: item.url,
				snippet: item.description ?? "",
			});
			if (results.length >= numResults) break;
		}

		const answerParts = results.map((result) => {
			if (result.snippet) return `${result.snippet}\nSource: ${result.title} (${result.url})`;
			return `Source: ${result.title} (${result.url})`;
		});

		return { answer: answerParts.join("\n\n"), results };
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
 * Scrape a single URL to clean Markdown via Firecrawl's `/v1/scrape` endpoint.
 * Two parameters, matching `extractWithOlostep`'s exact signature. Returns
 * `null` when no base URL is configured or on any failure — that IS the
 * fallback-chain convention (`extractWithOlostep` / `scrapeWithBrightData`
 * return null to yield to the next provider; a truthy result would short-
 * circuit the chain). Errors are logged to the activity widget before
 * returning null so failures stay diagnosable.
 */
export async function extractWithFirecrawl(
	url: string,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	const baseUrl = getBaseUrl();
	if (!baseUrl) return null;

	const activityId = activityMonitor.logStart({ type: "api", query: `fc-scrape: ${url}` });

	try {
		const response = await fetch(`${baseUrl}/v1/scrape`, {
			method: "POST",
			headers: buildHeaders(),
			body: JSON.stringify({
				url,
				formats: ["markdown"],
			}),
			signal: signal
				? AbortSignal.any([AbortSignal.timeout(EXTRACT_TIMEOUT_MS), signal])
				: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
		});

		if (!response.ok) {
			const errorText = await response.text();
			activityMonitor.logError(activityId, `Firecrawl scrape error ${response.status}: ${errorText.slice(0, 200)}`);
			return null;
		}

		let data: FirecrawlScrapeResponse;
		try {
			data = await response.json() as FirecrawlScrapeResponse;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			activityMonitor.logError(activityId, `Firecrawl scrape invalid JSON: ${message}`);
			return null;
		}

		activityMonitor.logComplete(activityId, response.status);

		if (!data.success || !data.data) {
			const message = data.error?.trim() || "Firecrawl scrape returned success: false";
			activityMonitor.logError(activityId, message);
			return null;
		}

		const doc = data.data;
		const content = doc.markdown?.trim() || "";
		if (!content) return null;

		return {
			url: doc.url || url,
			title: doc.metadata?.title ?? doc.title ?? "",
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
