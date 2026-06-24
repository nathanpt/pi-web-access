import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Ports upstream #100 (b305b2f) test intent onto our subfolder layout.
// youtube-extract.ts now returns a structured { url, title, content, error }
// aggregating each provider attempt's real failure instead of bare null.
//
// extractors/youtube-extract.ts imports only local modules + npm deps (no
// @mariozechner/* host packages), so it loads cleanly under tsx in a child
// process with mocked globalThis.fetch.
const moduleUrl = new URL("../extractors/youtube-extract.ts", import.meta.url).href;
const TS_NODE_ARGS = ["--import", "tsx"];

function runChild(home, childScript) {
	const env = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		GEMINI_API_KEY: "test-gemini-key",
		PERPLEXITY_API_KEY: "",
	};
	delete env.PI_ALLOW_BROWSER_COOKIES;
	delete env.FEYNMAN_ALLOW_BROWSER_COOKIES;

	return spawnSync(process.execPath, ["--input-type=module", ...TS_NODE_ARGS], {
		input: childScript,
		encoding: "utf8",
		env,
	});
}

// Mocks globalThis.fetch to answer Gemini API generateContent calls.
function buildScript(moduleUrl, fetchImplSrc) {
	return `
		process.on("uncaughtException", (error) => {
			console.error(error?.stack || error);
			process.exit(1);
		});
		process.on("unhandledRejection", (error) => {
			console.error(error?.stack || error);
			process.exit(1);
		});

		globalThis.fetch = ${fetchImplSrc};

		const { extractYouTube } = await import(${JSON.stringify(moduleUrl)});
		const result = await extractYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
		console.log(JSON.stringify(result));
	`;
}

test("YouTube extraction surfaces the real Gemini API error when all attempts fail", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-youtube-errors-"));

	// Gemini API returns 503; no browser cookies, no Perplexity key -> only the
	// Gemini API attempt runs and fails, so its real error is aggregated.
	const fetchImpl = `async (input) => {
		const url = String(input);
		if (url.startsWith("https://generativelanguage.googleapis.com/")) {
			return new Response(JSON.stringify({ error: { message: "model overloaded" } }), {
				status: 503,
				statusText: "Service Unavailable",
				headers: { "content-type": "application/json" },
			});
		}
		throw new Error("Unexpected fetch: " + url);
	}`;

	const child = runChild(home, buildScript(moduleUrl, fetchImpl));
	assert.equal(child.status, 0, child.stderr || child.stdout);

	const result = JSON.parse(child.stdout);
	assert.equal(result.title, "");
	assert.equal(result.content, "");
	assert.ok(result.error, "expected an aggregated error string");
	// Real per-attempt failure is surfaced...
	assert.match(result.error, /Gemini API error 503/);
	// ...and the generic guidance is NOT substituted in.
	assert.doesNotMatch(result.error, /Sign into Google in Chrome/);
});

test("YouTube extraction returns content with no error when Gemini API succeeds", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-youtube-ok-"));

	const fetchImpl = `async (input) => {
		const url = String(input);
		if (url.startsWith("https://generativelanguage.googleapis.com/")) {
			return new Response(JSON.stringify({
				candidates: [{ content: { parts: [{ text: "# My Video\\n\\nTranscript here." }] } }],
			}), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		// Thumbnail fetch (img.youtube.com) — return empty so it is skipped.
		if (url.startsWith("https://img.youtube.com/")) {
			return new Response("", { status: 404 });
		}
		throw new Error("Unexpected fetch: " + url);
	}`;

	const child = runChild(home, buildScript(moduleUrl, fetchImpl));
	assert.equal(child.status, 0, child.stderr || child.stdout);

	const result = JSON.parse(child.stdout);
	assert.equal(result.error, null);
	assert.ok(result.content);
	assert.match(result.content, /My Video/);
});
