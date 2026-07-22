import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

// Child-process integration tests for parallel.ts.
//
// Harness mines the isolation pattern from upstream PR #91's
// test/parallel.test.mjs (beettlle), but simplified: children are spawned
// with `--import tsx` (this repo's pdf-extract / gemini-web convention)
// instead of PR #91's custom module-loader hook that mocked activity.js and
// rewrote .js -> .ts. The real activity.ts loads fine under tsx.
//
// Because each test spawns a FRESH child with its own HOME, the module-level
// config cache in parallel.ts starts empty every time — no cache-clear hook
// is needed. This exercises the SHIPPED exports (isParallelAvailable,
// searchWithParallel, extractWithParallel) end-to-end as a true regression
// guard rather than a reimplementation.
//
// v0.19.0 cutover: the search path now calls the Parallel Responses API
// (`POST /v1/responses`, `Authorization: Bearer`, returns a synthesized
// answer + `url_citation` citations — same wire format as OpenAI's Responses
// API). The 0.16.0-era `buildSearchQueriesFromObjective` query expansion and
// the search-path `inlineContent` are gone (Responses does its own multi-step
// research and returns citations, not excerpts). The `/v1/extract` path
// (`extractWithParallel`, incl. its `MIN_USEFUL_CONTENT` gate) is unchanged.

const parallelModuleUrl = new URL("../providers/parallel.ts", import.meta.url).href;

// Plain `node --test` has no TypeScript loader (Pi registers one at runtime).
// tsx provides the transform for the spawned child to import .ts source.
const TS_NODE_ARGS = ["--import", "tsx"];

// Responses-API shape: a single `message` output item whose `output_text`
// part carries the synthesized answer + `url_citation` annotations.
const sampleSearchResponse = {
	output: [
		{
			type: "message",
			content: [
				{
					type: "output_text",
					text: "Synthesized answer about the topic.",
					annotations: [
						{ type: "url_citation", url: "https://example.test/article", title: "Example Article", start_index: 0, end_index: 10 },
						{ type: "url_citation", url: "https://example.test/other", title: "Other Page", start_index: 11, end_index: 20 },
					],
				},
			],
		},
	],
};

const extractTargetUrl = "https://example.test/article";

async function createTempHome(prefix = "pi-web-access-parallel-") {
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

// Spawn an isolated child with its own HOME and no inherited PARALLEL_API_KEY,
// then run an inline ESM script that imports the real parallel.ts under tsx.
function runWithHome(home, script, extraEnv = {}) {
	const env = { ...process.env, HOME: home, USERPROFILE: home };
	// The config helper prefers PI_CODING_AGENT_DIR / XDG_CONFIG_HOME over HOME;
	// clear them so the temp HOME's ~/.pi is the resolved config dir.
	delete env.PI_CODING_AGENT_DIR;
	delete env.XDG_CONFIG_HOME;
	delete env.PARALLEL_API_KEY;
	delete env.PARALLEL_REASONING_EFFORT;
	Object.assign(env, extraEnv);

	return spawnSync(process.execPath, ["--input-type=module", ...TS_NODE_ARGS], {
		input: wrapChildScript(script),
		encoding: "utf8",
		env,
		maxBuffer: 2 * 1024 * 1024,
	});
}

// Surface silent unhandled rejections / throws as a non-zero exit so failures
// are reported instead of producing empty stdout.
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

// Injects a global fetch mock that records every call and returns canned
// responses keyed by exact URL or URL substring. Modeled on PR #91's
// buildFetchMockScript. `mocks` is a plain JS array of real objects, so callers
// pass real values (vars / expressions) — never template interpolations.
function buildFetchMockScript(mocks) {
	return `
const __parallelFetchMocks = ${JSON.stringify(mocks)};
const __parallelFetchCalls = [];

globalThis.fetch = async (url, init = {}) => {
	const urlStr = String(url);
	const method = init.method ?? "GET";
	const bodyText = init.body == null ? null : String(init.body);
	const body = bodyText ? JSON.parse(bodyText) : null;
	const call = { url: urlStr, method, headers: init.headers ?? {}, body };
	__parallelFetchCalls.push(call);

	const mock = __parallelFetchMocks.find((entry) => {
		if (entry.url && urlStr === entry.url) return true;
		if (entry.urlMatch && urlStr.includes(entry.urlMatch)) return true;
		return false;
	});

	if (!mock) {
		throw new Error("Unexpected fetch to " + urlStr);
	}

	const responseBody = typeof mock.response === "function"
		? mock.response(call)
		: mock.response;

	return {
		ok: mock.ok ?? true,
		status: mock.status ?? 200,
		async text() {
			return typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody);
		},
		async json() {
			return typeof responseBody === "string" ? JSON.parse(responseBody) : responseBody;
		},
	};
};

globalThis.__getParallelFetchCalls = () => __parallelFetchCalls;
`;
}

function assertChildSuccess(child, label = "child process") {
	assert.equal(child.status, 0, `${label} failed:\n${child.stderr}`);
}

// Helper invocations for each exported function.
function runIsParallelAvailable(home, extraEnv = {}) {
	return runWithHome(
		home,
		`const { isParallelAvailable } = await import(${JSON.stringify(parallelModuleUrl)});
console.log(String(isParallelAvailable()));`,
		extraEnv,
	);
}

function runSearch(home, scriptBody, extraEnv = {}) {
	return runWithHome(
		home,
		`const { searchWithParallel } = await import(${JSON.stringify(parallelModuleUrl)});
${scriptBody}`,
		extraEnv,
	);
}

function runExtract(home, scriptBody, extraEnv = {}) {
	return runWithHome(
		home,
		`const { extractWithParallel } = await import(${JSON.stringify(parallelModuleUrl)});
${scriptBody}`,
		extraEnv,
	);
}

describe("isParallelAvailable", () => {
	test("returns false with empty HOME (no config, no env)", async () => {
		const home = await createTempHome();
		const child = runIsParallelAvailable(home);
		assertChildSuccess(child);
		assert.equal(child.stdout.trim(), "false");
	});

	test("returns true with parallelApiKey in web-search.json", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		const child = runIsParallelAvailable(home);
		assertChildSuccess(child);
		assert.equal(child.stdout.trim(), "true");
	});

	test("returns true with PARALLEL_API_KEY env var", async () => {
		const home = await createTempHome();
		const child = runIsParallelAvailable(home, { PARALLEL_API_KEY: "env-key-ok" });
		assertChildSuccess(child);
		assert.equal(child.stdout.trim(), "true");
	});

	test("returns false for a non-string parallelApiKey", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: 12345 });
		const child = runIsParallelAvailable(home);
		assertChildSuccess(child);
		assert.equal(child.stdout.trim(), "false");
	});

	test("returns false for an empty / whitespace-only key", async () => {
		const home = await createTempHome();
		for (const parallelApiKey of ["", "   ", "\t"]) {
			await writeWebSearchConfig(home, { parallelApiKey });
			const child = runIsParallelAvailable(home);
			assertChildSuccess(child, `whitespace key ${JSON.stringify(parallelApiKey)}`);
			assert.equal(child.stdout.trim(), "false", `expected false for ${JSON.stringify(parallelApiKey)}`);
		}
	});

	test("returns false for a whitespace-only PARALLEL_API_KEY env", async () => {
		const home = await createTempHome();
		const child = runIsParallelAvailable(home, { PARALLEL_API_KEY: "   " });
		assertChildSuccess(child);
		assert.equal(child.stdout.trim(), "false");
	});

	test("falls back to config when env var is blank", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "config-key" });
		const child = runIsParallelAvailable(home, { PARALLEL_API_KEY: "   " });
		assertChildSuccess(child);
		assert.equal(child.stdout.trim(), "true");
	});
});

describe("searchWithParallel", () => {
	test("throws a helpful error when no API key is configured", async () => {
		const home = await createTempHome();
		const child = runSearch(home, `
try {
	await searchWithParallel("anything");
	console.log("NO_THROW");
} catch (err) {
	console.log("THREW:" + err.message);
}
`);
		assertChildSuccess(child);
		const out = child.stdout.trim();
		assert.ok(out.startsWith("THREW:"), `expected an error, got: ${out}`);
		assert.match(out, /Parallel API key not found/i);
		assert.match(out, /PARALLEL_API_KEY/);
	});

	test("prefers PARALLEL_API_KEY env over the config key (via Authorization Bearer header)", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "config-key" });
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/responses", response: { output: [] } }])}
await searchWithParallel("q");
const call = globalThis.__getParallelFetchCalls()[0];
console.log(JSON.stringify({
	auth: call?.headers?.Authorization ?? null,
	xApiKey: call?.headers?.["x-api-key"] ?? null,
}));
`, { PARALLEL_API_KEY: "env-key-wins" });
		assertChildSuccess(child);
		const parsed = JSON.parse(child.stdout.trim());
		assert.equal(parsed.auth, "Bearer env-key-wins");
		// Auth moved from the legacy x-api-key header to Bearer with the Responses cutover.
		assert.equal(parsed.xApiKey, null);
	});

	test("posts to /v1/responses with model + input + reasoning body shape", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/responses", response: { output: [] } }])}
await searchWithParallel("the query");
const call = globalThis.__getParallelFetchCalls()[0];
console.log(JSON.stringify({
	url: call?.url ?? null,
	method: call?.method ?? null,
	model: call?.body?.model ?? null,
	input: call?.body?.input ?? null,
	reasoning: call?.body?.reasoning ?? null,
	tools: call?.body?.tools ?? null,
}));
`);
		assertChildSuccess(child);
		const parsed = JSON.parse(child.stdout.trim());
		assert.match(parsed.url, /api\.parallel\.ai\/v1\/responses/);
		assert.equal(parsed.method, "POST");
		assert.equal(parsed.model, "parallel");
		assert.equal(parsed.input, "the query");
		assert.deepEqual(parsed.reasoning, { effort: "low" });
		// No tools/web_search entry — grounding is automatic on the Responses endpoint.
		assert.equal(parsed.tools, null);
	});

	test("maps a Responses payload to answer + citation results", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/responses", response: sampleSearchResponse }])}
const result = await searchWithParallel("parallel search query");
console.log(JSON.stringify({
	answer: result.answer,
	results: result.results,
	inlineContent: result.inlineContent,
}));
`);
		assertChildSuccess(child, "search mapping");
		const parsed = JSON.parse(child.stdout.trim());

		// answer is the synthesized output_text.
		assert.equal(parsed.answer, "Synthesized answer about the topic.");
		// results are the url_citation annotations, mapped to { title, url, snippet }.
		assert.equal(parsed.results.length, 2);
		assert.equal(parsed.results[0].url, "https://example.test/article");
		assert.equal(parsed.results[0].title, "Example Article");
		assert.equal(parsed.results[1].url, "https://example.test/other");
		assert.equal(parsed.results[1].title, "Other Page");
		for (const r of parsed.results) {
			assert.equal(typeof r.snippet, "string");
		}
		// No inlineContent — Responses returns citations, not excerpts.
		assert.equal(parsed.inlineContent, undefined);
	});

	test("returns empty answer + results for an empty output array", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/responses", response: { output: [] } }])}
const result = await searchWithParallel("empty query");
console.log(JSON.stringify({ answer: result.answer, results: result.results }));
`);
		assertChildSuccess(child);
		const parsed = JSON.parse(child.stdout.trim());
		assert.equal(parsed.answer, "");
		assert.deepEqual(parsed.results, []);
	});

	test("sends domain + recency + numResults hints in the instructions field (not source_policy)", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/responses", response: { output: [] } }])}
await searchWithParallel("filtered query", {
	domainFilter: ["example.com", "-spam.com"],
	recencyFilter: "week",
	numResults: 10,
});
console.log(JSON.stringify({ callBody: globalThis.__getParallelFetchCalls()[0]?.body ?? null }));
`);
		assertChildSuccess(child);
		const parsed = JSON.parse(child.stdout.trim());

		// No legacy /v1/search fields.
		assert.equal(parsed.callBody.advanced_settings, undefined);
		assert.equal(parsed.callBody.source_policy, undefined);

		// All hints woven into the instructions string.
		assert.equal(typeof parsed.callBody.instructions, "string");
		assert.match(parsed.callBody.instructions, /example\.com/);
		assert.match(parsed.callBody.instructions, /spam\.com/);
		// "week" -> ~7 days ago.
		assert.match(parsed.callBody.instructions, /within the last 7 days/i);
		assert.match(parsed.callBody.instructions, /Cite up to 10 distinct sources/);
	});

	test("omits instructions from the body when no filters are given", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/responses", response: { output: [] } }])}
await searchWithParallel("plain query");
console.log(JSON.stringify({ instructions: globalThis.__getParallelFetchCalls()[0]?.body?.instructions ?? null }));
`);
		assertChildSuccess(child);
		assert.equal(JSON.parse(child.stdout.trim()).instructions, null);
	});

	test("caps parsed results at numResults", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		// 5 distinct citations; numResults=3 → sliced to 3.
		const manyCitations = {
			output: [{
				type: "message",
				content: [{
					type: "output_text",
					text: "answer",
					annotations: [1, 2, 3, 4, 5].map((n) => ({
						type: "url_citation",
						url: `https://example.test/c${n}`,
						title: `Citation ${n}`,
						start_index: 0,
						end_index: 1,
					})),
				}],
			}],
		};
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/responses", response: manyCitations }])}
const result = await searchWithParallel("capped query", { numResults: 3 });
console.log(JSON.stringify({ count: result.results.length }));
`);
		assertChildSuccess(child);
		assert.equal(JSON.parse(child.stdout.trim()).count, 3);
	});

	test("throws on a non-ok HTTP response", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/responses", ok: false, status: 429, response: "rate limited" }])}
try {
	await searchWithParallel("rate limited query");
	console.log("NO_THROW");
} catch (err) {
	console.log("THREW:" + err.message);
}
`);
		assertChildSuccess(child);
		const out = child.stdout.trim();
		assert.ok(out.startsWith("THREW:"), `expected an error, got: ${out}`);
		assert.match(out, /Parallel API error 429/);
	});

	test("defaults reasoning.effort to low", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/responses", response: { output: [] } }])}
await searchWithParallel("q");
console.log(JSON.stringify({ effort: globalThis.__getParallelFetchCalls()[0]?.body?.reasoning?.effort ?? null }));
`);
		assertChildSuccess(child);
		assert.equal(JSON.parse(child.stdout.trim()).effort, "low");
	});

	test("honors PARALLEL_REASONING_EFFORT=high", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/responses", response: { output: [] } }])}
await searchWithParallel("q");
console.log(JSON.stringify({ effort: globalThis.__getParallelFetchCalls()[0]?.body?.reasoning?.effort ?? null }));
`, { PARALLEL_REASONING_EFFORT: "high" });
		assertChildSuccess(child);
		assert.equal(JSON.parse(child.stdout.trim()).effort, "high");
	});

	test("honors parallelReasoningEffort from config", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key", parallelReasoningEffort: "medium" });
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/responses", response: { output: [] } }])}
await searchWithParallel("q");
console.log(JSON.stringify({ effort: globalThis.__getParallelFetchCalls()[0]?.body?.reasoning?.effort ?? null }));
`);
		assertChildSuccess(child);
		assert.equal(JSON.parse(child.stdout.trim()).effort, "medium");
	});

	test("falls back to low for a bogus PARALLEL_REASONING_EFFORT value", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/responses", response: { output: [] } }])}
await searchWithParallel("q");
console.log(JSON.stringify({ effort: globalThis.__getParallelFetchCalls()[0]?.body?.reasoning?.effort ?? null }));
`, { PARALLEL_REASONING_EFFORT: "bogus" });
		assertChildSuccess(child);
		assert.equal(JSON.parse(child.stdout.trim()).effort, "low");
	});

	test("prefers PARALLEL_REASONING_EFFORT env over the config value", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key", parallelReasoningEffort: "medium" });
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/responses", response: { output: [] } }])}
await searchWithParallel("q");
console.log(JSON.stringify({ effort: globalThis.__getParallelFetchCalls()[0]?.body?.reasoning?.effort ?? null }));
`, { PARALLEL_REASONING_EFFORT: "high" });
		assertChildSuccess(child);
		assert.equal(JSON.parse(child.stdout.trim()).effort, "high");
	});
});

describe("extractWithParallel", () => {
	test("returns null when no API key is configured (unavailable)", async () => {
		const home = await createTempHome();
		const child = runExtract(home, `
const result = await extractWithParallel(${JSON.stringify(extractTargetUrl)});
console.log(JSON.stringify({ result }));
`);
		assertChildSuccess(child);
		assert.equal(JSON.parse(child.stdout.trim()).result, null);
	});

	test("prefers full_content over excerpts", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		const fullContent = "A".repeat(600);
		const extractResponse = {
			results: [{ url: extractTargetUrl, title: "Article Title", full_content: fullContent, excerpts: ["ignored excerpt"] }],
		};
		const child = runExtract(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/extract", response: extractResponse }])}
const result = await extractWithParallel(${JSON.stringify(extractTargetUrl)});
console.log(JSON.stringify({ result, callBody: globalThis.__getParallelFetchCalls()[0]?.body ?? null }));
`);
		assertChildSuccess(child);
		const parsed = JSON.parse(child.stdout.trim());
		assert.equal(parsed.result.url, extractTargetUrl);
		assert.equal(parsed.result.title, "Article Title");
		assert.equal(parsed.result.content, fullContent);
		assert.equal(parsed.result.error, null);
		assert.deepEqual(parsed.callBody.urls, [extractTargetUrl]);
	});

	test("joins excerpts with a blank line when full_content is absent", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		const one = "a".repeat(300);
		const two = "b".repeat(300);
		const extractResponse = {
			results: [{ url: extractTargetUrl, title: "Excerpt Article", excerpts: [one, two] }],
		};
		const child = runExtract(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/extract", response: extractResponse }])}
const result = await extractWithParallel(${JSON.stringify(extractTargetUrl)});
console.log(JSON.stringify({ content: result?.content ?? null }));
`);
		assertChildSuccess(child);
		assert.equal(JSON.parse(child.stdout.trim()).content, `${one}\n\n${two}`);
	});

	test("derives the title from the URL path when no title is given", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		const url = "https://example.test/docs/guide";
		const extractResponse = { results: [{ url, full_content: "C".repeat(300) }] };
		const child = runExtract(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/extract", response: extractResponse }])}
const result = await extractWithParallel(${JSON.stringify(url)});
console.log(JSON.stringify({ title: result?.title ?? null }));
`);
		assertChildSuccess(child);
		assert.equal(JSON.parse(child.stdout.trim()).title, "guide");
	});

	test("sends full_content=true when no prompt is given", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		const extractResponse = { results: [{ url: extractTargetUrl, full_content: "D".repeat(300) }] };
		const child = runExtract(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/extract", response: extractResponse }])}
await extractWithParallel(${JSON.stringify(extractTargetUrl)});
console.log(JSON.stringify({ callBody: globalThis.__getParallelFetchCalls()[0]?.body ?? null }));
`);
		assertChildSuccess(child);
		const parsed = JSON.parse(child.stdout.trim());
		assert.equal(parsed.callBody.objective, undefined);
		assert.equal(parsed.callBody.advanced_settings.full_content, true);
		assert.equal(parsed.callBody.advanced_settings.excerpt_settings, undefined);
	});

	test("sends objective + excerpt_settings when a prompt is given", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		const extractResponse = { results: [{ url: extractTargetUrl, excerpts: ["E".repeat(300)] }] };
		const child = runExtract(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/extract", response: extractResponse }])}
await extractWithParallel(${JSON.stringify(extractTargetUrl)}, undefined, { prompt: "summarize key points" });
console.log(JSON.stringify({ callBody: globalThis.__getParallelFetchCalls()[0]?.body ?? null }));
`);
		assertChildSuccess(child);
		const parsed = JSON.parse(child.stdout.trim());
		assert.equal(parsed.callBody.objective, "summarize key points");
		assert.equal(parsed.callBody.advanced_settings.full_content, undefined);
		assert.deepEqual(parsed.callBody.advanced_settings.excerpt_settings, { max_chars_per_result: 10000 });
	});

	test("returns null on a non-ok HTTP response", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		const child = runExtract(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/extract", ok: false, status: 500, response: "boom" }])}
const result = await extractWithParallel(${JSON.stringify(extractTargetUrl)});
console.log(JSON.stringify({ result }));
`);
		assertChildSuccess(child);
		assert.equal(JSON.parse(child.stdout.trim()).result, null);
	});

	test("returns null when the API yields no results", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		const child = runExtract(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/extract", response: { results: [] } }])}
const result = await extractWithParallel(${JSON.stringify(extractTargetUrl)});
console.log(JSON.stringify({ result }));
`);
		assertChildSuccess(child);
		assert.equal(JSON.parse(child.stdout.trim()).result, null);
	});

	test("returns null when extracted content is empty / whitespace", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		const blank = "      ";
		const extractResponse = { results: [{ url: extractTargetUrl, full_content: blank, excerpts: [blank] }] };
		const child = runExtract(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/extract", response: extractResponse }])}
const result = await extractWithParallel(${JSON.stringify(extractTargetUrl)});
console.log(JSON.stringify({ result }));
`);
		assertChildSuccess(child);
		assert.equal(JSON.parse(child.stdout.trim()).result, null);
	});

	test("falls back to the first result when no result URL matches the request", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		const extractResponse = { results: [{ url: "https://other.test/page", title: "Fallback", full_content: "F".repeat(300) }] };
		const child = runExtract(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/extract", response: extractResponse }])}
const result = await extractWithParallel(${JSON.stringify(extractTargetUrl)});
console.log(JSON.stringify({ url: result?.url ?? null, title: result?.title ?? null }));
`);
		assertChildSuccess(child);
		const parsed = JSON.parse(child.stdout.trim());
		// Result is taken from the first (non-matching) entry, but url is the REQUESTED url.
		assert.equal(parsed.url, extractTargetUrl);
		assert.equal(parsed.title, "Fallback");
	});
});

describe("extractWithParallel MIN_USEFUL_CONTENT gate", () => {
	test("returns null for content shorter than the useful threshold", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		// 50 chars < 100 threshold -> junk, fall through.
		const short = "x".repeat(50);
		const extractResponse = { results: [{ url: extractTargetUrl, full_content: short }] };
		const child = runExtract(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/extract", response: extractResponse }])}
const result = await extractWithParallel(${JSON.stringify(extractTargetUrl)});
console.log(JSON.stringify({ result }));
`);
		assertChildSuccess(child);
		assert.equal(JSON.parse(child.stdout.trim()).result, null);
	});

	test("keeps content at or above the useful threshold", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		// Exactly 100 chars == threshold -> kept (gate is length < MIN).
		const ok = "y".repeat(100);
		const extractResponse = { results: [{ url: extractTargetUrl, full_content: ok, title: "OK" }] };
		const child = runExtract(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/extract", response: extractResponse }])}
const result = await extractWithParallel(${JSON.stringify(extractTargetUrl)});
console.log(JSON.stringify({ content: result?.content ?? null, contentLen: result?.content?.length ?? 0 }));
`);
		assertChildSuccess(child);
		const parsed = JSON.parse(child.stdout.trim());
		assert.equal(parsed.contentLen, 100);
		assert.equal(parsed.content, ok);
	});

	test("rejects short joined excerpts too, not just full_content", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		const extractResponse = { results: [{ url: extractTargetUrl, excerpts: ["tiny"] }] };
		const child = runExtract(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/extract", response: extractResponse }])}
const result = await extractWithParallel(${JSON.stringify(extractTargetUrl)}, undefined, { prompt: "anything" });
console.log(JSON.stringify({ result }));
`);
		assertChildSuccess(child);
		assert.equal(JSON.parse(child.stdout.trim()).result, null);
	});
});
