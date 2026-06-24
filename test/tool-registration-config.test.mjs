import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Source-shape regression guards for the webSearch.enabled config gate
// (upstream 22cdb46). Adapted to this fork: WebSearchConfig lives in
// workflow.ts; the gate itself is in index.ts.

const workflowSrc = readFileSync(new URL("../workflow.ts", import.meta.url), "utf8");
const indexSrc = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const readmeSrc = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("WebSearchConfig declares the webSearch.enabled gate", () => {
	assert.match(workflowSrc, /webSearch\?: \{\n\t\tenabled\?: boolean;\n\t\};/);
});

test("web_search registration is gated by webSearch.enabled", () => {
	assert.match(indexSrc, /if \(initConfig\.webSearch\?\.enabled !== false\) pi\.registerTool\(\{\n\t\tname: "web_search"/);
});

test("fetch tools remain registered outside the web_search gate", () => {
	const gateIndex = indexSrc.indexOf('if (initConfig.webSearch?.enabled !== false)');
	const fetchIndex = indexSrc.indexOf('name: "fetch_content"');
	assert.ok(gateIndex >= 0, "web_search gate not found");
	assert.ok(fetchIndex > gateIndex, "fetch_content registration should remain after the web_search gate");
});

test("README documents webSearch.enabled", () => {
	assert.match(readmeSrc, /"webSearch": \{ "enabled": true \}/);
	assert.match(readmeSrc, /webSearch\.enabled` to `false` to unregister the `web_search` tool/);
});
