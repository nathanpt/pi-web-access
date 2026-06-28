import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Exercises the REAL providers/brave.ts module end-to-end. Each case runs in a
// child process (`--import tsx`) with an isolated HOME + PI_CODING_AGENT_DIR
// and a cleared BRAVE_API_KEY, so module-level config reads start clean.
// Pattern matches test/olostep.test.mjs / test/searxng.test.mjs.
const braveModuleUrl = new URL("../providers/brave.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	delete childEnv.BRAVE_API_KEY;
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

test("isBraveAvailable returns false with no API key configured", async () => {
	const { home, agentDir } = await freshHome("pi-brave-none-");
	const out = runChild(
		`const { isBraveAvailable } = await import(${JSON.stringify(braveModuleUrl)});
		 console.log(JSON.stringify({ available: isBraveAvailable() }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir },
	);
	assert.equal(JSON.parse(out).available, false);
});

test("isBraveAvailable returns true when BRAVE_API_KEY is set", async () => {
	const { home, agentDir } = await freshHome("pi-brave-env-");
	const out = runChild(
		`const { isBraveAvailable } = await import(${JSON.stringify(braveModuleUrl)});
		 console.log(JSON.stringify({ available: isBraveAvailable() }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, BRAVE_API_KEY: "brave-test-key" },
	);
	assert.equal(JSON.parse(out).available, true);
});

test("isBraveAvailable treats placeholder values as missing", async () => {
	const { home, agentDir } = await freshHome("pi-brave-placeholder-");
	const out = runChild(
		`const { isBraveAvailable } = await import(${JSON.stringify(braveModuleUrl)});
		 console.log(JSON.stringify({ available: isBraveAvailable() }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, BRAVE_API_KEY: "your-key" },
	);
	// Shared normalizeApiKey rejects placeholders so a leftover doc value can't 401 mid-fallback.
	assert.equal(JSON.parse(out).available, false);
});

test("searchWithBrave returns null with no API key (yields to fallback)", async () => {
	const { home, agentDir } = await freshHome("pi-brave-nokey-");
	const out = runChild(
		`const { searchWithBrave } = await import(${JSON.stringify(braveModuleUrl)});
		 const result = await searchWithBrave("test");
		 console.log(JSON.stringify({ result }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir },
	);
	assert.equal(JSON.parse(out).result, null);
});

test("searchWithBrave applies domain filters in the query and returned results", async () => {
	const { home, agentDir } = await freshHome("pi-brave-domain-");
	const out = runChild(
		`let capturedUrl = "";
		 let capturedInit = null;
		 globalThis.fetch = async (url, init) => {
			 capturedUrl = String(url);
			 capturedInit = init;
			 return new Response(JSON.stringify({
				 web: { results: [
					 { title: "Repo", url: "https://github.com/foo/bar", description: "main" },
					 { title: "Gist", url: "https://gist.github.com/x", description: "gist" },
					 { title: "Other", url: "https://example.com/y", description: "other" },
				 ] },
			 }), { status: 200, headers: { "content-type": "application/json" } });
		 };
		 const { searchWithBrave } = await import(${JSON.stringify(braveModuleUrl)});
		 const result = await searchWithBrave("pi web access", {
			 numResults: 5,
			 domainFilter: ["github.com", "-gist.github.com"],
		 });
		 const u = new URL(capturedUrl);
		 console.log(JSON.stringify({
			 base: u.origin + u.pathname,
			 q: u.searchParams.get("q"),
			 count: u.searchParams.get("count"),
			 token: capturedInit.headers["X-Subscription-Token"],
			 resultUrls: result.results.map(r => r.url),
			 answer: result.answer,
		 }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, BRAVE_API_KEY: "brave-test-key" },
	);
	const output = JSON.parse(out);
	assert.equal(output.base, "https://api.search.brave.com/res/v1/web/search");
	// Domain include/exclude injected into the query string (Brave has no API domain filter).
	assert.match(output.q, /site:github\.com/);
	assert.match(output.q, /NOT site:gist\.github\.com/);
	// count bumped to 20 when domainFilter present so post-filter still yields enough.
	assert.equal(output.count, "20");
	assert.equal(output.token, "brave-test-key");
	// Client-side re-filter keeps github.com, drops gist + example.
	assert.deepEqual(output.resultUrls, ["https://github.com/foo/bar"]);
	assert.match(output.answer, /Source: Repo/);
});

test("searchWithBrave maps freshness for recencyFilter", async () => {
	const { home, agentDir } = await freshHome("pi-brave-recency-");
	const out = runChild(
		`let capturedUrl = "";
		 globalThis.fetch = async (url) => { capturedUrl = String(url); return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 }); };
		 const { searchWithBrave } = await import(${JSON.stringify(braveModuleUrl)});
		 await searchWithBrave("news", { recencyFilter: "week" });
		 console.log(JSON.stringify({ freshness: new URL(capturedUrl).searchParams.get("freshness"), count: new URL(capturedUrl).searchParams.get("count") }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, BRAVE_API_KEY: "brave-test-key" },
	);
	const output = JSON.parse(out);
	assert.equal(output.freshness, "pw");
	assert.equal(output.count, "5"); // no domainFilter -> count == numResults default
});

test("searchWithBrave surfaces a non-ok response as a thrown error", async () => {
	const { home, agentDir } = await freshHome("pi-brave-error-");
	const out = runChild(
		`globalThis.fetch = async () => new Response("rate limited", { status: 429 });
		 const { searchWithBrave } = await import(${JSON.stringify(braveModuleUrl)});
		 try { await searchWithBrave("x"); console.log(JSON.stringify({ threw: false })); }
		 catch (err) { console.log(JSON.stringify({ threw: true, msg: err.message })); }`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, BRAVE_API_KEY: "brave-test-key" },
	);
	const result = JSON.parse(out);
	assert.equal(result.threw, true);
	assert.match(result.msg, /Brave Search API error 429/);
});
