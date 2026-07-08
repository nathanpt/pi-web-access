import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const firecrawlModuleUrl = new URL("../providers/firecrawl.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	delete childEnv.FIRECRAWL_BASE_URL;
	delete childEnv.FIRECRAWL_API_KEY;
	delete childEnv.FIRECRAWL_BASIC_AUTH;
	delete childEnv.PI_CODING_AGENT_DIR;
	delete childEnv.XDG_CONFIG_HOME;
	for (const [key, value] of Object.entries(env)) {
		childEnv[key] = value;
	}
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

test("Firecrawl search uses bearer auth and maps results", async () => {
	const child = runChild(`
		let capturedUrl = "";
		let capturedHeaders = null;
		let capturedBody = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = init.headers;
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({
				success: true,
				data: [
					{ title: "Firecrawl Docs", url: "https://docs.firecrawl.dev", description: "Firecrawl docs snippet" },
				],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { isFirecrawlAvailable, searchWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
		const available = isFirecrawlAvailable();
		const result = await searchWithFirecrawl("firecrawl docs", { numResults: 1 });
		console.log(JSON.stringify({ available, capturedUrl, capturedHeaders, capturedBody, result }));
	`, { FIRECRAWL_BASE_URL: "http://localhost:3002", FIRECRAWL_API_KEY: "fc-test-key" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.available, true);
	assert.equal(output.capturedUrl, "http://localhost:3002/v1/search");
	assert.equal(output.capturedHeaders.Authorization, "Bearer fc-test-key");
	assert.equal(output.capturedBody.query, "firecrawl docs");
	assert.equal(output.capturedBody.limit, 1);
	assert.deepEqual(output.capturedBody.scrapeOptions, { formats: [] });
	assert.deepEqual(output.result.results, [
		{ title: "Firecrawl Docs", url: "https://docs.firecrawl.dev", snippet: "Firecrawl docs snippet" },
	]);
});

test("Firecrawl search uses basic auth when FIRECRAWL_BASIC_AUTH is set", async () => {
	const child = runChild(`
		let capturedHeaders = null;
		globalThis.fetch = async (url, init) => {
			capturedHeaders = init.headers;
			return new Response(JSON.stringify({ success: true, data: [] }), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { searchWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
		await searchWithFirecrawl("test", { numResults: 1 }).catch(() => {});
		console.log(JSON.stringify({ auth: capturedHeaders.Authorization }));
	`, { FIRECRAWL_BASE_URL: "http://localhost:3002", FIRECRAWL_BASIC_AUTH: "user:pass" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	const expected = Buffer.from("user:pass").toString("base64");
	assert.equal(output.auth, "Basic " + expected);
});

test("Firecrawl is not available without FIRECRAWL_BASE_URL", async () => {
	const child = runChild(`
		const { isFirecrawlAvailable } = await import(${JSON.stringify(firecrawlModuleUrl)});
		console.log(JSON.stringify({ available: isFirecrawlAvailable() }));
	`, {});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.available, false);
});

test("Firecrawl extraction returns null when unconfigured", async () => {
	const child = runChild(`
		const { extractWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
		const result = await extractWithFirecrawl("https://example.com");
		console.log(JSON.stringify({ result }));
	`, {});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.result, null);
});

test("Firecrawl extraction returns content on successful scrape", async () => {
	const child = runChild(`
		let capturedUrl = "";
		let capturedBody = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({
				success: true,
				data: {
					markdown: "# Extracted Content\\n\\nThis is the page content.",
					metadata: { title: "Test Page" },
				},
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { extractWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
		const result = await extractWithFirecrawl("https://example.com/page");
		console.log(JSON.stringify({ capturedUrl, capturedBody, result }));
	`, { FIRECRAWL_BASE_URL: "http://localhost:3002" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.capturedUrl, "http://localhost:3002/v1/scrape");
	assert.equal(output.capturedBody.url, "https://example.com/page");
	assert.deepEqual(output.capturedBody.formats, ["markdown"]);
	assert.equal(output.result.title, "Test Page");
	assert.equal(output.result.content, "# Extracted Content\n\nThis is the page content.");
	assert.equal(output.result.error, null);
});

test("Firecrawl extraction returns null on failed scrape", async () => {
	const child = runChild(`
		globalThis.fetch = async () => {
			return new Response(JSON.stringify({ success: false, error: "Blocked" }), { status: 200, headers: { "content-type": "application/json" } });
		};
		const { extractWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
		const result = await extractWithFirecrawl("https://blocked.example.com");
		console.log(JSON.stringify({ result }));
	`, { FIRECRAWL_BASE_URL: "http://localhost:3002" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.result, null);
});
