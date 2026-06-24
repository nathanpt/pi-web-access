import assert from "node:assert/strict";
import { test } from "node:test";

import { getWorkflowValues, isCuratorAllowed, resolveWorkflow } from "../workflow.ts";

test("allowCurator false hard-disables curator workflow but keeps auto-summary", () => {
	const config = { workflow: "summary-review", allowCurator: false };

	assert.equal(isCuratorAllowed(config), false);
	// auto-summary never opens the browser, so it stays available headless.
	assert.deepEqual(getWorkflowValues(config), ["none", "auto-summary"]);
	assert.equal(resolveWorkflow("summary-review", true, isCuratorAllowed(config)), "none");
	assert.equal(resolveWorkflow(undefined, true, isCuratorAllowed(config)), "none");
	// auto-summary bypasses the allowCurator guard (it is not the curator).
	assert.equal(resolveWorkflow("auto-summary", true, isCuratorAllowed(config)), "auto-summary");
});

test("workflow defaults preserve curator behavior when allowed", () => {
	const config = {};

	assert.equal(isCuratorAllowed(config), true);
	assert.deepEqual(getWorkflowValues(config), ["none", "summary-review", "auto-summary"]);
	assert.equal(resolveWorkflow(undefined, true, isCuratorAllowed(config)), "summary-review");
	assert.equal(resolveWorkflow("none", true, isCuratorAllowed(config)), "none");
	assert.equal(resolveWorkflow("summary-review", false, isCuratorAllowed(config)), "none");
});

test("auto-summary is headless-friendly (no UI required)", () => {
	const config = {};
	const allowed = isCuratorAllowed(config);

	// auto-summary resolves even when hasUI is false (headless / -p mode).
	assert.equal(resolveWorkflow("auto-summary", false, allowed), "auto-summary");
	// and even when the curator is disabled.
	assert.equal(resolveWorkflow("auto-summary", false, false), "auto-summary");
	// default workflow is unchanged when auto-summary is not requested.
	assert.equal(resolveWorkflow(undefined, false, allowed), "none");
});
