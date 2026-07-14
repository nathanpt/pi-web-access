import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Exercises the REAL providers/brightdata.ts + brightdata-feeds.ts modules
// end-to-end. Each case runs in a child process (`--import tsx`) with an
// isolated HOME + PI_CODING_AGENT_DIR and cleared BRIGHTDATA_* env, so
// module-level config reads start clean. Pattern matches test/tavily.test.mjs.
const brightdataModuleUrl = new URL("../providers/brightdata.ts", import.meta.url).href;
const feedsModuleUrl = new URL("../providers/brightdata-feeds.ts", import.meta.url).href;
const searchModuleUrl = new URL("../providers/gemini-search.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of [
		"BRIGHTDATA_API_TOKEN",
		"BRIGHTDATA_API_KEY",
		"BRIGHTDATA_ZONE",
		"BRIGHTDATA_UNLOCKER_ZONE",
		"BRIGHTDATA_SERP_ZONE",
		"BRIGHTDATA_POLL_INTERVAL_MS",
		"BRIGHTDATA_POLL_TIMEOUT_MS",
		"PI_CODING_AGENT_DIR",
		"XDG_CONFIG_HOME",
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
	return home;
}

// ── Availability ──

test("isBrightDataAvailable is false with no token", async () => {
	const home = await freshHome("bd-avail-none-");
	const out = runChild(`
		const { isBrightDataAvailable } = await import(${JSON.stringify(brightdataModuleUrl)});
		console.log(JSON.stringify({ available: isBrightDataAvailable() }));
	`, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home });
	assert.equal(JSON.parse(out).available, false);
});

test("isBrightDataAvailable is true with BRIGHTDATA_API_TOKEN", async () => {
	const home = await freshHome("bd-avail-token-");
	const out = runChild(`
		const { isBrightDataAvailable } = await import(${JSON.stringify(brightdataModuleUrl)});
		console.log(JSON.stringify({ available: isBrightDataAvailable() }));
	`, { HOME: home, USERPROFILE: home, BRIGHTDATA_API_TOKEN: "brd-real-token" });
	assert.equal(JSON.parse(out).available, true);
});

test("isBrightDataAvailable treats placeholder values as missing", async () => {
	const home = await freshHome("bd-avail-placeholder-");
	const out = runChild(`
		const { isBrightDataAvailable } = await import(${JSON.stringify(brightdataModuleUrl)});
		console.log(JSON.stringify({ available: isBrightDataAvailable() }));
	`, { HOME: home, USERPROFILE: home, BRIGHTDATA_API_TOKEN: "your-key" });
	assert.equal(JSON.parse(out).available, false);
});

// ── SERP search ──

test("searchWithBrightData returns null with no token (yields to fallback)", async () => {
	const home = await freshHome("bd-serp-nokey-");
	const out = runChild(`
		let called = false;
		globalThis.fetch = async () => { called = true; return new Response("{}", { status: 200 }); };
		const { searchWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		const result = await searchWithBrightData("query");
		console.log(JSON.stringify({ result, called }));
	`, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home });
	const r = JSON.parse(out);
	assert.equal(r.result, null);
	assert.equal(r.called, false);
});

test("searchWithBrightData sends bearer auth + brd_json, parses organic, applies filters", async () => {
	const home = await freshHome("bd-serp-");
	const out = runChild(`
		let capturedHeaders = null;
		let capturedBody = null;
		globalThis.fetch = async (url, init) => {
			capturedHeaders = init.headers;
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({
				organic: [
					{ link: "https://github.com/x/y", title: "Repo", description: "the repo" },
					{ link: "https://gist.github.com/x/abc", title: "Gist", description: "a gist" },
					{ link: "https://example.com/nope", title: "Ex", description: "nope" },
				],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};
		const { searchWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		const result = await searchWithBrightData("sdk docs", {
			domainFilter: ["github.com", "-gist.github.com"],
			recencyFilter: "week",
			numResults: 2,
		});
		console.log(JSON.stringify({
			auth: capturedHeaders.Authorization,
			zone: capturedBody.zone,
			format: capturedBody.format,
			dataFormat: capturedBody.data_format,
			brdJson: capturedBody.url.includes("brd_json=1"),
			recency: capturedBody.url.includes("tbs=qdr%3Aw"),
			hasSite: decodeURIComponent(capturedBody.url).includes("site:github.com"),
			hasExclude: decodeURIComponent(capturedBody.url).includes("-site:gist.github.com"),
			results: result.results.map(r => r.url),
			answerHasRepo: result.answer.includes("the repo"),
		}));
	`, { HOME: home, USERPROFILE: home, BRIGHTDATA_API_TOKEN: "brd-token" });
	const r = JSON.parse(out);
	assert.equal(r.auth, "Bearer brd-token");
	assert.equal(r.zone, "mcp_unlocker");
	assert.equal(r.format, "raw");
	assert.equal(r.dataFormat, "parsed_light");
	assert.equal(r.brdJson, true);
	assert.equal(r.recency, true);
	assert.equal(r.hasSite, true);
	assert.equal(r.hasExclude, true);
	// gist (blocked) + example (not allowed) filtered out post-parse.
	assert.deepEqual(r.results, ["https://github.com/x/y"]);
	assert.equal(r.answerHasRepo, true);
});

test("searchWithBrightData honors a custom zone from config (legacy brightdataZone)", async () => {
	const home = await freshHome("bd-zone-");
	writeFileSync(join(home, "web-search.json"), JSON.stringify({ brightdataApiKey: "cfg-token", brightdataZone: "my_zone" }));
	const out = runChild(`
		let body = null;
		globalThis.fetch = async (url, init) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ organic: [] }), { status: 200 }); };
		const { searchWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		await searchWithBrightData("q");
		console.log(JSON.stringify({ zone: body.zone }));
	`, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home });
	assert.equal(JSON.parse(out).zone, "my_zone");
});

test("searchWithBrightData surfaces a non-ok response as a thrown error", async () => {
	const home = await freshHome("bd-serp-err-");
	const out = runChild(`
		globalThis.fetch = async () => new Response("forbidden", { status: 403 });
		const { searchWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		let err = null;
		try { await searchWithBrightData("q"); } catch (e) { err = String(e); }
		console.log(JSON.stringify({ err }));
	`, { HOME: home, USERPROFILE: home, BRIGHTDATA_API_TOKEN: "brd-token" });
	const r = JSON.parse(out);
	assert.match(r.err, /403/);
});

// ── Web Unlocker scrape ──

test("scrapeWithBrightData returns markdown with extracted title", async () => {
	const home = await freshHome("bd-scrape-");
	const out = runChild(`
		let body = null;
		globalThis.fetch = async (url, init) => { body = JSON.parse(init.body); return new Response("# Real Title\\n\\n" + "content ".repeat(50), { status: 200 }); };
		const { scrapeWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		const result = await scrapeWithBrightData("https://blocked.example.com/a");
		console.log(JSON.stringify({ dataFormat: body.data_format, zone: body.zone, title: result?.title, hasContent: !!result?.content, error: result?.error }));
	`, { HOME: home, USERPROFILE: home, BRIGHTDATA_API_TOKEN: "brd-token" });
	const r = JSON.parse(out);
	assert.equal(r.dataFormat, "markdown");
	assert.equal(r.zone, "mcp_unlocker");
	assert.equal(r.title, "Real Title");
	assert.equal(r.hasContent, true);
	assert.equal(r.error, null);
});

test("scrapeWithBrightData returns null without a token and on error (falls through)", async () => {
	const home = await freshHome("bd-scrape-fallthrough-");
	// No key → null, no network call.
	const noKey = runChild(`
		let called = false;
		globalThis.fetch = async () => { called = true; return new Response("x", { status: 200 }); };
		const { scrapeWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		const result = await scrapeWithBrightData("https://blocked.example.com/a");
		console.log(JSON.stringify({ result, called }));
	`, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home });
	const r1 = JSON.parse(noKey);
	assert.equal(r1.result, null);
	assert.equal(r1.called, false);
	// HTTP error → null (caller falls through to next extractor).
	const httpErr = runChild(`
		globalThis.fetch = async () => new Response("blocked", { status: 403 });
		const { scrapeWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		const result = await scrapeWithBrightData("https://blocked.example.com/a");
		console.log(JSON.stringify({ result }));
	`, { HOME: home, USERPROFILE: home, BRIGHTDATA_API_TOKEN: "brd-token" });
	assert.equal(JSON.parse(httpErr).result, null);
});

// ── Structured feeds ──

test("detectBrightDataFeed routes known platform URLs and ignores others", async () => {
	const home = await freshHome("bd-detect-");
	const out = runChild(`
		const { detectBrightDataFeed } = await import(${JSON.stringify(feedsModuleUrl)});
		const id = (u) => detectBrightDataFeed(u)?.id ?? null;
		console.log(JSON.stringify({
			amazon: id("https://www.amazon.com/Thing/dp/B0ABCD1234"),
			reddit: id("https://www.reddit.com/r/rust/comments/abc/title/"),
			npm: id("https://www.npmjs.com/package/p-limit"),
			pypi: id("https://pypi.org/project/requests/"),
			plain: id("https://example.com/article"),
			amazonHome: id("https://www.amazon.com/"),
		}));
	`, { HOME: home, USERPROFILE: home });
	const r = JSON.parse(out);
	assert.equal(r.amazon, "amazon_product");
	assert.equal(r.reddit, "reddit_posts");
	assert.equal(r.npm, "npm_package");
	assert.equal(r.pypi, "pypi_package");
	assert.equal(r.plain, null);
	assert.equal(r.amazonHome, null);
});

test("fetchBrightDataFeed triggers a snapshot, polls past building, returns records", async () => {
	const home = await freshHome("bd-feed-");
	const out = runChild(`
		let triggerBody = null;
		let snapshotHits = 0;
		globalThis.fetch = async (url, init) => {
			const u = String(url);
			if (u.includes("/datasets/v3/trigger")) {
				triggerBody = JSON.parse(init.body);
				return new Response(JSON.stringify({ snapshot_id: "snap1" }), { status: 200 });
			}
			if (u.includes("/datasets/v3/snapshot/")) {
				snapshotHits++;
				if (snapshotHits === 1) return new Response(JSON.stringify({ status: "building" }), { status: 200 });
				return new Response(JSON.stringify([{ title: "p-limit", downloads: 123 }]), { status: 200 });
			}
			throw new Error("unexpected: " + u);
		};
		const { detectBrightDataFeed, fetchBrightDataFeed } = await import(${JSON.stringify(feedsModuleUrl)});
		const feed = detectBrightDataFeed("https://www.npmjs.com/package/p-limit");
		const result = await fetchBrightDataFeed("https://www.npmjs.com/package/p-limit", feed);
		console.log(JSON.stringify({
			triggerBody,
			title: result?.title,
			hasDataset: result?.content.includes(feed.datasetId),
			hasRecord: result?.content.includes("p-limit"),
			error: result?.error,
		}));
	`, { HOME: home, USERPROFILE: home, BRIGHTDATA_API_TOKEN: "brd-token", BRIGHTDATA_POLL_INTERVAL_MS: "0" });
	const r = JSON.parse(out);
	// npm feed maps to { package_name }, not { url }.
	assert.deepEqual(r.triggerBody, [{ package_name: "p-limit" }]);
	assert.equal(r.title, "npm package (structured)");
	assert.equal(r.hasDataset, true);
	assert.equal(r.hasRecord, true);
	assert.equal(r.error, null);
});

test("fetchBrightDataFeed returns null without a token (no network call)", async () => {
	const home = await freshHome("bd-feed-nokey-");
	const out = runChild(`
		let called = false;
		globalThis.fetch = async () => { called = true; return new Response("{}", { status: 200 }); };
		const { detectBrightDataFeed, fetchBrightDataFeed } = await import(${JSON.stringify(feedsModuleUrl)});
		const feed = detectBrightDataFeed("https://pypi.org/project/requests/");
		const result = await fetchBrightDataFeed("https://pypi.org/project/requests/", feed);
		console.log(JSON.stringify({ result, called }));
	`, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home });
	const r = JSON.parse(out);
	assert.equal(r.result, null);
	assert.equal(r.called, false);
});

// ── Routing (fork-specific: Bright Data is OPT-IN) ──

test("explicit provider:brightdata routes through Bright Data", async () => {
	const home = await freshHome("bd-route-explicit-");
	const out = runChild(`
		globalThis.fetch = async (url) => {
			if (String(url) === "https://api.brightdata.com/request") {
				return new Response(JSON.stringify({
					organic: [{ link: "https://docs.rs/tokio", title: "Tokio", description: "async runtime" }],
				}), { status: 200, headers: { "content-type": "application/json" } });
			}
			throw new Error("unexpected: " + url);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const res = await search("rust async", { provider: "brightdata" });
		console.log(JSON.stringify({ provider: res.provider, n: res.results.length, answer: res.answer }));
	`, { HOME: home, USERPROFILE: home, BRIGHTDATA_API_TOKEN: "brd-token" });
	const r = JSON.parse(out);
	assert.equal(r.provider, "brightdata");
	assert.equal(r.n, 1);
	assert.match(r.answer, /async runtime/);
});

test("Bright Data is opt-in: not tried in auto mode even when only its token is set", async () => {
	const home = await freshHome("bd-route-optin-");
	const out = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const u = String(url);
			calls.push(u);
			if (u.includes("mcp.exa.ai")) return new Response("unavailable", { status: 503 });
			throw new Error("unexpected: " + u);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		let threw = false;
		try {
			await search("rust async", { provider: "auto" });
		} catch {
			threw = true;
		}
		console.log(JSON.stringify({ threw, brightdataCalled: calls.some(c => c.includes("brightdata.com")) }));
	`, { HOME: home, USERPROFILE: home, BRIGHTDATA_API_TOKEN: "brd-token" });
	const r = JSON.parse(out);
	assert.equal(r.threw, true, "auto should fail (no unpaid provider) rather than silently use Bright Data");
	assert.equal(r.brightdataCalled, false, "Bright Data must not be tried in the silent auto chain");
});
