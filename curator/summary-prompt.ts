import type { QueryResultData } from "../storage.js";

/**
 * Pure prompt-building logic for the summary synthesis layer.
 *
 * Split out of `summary-review.ts` so it has NO host-package imports
 * (`@earendil-works/pi-ai/compat` is host-injected and not resolvable under
 * tsx). This keeps the prompt construction — including the primary-source
 * enrichment, URL matching, and budget caps — unit-testable in isolation.
 * `summary-review.ts` owns only the host-dependent `complete()` dispatch and
 * model resolution, and re-exports the pure helpers for callers.
 */

export interface SummaryMeta {
	model: string | null;
	durationMs: number;
	tokenEstimate: number;
	fallbackUsed: boolean;
	fallbackReason?: string;
	edited?: boolean;
}

function estimateTokens(text: string): number {
	const trimmed = text.trim();
	if (trimmed.length === 0) return 0;
	return Math.max(1, Math.ceil(trimmed.length / 4));
}

// Budget caps for primary-source content fed to the synthesis model. Keep the
// prompt bounded so multi-query summaries still fit the model context.
const INLINE_PER_SOURCE_CHARS = 2000;
const INLINE_PER_QUERY_CHARS = 8000;

function truncateWithEllipsis(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function summarizeQueryResult(result: QueryResultData): string {
	if (result.error) {
		return `Query: ${result.query}\nStatus: Error\nError: ${result.error}`;
	}

	const lines = [
		`Query: ${result.query}`,
		`Provider: ${result.provider ?? "unknown"}`,
		`Answer: ${result.answer || "(no answer text returned)"}`,
	];

	if (result.results.length === 0) {
		lines.push("Sources: none");
		return lines.join("\n");
	}

	lines.push("Sources:");
	for (let i = 0; i < result.results.length; i++) {
		const source = result.results[i];
		lines.push(`${i + 1}. ${source.title} — ${source.url}`);
	}

	// Primary source content: feed the synthesizer raw per-source text (from
	// inlineContent, matched by URL) so it can reason from primary material
	// instead of relying solely on the pre-filtered provider `answer`. This is
	// retrieval-augmented enrichment — it reduces single-filter reliance rather
	// than stacking a second LLM filter. Undefined for providers that return no
	// inline content (the provider `answer` alone is used, as before). Budget-
	// capped per source and per query to keep the prompt bounded.
	const inlineByUrl = new Map<string, string>();
	if (Array.isArray(result.inlineContent)) {
		for (const entry of result.inlineContent) {
			if (entry?.url && typeof entry.content === "string" && entry.content.trim().length > 0) {
				inlineByUrl.set(entry.url, entry.content.trim());
			}
		}
	}

	let budget = INLINE_PER_QUERY_CHARS;
	const sourcesWithContent: string[] = [];
	for (let i = 0; i < result.results.length && budget > 0; i++) {
		const source = result.results[i];
		const content = inlineByUrl.get(source.url);
		if (!content) continue;
		const capped = truncateWithEllipsis(content, Math.min(INLINE_PER_SOURCE_CHARS, budget));
		sourcesWithContent.push(`[${i + 1}] ${source.url}\n${capped}`);
		budget -= capped.length;
	}

	if (sourcesWithContent.length > 0) {
		lines.push("");
		lines.push("Primary source content (raw excerpts — verify the answer against these):");
		lines.push(sourcesWithContent.join("\n\n"));
	}

	return lines.join("\n");
}

export function buildSummaryPrompt(results: QueryResultData[], feedback?: string): string {
	const sections = [
		"You are writing the final web search summary for a coding assistant.",
		"Write a concise, factual summary using only the provided search results.",
		"Requirements:",
		"- Keep it readable and skimmable.",
		"- Include key findings and caveats.",
		"- Do not invent sources or claims.",
		"- If evidence is weak or conflicting, say so explicitly.",
		"- Primary source content is provided where available; treat it as ground truth and prefer it over the provider answer when they conflict.",
		"- End with a short \"Sources\" section listing the most relevant URLs.",
	];

	if (feedback) {
		sections.push("- Incorporate the user feedback provided below into the summary.");
	}

	sections.push("");
	sections.push("<search_results>");

	for (let i = 0; i < results.length; i++) {
		sections.push(`\n[Result ${i + 1}]`);
		sections.push(summarizeQueryResult(results[i]));
	}

	sections.push("\n</search_results>");

	if (feedback) {
		sections.push("");
		sections.push("<user_feedback>");
		sections.push(feedback);
		sections.push("</user_feedback>");
	}

	return sections.join("\n");
}

function buildDeterministicAnswerPreview(answer: string): string {
	let text = answer.replace(/\s+/g, " ").trim();
	if (text.length === 0) return "";

	const sourceMarker = text.search(/\bSources?\s*:/i);
	if (sourceMarker >= 0) text = text.slice(0, sourceMarker).trim();
	if (text.length === 0) return "";

	return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function buildDeterministicSummaryLines(results: QueryResultData[]): string[] {
	if (results.length === 0) {
		return [
			"No completed search results were available when the curator session finished.",
			"",
			"Sources",
			"- None",
		];
	}

	const lines: string[] = [
		"Summary based on the currently selected search results.",
		"",
	];

	const sourceUrls: string[] = [];
	let successful = 0;
	let failed = 0;

	for (const result of results) {
		if (result.error) {
			failed += 1;
			lines.push(`- ${result.query}: failed (${result.error})`);
			continue;
		}

		successful += 1;
		const preview = buildDeterministicAnswerPreview(result.answer);
		if (preview.length > 0) {
			lines.push(`- ${result.query}: ${preview}`);
		} else {
			lines.push(`- ${result.query}: returned ${result.results.length} source${result.results.length === 1 ? "" : "s"} without answer text.`);
		}

		for (const source of result.results) {
			if (!sourceUrls.includes(source.url)) {
				sourceUrls.push(source.url);
			}
		}
	}

	lines.push("");
	lines.push(`Completed queries: ${results.length}`);
	lines.push(`Successful: ${successful}`);
	lines.push(`Failed: ${failed}`);
	lines.push("");
	lines.push("Sources");

	if (sourceUrls.length === 0) {
		lines.push("- None");
	} else {
		for (const url of sourceUrls.slice(0, 12)) {
			lines.push(`- ${url}`);
		}
		if (sourceUrls.length > 12) {
			lines.push(`- ... and ${sourceUrls.length - 12} more`);
		}
	}

	return lines;
}

export function buildDeterministicSummary(results: QueryResultData[]): { summary: string; meta: SummaryMeta } {
	const summary = buildDeterministicSummaryLines(results).join("\n").trim();
	const nonEmptySummary = summary.length > 0
		? summary
		: "No completed search results were available when the curator session finished.\n\nSources\n- None";

	return {
		summary: nonEmptySummary,
		meta: {
			model: null,
			durationMs: 0,
			tokenEstimate: estimateTokens(nonEmptySummary),
			fallbackUsed: true,
			fallbackReason: "deterministic-submit-fallback",
			edited: false,
		},
	};
}
