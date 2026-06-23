import assert from "node:assert/strict";
import { test } from "node:test";

import { getWorkflowValues, isCuratorAllowed, resolveWorkflow } from "../workflow.ts";

test("allowCurator false hard-disables curator workflow", () => {
	const config = { workflow: "summary-review", allowCurator: false };

	assert.equal(isCuratorAllowed(config), false);
	assert.deepEqual(getWorkflowValues(config), ["none"]);
	assert.equal(resolveWorkflow("summary-review", true, isCuratorAllowed(config)), "none");
	assert.equal(resolveWorkflow(undefined, true, isCuratorAllowed(config)), "none");
});

test("workflow defaults preserve curator behavior when allowed", () => {
	const config = {};

	assert.equal(isCuratorAllowed(config), true);
	assert.deepEqual(getWorkflowValues(config), ["none", "summary-review"]);
	assert.equal(resolveWorkflow(undefined, true, isCuratorAllowed(config)), "summary-review");
	assert.equal(resolveWorkflow("none", true, isCuratorAllowed(config)), "none");
	assert.equal(resolveWorkflow("summary-review", false, isCuratorAllowed(config)), "none");
});
