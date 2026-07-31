import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { formatSearchSummary } from "../utils.ts";

// P3 — render provider answers that carry zero citations (ports upstream #146,
// commit 7832609, @nicobailon). formatSearchSummary was extracted from index.ts
// into utils.ts so the behavior is unit-testable under tsx: index.ts is
// host-coupled (@earendil-works/* / typebox are host-injected) and cannot be
// imported by any test. Cases 1-2 assert the NEW behavior (an answer with no
// sources is preserved + "No sources returned." rather than dropped); 3-4 pin
// the unchanged common path so the move doesn't alter it; 5-7 guard the
// index.ts wiring (no local def, import present, dead branch removed).

const indexSrc = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

test("formatSearchSummary renders an answer with no sources instead of dropping it", () => {
	assert.equal(
		formatSearchSummary([], "Direct answer without citations."),
		"Direct answer without citations.\n\n---\n\n**Sources:**\nNo sources returned.",
	);
});

test("formatSearchSummary renders 'No results found.' for empty answer and empty results", () => {
	assert.equal(formatSearchSummary([], ""), "No results found.");
});

test("formatSearchSummary renders answer + numbered sources for the common path", () => {
	assert.equal(
		formatSearchSummary(
			[
				{ title: "A", url: "https://a.example" },
				{ title: "B", url: "https://b.example" },
			],
			"Ans.",
		),
		"Ans.\n\n---\n\n**Sources:**\n1. A\n   https://a.example\n\n2. B\n   https://b.example",
	);
});

test("formatSearchSummary omits the separator prefix when there is no answer", () => {
	assert.equal(
		formatSearchSummary([{ title: "A", url: "https://a.example" }], ""),
		"1. A\n   https://a.example",
	);
});

test("index.ts no longer defines a local formatSearchSummary", () => {
	assert.doesNotMatch(indexSrc, /function formatSearchSummary/);
});

test("index.ts imports formatSearchSummary from utils.js", () => {
	assert.match(indexSrc, /import \{[^}]*\bformatSearchSummary\b[^}]*\} from "\.\/utils\.js";/);
});

test("buildSearchReturn renders via formatSearchSummary with no answer-dropping branch", () => {
	// The `else if (results.length === 0) output += "No results found.\n\n";`
	// branch that discarded a source-less answer is gone...
	assert.doesNotMatch(
		indexSrc,
		/else if \(results\.length === 0\) output \+= "No results found\.\\n\\n";/,
	);
	// ...and the two-branch if/else shape (error | formatSearchSummary) remains.
	assert.match(
		indexSrc,
		/if \(error\) output \+= `Error: \$\{error\}\\n\\n`;\s+else output \+= formatSearchSummary\(results, answer\) \+ "\\n\\n";/,
	);
});
