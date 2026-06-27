import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Source-contract test: curator state is keyed per tool call so parallel
// web_search invocations no longer collide on shared singletons. Ports the
// contract from upstream #83 (MaxKruse). We assert against the exact strings
// the refactor introduced (and that the old singletons are gone) — this guards
// the per-callId invariant even though the host entry point can't be imported
// under tsx (no test loads index.ts at runtime).
const indexSrc = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

test("web_search curator state is keyed per tool call for parallel calls", () => {
	assert.match(indexSrc, /const pendingCurates = new Map<string, PendingCurate>\(\)/);
	assert.match(indexSrc, /const activeCurators = new Map<string, CuratorServerHandle>\(\)/);
	assert.match(indexSrc, /const glimpseWins = new Map<string, GlimpseWindow>\(\)/);
	assert.match(indexSrc, /async execute\(callId, params, signal, onUpdate, ctx\)/);
	assert.match(indexSrc, /pendingCurates\.set\(callId, pc\)/);
	assert.match(indexSrc, /pendingCurates\.delete\(callId\)/);
	assert.match(indexSrc, /activeCurators\.set\(callId, handle\)/);
	assert.match(indexSrc, /activeCurators\.get\(callId\)/);
	// The old singletons must be gone.
	assert.doesNotMatch(indexSrc, /let pendingCurate: PendingCurate \| null/);
	assert.doesNotMatch(indexSrc, /let activeCurator: CuratorServerHandle \| null/);
	assert.doesNotMatch(indexSrc, /let glimpseWin: GlimpseWindow \| null/);
	// openCuratorBrowser takes the callId as its first parameter.
	assert.match(indexSrc, /openCuratorBrowser\(callId: string, pc: PendingCurate/);
});

test("closeCurator is callId-aware (single-call cleanup + close-all fallback)", () => {
	assert.match(indexSrc, /function closeCurator\(callId\?: string\): void/);
	// Per-call teardown is threaded through the abort + cancel paths.
	assert.match(indexSrc, /const onAbort = \(\) => closeCurator\(callId\)/);
});

test("manual /websearch command uses a distinct map key (no toolCallId available)", () => {
	assert.match(indexSrc, /const commandCallId = `cmd:\$\{sessionToken\}`/);
	assert.match(indexSrc, /activeCurators\.set\(commandCallId, handle\)/);
	assert.match(indexSrc, /glimpseWins\.set\(commandCallId, win\)/);
	assert.match(indexSrc, /activeCurators\.get\(commandCallId\) !== commandHandle/);
});

test("curateKey shortcut resolves the most-recent pending curator from the map", () => {
	assert.match(indexSrc, /\[...pendingCurates\.entries\(\)\]/);
	assert.match(indexSrc, /entries\[entries\.length - 1\]/);
});
