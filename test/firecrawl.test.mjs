import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Exercises the REAL providers/firecrawl.ts module end-to-end. Each case runs
// in a child process (`--import tsx`) with an isolated HOME + PI_CODING_AGENT_DIR
// and cleared FIRECRAWL_* env, so module-level config reads start clean.
// Pattern matches test/searxng.test.mjs (self-hosted, base-URL-driven analogue)
// and test/brightdata.test.mjs (fetch-mock + activity-widget conventions).
const firecrawlModuleUrl = new URL("../providers/firecrawl.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	// Clear search-config inputs so availability starts from a known state.
	delete childEnv.FIRECRAWL_BASE_URL;
	delete childEnv.FIRECRAWL_API_KEY;
	delete childEnv.FIRECRAWL_BASIC_AUTH;
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

test("isFirecrawlAvailable returns false with no base URL configured", async () => {
	const { home, agentDir } = await freshHome("pi-firecrawl-none-");
	const out = runChild(
		`const { isFirecrawlAvailable } = await import(${JSON.stringify(firecrawlModuleUrl)});
		 console.log(JSON.stringify({ available: isFirecrawlAvailable() }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir },
	);
	assert.equal(JSON.parse(out).available, false);
});

test("isFirecrawlAvailable returns true when FIRECRAWL_BASE_URL is set", async () => {
	const { home, agentDir } = await freshHome("pi-firecrawl-env-");
	const out = runChild(
		`const { isFirecrawlAvailable } = await import(${JSON.stringify(firecrawlModuleUrl)});
		 console.log(JSON.stringify({ available: isFirecrawlAvailable() }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, FIRECRAWL_BASE_URL: "http://localhost:3002" },
	);
	assert.equal(JSON.parse(out).available, true);
});

test("isFirecrawlAvailable rejects non-http base URLs", async () => {
	const { home, agentDir } = await freshHome("pi-firecrawl-file-");
	const out = runChild(
		`const { isFirecrawlAvailable } = await import(${JSON.stringify(firecrawlModuleUrl)});
		 console.log(JSON.stringify({ available: isFirecrawlAvailable() }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, FIRECRAWL_BASE_URL: "file:///etc/passwd" },
	);
	assert.equal(JSON.parse(out).available, false);
});

test("searchWithFirecrawl throws a clear missing-config error naming both config and env", async () => {
	const { home, agentDir } = await freshHome("pi-firecrawl-missing-");
	const out = runChild(
		`const { searchWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
		 try { await searchWithFirecrawl("x"); console.log(JSON.stringify({ threw: false })); }
		 catch (err) { console.log(JSON.stringify({ threw: true, msg: err.message })); }`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir },
	);
	const result = JSON.parse(out);
	assert.equal(result.threw, true);
	assert.match(result.msg, /firecrawlBaseUrl/);
	assert.match(result.msg, /FIRECRAWL_BASE_URL/);
});

test("searchWithFirecrawl POSTs to /v1/search, sends Bearer auth, maps data[], synthesizes answer", async () => {
	const { home, agentDir } = await freshHome("pi-firecrawl-search-");
	const out = runChild(
		`const { searchWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
		 let capturedUrl = "";
		 let capturedMethod = "";
		 let capturedHeaders = null;
		 let capturedBody = null;
		 globalThis.fetch = async (url, init) => {
			 capturedUrl = String(url);
			 capturedMethod = init.method;
			 capturedHeaders = init.headers;
			 capturedBody = JSON.parse(init.body);
			 return new Response(JSON.stringify({
				 success: true,
				 data: [
					 { title: "Firecrawl docs", url: "https://docs.firecrawl.dev", description: "Official docs" },
					 { title: "No desc", url: "https://example.com/node" },
				 ],
			 }), { status: 200, headers: { "content-type": "application/json" } });
		 };
		 const result = await searchWithFirecrawl("firecrawl", { numResults: 5 });
		 console.log(JSON.stringify({
			 url: capturedUrl,
			 method: capturedMethod,
			 auth: capturedHeaders.Authorization,
			 body: capturedBody,
			 result,
		 }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, FIRECRAWL_BASE_URL: "http://localhost:3002", FIRECRAWL_API_KEY: "fc-test-key" },
	);
	const output = JSON.parse(out);
	assert.equal(output.url, "http://localhost:3002/v1/search");
	assert.equal(output.method, "POST");
	assert.equal(output.auth, "Bearer fc-test-key");
	assert.equal(output.body.query, "firecrawl");
	assert.equal(output.body.limit, 5);
	assert.deepEqual(output.body.scrapeOptions, { formats: [] });
	assert.deepEqual(output.result.results, [
		{ title: "Firecrawl docs", url: "https://docs.firecrawl.dev", snippet: "Official docs" },
		{ title: "No desc", url: "https://example.com/node", snippet: "" },
	]);
	assert.match(output.result.answer, /Official docs/);
	assert.match(output.result.answer, /Source: Firecrawl docs \(https:\/\/docs\.firecrawl\.dev\)/);
	assert.match(output.result.answer, /Source: No desc \(https:\/\/example\.com\/node\)/);
});

test("searchWithFirecrawl sends HTTP Basic auth from FIRECRAWL_BASIC_AUTH (user:pass → base64)", async () => {
	const { home, agentDir } = await freshHome("pi-firecrawl-basic-");
	const out = runChild(
		`const { searchWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
		 let capturedHeaders = null;
		 globalThis.fetch = async (url, init) => {
			 capturedHeaders = init.headers;
			 return new Response(JSON.stringify({ success: true, data: [] }), { status: 200, headers: { "content-type": "application/json" } });
		 };
		 await searchWithFirecrawl("x");
		 console.log(JSON.stringify({ auth: capturedHeaders.Authorization }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, FIRECRAWL_BASE_URL: "http://localhost:3002", FIRECRAWL_BASIC_AUTH: "alice:secret" },
	);
	const output = JSON.parse(out);
	// "alice:secret" → base64
	assert.equal(output.auth, `Basic ${Buffer.from("alice:secret").toString("base64")}`);
});

test("searchWithFirecrawl applies domain include/exclude client-side", async () => {
	const { home, agentDir } = await freshHome("pi-firecrawl-domains-");
	const out = runChild(
		`const { searchWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
		 globalThis.fetch = async () => new Response(JSON.stringify({
			 success: true,
			 data: [
				 { title: "Pi Web Access", url: "https://github.com/nathanpt/pi-web-access", description: "repo" },
				 { title: "Blocked", url: "https://gist.github.com/nathanpt/abc", description: "blocked" },
				 { title: "Other", url: "https://example.com/nope", description: "other" },
			 ],
		 }), { status: 200, headers: { "content-type": "application/json" } });
		 const result = await searchWithFirecrawl("pi", {
			 domainFilter: ["github.com", "-gist.github.com"],
			 numResults: 5,
		 });
		 console.log(JSON.stringify({ urls: result.results.map(r => r.url) }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, FIRECRAWL_BASE_URL: "http://localhost:3002" },
	);
	const output = JSON.parse(out);
	assert.deepEqual(output.urls, ["https://github.com/nathanpt/pi-web-access"]);
});

test("searchWithFirecrawl surfaces a non-2xx as an error", async () => {
	const { home, agentDir } = await freshHome("pi-firecrawl-403-");
	const out = runChild(
		`globalThis.fetch = async () => new Response("forbidden", { status: 403 });
		 const { searchWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
		 try { await searchWithFirecrawl("x"); console.log(JSON.stringify({ threw: false })); }
		 catch (err) { console.log(JSON.stringify({ threw: true, msg: err.message })); }`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, FIRECRAWL_BASE_URL: "http://localhost:3002" },
	);
	const result = JSON.parse(out);
	assert.equal(result.threw, true);
	assert.match(result.msg, /403/);
});

test("extractWithFirecrawl returns content on a successful scrape", async () => {
	const { home, agentDir } = await freshHome("pi-firecrawl-scrape-");
	const out = runChild(
		`const { extractWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
		 let capturedUrl = "";
		 let capturedBody = null;
		 globalThis.fetch = async (url, init) => {
			 capturedUrl = String(url);
			 capturedBody = JSON.parse(init.body);
			 return new Response(JSON.stringify({
				 success: true,
				 data: {
					 url: "https://example.com/page",
					 markdown: "# Hello\\n\\nWorld",
					 title: "Page Title",
					 metadata: { title: "Meta Title" },
				 },
			 }), { status: 200, headers: { "content-type": "application/json" } });
		 };
		 const result = await extractWithFirecrawl("https://example.com/page");
		 console.log(JSON.stringify({ url: capturedUrl, body: capturedBody, result }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, FIRECRAWL_BASE_URL: "http://localhost:3002" },
	);
	const output = JSON.parse(out);
	assert.equal(output.url, "http://localhost:3002/v1/scrape");
	assert.deepEqual(output.body, { url: "https://example.com/page", formats: ["markdown"] });
	// metadata.title takes precedence over the top-level title (matches the ExtractedContent shape).
	assert.equal(output.result.title, "Meta Title");
	assert.equal(output.result.content, "# Hello\n\nWorld");
	assert.equal(output.result.url, "https://example.com/page");
	assert.equal(output.result.error, null);
});

test("extractWithFirecrawl returns null on failure paths (success:false, missing data, no base URL)", async () => {
	const { home, agentDir } = await freshHome("pi-firecrawl-null-");
	const out = runChild(
		`const { extractWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
		 const calls = [];
		 globalThis.fetch = async () => {
			 calls.push("fetch");
			 return new Response(JSON.stringify({ success: false, error: "boom" }), { status: 200, headers: { "content-type": "application/json" } });
		 };

		 const noBaseUrl = await extractWithFirecrawl("https://example.com/a");

		 // Re-import with FIRECRAWL_BASE_URL effective (env already set in runChild).
		 const falseResult = await extractWithFirecrawl("https://example.com/b");

		 globalThis.fetch = async () => new Response(JSON.stringify({ success: true }), { status: 200, headers: { "content-type": "application/json" } });
		 const missingData = await extractWithFirecrawl("https://example.com/c");

		 console.log(JSON.stringify({
			 fetchCallCount: calls.length,
			 noBaseUrl,
			 falseResult,
			 missingData,
		 }));`,
		// Two-phase: first run has NO base URL, second phase needs one. We do the
		// "no base URL" assertion in a separate child below; here just exercise the
		// success:false + missing-data paths with a base URL set.
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, FIRECRAWL_BASE_URL: "http://localhost:3002" },
	);
	const output = JSON.parse(out);
	// With a base URL set throughout this child, noBaseUrl is actually a
	// success:false response (the first fetch override). The dedicated no-base-URL
	// child below asserts the true "no base URL" path.
	assert.equal(output.falseResult, null, "success:false → null");
	assert.equal(output.missingData, null, "missing data field → null");

	// Dedicated child for the no-base-URL path.
	const { home: home2, agentDir: agentDir2 } = await freshHome("pi-firecrawl-nobase-");
	const out2 = runChild(
		`const { extractWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
		 globalThis.fetch = async () => { throw new Error("fetch must not be called without a base URL"); };
		 const result = await extractWithFirecrawl("https://example.com/page");
		 console.log(JSON.stringify({ result }));`,
		{ HOME: home2, USERPROFILE: home2, PI_CODING_AGENT_DIR: agentDir2 },
	);
	assert.equal(JSON.parse(out2).result, null, "no base URL configured → null (fetch not called)");
});
