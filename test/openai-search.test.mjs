import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Exercises the REAL providers/openai-search.ts module end-to-end. Each case
// runs in a child process (`--import tsx`) with an isolated HOME +
// PI_CODING_AGENT_DIR and a cleared OPENAI_API_KEY, so module-level config
// reads start clean. Pattern matches test/olostep.test.mjs / test/brave.test.mjs.
const openaiModuleUrl = new URL("../providers/openai-search.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	delete childEnv.OPENAI_API_KEY;
	delete childEnv.OPENAI_BASE_URL;
	delete childEnv.OPENAI_SEARCH_MODEL;
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

test("isOpenAISearchAvailable returns false with no API key configured", async () => {
	const { home, agentDir } = await freshHome("pi-openai-none-");
	const out = runChild(
		`const { isOpenAISearchAvailable } = await import(${JSON.stringify(openaiModuleUrl)});
		 console.log(JSON.stringify({ available: isOpenAISearchAvailable() }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir },
	);
	assert.equal(JSON.parse(out).available, false);
});

test("isOpenAISearchAvailable returns true when OPENAI_API_KEY is set", async () => {
	const { home, agentDir } = await freshHome("pi-openai-env-");
	const out = runChild(
		`const { isOpenAISearchAvailable } = await import(${JSON.stringify(openaiModuleUrl)});
		 console.log(JSON.stringify({ available: isOpenAISearchAvailable() }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, OPENAI_API_KEY: "sk-test-key" },
	);
	assert.equal(JSON.parse(out).available, true);
});

test("isOpenAISearchAvailable treats placeholder values as missing", async () => {
	const { home, agentDir } = await freshHome("pi-openai-placeholder-");
	const out = runChild(
		`const { isOpenAISearchAvailable } = await import(${JSON.stringify(openaiModuleUrl)});
		 console.log(JSON.stringify({ available: isOpenAISearchAvailable() }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, OPENAI_API_KEY: "placeholder" },
	);
	assert.equal(JSON.parse(out).available, false);
});

test("searchWithOpenAI returns null with no API key (yields to fallback)", async () => {
	const { home, agentDir } = await freshHome("pi-openai-nokey-");
	const out = runChild(
		`const { searchWithOpenAI } = await import(${JSON.stringify(openaiModuleUrl)});
		 const result = await searchWithOpenAI("test");
		 console.log(JSON.stringify({ result }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir },
	);
	assert.equal(JSON.parse(out).result, null);
});

test("searchWithOpenAI requires web_search and maps domain filters + parses citations", async () => {
	const { home, agentDir } = await freshHome("pi-openai-search-");
	const out = runChild(
		`let capturedUrl = "";
		 let capturedInit = null;
		 globalThis.fetch = async (url, init) => {
			 capturedUrl = String(url);
			 capturedInit = init;
			 // Single-JSON Responses shape: a message with a url_citation + a
			 // web_search_call with extra sources. Tests both extraction passes.
			 return new Response(JSON.stringify({
				 output: [
					 { type: "message", content: [{ type: "output_text", text: "OpenAI synthesized answer with [OpenAI](https://openai.com/docs?utm_source=openai).", annotations: [{ type: "url_citation", url: "https://openai.com/docs?utm_source=openai", title: "OpenAI Docs", start_index: 0, end_index: 10 }] }] },
					 { type: "web_search_call", action: { sources: [{ url: "https://openai.com/blog", title: "Blog" }] } },
				 ],
			 }), { status: 200, headers: { "content-type": "application/json" } });
		 };
		 const { searchWithOpenAI } = await import(${JSON.stringify(openaiModuleUrl)});
		 const result = await searchWithOpenAI("openai web search", {
			 numResults: 5,
			 domainFilter: ["openai.com", "-reddit.com"],
		 });
		 const body = JSON.parse(capturedInit.body);
		 console.log(JSON.stringify({ url: capturedUrl, auth: capturedInit.headers.Authorization, beta: capturedInit.headers["OpenAI-Beta"], body, result }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, OPENAI_API_KEY: "sk-test-key" },
	);
	const output = JSON.parse(out);
	assert.equal(output.url, "https://api.openai.com/v1/responses");
	assert.equal(output.auth, "Bearer sk-test-key");
	assert.equal(output.beta, "responses=experimental");
	// tool_choice required, web_search tool with domain filters, include sources.
	assert.equal(output.body.tool_choice, "required");
	assert.deepEqual(output.body.include, ["web_search_call.action.sources"]);
	assert.equal(output.body.tools[0].type, "web_search");
	assert.deepEqual(output.body.tools[0].filters, { allowed_domains: ["openai.com"], blocked_domains: ["reddit.com"] });
	assert.equal(output.result.answer, "OpenAI synthesized answer with [OpenAI](https://openai.com/docs?utm_source=openai).");
	// Citations first (utm_source stripped), then web_search_call sources; deduped.
	assert.deepEqual(output.result.results.map((r) => r.url), ["https://openai.com/docs", "https://openai.com/blog"]);
});

test("searchWithOpenAI parses an SSE-streamed response", async () => {
	const { home, agentDir } = await freshHome("pi-openai-sse-");
	const out = runChild(
		`globalThis.fetch = async () => {
			 const items = [
				 { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "streamed answer", annotations: [] }] } },
			 ];
			 const lines = items.map((i) => "data: " + JSON.stringify(i)).join("\\n") + "\\n";
			 return new Response(lines, { status: 200, headers: { "content-type": "text/event-stream" } });
		 };
		 const { searchWithOpenAI } = await import(${JSON.stringify(openaiModuleUrl)});
		 const result = await searchWithOpenAI("x");
		 console.log(JSON.stringify({ answer: result.answer }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, OPENAI_API_KEY: "sk-test-key" },
	);
	assert.equal(JSON.parse(out).answer, "streamed answer");
});

test("searchWithOpenAI surfaces a non-ok response as a thrown error", async () => {
	const { home, agentDir } = await freshHome("pi-openai-error-");
	const out = runChild(
		`globalThis.fetch = async () => new Response("rate limited", { status: 429 });
		 const { searchWithOpenAI } = await import(${JSON.stringify(openaiModuleUrl)});
		 try { await searchWithOpenAI("x"); console.log(JSON.stringify({ threw: false })); }
		 catch (err) { console.log(JSON.stringify({ threw: true, msg: err.message })); }`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, OPENAI_API_KEY: "sk-test-key" },
	);
	const result = JSON.parse(out);
	assert.equal(result.threw, true);
	assert.match(result.msg, /OpenAI API error 429/);
});
