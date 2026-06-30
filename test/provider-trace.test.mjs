import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

// Provider Trace v1 (ROADMAP item #3). Asserts the `trace` object on
// AttributedSearchResponse (success) and on thrown errors (via
// getSearchTrace) covers: routing mode, selected provider, per-attempt
// status (success/error/skipped/no-result), and the resolved order.
//
// Harness mirrors test/provider-priority.test.mjs: child-process isolation
// (per-test HOME, mocked fetch, --import tsx) so the shipped search() runs
// end-to-end.

const searchModuleUrl = new URL("../providers/gemini-search.ts", import.meta.url).href;
const TS_NODE_ARGS = ["--import", "tsx"];

async function createTempHome(prefix = "pi-web-access-trace-") {
	return mkdtemp(join(tmpdir(), prefix));
}

async function writeWebSearchConfig(home, config) {
	await mkdir(join(home, ".pi"), { recursive: true });
	await writeFile(join(home, ".pi", "web-search.json"), `${JSON.stringify(config)}\n`, "utf8");
}

function wrapChildScript(script) {
	return `
process.on("uncaughtException", (error) => { console.error(error?.stack || error); process.exit(1); });
process.on("unhandledRejection", (error) => { console.error(error?.stack || error); process.exit(1); });
${script}
`;
}

function runSearch(home, scriptBody, extraEnv = {}) {
	const env = { ...process.env, HOME: home, USERPROFILE: home };
	delete env.PI_CODING_AGENT_DIR;
	delete env.XDG_CONFIG_HOME;
	for (const key of ["EXA_API_KEY", "PERPLEXITY_API_KEY", "GEMINI_API_KEY", "PARALLEL_API_KEY", "CLOUDFLARE_API_KEY", "GOOGLE_GEMINI_BASE_URL", "PI_ALLOW_BROWSER_COOKIES"]) delete env[key];
	Object.assign(env, extraEnv);
	return spawnSync(process.execPath, ["--input-type=module", ...TS_NODE_ARGS], {
		input: wrapChildScript(scriptBody),
		encoding: "utf8",
		env,
		maxBuffer: 2 * 1024 * 1024,
	});
}

function assertChildSuccess(child, label = "child process") {
	assert.equal(child.status, 0, `${label} failed:\n${child.stderr}`);
}

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
	return { ok: mock.ok ?? true, status: mock.status ?? 200, async text() { return body; }, async json() { return typeof mock.response === "string" ? JSON.parse(mock.response) : mock.response; } };
};
globalThis.__getCalls = () => __calls;
`;
}

const perplexityOkResponse = {
	id: "x", model: "m", choices: [{ message: { content: "Mocked Perplexity answer." } }], citations: ["https://example.test/source"],
};
const parallelOkResponse = {
	answer: "Parallel answer.", results: [{ title: "P", url: "https://p.example", snippet: "" }],
};

describe("search() provider trace", () => {
	test("explicit provider success: trace has one success attempt, mode=provider, selected set", async () => {
		const home = await createTempHome();
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.perplexity.ai", response: perplexityOkResponse }])}
const { search, getSearchTrace } = await import(${JSON.stringify(searchModuleUrl)});
const res = await search("query", { provider: "perplexity" });
console.log(JSON.stringify(res.trace));
`, { PERPLEXITY_API_KEY: "pp-key" });
		assertChildSuccess(child);
		const trace = JSON.parse(child.stdout.trim());
		assert.equal(trace.mode, "perplexity");
		assert.equal(trace.selected, "perplexity");
		assert.equal(trace.order, undefined, "explicit provider should not record an order");
		assert.equal(trace.attempts.length, 1);
		assert.equal(trace.attempts[0].provider, "perplexity");
		assert.equal(trace.attempts[0].status, "success");
	});

	test("auto mode records the winner + resolved order (opt-in providers absent)", async () => {
		// Exa keyed + succeeds via its direct API -> auto winner. Under the
		// "auto = no paid key" policy the order is [exa, gemini]; once exa wins
		// the loop stops (gemini isn't attempted), and opt-in paid providers
		// (perplexity, parallel, ...) are absent from attempts entirely.
		const home = await createTempHome();
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.exa.ai/answer", response: { answer: "Exa answer.", results: [] } }])}
const { search } = await import(${JSON.stringify(searchModuleUrl)});
const res = await search("query", { provider: "auto" });
console.log(JSON.stringify(res.trace));
`, { EXA_API_KEY: "exa-key" });
		assertChildSuccess(child);
		const trace = JSON.parse(child.stdout.trim());
		assert.equal(trace.mode, "auto");
		assert.equal(trace.selected, "exa");
		assert.deepEqual(trace.order, ["exa", "gemini"]);
		const byName = Object.fromEntries(trace.attempts.map((a) => [a.provider, a.status]));
		assert.equal(byName.exa, "success", "exa was called and won");
		assert.equal(byName.perplexity, undefined, "perplexity is opt-in (not in auto order)");
		assert.equal(byName.parallel, undefined, "parallel is opt-in (not in auto order)");
	});

	test("failure: trace is attached to the thrown error via getSearchTrace", async () => {
		// Only exa (MCP) available, mocked to 503. Others unkeyed/skipped.
		// search() throws "Auto provider search failed"; trace must be
		// recoverable from the error with selected=null and the exa error attempt.
		const home = await createTempHome();
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "mcp.exa.ai/mcp", ok: false, status: 503, response: "exa down" }])}
const { search, getSearchTrace } = await import(${JSON.stringify(searchModuleUrl)});
try {
	await search("query", { provider: "auto" });
	console.log("NO_THROW");
} catch (err) {
	const trace = getSearchTrace(err);
	console.log("TRACE:" + JSON.stringify(trace));
}
`);
		assertChildSuccess(child);
		const out = child.stdout.trim();
		assert.ok(out.startsWith("TRACE:"), `expected trace, got: ${out}`);
		const trace = JSON.parse(out.slice("TRACE:".length));
		assert.equal(trace.mode, "auto");
		assert.equal(trace.selected, null);
		assert.deepEqual(trace.order, ["exa", "gemini"]);
		const byName = Object.fromEntries(trace.attempts.map((a) => [a.provider, a.status]));
		assert.equal(byName.exa, "error");
		assert.equal(byName.perplexity, undefined, "perplexity is opt-in (not in auto order)");
		assert.equal(byName.gemini, "skipped");
		assert.equal(byName.parallel, undefined, "parallel is opt-in (not in auto order)");
	});

	test("explicit gemini no-result: trace records no-result attempt + throws", async () => {
		// Gemini selected explicitly but unavailable (no key, no cookies) ->
		// searchWithGemini returns null -> throws "Gemini search unavailable".
		const home = await createTempHome();
		const child = runSearch(home, `
const { search, getSearchTrace } = await import(${JSON.stringify(searchModuleUrl)});
try {
	await search("query", { provider: "gemini" });
	console.log("NO_THROW");
} catch (err) {
	console.log("TRACE:" + JSON.stringify(getSearchTrace(err)));
}
`);
		assertChildSuccess(child);
		const out = child.stdout.trim();
		assert.ok(out.startsWith("TRACE:"), `expected trace, got: ${out}`);
		const trace = JSON.parse(out.slice("TRACE:".length));
		assert.equal(trace.mode, "gemini");
		assert.equal(trace.selected, null);
		assert.equal(trace.attempts.length, 1);
		assert.equal(trace.attempts[0].provider, "gemini");
		assert.equal(trace.attempts[0].status, "no-result");
	});
});
