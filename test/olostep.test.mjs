import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Exercises the REAL providers/olostep.ts module end-to-end. Each case runs in
// a child process (`--import tsx`) with an isolated HOME + PI_CODING_AGENT_DIR
// and a cleared OLOSTEP_API_KEY, so module-level config reads start clean.
// Pattern matches test/searxng.test.mjs / test/parallel.test.mjs.
const ololstepModuleUrl = new URL("../providers/olostep.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	// Clear search-config inputs so availability starts from a known state.
	delete childEnv.OLOSTEP_API_KEY;
	delete childEnv.PI_CODING_AGENT_DIR;
	delete childEnv.XDG_CONFIG_HOME;
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete childEnv[key];
		else childEnv[key] = value;
	}
	const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
	});
	assert.equal(child.status, 0, child.stderr);
	return child.stdout.trim();
}

async function freshHome(prefix) {
	const home = await mkdtemp(join(tmpdir(), prefix));
	return { home, agentDir: home };
}

test("isOlostepAvailable returns false with no API key configured", async () => {
	const { home, agentDir } = await freshHome("pi-olostep-none-");
	const out = runChild(
		`const { isOlostepAvailable } = await import(${JSON.stringify(ololstepModuleUrl)});
		 console.log(JSON.stringify({ available: isOlostepAvailable() }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir },
	);
	assert.equal(JSON.parse(out).available, false);
});

test("isOlostepAvailable returns true when OLOSTEP_API_KEY is set", async () => {
	const { home, agentDir } = await freshHome("pi-olostep-env-");
	const out = runChild(
		`const { isOlostepAvailable } = await import(${JSON.stringify(ololstepModuleUrl)});
		 console.log(JSON.stringify({ available: isOlostepAvailable() }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, OLOSTEP_API_KEY: "olostep-test-key" },
	);
	assert.equal(JSON.parse(out).available, true);
});

test("isOlostepAvailable treats placeholder values as missing", async () => {
	const { home, agentDir } = await freshHome("pi-olostep-placeholder-");
	const out = runChild(
		`const { isOlostepAvailable } = await import(${JSON.stringify(ololstepModuleUrl)});
		 console.log(JSON.stringify({ available: isOlostepAvailable() }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, OLOSTEP_API_KEY: "your-key" },
	);
	// Shared normalizeApiKey rejects placeholders so a leftover doc value can't 401 mid-fallback.
	assert.equal(JSON.parse(out).available, false);
});

test("searchWithOlostep returns null with no API key (yields to fallback)", async () => {
	const { home, agentDir } = await freshHome("pi-olostep-nokey-");
	const out = runChild(
		`const { searchWithOlostep } = await import(${JSON.stringify(ololstepModuleUrl)});
		 const result = await searchWithOlostep("test");
		 console.log(JSON.stringify({ result }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir },
	);
	assert.equal(JSON.parse(out).result, null);
});

test("searchWithOlostep sends correct request and maps the response", async () => {
	const { home, agentDir } = await freshHome("pi-olostep-search-");
	const out = runChild(
		`let capturedUrl = "";
		 let capturedInit = null;
		 globalThis.fetch = async (url, init) => {
			 capturedUrl = String(url);
			 capturedInit = init;
			 return new Response(JSON.stringify({
				 answer: "Pi Web Access is a Pi extension.",
				 results: [
					 { url: "https://github.com/nathanpt/pi-web-access", title: "Pi Web Access", description: "repo" },
					 { url: "https://example.com/x", title: "", description: "other" },
				 ],
			 }), { status: 200, headers: { "content-type": "application/json" } });
		 };
		 const { searchWithOlostep } = await import(${JSON.stringify(ololstepModuleUrl)});
		 const result = await searchWithOlostep("pi web access", {
			 numResults: 7,
			 recencyFilter: "week",
			 domainFilter: ["github.com", "-example.com"],
		 });
		 const body = JSON.parse(capturedInit.body);
		 console.log(JSON.stringify({
			 url: capturedUrl,
			 method: capturedInit.method,
			 auth: capturedInit.headers.Authorization,
			 body,
			 result,
		 }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, OLOSTEP_API_KEY: "olostep-test-key" },
	);
	const output = JSON.parse(out);
	assert.equal(output.url, "https://api.olostep.com/v1/answers");
	assert.equal(output.method, "POST");
	assert.equal(output.auth, "Bearer olostep-test-key");
	assert.equal(output.body.query, "pi web access");
	assert.equal(output.body.numResults, 7);
	assert.equal(output.body.recencyFilter, "week");
	assert.deepEqual(output.body.domainFilter, ["github.com"]);
	assert.deepEqual(output.body.excludeDomains, ["example.com"]);
	assert.equal(output.result.answer, "Pi Web Access is a Pi extension.");
	assert.deepEqual(output.result.results, [
		{ url: "https://github.com/nathanpt/pi-web-access", title: "Pi Web Access", snippet: "repo" },
		{ url: "https://example.com/x", title: "Source 2", snippet: "other" },
	]);
});

test("searchWithOlostep omits numResults when it equals the default (5)", async () => {
	const { home, agentDir } = await freshHome("pi-olostep-defaultnum-");
	const out = runChild(
		`let capturedBody = null;
		 globalThis.fetch = async (url, init) => {
			 capturedBody = JSON.parse(init.body);
			 return new Response(JSON.stringify({ answer: "a", results: [] }), { status: 200 });
		 };
		 const { searchWithOlostep } = await import(${JSON.stringify(ololstepModuleUrl)});
		 await searchWithOlostep("x", { numResults: 5 });
		 console.log(JSON.stringify({ hasNumResults: "numResults" in capturedBody }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, OLOSTEP_API_KEY: "olostep-test-key" },
	);
	assert.equal(JSON.parse(out).hasNumResults, false);
});

test("searchWithOlostep surfaces a non-ok response as a thrown error", async () => {
	const { home, agentDir } = await freshHome("pi-olostep-error-");
	const out = runChild(
		`globalThis.fetch = async () => new Response("upstream error", { status: 502 });
		 const { searchWithOlostep } = await import(${JSON.stringify(ololstepModuleUrl)});
		 try { await searchWithOlostep("x"); console.log(JSON.stringify({ threw: false })); }
		 catch (err) { console.log(JSON.stringify({ threw: true, msg: err.message })); }`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, OLOSTEP_API_KEY: "olostep-test-key" },
	);
	const result = JSON.parse(out);
	assert.equal(result.threw, true);
	assert.match(result.msg, /Olostep API error 502/);
});

test("extractWithOlostep returns null with no API key (yields to fallback)", async () => {
	const { home, agentDir } = await freshHome("pi-olostep-extract-nokey-");
	const out = runChild(
		`const { extractWithOlostep } = await import(${JSON.stringify(ololstepModuleUrl)});
		 const result = await extractWithOlostep("https://example.com/page");
		 console.log(JSON.stringify({ result }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir },
	);
	assert.equal(JSON.parse(out).result, null);
});

test("extractWithOlostep scrapes markdown and returns ExtractedContent on success", async () => {
	const { home, agentDir } = await freshHome("pi-olostep-extract-ok-");
	const out = runChild(
		`let capturedBody = null;
		 globalThis.fetch = async (url, init) => {
			 capturedBody = JSON.parse(init.body);
			 return new Response(JSON.stringify({
				 markdown_content: "# Title\\n\\nPage body text.",
				 page_title: "Title",
				 url: "https://example.com/page",
			 }), { status: 200, headers: { "content-type": "application/json" } });
		 };
		 const { extractWithOlostep } = await import(${JSON.stringify(ololstepModuleUrl)});
		 const result = await extractWithOlostep("https://example.com/page");
		 console.log(JSON.stringify({ capturedBody, result }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, OLOSTEP_API_KEY: "olostep-test-key" },
	);
	const output = JSON.parse(out);
	assert.deepEqual(output.capturedBody, { url: "https://example.com/page", formats: ["markdown"] });
	assert.deepEqual(output.result, {
		url: "https://example.com/page",
		title: "Title",
		content: "# Title\n\nPage body text.",
		error: null,
	});
});

test("extractWithOlostep returns null on a non-ok response (yields, does not short-circuit)", async () => {
	const { home, agentDir } = await freshHome("pi-olostep-extract-err-");
	const out = runChild(
		`globalThis.fetch = async () => new Response("blocked", { status: 403 });
		 const { extractWithOlostep } = await import(${JSON.stringify(ololstepModuleUrl)});
		 const result = await extractWithOlostep("https://example.com/page");
		 console.log(JSON.stringify({ result }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, OLOSTEP_API_KEY: "olostep-test-key" },
	);
	// Chain convention: null = yield to the next fallback (a truthy error-result would short-circuit).
	assert.equal(JSON.parse(out).result, null);
});

test("extractWithOlostep returns null when markdown_content is empty", async () => {
	const { home, agentDir } = await freshHome("pi-olostep-extract-empty-");
	const out = runChild(
		`globalThis.fetch = async () => new Response(JSON.stringify({ markdown_content: "   ", page_title: "", url: "https://example.com/page" }), { status: 200 });
		 const { extractWithOlostep } = await import(${JSON.stringify(ololstepModuleUrl)});
		 const result = await extractWithOlostep("https://example.com/page");
		 console.log(JSON.stringify({ result }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, OLOSTEP_API_KEY: "olostep-test-key" },
	);
	assert.equal(JSON.parse(out).result, null);
});
