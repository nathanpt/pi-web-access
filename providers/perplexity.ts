import { getWebSearchConfigPath } from "../utils.js";
import { loadWebSearchConfig, normalizeApiKey, normalizeBaseUrl } from "../config.js";
import { activityMonitor } from "../activity.js";
import type { ExtractedContent } from "../extract.js";

// Public Perplexity endpoint by default. Override via PERPLEXITY_BASE_URL /
// perplexityBaseUrl to route through an OpenAI-compatible gateway — mirrors
// GOOGLE_GEMINI_BASE_URL / geminiBaseUrl. Bare URL including any version
// segment and no trailing slash (e.g. "https://my-gateway.example.com/v1");
// we append /chat/completions.
const DEFAULT_PERPLEXITY_BASE_URL = "https://api.perplexity.ai";
const DEFAULT_PERPLEXITY_MODEL = "sonar";
const CONFIG_PATH = getWebSearchConfigPath();

const RATE_LIMIT = {
	maxRequests: 10,
	windowMs: 60 * 1000,
};

const requestTimestamps: number[] = [];

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchResponse {
	answer: string;
	results: SearchResult[];
	inlineContent?: ExtractedContent[];
}

export interface SearchOptions {
	numResults?: number;
	recencyFilter?: "day" | "week" | "month" | "year";
	domainFilter?: string[];
	signal?: AbortSignal;
}

function getApiKey(): string {
	const config = loadWebSearchConfig();
	const key = normalizeApiKey(process.env.PERPLEXITY_API_KEY) ?? normalizeApiKey(config.perplexityApiKey);
	if (!key) {
		throw new Error(
			"Perplexity API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "perplexityApiKey": "your-key" }\n` +
			"  2. Set PERPLEXITY_API_KEY environment variable\n" +
			"Get a key at https://perplexity.ai/settings/api"
		);
	}
	return key;
}

/** Full chat/completions URL (`<base>/chat/completions`). Base override via
 * `PERPLEXITY_BASE_URL` (env) or `perplexityBaseUrl` (config); defaults to the
 * public Perplexity endpoint. Precedence: env > config > default. */
function getPerplexityCompletionsUrl(): string {
	const base =
		normalizeBaseUrl(process.env.PERPLEXITY_BASE_URL) ??
		normalizeBaseUrl(loadWebSearchConfig().perplexityBaseUrl) ??
		DEFAULT_PERPLEXITY_BASE_URL;
	return `${base}/chat/completions`;
}

/** Effective model for the Perplexity search call. Override via
 * `PERPLEXITY_MODEL` (env) or `perplexityModel` (config) — needed when a
 * gateway exposes non-Perplexity model IDs (e.g. `provider/model` forms).
 * Defaults to `sonar`. Placeholders fall through via `normalizeApiKey`. */
function getPerplexityModel(): string {
	return (
		normalizeApiKey(process.env.PERPLEXITY_MODEL) ??
		normalizeApiKey(loadWebSearchConfig().perplexityModel) ??
		DEFAULT_PERPLEXITY_MODEL
	);
}

function checkRateLimit(): void {
	const now = Date.now();
	const windowStart = now - RATE_LIMIT.windowMs;

	while (requestTimestamps.length > 0 && requestTimestamps[0] < windowStart) {
		requestTimestamps.shift();
	}

	if (requestTimestamps.length >= RATE_LIMIT.maxRequests) {
		const waitMs = requestTimestamps[0] + RATE_LIMIT.windowMs - now;
		throw new Error(`Rate limited. Try again in ${Math.ceil(waitMs / 1000)}s`);
	}

	requestTimestamps.push(now);
}

function validateDomainFilter(domains: string[]): string[] {
	return domains.filter((d) => {
		const domain = d.startsWith("-") ? d.slice(1) : d;
		return /^[a-zA-Z0-9][a-zA-Z0-9-_.]*\.[a-zA-Z]{2,}$/.test(domain);
	});
}

export function isPerplexityAvailable(): boolean {
	const config = loadWebSearchConfig();
	return !!(normalizeApiKey(process.env.PERPLEXITY_API_KEY) ?? normalizeApiKey(config.perplexityApiKey));
}

export async function searchWithPerplexity(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	checkRateLimit();

	const activityId = activityMonitor.logStart({ type: "api", query });

	activityMonitor.updateRateLimit({
		used: requestTimestamps.length,
		max: RATE_LIMIT.maxRequests,
		oldestTimestamp: requestTimestamps[0] ?? null,
		windowMs: RATE_LIMIT.windowMs,
	});

	const apiKey = getApiKey();
	const numResults = Math.min(options.numResults ?? 5, 20);

	const requestBody: Record<string, unknown> = {
		model: getPerplexityModel(),
		messages: [{ role: "user", content: query }],
		max_tokens: 1024,
		return_related_questions: false,
	};

	if (options.recencyFilter) {
		requestBody.search_recency_filter = options.recencyFilter;
	}

	if (options.domainFilter && options.domainFilter.length > 0) {
		const validated = validateDomainFilter(options.domainFilter);
		if (validated.length > 0) {
			requestBody.search_domain_filter = validated;
		}
	}

	let response: Response;
	try {
		response = await fetch(getPerplexityCompletionsUrl(), {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(requestBody),
			signal: options.signal,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}

	if (!response.ok) {
		activityMonitor.logComplete(activityId, response.status);
		const errorText = await response.text();
		throw new Error(`Perplexity API error ${response.status}: ${errorText}`);
	}

	let data: Record<string, unknown>;
	try {
		data = await response.json();
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Perplexity API returned invalid JSON: ${message}`);
	}

	const answer = (data.choices as Array<{ message?: { content?: string } }>)?.[0]?.message?.content || "";
	const citations = Array.isArray(data.citations) ? data.citations : [];

	const results: SearchResult[] = [];
	for (let i = 0; i < Math.min(citations.length, numResults); i++) {
		const citation = citations[i];
		if (typeof citation === "string") {
			results.push({ title: `Source ${i + 1}`, url: citation, snippet: "" });
		} else if (citation && typeof citation === "object" && typeof citation.url === "string") {
			results.push({
				title: citation.title || `Source ${i + 1}`,
				url: citation.url,
				snippet: "",
			});
		}
	}

	activityMonitor.logComplete(activityId, response.status);
	return { answer, results };
}
