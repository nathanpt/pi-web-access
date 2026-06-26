import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Exercises the REAL providers/searxng.ts module end-to-end. Each case runs in
// a child process (`--import tsx`) with an isolated HOME + PI_CODING_AGENT_DIR
// and a cleared SEARXNG_BASE_URL, so module-level config reads start clean.
// Pattern matches test/parallel.test.mjs (child-process isolation + fetch mock).
const searxngModuleUrl = new URL("../providers/searxng.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	// Clear search-config inputs so availability starts from a known state.
	delete childEnv.SEARXNG_BASE_URL;
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

test("isSearXNGAvailable returns false with no base URL configured", async () => {
	const { home, agentDir } = await freshHome("pi-searxng-none-");
	const out = runChild(
		`const { isSearXNGAvailable } = await import(${JSON.stringify(searxngModuleUrl)});
		 console.log(JSON.stringify({ available: isSearXNGAvailable() }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir },
	);
	assert.equal(JSON.parse(out).available, false);
});

test("isSearXNGAvailable returns true when SEARXNG_BASE_URL is set", async () => {
	const { home, agentDir } = await freshHome("pi-searxng-env-");
	const out = runChild(
		`const { isSearXNGAvailable } = await import(${JSON.stringify(searxngModuleUrl)});
		 console.log(JSON.stringify({ available: isSearXNGAvailable() }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, SEARXNG_BASE_URL: "https://search.example.com/" },
	);
	assert.equal(JSON.parse(out).available, true);
});

test("isSearXNGAvailable rejects non-http base URLs", async () => {
	const { home, agentDir } = await freshHome("pi-searxng-badproto-");
	const out = runChild(
		`const { isSearXNGAvailable } = await import(${JSON.stringify(searxngModuleUrl)});
		 console.log(JSON.stringify({ available: isSearXNGAvailable() }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, SEARXNG_BASE_URL: "file:///etc/passwd" },
	);
	assert.equal(JSON.parse(out).available, false);
});

test("searchWithSearXNG throws when no base URL is configured", async () => {
	const { home, agentDir } = await freshHome("pi-searxng-nokey-");
	const out = runChild(
		`const { searchWithSearXNG } = await import(${JSON.stringify(searxngModuleUrl)});
		 try { await searchWithSearXNG("test"); console.log(JSON.stringify({ threw: false })); }
		 catch (err) { console.log(JSON.stringify({ threw: true, msg: err.message })); }`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir },
	);
	const result = JSON.parse(out);
	assert.equal(result.threw, true);
	assert.match(result.msg, /SearXNG base URL not found/);
});

test("searchWithSearXNG uses configured base URL and maps JSON results", async () => {
	const { home, agentDir } = await freshHome("pi-searxng-config-");
	const out = runChild(
		`const { writeFileSync } = await import("node:fs");
		 writeFileSync(${JSON.stringify(join(agentDir, "web-search.json"))}, JSON.stringify({ searxngBaseUrl: "https://search.example.com/" }));

		 let capturedUrl = "";
		 let capturedHeaders = null;
		 globalThis.fetch = async (url, init) => {
			 capturedUrl = String(url);
			 capturedHeaders = init.headers;
			 return new Response(JSON.stringify({
				 answers: ["SearXNG instant answer"],
				 results: [
					 { title: "Pi Web Access", url: "https://github.com/nathanpt/pi-web-access", content: "repo snippet" },
					 { title: "Blocked", url: "https://gist.github.com/nathanpt/abc", content: "blocked snippet" },
					 { title: "Other", url: "https://example.com/nope", content: "other snippet" },
				 ],
			 }), { status: 200, headers: { "content-type": "application/json" } });
		 };

		 const { isSearXNGAvailable, searchWithSearXNG } = await import(${JSON.stringify(searxngModuleUrl)});
		 const available = isSearXNGAvailable();
		 const result = await searchWithSearXNG("pi web access", {
			 domainFilter: ["github.com", "-gist.github.com"],
			 recencyFilter: "week",
			 numResults: 2,
		 });
		 const parsedUrl = new URL(capturedUrl);
		 console.log(JSON.stringify({
			 available,
			 url: parsedUrl.origin + parsedUrl.pathname,
			 q: parsedUrl.searchParams.get("q"),
			 format: parsedUrl.searchParams.get("format"),
			 timeRange: parsedUrl.searchParams.get("time_range"),
			 accept: capturedHeaders.Accept,
			 result,
		 }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir },
	);

	const output = JSON.parse(out);
	assert.equal(output.available, true);
	assert.equal(output.url, "https://search.example.com/search");
	assert.match(output.q, /pi web access/);
	assert.match(output.q, /site:github\.com/);
	assert.match(output.q, /-site:gist\.github\.com/);
	assert.equal(output.format, "json");
	assert.equal(output.timeRange, "week");
	assert.equal(output.accept, "application/json");
	assert.deepEqual(output.result.results, [{ title: "Pi Web Access", url: "https://github.com/nathanpt/pi-web-access", snippet: "repo snippet" }]);
	assert.match(output.result.answer, /SearXNG instant answer/);
	assert.match(output.result.answer, /repo snippet/);
});

test("searchWithSearXNG strips trailing slashes but preserves a subpath base URL", async () => {
	const { home, agentDir } = await freshHome("pi-searxng-normalize-");
	const out = runChild(
		`let capturedUrl = "";
		 globalThis.fetch = async (url) => {
			 capturedUrl = String(url);
			 return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
		 };
		 const { searchWithSearXNG } = await import(${JSON.stringify(searxngModuleUrl)});
		 await searchWithSearXNG("x");
		 console.log(JSON.stringify({ full: new URL(capturedUrl).origin + new URL(capturedUrl).pathname }));`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, SEARXNG_BASE_URL: "https://search.example.com/some/path///" },
	);
	const output = JSON.parse(out);
	// Trailing slashes are stripped; a legitimate subpath deployment is preserved.
	assert.equal(output.full, "https://search.example.com/some/path/search");
});

test("searchWithSearXNG surfaces a non-ok response as an error", async () => {
	const { home, agentDir } = await freshHome("pi-searxng-error-");
	const out = runChild(
		`globalThis.fetch = async () => new Response("upstream error", { status: 502 });
		 const { searchWithSearXNG } = await import(${JSON.stringify(searxngModuleUrl)});
		 try { await searchWithSearXNG("x"); console.log(JSON.stringify({ threw: false })); }
		 catch (err) { console.log(JSON.stringify({ threw: true, msg: err.message })); }`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, SEARXNG_BASE_URL: "https://search.example.com" },
	);
	const result = JSON.parse(out);
	assert.equal(result.threw, true);
	assert.match(result.msg, /SearXNG search error 502/);
});
