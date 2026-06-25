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
const toolsDocSrc = readFileSync(new URL("../docs/tools.md", import.meta.url), "utf8");
const commandsDocSrc = readFileSync(new URL("../docs/commands.md", import.meta.url), "utf8");

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

test("docs document auto-summary", () => {
	// workflow param lives in docs/tools.md; the /curator blurb in docs/commands.md.
	assert.match(toolsDocSrc, /workflow: "auto-summary"/);
	assert.match(commandsDocSrc, /generate a summary without opening the curator/);
});

test("/webaccess renders without triggering a model follow-up turn", () => {
	// /webaccess is a terminal/CLI-only command: it renders its own output via
	// display: "tool" but must NOT set triggerTurn: true, or the model wakes up
	// and appends commentary to a purely informational dump. Match the
	// silent-render shape used by /curator and /google-account (success path).
	assert.match(indexSrc, /pi\.registerCommand\("webaccess"[\s\S]*?customType: "webaccess"[\s\S]*?display: "tool"[\s\S]*?\}, \{ triggerTurn: false, deliverAs: "followUp" \}\);/);
});

test("/webaccess test-key dispatches to an async runner before the sync handler", () => {
	// test-key makes a live network call, so it can't go through the pure/
	// synchronous handleWebAccessCommand. index.ts must intercept the
	// "test-key" first token and route to runKeyTest (which calls search()).
	assert.match(indexSrc, /firstToken === "test-key"/);
	assert.match(indexSrc, /result = await runKeyTest\(/);
	// the runner uses the shared search router with a forced provider, and
	// restores any ephemeral env var it set in a finally block.
	assert.match(indexSrc, /await search\("connection test", \{ provider: provider as SearchProvider \}\)/);
	assert.match(indexSrc, /if \(hadEnv === undefined\) delete process\.env\[envVar\]/);
});
