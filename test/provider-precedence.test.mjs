import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

// Honor a configured provider when the model emits the schema default "auto"
// (P2 correctness slice of upstream #151, commit 743f838, @nicobailon).
//
// The web_search tool schema lists "auto" first, so the model routinely sends
// the literal string "auto". The old `options.provider ?? config.searchProvider`
// short-circuited on it (?? only falls through on null/undefined), silently
// ignoring a globally-configured concrete provider and routing exa/gemini
// instead. The fix treats an explicit "auto" like "no provider", so a
// configured provider wins; an explicit named provider still overrides; with
// nothing configured, "auto" still runs the built-in order.
//
// Two layers, mirroring the split in test/provider-priority.test.mjs +
// test/auto-summary-source.test.mjs:
//   (a) Behavioral routing in providers/gemini-search.ts search() — exercised
//       end-to-end via the SHIPPED search() in an isolated child process (per-
//       test HOME, mocked fetch, --import tsx).
//   (b) index.ts wiring — the curated and non-curated resolution sites now
//       route through a shared resolveRequestedProvider() helper. index.ts is
//       host-coupled and NOT tsx-loadable (per AGENTS.md), so this is guarded
//       by a source-grep, not a runtime import.

const searchModuleUrl = new URL("../providers/gemini-search.ts", import.meta.url).href;
const indexSrc = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const TS_NODE_ARGS = ["--import", "tsx"];

async function createTempHome(prefix = "pi-web-access-precedence-") {
	return mkdtemp(join(tmpdir(), prefix));
}

async function writeWebSearchConfig(home, config) {
	await mkdir(join(home, ".pi"), { recursive: true });
	await writeFile(
		join(home, ".pi", "web-search.json"),
		`${JSON.stringify(config)}\n`,
		"utf8",
	);
}

function wrapChildScript(script) {
	return `
process.on("uncaughtException", (error) => {
	console.error(error?.stack || error);
	process.exit(1);
});
process.on("unhandledRejection", (error) => {
	console.error(error?.stack || error);
	process.exit(1);
});

${script}
`;
}

function runWithHome(home, script, extraEnv = {}) {
	const env = { ...process.env, HOME: home, USERPROFILE: home };
	// The config helper prefers PI_CODING_AGENT_DIR / XDG_CONFIG_HOME over HOME;
	// clear them so the temp HOME's ~/.pi is the resolved config dir.
	delete env.PI_CODING_AGENT_DIR;
	delete env.XDG_CONFIG_HOME;
	// Strip every provider key/base-url so availability is fully controlled by
	// this test's env/config (no leakage from the host shell).
	for (const key of [
		"EXA_API_KEY",
		"PERPLEXITY_API_KEY",
		"GEMINI_API_KEY",
		"PARALLEL_API_KEY",
		"CLOUDFLARE_API_KEY",
		"GOOGLE_GEMINI_BASE_URL",
		"PI_ALLOW_BROWSER_COOKIES",
		"TAVILY_API_KEY",
		"OPENAI_API_KEY",
		"OPENAI_BASE_URL",
		"OPENAI_SEARCH_MODEL",
		"BRAVE_API_KEY",
		"OLOSTEP_API_KEY",
		"SEARXNG_BASE_URL",
		"BRIGHTDATA_API_TOKEN",
		"FIRECRAWL_BASE_URL",
		"FIRECRAWL_API_KEY",
	]) delete env[key];
	Object.assign(env, extraEnv);

	return spawnSync(process.execPath, ["--input-type=module", ...TS_NODE_ARGS], {
		input: wrapChildScript(script),
		encoding: "utf8",
		env,
		maxBuffer: 2 * 1024 * 1024,
	});
}

function assertChildSuccess(child, label = "child process") {
	assert.equal(child.status, 0, `${label} failed:\n${child.stderr}`);
}

// A fetch mock that answers by URL substring. Each mock entry: { urlMatch,
// response, ok?, status? }. `response` may be a string or a JSON-able object.
function buildFetchMockScript(mocks) {
	return `
const __mocks = ${JSON.stringify(mocks)};
const __calls = [];
globalThis.fetch = async (url, init = {}) => {
	const urlStr = String(url);
	__calls.push({ url: urlStr, method: init.method ?? "GET" });
	const mock = __mocks.find((m) => (m.urlMatch ? urlStr.includes(m.urlMatch) : urlStr === m.url));
	if (!mock) throw new Error("Unexpected fetch to " + urlStr);
	const body = typeof mock.response === "string" ? mock.response : JSON.stringify(mock.response);
	return {
		ok: mock.ok ?? true,
		status: mock.status ?? 200,
		async text() { return body; },
		async json() { return typeof mock.response === "string" ? JSON.parse(mock.response) : mock.response; },
	};
};
globalThis.__getCalls = () => __calls;
`;
}

function runSearch(home, scriptBody, extraEnv = {}) {
	return runWithHome(
		home,
		`const { search } = await import(${JSON.stringify(searchModuleUrl)});
${scriptBody}`,
		extraEnv,
	);
}

// Perplexity chat/completions reply shape (shared with provider-trace.test.mjs).
const perplexityOkResponse = {
	choices: [{ message: { content: "Mocked Perplexity answer." } }],
	citations: ["https://example.test/source"],
};

// ---------- search() routing ----------

describe("search() honors a configured provider for auto tool calls", () => {
	test("auto honors a globally-configured concrete provider (the core fix)", async () => {
		// Before the fix an explicit "auto" short-circuited `??` and exa/gemini
		// ran; now config provider "perplexity" wins. Perplexity is keyed via
		// config only (no env), proving availability is read from config too.
		const home = await createTempHome();
		await writeWebSearchConfig(home, { provider: "perplexity", perplexityApiKey: "pp-key" });
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.perplexity.ai", response: perplexityOkResponse }])}
const res = await search("query", { provider: "auto" });
const calls = globalThis.__getCalls().map((c) => c.url);
console.log(JSON.stringify({ provider: res.provider, answer: res.answer, calledPerplexity: calls.some((u) => u.includes("api.perplexity.ai")), calledExa: calls.some((u) => u.includes("api.exa.ai")) }));
`);
		assertChildSuccess(child);
		const parsed = JSON.parse(child.stdout.trim());
		assert.equal(parsed.provider, "perplexity");
		assert.equal(parsed.answer, "Mocked Perplexity answer.");
		assert.equal(parsed.calledPerplexity, true);
		assert.equal(parsed.calledExa, false, "auto must honor the configured provider, not fall through to exa");
	});

	test("an explicit named provider overrides the configured default", async () => {
		// config says perplexity, but provider:"tavily" wins. Both are keyed so
		// the assertion is about selection, not availability.
		const home = await createTempHome();
		await writeWebSearchConfig(home, { provider: "perplexity", perplexityApiKey: "pp-key" });
		const child = runSearch(home, `
${buildFetchMockScript([
	{ urlMatch: "api.tavily.com/search", response: { answer: "Mocked Tavily answer.", results: [{ title: "T", url: "https://example.test/t", content: "c" }] } },
	{ urlMatch: "api.perplexity.ai", response: perplexityOkResponse },
])}
const res = await search("query", { provider: "tavily" });
const calls = globalThis.__getCalls().map((c) => c.url);
console.log(JSON.stringify({ provider: res.provider, answer: res.answer, calledTavily: calls.some((u) => u.includes("api.tavily.com")), calledPerplexity: calls.some((u) => u.includes("api.perplexity.ai")) }));
`, { TAVILY_API_KEY: "tv-key" });
		assertChildSuccess(child);
		const parsed = JSON.parse(child.stdout.trim());
		assert.equal(parsed.provider, "tavily");
		assert.equal(parsed.answer, "Mocked Tavily answer.");
		assert.equal(parsed.calledTavily, true);
		assert.equal(parsed.calledPerplexity, false, "explicit tavily must not also call the configured perplexity");
	});

	test("auto with no configured provider uses the built-in order (regression guard)", async () => {
		// No config -> searchProvider normalizes to "auto" -> built-in order
		// (exa first). Proves the fix didn't change the nothing-configured path.
		const home = await createTempHome();
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.exa.ai/answer", response: { answer: "Exa via auto.", results: [] } }])}
const res = await search("query", { provider: "auto" });
console.log(JSON.stringify({ provider: res.provider }));
`, { EXA_API_KEY: "exa-key" });
		assertChildSuccess(child);
		assert.equal(JSON.parse(child.stdout.trim()).provider, "exa");
	});

	test("an opt-in provider (openai) is reachable via an explicit request when config is absent", async () => {
		// NOTE: the plan's draft listed provider:"auto" here, but opt-in
		// providers (openai) are deliberately NOT in DEFAULT_AUTO_ORDER, so
		// "auto" can never reach them regardless of keys. An explicit
		// provider:"openai" is the only selection path with no config. This
		// guards that the fix didn't break explicit opt-in routing and
		// exercises the OpenAI Responses endpoint (api.openai.com/v1/responses).
		const home = await createTempHome();
		const child = runSearch(home, `
${buildFetchMockScript([
	{ urlMatch: "api.openai.com/v1/responses", response: { output: [{ type: "message", content: [{ type: "output_text", text: "Mocked OpenAI answer." }] }] } },
])}
const res = await search("query", { provider: "openai" });
const calls = globalThis.__getCalls().map((c) => c.url);
console.log(JSON.stringify({ provider: res.provider, answer: res.answer, calledOpenAI: calls.some((u) => u.includes("api.openai.com/v1/responses")) }));
`, { OPENAI_API_KEY: "oai-key" });
		assertChildSuccess(child);
		const parsed = JSON.parse(child.stdout.trim());
		assert.equal(parsed.provider, "openai");
		assert.equal(parsed.answer, "Mocked OpenAI answer.");
		assert.equal(parsed.calledOpenAI, true);
	});
});

// ---------- index.ts wiring (source-grep) ----------

describe("index.ts provider-resolution wiring (source-grep)", () => {
	test("defines the shared resolveRequestedProvider helper", () => {
		assert.match(indexSrc, /function resolveRequestedProvider\(/);
	});

	test("curated path routes requested through resolveRequestedProvider", () => {
		assert.match(indexSrc, /const provider = resolveRequestedProvider\(requested\);/);
	});

	test("non-curated path routes params.provider through resolveRequestedProvider", () => {
		assert.match(indexSrc, /const resolvedProvider = resolveRequestedProvider\(params\.provider\);/);
	});

	test("the old direct normalizeProviderInput(params.provider ?? loadConfig().provider) callsite is gone", () => {
		assert.doesNotMatch(indexSrc, /normalizeProviderInput\(params\.provider \?\? loadConfig\(\)\.provider\)/);
	});
});
