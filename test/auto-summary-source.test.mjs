import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Source-shape regression guards for the headless-workflows port (upstream
// 22cdb46). Adapted to this fork: WebSearchWorkflow + resolveWorkflow live in
// workflow.ts (not index.ts), the tool schema uses a dynamic `workflowValues`
// variable (not a literal array), and shouldCurate is `let` (concurrent-skip
// guard reassigns it). The assertions match our actual source.

const workflowSrc = readFileSync(new URL("../workflow.ts", import.meta.url), "utf8");
const indexSrc = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const readmeSrc = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("auto-summary is a recognized workflow value and bypasses the curator guards", () => {
	assert.match(workflowSrc, /"none" \| "summary-review" \| "auto-summary"/);
	assert.match(workflowSrc, /if \(normalized === "auto-summary"\) return "auto-summary"/);
	// auto-summary stays available even when the curator is disabled (headless).
	assert.match(workflowSrc, /isCuratorAllowed\(config\) \? \["none", "summary-review", "auto-summary"\] : \["none", "auto-summary"\]/);
});

test("auto-summary skips curator and reuses the summary model fallback plumbing", () => {
	// Only summary-review opens the curator; auto-summary and none share the
	// non-curate search path.
	assert.match(indexSrc, /let shouldCurate = workflow === "summary-review"/);
	assert.match(indexSrc, /if \(workflow === "auto-summary"\)/);
	assert.match(indexSrc, /await loadSummaryModelChoices\(summaryContext\)/);
	assert.match(indexSrc, /await generateSummaryDraft\(searchResults, summaryContext, signal, summaryModelChoices\.defaultSummaryModel \?\? undefined\)/);
	assert.match(indexSrc, /workflow: workflow === "auto-summary" \? "auto-summary" : undefined/);
});

test("/curator command accepts auto-summary", () => {
	assert.match(indexSrc, /arg === "none" \|\| arg === "summary-review" \|\| arg === "auto-summary"/);
});

test("README documents auto-summary", () => {
	assert.match(readmeSrc, /workflow: "auto-summary"/);
	assert.match(readmeSrc, /generate a summary without opening the curator/);
});
