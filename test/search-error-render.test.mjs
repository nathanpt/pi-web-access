import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildSearchErrorPlan } from "../render-search-error.ts";

// Unit tests for the pure error/cancel render plan (buildSearchErrorPlan) plus a
// source-contract guard that the four tool renderResult branches delegate to it.
// Ports the contract from upstream a3fa148 (#99, iRonin).

test("cancel path is not a dead-end (expanded has more than the headline)", () => {
	const plan = buildSearchErrorPlan({
		error: "Search curation cancelled (stale).",
		cancelled: true,
		cancelReason: "stale",
		browserConnected: false,
		queryCount: 3,
		cancelledQueries: [
			{ query: "react vs vue", provider: "exa", error: null, resultCount: 5 },
			{ query: "react perf", provider: "exa", error: "timeout", resultCount: 0 },
		],
	});
	assert.ok(plan);
	assert.ok(plan.expanded.length > 1, "expanded view must have diagnostics");
	assert.ok(plan.collapsed.length > 0, "collapsed view must preview");
	assert.ok(plan.expandHint, "collapsed view must hint at ctrl+o");
});

test("expanded plan surfaces cancel reason, browser state, and per-query progress", () => {
	const plan = buildSearchErrorPlan({
		error: "cancelled.",
		cancelled: true,
		cancelReason: "user",
		browserConnected: true,
		lastHeartbeatAgeMs: 4000,
		queryCount: 2,
		cancelledQueries: [{ query: "q", provider: null, error: null, resultCount: 3 }],
	});
	const text = plan.expanded.join("\n");
	assert.match(text, /cancel reason\s*:\s*user/);
	assert.match(text, /browser\s*:\s*connected/);
	assert.match(text, /last heartbeat\s*:\s*4s ago/);
	assert.match(text, /queries started\s*:\s*2/);
	assert.match(text, /queries done\s*:\s*1/);
	assert.match(text, /Per-query results/);
});

test("plain non-cancel error with no extras stays a single line", () => {
	const plan = buildSearchErrorPlan({ error: "No query provided" });
	assert.deepEqual(plan.expanded, ["No query provided"]);
	assert.equal(plan.collapsed.length, 0);
	assert.equal(plan.expandHint, null);
});

test("fetch_content-style error (extras, no cancel) is expandable without browser diagnostics", () => {
	const plan = buildSearchErrorPlan({
		error: "fetch failed",
		extraLines: ["urls: 0/2 succeeded", "response id: abc123"],
	});
	const text = plan.expanded.join("\n");
	assert.match(text, /Details:/);
	assert.match(text, /urls: 0\/2 succeeded/);
	assert.doesNotMatch(text, /browser:/); // non-cancel -> no curator diagnostics
	assert.ok(plan.expandHint);
});

test("code_search-style error surfaces the failed query", () => {
	const plan = buildSearchErrorPlan({ error: "boom", extraLines: ["query: foo"] });
	assert.match(plan.expanded.join("\n"), /query: foo/);
});

test("non-error / empty details yields null (caller falls through to normal renderer)", () => {
	assert.equal(buildSearchErrorPlan(undefined), null);
	assert.equal(buildSearchErrorPlan({}), null);
	assert.equal(buildSearchErrorPlan({ queryCount: 3 }), null);
});

test("source contract: index.ts wires all four tool error branches through the plan", () => {
	const src = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
	assert.match(src, /import \{ buildSearchErrorPlan, type SearchErrorDetails, type SearchErrorPlan \} from "\.\/render-search-error\.js"/);
	assert.match(src, /buildCurationCancelledReturn\(reason, \{/);
	assert.match(src, /activeCurators\.get\(callId\)\?\.getConnectionState\(\)/);
	// Exactly four delegations from the tool renderResult error branches.
	assert.equal((src.match(/buildSearchErrorPlan\(/g) || []).length, 4);
	assert.equal((src.match(/renderSearchErrorPlan\(plan, expanded, theme\)/g) || []).length, 4);
});

test("source contract: curator server exposes connection state", () => {
	const srv = readFileSync(new URL("../curator/curator-server.ts", import.meta.url), "utf8");
	assert.match(srv, /getConnectionState: \(\) => \(\{/);
	assert.match(srv, /browserConnected,\s*lastHeartbeatAgeMs:/);
});
