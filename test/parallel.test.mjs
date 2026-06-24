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
// Assertions describe THIS repo's leaner parallel.ts. PR #91 is NOT a literal
// duplicate: it adds placeholder-key detection, query expansion, inlineContent,
// and a MIN_USEFUL_CONTENT gate that we do not have, so those PR #91 tests are
// intentionally not carried over.

const parallelModuleUrl = new URL("../providers/parallel.ts", import.meta.url).href;

// Plain `node --test` has no TypeScript loader (Pi registers one at runtime).
// tsx provides the transform for the spawned child to import .ts source.
const TS_NODE_ARGS = ["--import", "tsx"];

const sampleSearchResponse = {
	results: [
		{
			url: "https://example.test/article",
			title: "Example Article",
			excerpts: ["First excerpt.", "Second excerpt."],
		},
		{
			url: "https://example.test/other",
			title: "Other Page",
			excerpts: ["Other content here."],
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

	test("prefers PARALLEL_API_KEY env over the config key (via x-api-key header)", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "config-key" });
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/search", response: { results: [] } }])}
await searchWithParallel("q");
console.log(JSON.stringify({ apiKey: globalThis.__getParallelFetchCalls()[0]?.headers?.["x-api-key"] ?? null }));
`, { PARALLEL_API_KEY: "env-key-wins" });
		assertChildSuccess(child);
		assert.equal(JSON.parse(child.stdout.trim()).apiKey, "env-key-wins");
	});

	test("maps a V1 search response to answer + results", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/search", response: sampleSearchResponse }])}
const result = await searchWithParallel("parallel search query");
console.log(JSON.stringify({
	answer: result.answer,
	results: result.results,
	inlineContent: result.inlineContent,
	callBody: globalThis.__getParallelFetchCalls()[0]?.body ?? null,
}));
`);
		assertChildSuccess(child, "search mapping");
		const parsed = JSON.parse(child.stdout.trim());

		// Answer assembles excerpts with a "Source: title (url)" footer.
		assert.match(parsed.answer, /First excerpt\.\s+Second excerpt\./);
		assert.match(parsed.answer, /Source: Example Article \(https:\/\/example\.test\/article\)/);
		assert.match(parsed.answer, /Other content here\./);
		assert.match(parsed.answer, /Source: Other Page \(https:\/\/example\.test\/other\)/);

		// Results mapped to { title, url, snippet }.
		assert.equal(parsed.results.length, 2);
		assert.equal(parsed.results[0].url, "https://example.test/article");
		assert.equal(parsed.results[0].title, "Example Article");
		assert.equal(parsed.results[0].snippet, "First excerpt. Second excerpt.");
		assert.equal(parsed.results[1].snippet, "Other content here.");

		// Our parallel.ts does NOT return inlineContent (that's a PR #91 feature).
		assert.equal(parsed.inlineContent, undefined);

		// Request body shape.
		assert.equal(parsed.callBody.objective, "parallel search query");
		assert.deepEqual(parsed.callBody.search_queries, ["parallel search query"]);
		assert.equal(parsed.callBody.mode, "basic");
		assert.equal(parsed.callBody.max_chars_total, 40000);
		assert.equal(parsed.callBody.advanced_settings.max_results, 5);
	});

	test("returns an empty answer and no results for an empty results array", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/search", response: { results: [] } }])}
const result = await searchWithParallel("empty query");
console.log(JSON.stringify({ answer: result.answer, results: result.results }));
`);
		assertChildSuccess(child);
		const parsed = JSON.parse(child.stdout.trim());
		assert.equal(parsed.answer, "");
		assert.deepEqual(parsed.results, []);
	});

	test("keeps URL-bearing results but omits content-less entries from the answer", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		// The returned `results` array only drops entries with an empty url;
		// the synthesized `answer` additionally drops entries that have no
		// excerpt content (buildAnswerFromResults requires both).
		const dropResponse = {
			results: [
				{ url: "https://example.test/kept", title: "Kept", excerpts: ["keep me"] },
				{ url: "", title: "No URL", excerpts: ["dropped"] },
				{ url: "https://example.test/no-excerpts", title: "No Excerpts", excerpts: [] },
				{ url: "https://example.test/blank", title: "Blank", excerpts: ["   "] },
			],
		};
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/search", response: dropResponse }])}
const result = await searchWithParallel("drop query");
console.log(JSON.stringify({ results: result.results, answer: result.answer }));
`);
		assertChildSuccess(child);
		const parsed = JSON.parse(child.stdout.trim());

		// Results: only the URL-less entry is dropped; snippet-less entries stay.
		assert.deepEqual(parsed.results.map((r) => r.url), [
			"https://example.test/kept",
			"https://example.test/no-excerpts",
			"https://example.test/blank",
		]);
		const byUrl = Object.fromEntries(parsed.results.map((r) => [r.url, r]));
		assert.equal(byUrl["https://example.test/kept"].snippet, "keep me");
		assert.equal(byUrl["https://example.test/no-excerpts"].snippet, "");

		// Answer: includes only the entry with both a url AND excerpt content.
		assert.match(parsed.answer, /keep me/);
		assert.doesNotMatch(parsed.answer, /dropped/);
	});

	test("truncates the per-result snippet to 1000 characters", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		const longExcerpt = "x".repeat(2500);
		const longResponse = { results: [{ url: "https://example.test/long", title: "Long", excerpts: [longExcerpt] }] };
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/search", response: longResponse }])}
const result = await searchWithParallel("long query");
console.log(JSON.stringify({ snippetLength: result.results[0]?.snippet?.length ?? 0 }));
`);
		assertChildSuccess(child);
		assert.equal(JSON.parse(child.stdout.trim()).snippetLength, 1000);
	});

	test("sends domain + recency filters in the request body", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/search", response: { results: [] } }])}
await searchWithParallel("filtered query", {
	domainFilter: ["example.com", "-spam.com"],
	recencyFilter: "week",
	numResults: 10,
});
console.log(JSON.stringify({ callBody: globalThis.__getParallelFetchCalls()[0]?.body ?? null }));
`);
		assertChildSuccess(child);
		const parsed = JSON.parse(child.stdout.trim());
		const policy = parsed.callBody.advanced_settings.source_policy;

		assert.equal(parsed.callBody.advanced_settings.max_results, 10);
		assert.deepEqual(policy.include_domains, ["example.com"]);
		assert.deepEqual(policy.exclude_domains, ["spam.com"]);
		assert.match(policy.after_date, /^\d{4}-\d{2}-\d{2}$/);
		// "week" -> ~7 days ago (tolerant: within 2 days of 7 days ago).
		const afterDate = new Date(`${policy.after_date}T00:00:00Z`);
		const weekAgo = new Date(Date.now() - 7 * 86400000);
		assert.ok(Math.abs(afterDate.getTime() - weekAgo.getTime()) < 2 * 86400000);
	});

	test("caps numResults at 20", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/search", response: { results: [] } }])}
await searchWithParallel("capped query", { numResults: 99 });
console.log(JSON.stringify({ maxResults: globalThis.__getParallelFetchCalls()[0]?.body?.advanced_settings?.max_results ?? null }));
`);
		assertChildSuccess(child);
		assert.equal(JSON.parse(child.stdout.trim()).maxResults, 20);
	});

	test("does not populate source_policy when no domain/recency filters are given", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/search", response: { results: [] } }])}
await searchWithParallel("plain query");
console.log(JSON.stringify({ sourcePolicy: globalThis.__getParallelFetchCalls()[0]?.body?.advanced_settings?.source_policy ?? null }));
`);
		assertChildSuccess(child);
		assert.equal(JSON.parse(child.stdout.trim()).sourcePolicy, null);
	});

	test("throws on a non-ok HTTP response", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/search", ok: false, status: 429, response: "rate limited" }])}
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

	test("handles a results field that is not an array (defensive)", async () => {
		const home = await createTempHome();
		await writeWebSearchConfig(home, { parallelApiKey: "test-key" });
		const weirdResponse = { results: "not-an-array" };
		const child = runSearch(home, `
${buildFetchMockScript([{ urlMatch: "api.parallel.ai/v1/search", response: weirdResponse }])}
const result = await searchWithParallel("weird response");
console.log(JSON.stringify({ answer: result.answer, results: result.results }));
`);
		assertChildSuccess(child);
		const parsed = JSON.parse(child.stdout.trim());
		assert.equal(parsed.answer, "");
		assert.deepEqual(parsed.results, []);
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
