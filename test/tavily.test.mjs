import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Exercises the REAL providers/tavily.ts module end-to-end. Each case runs in a
// child process (`--import tsx`) with an isolated HOME + PI_CODING_AGENT_DIR
// and a cleared TAVILY_API_KEY, so module-level config reads start clean.
// Pattern matches test/olostep.test.mjs / test/brave.test.mjs.
const tavilyModuleUrl = new URL("../providers/tavily.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	delete childEnv.TAVILY_API_KEY;
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

test("isTavilyAvailable returns false with no API key configured", async () => {
	const { home, agentDir } = await freshHome("pi-tavily-none-");
	const out = runChild(
		`const { isTavilyAvailable } = await import(${JSON.stringify(tavilyModuleUrl)});
		 console.log(JSON.stringify({ available: isTavilyAvailable() }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir },
	);
	assert.equal(JSON.parse(out).available, false);
});

test("isTavilyAvailable returns true when TAVILY_API_KEY is set", async () => {
	const { home, agentDir } = await freshHome("pi-tavily-env-");
	const out = runChild(
		`const { isTavilyAvailable } = await import(${JSON.stringify(tavilyModuleUrl)});
		 console.log(JSON.stringify({ available: isTavilyAvailable() }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, TAVILY_API_KEY: "tvly-test-key" },
	);
	assert.equal(JSON.parse(out).available, true);
});

test("isTavilyAvailable treats placeholder values as missing", async () => {
	const { home, agentDir } = await freshHome("pi-tavily-placeholder-");
	const out = runChild(
		`const { isTavilyAvailable } = await import(${JSON.stringify(tavilyModuleUrl)});
		 console.log(JSON.stringify({ available: isTavilyAvailable() }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, TAVILY_API_KEY: "<your-api-key>" },
	);
	assert.equal(JSON.parse(out).available, false);
});

test("searchWithTavily returns null with no API key (yields to fallback)", async () => {
	const { home, agentDir } = await freshHome("pi-tavily-nokey-");
	const out = runChild(
		`const { searchWithTavily } = await import(${JSON.stringify(tavilyModuleUrl)});
		 const result = await searchWithTavily("test");
		 console.log(JSON.stringify({ result }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir },
	);
	assert.equal(JSON.parse(out).result, null);
});

test("searchWithTavily uses bearer auth and maps filters + content", async () => {
	const { home, agentDir } = await freshHome("pi-tavily-search-");
	const out = runChild(
		`let capturedUrl = "";
		 let capturedInit = null;
		 globalThis.fetch = async (url, init) => {
			 capturedUrl = String(url);
			 capturedInit = init;
			 return new Response(JSON.stringify({
				 answer: "Tavily synthesized answer.",
				 results: [
					 { url: "https://docs.tavily.com", title: "Docs", content: "the docs", raw_content: "# Docs\\n\\nbody" },
					 { url: "https://example.com/x", title: "", content: "other" },
				 ],
			 }), { status: 200, headers: { "content-type": "application/json" } });
		 };
		 const { searchWithTavily } = await import(${JSON.stringify(tavilyModuleUrl)});
		 const result = await searchWithTavily("tavily api", {
			 numResults: 4,
			 recencyFilter: "week",
			 domainFilter: ["docs.tavily.com", "-reddit.com"],
			 includeContent: true,
		 });
		 const body = JSON.parse(capturedInit.body);
		 console.log(JSON.stringify({ url: capturedUrl, method: capturedInit.method, auth: capturedInit.headers.Authorization, body, result }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, TAVILY_API_KEY: "tvly-test-key" },
	);
	const output = JSON.parse(out);
	assert.equal(output.url, "https://api.tavily.com/search");
	assert.equal(output.method, "POST");
	assert.equal(output.auth, "Bearer tvly-test-key");
	assert.equal(output.body.query, "tavily api");
	assert.equal(output.body.search_depth, "basic");
	assert.equal(output.body.max_results, 4);
	assert.equal(output.body.include_answer, "basic");
	assert.equal(output.body.include_raw_content, "markdown"); // includeContent true
	assert.equal(output.body.time_range, "week");
	assert.deepEqual(output.body.include_domains, ["docs.tavily.com"]);
	assert.deepEqual(output.body.exclude_domains, ["reddit.com"]);
	assert.equal(output.result.answer, "Tavily synthesized answer.");
	assert.deepEqual(output.result.results, [
		{ url: "https://docs.tavily.com", title: "Docs", snippet: "the docs" },
		{ url: "https://example.com/x", title: "Source 2", snippet: "other" },
	]);
	// inlineContent populated from raw_content (markdown) — Tavily is the only batch provider with it.
	assert.deepEqual(output.result.inlineContent, [
		{ url: "https://docs.tavily.com", title: "Docs", content: "# Docs\n\nbody", error: null },
	]);
});

test("searchWithTavily omits inlineContent when includeContent is false", async () => {
	const { home, agentDir } = await freshHome("pi-tavily-nocontent-");
	const out = runChild(
		`let capturedBody = null;
		 globalThis.fetch = async (url, init) => {
			 capturedBody = JSON.parse(init.body);
			 return new Response(JSON.stringify({ answer: "a", results: [{ url: "https://x.com", title: "X", content: "c", raw_content: "raw" }] }), { status: 200 });
		 };
		 const { searchWithTavily } = await import(${JSON.stringify(tavilyModuleUrl)});
		 const result = await searchWithTavily("x", { numResults: 5 });
		 console.log(JSON.stringify({ raw: capturedBody.include_raw_content, hasInline: "inlineContent" in result }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, TAVILY_API_KEY: "tvly-test-key" },
	);
	const output = JSON.parse(out);
	assert.equal(output.raw, false);
	assert.equal(output.hasInline, false);
});

test("searchWithTavily surfaces a non-ok response as a thrown error", async () => {
	const { home, agentDir } = await freshHome("pi-tavily-error-");
	const out = runChild(
		`globalThis.fetch = async () => new Response("unauthorized", { status: 401 });
		 const { searchWithTavily } = await import(${JSON.stringify(tavilyModuleUrl)});
		 try { await searchWithTavily("x"); console.log(JSON.stringify({ threw: false })); }
		 catch (err) { console.log(JSON.stringify({ threw: true, msg: err.message })); }`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, TAVILY_API_KEY: "tvly-test-key" },
	);
	const result = JSON.parse(out);
	assert.equal(result.threw, true);
	assert.match(result.msg, /Tavily API error 401/);
});
