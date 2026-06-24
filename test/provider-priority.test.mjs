import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

// Tests for provider-priority routing (ROADMAP item #1, 2026-06-24).
//
// Covers two layers of the shipped code in providers/gemini-search.ts:
//   1. normalizeProviderPriority — pure validation of the providerPriority list.
//   2. search() routing — that `provider: "priority"` honors the configured
//      order, skips unavailable providers, and falls through on error; and that
//      `provider: "auto"` still uses the built-in order (regression guard for
//      the shared-loop refactor).
//
// Harness reuses the isolation pattern from test/parallel.test.mjs: each test
// spawns a fresh child with its own HOME (so the module-level config cache in
// gemini-search.ts starts empty), a mocked global fetch, and `--import tsx`.
// This exercises the SHIPPED search() end-to-end, not a reimplementation.

const searchModuleUrl = new URL("../providers/gemini-search.ts", import.meta.url).href;
const TS_NODE_ARGS = ["--import", "tsx"];

async function createTempHome(prefix = "pi-web-access-priority-") {
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
	// Strip any inherited provider keys so availability is fully controlled
	// by this test's env/config.
	for (const key of [
		"EXA_API_KEY",
		"PERPLEXITY_API_KEY",
		"GEMINI_API_KEY",
		"PARALLEL_API_KEY",
		"CLOUDFLARE_API_KEY",
		"GOOGLE_GEMINI_BASE_URL",
		"PI_ALLOW_BROWSER_COOKIES",
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

// ---------- normalizeProviderPriority (pure) ----------

function runNormalize(valueExpr) {
	// valueExpr is a literal JS expression (e.g. "['exa','gemini']" or "undefined").
	const child = runWithHome(
		createTempHomeSync(),
		`const { normalizeProviderPriority } = await import(${JSON.stringify(searchModuleUrl)});
const value = ${valueExpr};
const out = normalizeProviderPriority(value);
console.log(JSON.stringify({ out: out === null ? null : out }));`,
	);
	assertChildSuccess(child, `normalize(${valueExpr})`);
	return JSON.parse(child.stdout.trim()).out;
}

// createTempHome is async; normalize tests don't care about the directory
// contents, only that HOME is isolated, so a sync temp dir is fine here.
function createTempHomeSync() {
	return mkdtempSync(join(tmpdir(), "pi-web-access-priority-norm-"));
}

describe("normalizeProviderPriority", () => {
	test("returns null for undefined / non-array / empty", async () => {
		assert.equal(await runNormalize("undefined"), null);
		assert.equal(await runNormalize("'exa'"), null); // not an array
		assert.equal(await runNormalize("[]"), null);
		assert.equal(await runNormalize("{}"), null);
	});

	test("preserves a valid ordered list", async () => {
		assert.deepEqual(await runNormalize("['perplexity','gemini','exa']"), [
			"perplexity",
			"gemini",
			"exa",
		]);
	});

	test("case-insensitive and trims whitespace", async () => {
		assert.deepEqual(await runNormalize("['  EXA ', 'Gemini']"), ["exa", "gemini"]);
	});

	test("drops unknown names and keeps valid ones in order", async () => {
		assert.deepEqual(await runNormalize("['brave','exa','tavily','gemini']"), ["exa", "gemini"]);
	});

	test("rejects meta-values auto and priority inside the list", async () => {
		// A meta-value as a list entry is meaningless; dropping it is the safe
		// choice rather than recursively re-entering routing.
		assert.deepEqual(await runNormalize("['auto','exa']"), ["exa"]);
		assert.deepEqual(await runNormalize("['priority','exa']"), ["exa"]);
	});

	test("deduplicates while preserving first-seen order", async () => {
		assert.deepEqual(await runNormalize("['exa','perplexity','exa','gemini','perplexity']"), [
			"exa",
			"perplexity",
			"gemini",
		]);
	});

	test("returns null when all entries are invalid", async () => {
		assert.equal(await runNormalize("['brave','tavily']"), null);
		assert.equal(await runNormalize("[42, true, null]"), null);
	});

	test("accepts parallel as a valid (opt-in) entry", async () => {
		assert.deepEqual(await runNormalize("['parallel','exa']"), ["parallel", "exa"]);
	});
});

// ---------- search() routing ----------

// Perplexity availability = PERPLEXITY_API_KEY env or config. When available
// and its endpoint is mocked, search() should return a perplexity-attributed
// result. We route around exa/gemini by NOT keying them (unavailable), so they
// are skipped without any fetch.
const perplexityOkResponse = {
	choices: [{ message: { content: "Mocked Perplexity answer." } }],
	citations: ["https://example.test/source"],
};

function runSearch(home, scriptBody, extraEnv = {}) {
	return runWithHome(
		home,
		`const { search } = await import(${JSON.stringify(searchModuleUrl)});
${scriptBody}`,
		extraEnv,
	);
}

describe("search() priority routing", () => {
	test("priority mode respects providerPriority order, skipping unavailable", async () => {
		// Only perplexity is keyed (available). providerPriority lists gemini
		// first — unavailable (no key/cookies), so it is skipped without any
		// network call, and perplexity is selected. (Exa is intentionally not
		// listed: exa is always 'available' via MCP fallback even without a key,
		// so listing it would make this a fall-through-on-error test instead.)
		const home = await createTempHome();
		await writeWebSearchConfig(home, { providerPriority: ["gemini", "perplexity"] });
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.perplexity.ai", response: perplexityOkResponse }])}
const res = await search("query", { provider: "priority" });
const perplexityCalls = globalThis.__getCalls().filter((c) => c.url.includes("api.perplexity.ai")).length;
console.log(JSON.stringify({ provider: res.provider, answer: res.answer, perplexityCalls }));
`, { PERPLEXITY_API_KEY: "pp-key" });
		assertChildSuccess(child);
		const parsed = JSON.parse(child.stdout.trim());
		assert.equal(parsed.provider, "perplexity");
		assert.equal(parsed.answer, "Mocked Perplexity answer.");
		assert.equal(parsed.perplexityCalls, 1);
	});

	test("priority mode falls through on a provider error to the next", async () => {
		// Both perplexity and exa keyed (available). providerPriority lists
		// perplexity first; mock it to 500 so it throws, then exa returns ok.
		// Expect exa to be selected (fall-through on error).
		const home = await createTempHome();
		await writeWebSearchConfig(home, { providerPriority: ["perplexity", "exa"] });
		const exaAnswerResponse = { answer: "Mocked Exa answer.", results: [] };
		const child = runSearch(home, `
${buildFetchMockScript([
	{ urlMatch: "api.perplexity.ai", ok: false, status: 500, response: "boom" },
	{ urlMatch: "api.exa.ai/answer", response: exaAnswerResponse },
])}
const res = await search("query", { provider: "priority" });
const calls = globalThis.__getCalls().map((c) => c.url);
console.log(JSON.stringify({ provider: res.provider, answer: res.answer, calledPerplexity: calls.some((u) => u.includes("api.perplexity.ai")), calledExa: calls.some((u) => u.includes("api.exa.ai")) }));
`, { PERPLEXITY_API_KEY: "pp-key", EXA_API_KEY: "exa-key" });
		assertChildSuccess(child);
		const parsed = JSON.parse(child.stdout.trim());
		assert.equal(parsed.provider, "exa");
		assert.equal(parsed.answer, "Mocked Exa answer.");
		assert.equal(parsed.calledPerplexity, true, "perplexity should have been attempted first");
		assert.equal(parsed.calledExa, true, "exa should have been tried after perplexity failed");
	});

	test("priority mode with no providerPriority falls back to the built-in auto order", async () => {
		// No providerPriority configured -> priority behaves like auto (exa first).
		const home = await createTempHome();
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.exa.ai/answer", response: { answer: "Exa first.", results: [] } }])}
const res = await search("query", { provider: "priority" });
console.log(JSON.stringify({ provider: res.provider }));
`, { EXA_API_KEY: "exa-key" });
		assertChildSuccess(child);
		assert.equal(JSON.parse(child.stdout.trim()).provider, "exa");
	});

	test("priority mode with an invalid providerPriority falls back to built-in order", async () => {
		// providerPriority is all junk -> normalized to null -> built-in order.
		const home = await createTempHome();
		await writeWebSearchConfig(home, { providerPriority: ["brave", "tavily", 42] });
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.exa.ai/answer", response: { answer: "Exa fallback.", results: [] } }])}
const res = await search("query", { provider: "priority" });
console.log(JSON.stringify({ provider: res.provider }));
`, { EXA_API_KEY: "exa-key" });
		assertChildSuccess(child);
		assert.equal(JSON.parse(child.stdout.trim()).provider, "exa");
	});

	test("auto mode still uses the built-in order (regression guard)", async () => {
		// Exa keyed + available -> auto must pick exa first, regardless of any
		// providerPriority config (auto ignores providerPriority).
		const home = await createTempHome();
		await writeWebSearchConfig(home, { providerPriority: ["perplexity", "gemini"] });
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.exa.ai/answer", response: { answer: "Exa via auto.", results: [] } }])}
const res = await search("query", { provider: "auto" });
const perplexityCalls = globalThis.__getCalls().filter((c) => c.url.includes("api.perplexity.ai")).length;
console.log(JSON.stringify({ provider: res.provider, perplexityCalls }));
`, { EXA_API_KEY: "exa-key" });
		assertChildSuccess(child);
		const parsed = JSON.parse(child.stdout.trim());
		assert.equal(parsed.provider, "exa");
		// auto must NOT consult providerPriority, so perplexity is never tried.
		assert.equal(parsed.perplexityCalls, 0);
	});

	test("priority mode throws the aggregated error when every provider fails", async () => {
		// Only perplexity available, mocked to 500, and it's the only candidate.
		const home = await createTempHome();
		await writeWebSearchConfig(home, { providerPriority: ["perplexity"] });
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.perplexity.ai", ok: false, status: 500, response: "boom" }])}
try {
	await search("query", { provider: "priority" });
	console.log("NO_THROW");
} catch (err) {
	console.log("THREW:" + err.message);
}
`, { PERPLEXITY_API_KEY: "pp-key" });
		assertChildSuccess(child);
		const out = child.stdout.trim();
		assert.ok(out.startsWith("THREW:"), `expected an error, got: ${out}`);
		assert.match(out, /Auto provider search failed/);
		assert.match(out, /Perplexity:/);
	});

	test("priority mode throws the aggregated error when every provider fails", async () => {
		// Exa is 'available' via MCP fallback even without a key, so it is the
		// only candidate that gets attempted. Mock its MCP endpoint to error;
		// perplexity/gemini are not keyed (unavailable, skipped). Expect the
		// aggregated 'Auto provider search failed' error mentioning Exa.
		const home = await createTempHome();
		await writeWebSearchConfig(home, { providerPriority: ["exa", "perplexity", "gemini"] });
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "mcp.exa.ai/mcp", ok: false, status: 503, response: "exa down" }])}
try {
	await search("query", { provider: "priority" });
	console.log("NO_THROW");
} catch (err) {
	console.log("THREW:" + err.message);
}
`);
		assertChildSuccess(child);
		const out = child.stdout.trim();
		assert.ok(out.startsWith("THREW:"), `expected an error, got: ${out}`);
		assert.match(out, /Auto provider search failed/);
		assert.match(out, /Exa:/);
	});
});
