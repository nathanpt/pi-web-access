import { loadWebSearchConfig, normalizeApiKey } from "../config.js";
import { activityMonitor } from "../activity.js";
import type { ExtractedContent } from "../extract.js";
import type { SearchOptions, SearchResponse, SearchResult } from "./perplexity.js";

// Firecrawl: an optional, self-hosted provider contributing BOTH a
// `web_search` API (`/v1/search`) and a `fetch_content` scrape fallback
// (`/v1/scrape` — Playwright-rendered Markdown). Config via
// `firecrawlBaseUrl` / `FIRECRAWL_BASE_URL`, with optional Bearer token
// auth (`firecrawlApiKey` / `FIRECRAWL_API_KEY`) or HTTP Basic Auth
// (`FIRECRAWL_BASIC_AUTH`) for reverse-proxy setups.
//
// Self-hosted by design: requires a base URL to a running Firecrawl instance.
// No third-party API key needed — runs fully offline when pointed at a local
// Firecrawl container. Config access routes through the centralized `config.ts`.
//
// Opt-in by design: NOT in `DEFAULT_AUTO_ORDER`. Reachable via explicit
// `provider: "firecrawl"` or a `providerPriority` listing.

const SEARCH_TIMEOUT_MS = 60_000;
const EXTRACT_TIMEOUT_MS = 60_000;

interface NormalizedDomainFilters {
	allowed: string[];
	blocked: string[];
}

interface FirecrawlSearchData {
	title?: string;
	url?: string;
	description?: string;
}

interface FirecrawlSearchResponse {
	success: boolean;
	data?: FirecrawlSearchData[];
	error?: string;
}

interface FirecrawlScrapeMetadata {
	title?: string;
	sourceURL?: string;
	[key: string]: unknown;
}

interface FirecrawlScrapeData {
	title?: string;
	url?: string;
	markdown?: string;
	metadata?: FirecrawlScrapeMetadata;
}

interface FirecrawlScrapeResponse {
	success?: boolean;
	data?: FirecrawlScrapeData;
	error?: string;
}

/**
 * Normalize a base URL: accept only http/https, strip trailing slashes, drop
 * any path/query/hash. Returns null for non-strings, empty, or invalid input
 * so availability gating treats them as "not configured".
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

/** Resolve the Firecrawl base URL: env takes precedence over config. */
function getBaseUrl(): string | null {
	return (
		normalizeBaseUrl(process.env.FIRECRAWL_BASE_URL) ??
		normalizeBaseUrl(loadWebSearchConfig().firecrawlBaseUrl)
	);
}

function requireBaseUrl(): string {
	const baseUrl = getBaseUrl();
	if (!baseUrl) {
		throw new Error(
			"Firecrawl base URL not configured. Either:\n" +
			"  1. Set firecrawlBaseUrl in the web-search config (e.g. { \"firecrawlBaseUrl\": \"http://localhost:3002\" })\n" +
			"  2. Set FIRECRAWL_BASE_URL environment variable",
		);
	}
	return baseUrl;
}

/** Resolve the Firecrawl API key: env takes precedence over config. */
function getApiKey(): string | null {
	return (
		normalizeApiKey(process.env.FIRECRAWL_API_KEY) ??
		normalizeApiKey(loadWebSearchConfig().firecrawlApiKey)
	);
}

/** Build headers for Firecrawl API calls.
 *  Supports Bearer token (FIRECRAWL_API_KEY) or HTTP Basic Auth
 *  (FIRECRAWL_BASIC_AUTH) for reverse-proxy setups. */
function buildHeaders(): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };

	const apiKey = getApiKey();
	if (apiKey) {
		headers["Authorization"] = `Bearer ${apiKey}`;
		return headers;
	}

	const basicAuth = normalizeApiKey(process.env.FIRECRAWL_BASIC_AUTH);
	if (basicAuth) {
		headers["Authorization"] = `Basic ${Buffer.from(basicAuth).toString("base64")}`;
	}

	return headers;
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
	if (filters.allowed.length > 0 && !filters.allowed.some(d => hostMatchesDomain(hostname, d))) return false;
	return !filters.blocked.some(d => hostMatchesDomain(hostname, d));
}

/** Pick the first non-empty metadata value across candidate keys. */
function pickMeta(meta: Record<string, unknown> | undefined, keys: string[]): string | undefined {
	if (!meta) return undefined;
	for (const k of keys) {
		const v = meta[k];
		if (typeof v === "string" && v.trim()) return v;
		if (Array.isArray(v) && typeof v[0] === "string" && v[0].trim()) return v[0];
	}
	return undefined;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// ─── Search ───

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

		const data = (await response.json()) as FirecrawlSearchResponse;
		activityMonitor.logComplete(activityId, response.status);

		if (!data.success) {
			throw new Error(`Firecrawl search unsuccessful: ${data.error ?? "unknown error"}`);
		}

		const results: SearchResult[] = [];
		for (const d of data.data ?? []) {
			if (!d.url || !matchesDomainFilters(d.url, domainFilters)) continue;
			results.push({
				title: d.title ?? "",
				url: d.url,
				snippet: d.description ?? "",
			});
			if (results.length >= numResults) break;
		}

		const answer = results
			.map(r => r.snippet ? `${r.snippet}\nSource: ${r.title} (${r.url})` : `Source: ${r.title} (${r.url})`)
			.join("\n\n");

		return { answer, results };
	} catch (err) {
		const message = errorMessage(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}
}

// ─── Content Extraction ───

/**
 * Extract content from a URL using Firecrawl's /v1/scrape endpoint.
 * Returns null when Firecrawl is not configured or the page can't be scraped,
 * so callers can fall through to other extraction methods.
 */
export async function extractWithFirecrawl(
	url: string,
	signal?: AbortSignal,
	timeoutMs?: number,
): Promise<ExtractedContent | null> {
	const baseUrl = getBaseUrl();
	if (!baseUrl) return null;

	const ttl = timeoutMs ?? EXTRACT_TIMEOUT_MS;
	const activityId = activityMonitor.logStart({ type: "api", query: `fc-scrape: ${url}` });

	try {
		const response = await fetch(`${baseUrl}/v1/scrape`, {
			method: "POST",
			headers: buildHeaders(),
			body: JSON.stringify({
				url,
				formats: ["markdown"],
			}),
			signal: AbortSignal.any([
				AbortSignal.timeout(ttl),
				...(signal ? [signal] : []),
			]),
		});

		if (!response.ok) {
			activityMonitor.logComplete(activityId, response.status);
			return null;
		}

		const data = (await response.json()) as FirecrawlScrapeResponse;

		if (data.success === false) {
			activityMonitor.logComplete(activityId, 200);
			return null;
		}

		const doc = data.data;
		if (!doc) {
			activityMonitor.logComplete(activityId, 200);
			return null;
		}

		const rawContent = doc.markdown ?? "";
		if (!rawContent.trim()) {
			activityMonitor.logComplete(activityId, 200);
			return null;
		}

		const title = doc.metadata?.title ?? doc.title ?? "";
		const author = pickMeta(doc.metadata, ["author", "article:author", "dc.creator", "parsely-author"]);
		const publishedDate = pickMeta(doc.metadata, ["publishedTime", "article:published_time", "date"]);

		activityMonitor.logComplete(activityId, response.status);

		return {
			url,
			title,
			content: rawContent,
			error: null,
		};
	} catch (err) {
		const message = errorMessage(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return null;
	}
}
