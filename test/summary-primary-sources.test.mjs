import assert from "node:assert/strict";
import { test } from "node:test";

// Tests for feeding primary source content (inlineContent) into the summary
// synthesis prompt. The synthesis layer previously worked from the pre-filtered
// provider `answer` + bare source titles/URLs only; now it also receives raw
// per-source text (matched by URL, budget-capped) so it can reason from primary
// material instead of a single stacked filter. Pure-function tests over the
// exported `buildSummaryPrompt` (which calls the internal `summarizeQueryResult`).

import { buildSummaryPrompt } from "../curator/summary-prompt.ts";

/** Minimal QueryResultData builder for prompt tests. */
function result({
	query = "q",
	answer = "provider answer",
	results = [],
	inlineContent,
	error = null,
	provider = "parallel",
} = {}) {
	return { query, answer, results, error, provider, ...(inlineContent ? { inlineContent } : {}) };
}

const src = (url, title = "Source") => ({ title, url, snippet: "snippet" });
const inline = (url, content) => ({ url, title: "Source", content, error: null });

test("prompt includes the 'prefer primary source content' guidance", () => {
	const prompt = buildSummaryPrompt([result({ results: [src("https://a.test/1")] })]);
	assert.match(prompt, /Primary source content is provided where available/i);
	assert.match(prompt, /treat it as ground truth/i);
});

test("inlineContent for a matching source URL is surfaced as primary source content", () => {
	const prompt = buildSummaryPrompt([
		result({
			query: "parallel rate limits",
			answer: "The API allows 600 req/min.",
			results: [src("https://a.test/docs", "Docs")],
			inlineContent: [inline("https://a.test/docs", "Rate limit is 600 requests per minute per key.")],
		}),
	]);
	assert.match(prompt, /Primary source content \(raw excerpts/i);
	assert.match(prompt, /Rate limit is 600 requests per minute per key\./);
	// Indexed source reference ties the content back to the Sources list.
	assert.match(prompt, /\[1\] https:\/\/a\.test\/docs/);
});

test("inlineContent with no matching result URL is not surfaced", () => {
	const prompt = buildSummaryPrompt([
		result({
			results: [src("https://a.test/seen")],
			inlineContent: [inline("https://a.test/other", "orphan content that should not appear")],
		}),
	]);
	assert.doesNotMatch(prompt, /orphan content/);
	// No primary-source section when nothing matched.
	assert.doesNotMatch(prompt, /Primary source content \(raw excerpts/i);
});

test("prompt has no primary-source section when inlineContent is absent (backward compatible)", () => {
	const prompt = buildSummaryPrompt([
		result({ results: [src("https://a.test/1"), src("https://a.test/2")] }),
	]);
	assert.doesNotMatch(prompt, /Primary source content \(raw excerpts/i);
	// Answer + bare source list still present (the pre-existing shape).
	assert.match(prompt, /Answer: provider answer/);
	assert.match(prompt, /1\. Source — https:\/\/a\.test\/1/);
});

test("per-source content is truncated at the cap", () => {
	const long = "x".repeat(5000);
	const prompt = buildSummaryPrompt([
		result({
			results: [src("https://a.test/long")],
			inlineContent: [inline("https://a.test/long", long)],
		}),
	]);
	// Cap is 2000 chars; the ellipsis accounts for one char.
	assert.match(prompt, /x{1998}…/);
});

test("per-query total content is capped across multiple sources", () => {
	// 5 sources × 2000 cap = 10000, but the per-query budget is 8000, so only
	// the first ~4 full sources fit.
	const a = "A".repeat(2000);
	const prompt = buildSummaryPrompt([
		result({
			results: [
				src("https://a.test/1"), src("https://a.test/2"),
				src("https://a.test/3"), src("https://a.test/4"),
				src("https://a.test/5"),
			],
			inlineContent: [
				inline("https://a.test/1", a), inline("https://a.test/2", a),
				inline("https://a.test/3", a), inline("https://a.test/4", a),
				inline("https://a.test/5", a),
			],
		}),
	]);
	// Count how many indexed source blocks were emitted.
	const blocks = prompt.match(/\[\d+\] https:\/\/a\.test\/\d+\nA+/g) ?? [];
	assert.ok(blocks.length >= 4 && blocks.length <= 4, `expected ~4 blocks under the 8000 budget, got ${blocks.length}`);
	// The 5th source's content must not have made it in (budget exhausted).
	assert.doesNotMatch(prompt, /\[5\] https:\/\/a\.test\/5/);
});

test("multiple queries each get their own primary-source section", () => {
	const prompt = buildSummaryPrompt([
		result({
			query: "first",
			results: [src("https://a.test/1")],
			inlineContent: [inline("https://a.test/1", "first source text")],
		}),
		result({
			query: "second",
			results: [src("https://a.test/2")],
			inlineContent: [inline("https://a.test/2", "second source text")],
		}),
	]);
	assert.match(prompt, /first source text/);
	assert.match(prompt, /second source text/);
	// Two distinct primary-source sections (one per query).
	assert.equal((prompt.match(/Primary source content \(raw excerpts/g) ?? []).length, 2);
});

test("empty/whitespace inlineContent entries are ignored", () => {
	const prompt = buildSummaryPrompt([
		result({
			results: [src("https://a.test/1")],
			inlineContent: [
				inline("https://a.test/1", "   "),
				inline("https://a.test/1", ""),
			],
		}),
	]);
	assert.doesNotMatch(prompt, /Primary source content \(raw excerpts/i);
});

test("error results are still summarized without primary-source content", () => {
	const prompt = buildSummaryPrompt([
		result({ error: "boom", results: [] }),
	]);
	assert.match(prompt, /Status: Error/);
	assert.doesNotMatch(prompt, /Primary source content \(raw excerpts/i);
});
