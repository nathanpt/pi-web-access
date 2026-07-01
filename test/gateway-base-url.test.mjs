import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Gateway-routing regression tests for the OpenAI Responses + Perplexity
// search providers (ports upstream #113, robobryce). Verifies the base-URL +
// model overrides (env > config > default) actually reach the outgoing fetch.
// Each case runs in a child process (`--import tsx`) with an isolated HOME +
// PI_CODING_AGENT_DIR and the relevant env vars cleared, mirroring
// test/openai-search.test.mjs.
const openaiModule = new URL("../providers/openai-search.ts", import.meta.url).href;
const perplexityModule = new URL("../providers/perplexity.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of [
		"OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_SEARCH_MODEL",
		"PERPLEXITY_API_KEY", "PERPLEXITY_BASE_URL", "PERPLEXITY_MODEL",
		"PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME",
	]) {
		delete childEnv[key];
	}
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

async function writeConfig(agentDir, obj) {
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify(obj) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// OpenAI Responses
// ---------------------------------------------------------------------------

test("OpenAI search routes through OPENAI_BASE_URL + OPENAI_SEARCH_MODEL (env)", async () => {
	const { home, agentDir } = await freshHome("pi-gw-openai-env-");
	const out = runChild(
		`let capturedUrl = "";
		 let capturedModel = "";
		 globalThis.fetch = async (url, init) => {
			 capturedUrl = String(url);
			 capturedModel = JSON.parse(init.body).model;
			 return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "ok", annotations: [] }] }] }), { status: 200, headers: { "content-type": "application/json" } });
		 };
		 const { searchWithOpenAI } = await import(${JSON.stringify(openaiModule)});
		 const res = await searchWithOpenAI("hello");
		 console.log(JSON.stringify({ url: capturedUrl, model: capturedModel, answer: res.answer }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, OPENAI_API_KEY: "sk-test", OPENAI_BASE_URL: "https://gw.example.com/v1", OPENAI_SEARCH_MODEL: "azure/openai/gpt-5.5" },
	);
	const o = JSON.parse(out);
	assert.equal(o.url, "https://gw.example.com/v1/responses");
	assert.equal(o.model, "azure/openai/gpt-5.5");
	assert.equal(o.answer, "ok");
});

test("OpenAI search defaults to the public endpoint + gpt-4.1-mini when unset", async () => {
	const { home, agentDir } = await freshHome("pi-gw-openai-default-");
	await writeConfig(agentDir, { openaiApiKey: "sk-test" });
	const out = runChild(
		`let capturedUrl = ""; let capturedModel = "";
		 globalThis.fetch = async (url, init) => {
			 capturedUrl = String(url); capturedModel = JSON.parse(init.body).model;
			 return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "ok", annotations: [] }] }] }), { status: 200, headers: { "content-type": "application/json" } });
		 };
		 const { searchWithOpenAI } = await import(${JSON.stringify(openaiModule)});
		 await searchWithOpenAI("hello");
		 console.log(JSON.stringify({ url: capturedUrl, model: capturedModel }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir },
	);
	const o = JSON.parse(out);
	assert.equal(o.url, "https://api.openai.com/v1/responses");
	assert.equal(o.model, "gpt-4.1-mini");
});

test("OpenAI search honors config-file openaiBaseUrl/openaiSearchModel", async () => {
	const { home, agentDir } = await freshHome("pi-gw-openai-cfg-");
	await writeConfig(agentDir, { openaiApiKey: "sk-test", openaiBaseUrl: "https://cfg.example.com/v1/", openaiSearchModel: "litellm/gpt-5.5" });
	const out = runChild(
		`let capturedUrl = ""; let capturedModel = "";
		 globalThis.fetch = async (url, init) => {
			 capturedUrl = String(url); capturedModel = JSON.parse(init.body).model;
			 return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "ok", annotations: [] }] }] }), { status: 200, headers: { "content-type": "application/json" } });
		 };
		 const { searchWithOpenAI } = await import(${JSON.stringify(openaiModule)});
		 await searchWithOpenAI("hello");
		 console.log(JSON.stringify({ url: capturedUrl, model: capturedModel }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir },
	);
	const o = JSON.parse(out);
	// trailing slash stripped by normalizeBaseUrl
	assert.equal(o.url, "https://cfg.example.com/v1/responses");
	assert.equal(o.model, "litellm/gpt-5.5");
});

test("OpenAI search: env base URL wins over config base URL", async () => {
	const { home, agentDir } = await freshHome("pi-gw-openai-precedence-");
	await writeConfig(agentDir, { openaiApiKey: "sk-test", openaiBaseUrl: "https://cfg.example.com/v1", openaiSearchModel: "from-config-model" });
	const out = runChild(
		`let capturedUrl = ""; let capturedModel = "";
		 globalThis.fetch = async (url, init) => {
			 capturedUrl = String(url); capturedModel = JSON.parse(init.body).model;
			 return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "ok", annotations: [] }] }] }), { status: 200, headers: { "content-type": "application/json" } });
		 };
		 const { searchWithOpenAI } = await import(${JSON.stringify(openaiModule)});
		 await searchWithOpenAI("hello");
		 console.log(JSON.stringify({ url: capturedUrl, model: capturedModel }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, OPENAI_BASE_URL: "https://env.example.com/v1" },
	);
	const o = JSON.parse(out);
	// env base wins; model falls through to config (no env model set)
	assert.equal(o.url, "https://env.example.com/v1/responses");
	assert.equal(o.model, "from-config-model");
});

// ---------------------------------------------------------------------------
// Perplexity
// ---------------------------------------------------------------------------

test("Perplexity search routes through PERPLEXITY_BASE_URL + PERPLEXITY_MODEL (env)", async () => {
	const { home, agentDir } = await freshHome("pi-gw-pplx-env-");
	const out = runChild(
		`let capturedUrl = ""; let capturedModel = "";
		 globalThis.fetch = async (url, init) => {
			 capturedUrl = String(url); capturedModel = JSON.parse(init.body).model;
			 return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], citations: [] }), { status: 200, headers: { "content-type": "application/json" } });
		 };
		 const { searchWithPerplexity } = await import(${JSON.stringify(perplexityModule)});
		 const res = await searchWithPerplexity("hello");
		 console.log(JSON.stringify({ url: capturedUrl, model: capturedModel, answer: res.answer }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, PERPLEXITY_API_KEY: "pplx-test", PERPLEXITY_BASE_URL: "https://gw.example.com/v1", PERPLEXITY_MODEL: "perplexity/sonar-pro" },
	);
	const o = JSON.parse(out);
	assert.equal(o.url, "https://gw.example.com/v1/chat/completions");
	assert.equal(o.model, "perplexity/sonar-pro");
	assert.equal(o.answer, "ok");
});

test("Perplexity search defaults to the public endpoint + sonar when unset", async () => {
	const { home, agentDir } = await freshHome("pi-gw-pplx-default-");
	await writeConfig(agentDir, { perplexityApiKey: "pplx-test" });
	const out = runChild(
		`let capturedUrl = ""; let capturedModel = "";
		 globalThis.fetch = async (url, init) => {
			 capturedUrl = String(url); capturedModel = JSON.parse(init.body).model;
			 return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], citations: [] }), { status: 200, headers: { "content-type": "application/json" } });
		 };
		 const { searchWithPerplexity } = await import(${JSON.stringify(perplexityModule)});
		 await searchWithPerplexity("hello");
		 console.log(JSON.stringify({ url: capturedUrl, model: capturedModel }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir },
	);
	const o = JSON.parse(out);
	assert.equal(o.url, "https://api.perplexity.ai/chat/completions");
	assert.equal(o.model, "sonar");
});

test("Perplexity search honors config-file perplexityBaseUrl/perplexityModel", async () => {
	const { home, agentDir } = await freshHome("pi-gw-pplx-cfg-");
	await writeConfig(agentDir, { perplexityApiKey: "pplx-test", perplexityBaseUrl: "https://cfg.example.com/", perplexityModel: "sonar-huge" });
	const out = runChild(
		`let capturedUrl = ""; let capturedModel = "";
		 globalThis.fetch = async (url, init) => {
			 capturedUrl = String(url); capturedModel = JSON.parse(init.body).model;
			 return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], citations: [] }), { status: 200, headers: { "content-type": "application/json" } });
		 };
		 const { searchWithPerplexity } = await import(${JSON.stringify(perplexityModule)});
		 await searchWithPerplexity("hello");
		 console.log(JSON.stringify({ url: capturedUrl, model: capturedModel }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir },
	);
	const o = JSON.parse(out);
	assert.equal(o.url, "https://cfg.example.com/chat/completions");
	assert.equal(o.model, "sonar-huge");
});
