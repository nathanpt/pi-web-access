import { loadWebSearchConfig, normalizeApiKey } from "../config.js";
import { activityMonitor } from "../activity.js";
import type { SearchOptions, SearchResponse } from "./perplexity.js";

// Brave Search: an optional, key-gated web_search provider (Brave Search API).
// Ports upstream `5229388` (nicobailon) onto our tree. Two changes from the
// upstream source: config access routes through the centralized `config.ts`
// (no local `loadConfig`/`normalizeApiKey` clone — the shared `normalizeApiKey`
// also treats placeholders as missing, so a leftover doc value can't 401
// mid-fallback), and search types are imported from `perplexity.js` (our tree's
// shared search-types home, per exa/parallel/searxng/olostep).
//
// Opt-in by design: NOT in `DEFAULT_AUTO_ORDER`. Reachable via explicit
// `provider: "brave"` or a `providerPriority` listing. A configured key never
// silently routes queries into the auto chain.
//
// Brave is unusual in two respects:
//   1. Auth uses `X-Subscription-Token` (not `Authorization: Bearer`).
//   2. The API has no domain filter of its own — domain include/exclude is
//      injected into the query string via `site:`/`NOT site:` AND results are
//      re-filtered client-side. When a domainFilter is present we bump `count`
//      to 20 so the post-filter still yields enough hits.

const BRAVE_API_URL = "https://api.search.brave.com/res/v1/web/search";
const SEARCH_TIMEOUT_MS = 30_000;

interface NormalizedDomainFilters {
	allowed: string[];
	blocked: string[];
}

/** Resolve the API key: env (`BRAVE_API_KEY`) takes precedence over the
 * resolved config (`braveApiKey`), matching our global precedence. Placeholders
 * fall through (treated as missing) via the shared `normalizeApiKey`. */
function getApiKey(): string | null {
	return normalizeApiKey(process.env.BRAVE_API_KEY) ?? normalizeApiKey(loadWebSearchConfig().braveApiKey);
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

/** Inject `site:`/`NOT site:` operators into the query string (Brave has no
 * API domain filter of its own). */
function buildBraveQuery(query: string, domainFilter: string[] | undefined): string {
	const filters = normalizeDomainFilters(domainFilter);
	const parts = [query];
	if (filters.allowed.length === 1) {
		parts.push(`site:${filters.allowed[0]}`);
	} else if (filters.allowed.length > 1) {
		parts.push(filters.allowed.map(domain => `site:${domain}`).join(" OR "));
	}
	for (const domain of filters.blocked) {
		parts.push(`NOT site:${domain}`);
	}
	return parts.join(" ");
}

function hostMatchesDomain(hostname: string, domain: string): boolean {
	return hostname === domain || hostname.endsWith(`.${domain}`);
}

/** Re-filter results client-side (the query-string `site:` is best-effort and
 * Brave may still surface off-domain hits). */
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

export function isBraveAvailable(): boolean {
	return !!getApiKey();
}

/**
 * Search via the Brave Search API. Returns `null` when no API key is
 * configured (so the fallback loop skips it); throws on a real request error.
 * The `runFallbackProvider` dispatch never calls this without a key
 * (`isCandidateAvailable` gates), and the explicit `provider === "brave"` block
 * throws a helpful key-missing message when this returns null.
 *
 * Brave returns no synthesized answer — one is built locally by joining each
 * result's snippet with its source citation.
 */
export async function searchWithBrave(query: string, options: SearchOptions = {}): Promise<SearchResponse | null> {
	const apiKey = getApiKey();
	if (!apiKey) return null;

	const numResults = normalizeCount(options.numResults);
	const domainFilters = normalizeDomainFilters(options.domainFilter);
	const searchQuery = buildBraveQuery(query, options.domainFilter);
	const activityId = activityMonitor.logStart({ type: "api", query: searchQuery });

	const params = new URLSearchParams({
		q: searchQuery,
		count: String(options.domainFilter?.length ? 20 : numResults),
	});

	if (options.recencyFilter) {
		const freshnessMap: Record<string, string> = {
			day: "pd",
			week: "pw",
			month: "pm",
			year: "py",
		};
		const freshness = freshnessMap[options.recencyFilter];
		if (freshness) params.set("freshness", freshness);
	}

	try {
		const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
		const response = await fetch(`${BRAVE_API_URL}?${params.toString()}`, {
			method: "GET",
			headers: {
				"X-Subscription-Token": apiKey,
				"Accept": "application/json",
				"Accept-Encoding": "gzip",
			},
			signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
		});

		if (!response.ok) {
			activityMonitor.logError(activityId, `HTTP ${response.status}`);
			const errorText = await response.text();
			throw new Error(`Brave Search API error ${response.status}: ${errorText.slice(0, 300)}`);
		}

		const data = await response.json() as {
			web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
		};
		activityMonitor.logComplete(activityId, response.status);

		const results: SearchResponse["results"] = [];
		for (const item of data.web?.results ?? []) {
			if (!item.url || !matchesDomainFilters(item.url, domainFilters)) continue;
			results.push({
				title: item.title || item.url,
				url: item.url,
				snippet: item.description || "",
			});
			if (results.length >= numResults) break;
		}

		const answer = results
			.map((result) => {
				if (result.snippet) return `${result.snippet}\nSource: ${result.title} (${result.url})`;
				return `Source: ${result.title} (${result.url})`;
			})
			.join("\n\n");

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
