import { loadWebSearchConfig, normalizeApiKey } from "../config.js";
import { activityMonitor } from "../activity.js";
import type { SearchOptions, SearchResponse, SearchResult } from "./perplexity.js";

// OpenAI Search: an optional, key-gated web_search provider built on the
// OpenAI Responses API with the built-in `web_search` tool. Ports upstream
// `5229388` (nicobailon) onto our tree, KEY-ONLY (see D3 in the plan).
//
// SCOPE NOTE (D3): upstream's resolveOpenAIAuth(ctx) ALSO resolves auth via the
// model registry (getModel from @earendil-works/pi-ai/compat +
// ctx.modelRegistry.getApiKeyAndHeaders) to use a Codex subscription token —
// the one piece that intersects the deferred @mariozechner→@earendil-works
// namespace migration. We port the FALLBACK PATH ONLY: OPENAI_API_KEY env /
// openaiApiKey config → plain API key against the public Responses endpoint.
// This keeps the port pure-additive (no search()/SearchOptions signature
// change, no ctx threading through every curator call site) and lets the
// Responses-API + web_search-tool integration (the real value) work with any
// key. Codex-subscription auth is a tracked follow-up tied to the namespace
// migration.
//
// Two changes from the upstream source beyond D3: config access routes through
// the centralized `config.ts` (no local loadConfig/normalizeApiKey clone — the
// shared normalizeApiKey also treats placeholders as missing, so a leftover
// doc value can't 401 mid-fallback), and search types are imported from
// `perplexity.js` (our tree's shared search-types home).
//
// Opt-in by design: NOT in `DEFAULT_AUTO_ORDER`. Reachable via explicit
// `provider: "openai"` or a `providerPriority` listing.

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const SEARCH_TIMEOUT_MS = 60_000;

// Key path uses the public OpenAI API. (Codex endpoint + JWT detection deferred per D3.)
const DEFAULT_MODEL = "gpt-4.1-mini";

/** Resolve the API key: env (`OPENAI_API_KEY`) takes precedence over the
 * resolved config (`openaiApiKey`), matching our global precedence. Placeholders
 * fall through (treated as missing) via the shared `normalizeApiKey`. */
function getApiKey(): string | null {
	return normalizeApiKey(process.env.OPENAI_API_KEY) ?? normalizeApiKey(loadWebSearchConfig().openaiApiKey);
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

interface NormalizedDomainFilters {
	allowedDomains?: string[];
	blockedDomains?: string[];
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

/** Map domainFilter (incl. `-`-prefixed excludes) to the web_search tool's
 * allowed_domains / blocked_domains (capped at 100 each, per the API). */
function normalizeDomainFilters(domainFilter: string[] | undefined): NormalizedDomainFilters | null {
	if (!domainFilter?.length) return null;
	const allowedDomains: string[] = [];
	const blockedDomains: string[] = [];
	for (const raw of domainFilter) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? blockedDomains : allowedDomains;
		if (!target.includes(domain)) target.push(domain);
	}
	return allowedDomains.length > 0 || blockedDomains.length > 0
		? {
			...(allowedDomains.length > 0 ? { allowedDomains: allowedDomains.slice(0, 100) } : {}),
			...(blockedDomains.length > 0 ? { blockedDomains: blockedDomains.slice(0, 100) } : {}),
		}
		: null;
}

/** Weave recency/count/domain hints into the system instructions. The
 * `web_search` tool itself can't express recency, so it lives in the prompt. */
function buildInstructions(options: SearchOptions): string {
	const lines = [
		"Search the web and return a concise answer grounded only in the web results.",
		"Include clickable source citations in the response text when possible.",
	];
	if (options.recencyFilter) {
		const labels: Record<string, string> = {
			day: "past 24 hours",
			week: "past week",
			month: "past month",
			year: "past year",
		};
		lines.push(`Prefer sources from the ${labels[options.recencyFilter]}.`);
	}
	if (typeof options.numResults === "number" && Number.isFinite(options.numResults) && options.numResults > 0) {
		lines.push(`Prefer around ${Math.min(Math.floor(options.numResults), 20)} distinct sources.`);
	}
	const filters = normalizeDomainFilters(options.domainFilter);
	if (filters?.allowedDomains?.length) lines.push(`Only use sources from: ${filters.allowedDomains.join(", ")}.`);
	if (filters?.blockedDomains?.length) lines.push(`Do not use sources from: ${filters.blockedDomains.join(", ")}.`);
	return lines.join(" ");
}

/** Build the Responses-API `web_search` tool entry with domain filters (the
 * tool supports allowed/blocked domains natively). */
function buildWebSearchTool(options: SearchOptions): Record<string, unknown> {
	const tool: Record<string, unknown> = { type: "web_search" };
	const filters = normalizeDomainFilters(options.domainFilter);
	if (filters) {
		tool.filters = {
			...(filters.allowedDomains ? { allowed_domains: filters.allowedDomains } : {}),
			...(filters.blockedDomains ? { blocked_domains: filters.blockedDomains } : {}),
		};
	}
	return tool;
}

/** Parse the Responses-API reply, which may be a single JSON object OR an SSE
 * stream (`data:` lines). Accumulates output items either way. */
async function parseOpenAIResponse(response: Response): Promise<Record<string, unknown>> {
	const text = await response.text();
	const trimmed = text.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed)) return { output: parsed };
			return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : { output: [] };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`OpenAI API returned invalid JSON: ${message}`);
		}
	}

	const outputItems: unknown[] = [];
	let completedResponse: Record<string, unknown> | null = null;
	for (const line of text.split("\n")) {
		if (!line.startsWith("data: ")) continue;
		const data = line.slice(6).trim();
		if (!data || data === "[DONE]") continue;
		try {
			const parsed = JSON.parse(data) as Record<string, unknown>;
			if (parsed.type === "response.output_item.done" && parsed.item) outputItems.push(parsed.item);
			if ((parsed.type === "response.done" || parsed.type === "response.completed") && parsed.response && typeof parsed.response === "object") {
				completedResponse = parsed.response as Record<string, unknown>;
			}
		} catch {
			// ignore malformed SSE lines
		}
	}

	if (completedResponse) {
		const output = Array.isArray(completedResponse.output) ? completedResponse.output : [];
		return output.length > 0 ? completedResponse : { ...completedResponse, output: outputItems };
	}
	if (outputItems.length > 0) return { output: outputItems };
	throw new Error("OpenAI API returned no parseable response output");
}

/** Strip OpenAI's tracking param so citation URLs are clean/canonical. */
function cleanSourceUrl(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		if (url.searchParams.get("utm_source") === "openai") url.searchParams.delete("utm_source");
		return url.toString();
	} catch {
		return rawUrl.replace(/[?&]utm_source=openai$/, "");
	}
}

/** Extract a snippet window around an annotation's text span. */
function extractSnippetAround(text: string, start: unknown, end: unknown): string {
	if (typeof start !== "number" || typeof end !== "number" || !text) return "";
	const before = Math.max(0, start - 100);
	const after = Math.min(text.length, end + 100);
	const snippet = text.slice(before, after).replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
	return snippet.length > 300 ? `${snippet.slice(0, 297)}...` : snippet;
}

function addResult(results: SearchResult[], seen: Set<string>, url: unknown, title: unknown, snippet = ""): void {
	if (typeof url !== "string" || url.trim().length === 0) return;
	const cleanUrl = cleanSourceUrl(url);
	if (seen.has(cleanUrl)) return;
	seen.add(cleanUrl);
	results.push({
		title: typeof title === "string" && title.trim().length > 0 ? title : cleanUrl,
		url: cleanUrl,
		snippet,
	});
}

/** Two-pass source extraction: (1) `message` items' url_citation annotations,
 * (2) `web_search_call` items' source groups. Dedupes + caps at numResults. */
function extractSearchResults(output: unknown[], numResults: number | undefined): SearchResult[] {
	const results: SearchResult[] = [];
	const seenUrls = new Set<string>();

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
				addResult(
					results,
					seenUrls,
					(annotation as { url?: unknown }).url,
					(annotation as { title?: unknown }).title,
					extractSnippetAround(text, (annotation as { start_index?: unknown }).start_index, (annotation as { end_index?: unknown }).end_index),
				);
			}
		}
	}

	for (const item of output) {
		if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "web_search_call") continue;
		const value = item as { action?: unknown; sources?: unknown; results?: unknown };
		const actionSources = value.action && typeof value.action === "object"
			? (value.action as { sources?: unknown }).sources
			: undefined;
		for (const group of [actionSources, value.sources, value.results]) {
			if (!Array.isArray(group)) continue;
			for (const source of group) {
				if (!source || typeof source !== "object") continue;
				const record = source as Record<string, unknown>;
				addResult(results, seenUrls, record.url ?? record.source_website_url, record.title ?? record.caption);
			}
		}
	}

	if (typeof numResults === "number" && Number.isFinite(numResults) && numResults > 0) {
		return results.slice(0, Math.min(Math.floor(numResults), 20));
	}
	return results;
}

/** Concatenate all message-part text as the synthesized answer. */
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

export function isOpenAISearchAvailable(): boolean {
	return !!getApiKey();
}

/**
 * Search via the OpenAI Responses API with the built-in `web_search` tool.
 * Returns `null` when no API key is configured (so the fallback loop skips
 * it); throws on a real request error. The `runFallbackProvider` dispatch
 * never calls this without a key (`isCandidateAvailable` gates), and the
 * explicit `provider === "openai"` block throws a helpful key-missing message
 * when this returns null.
 *
 * Streams the response (`stream: true`) but parses both SSE and single-JSON
 * shapes; citations come from `url_citation` annotations + `web_search_call`
 * source groups, with OpenAI's `utm_source` stripped.
 */
export async function searchWithOpenAI(query: string, options: SearchOptions = {}): Promise<SearchResponse | null> {
	const apiKey = getApiKey();
	if (!apiKey) return null;

	const activityId = activityMonitor.logStart({ type: "api", query });
	const headers: Record<string, string> = {
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/json",
		"OpenAI-Beta": "responses=experimental",
	};

	const body = {
		model: DEFAULT_MODEL,
		instructions: buildInstructions(options),
		input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
		tools: [buildWebSearchTool(options)],
		include: ["web_search_call.action.sources"],
		store: false,
		stream: true,
		tool_choice: "required" as const,
		parallel_tool_calls: true,
	};

	try {
		const response = await fetch(OPENAI_RESPONSES_URL, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: requestSignal(options.signal),
		});

		if (!response.ok) {
			activityMonitor.logError(activityId, `HTTP ${response.status}`);
			const errorText = await response.text();
			throw new Error(`OpenAI API error ${response.status}: ${errorText.slice(0, 300)}`);
		}

		const parsed = await parseOpenAIResponse(response);
		const output = Array.isArray(parsed.output) ? parsed.output : [];
		const answer = extractAnswer(output);
		const results = extractSearchResults(output, options.numResults);

		if (!answer && results.length === 0) {
			throw new Error("OpenAI web_search returned no answer or sources");
		}

		activityMonitor.logComplete(activityId, response.status);
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
