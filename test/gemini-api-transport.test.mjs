import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Ports upstream #154 (@nicobailon, the key->header security slice) onto our
// subfolder layout. Verifies every Gemini API transport path (video generate,
// upload init + PUT, file-state GET, file DELETE) authenticates via the
// `x-goog-api-key` header and NEVER puts the key in the URL query string.
//
// video-extract.ts imports only local modules + npm deps (no @earendil-works/*
// host packages), so it loads cleanly under tsx in a child process with mocked
// globalThis.fetch — same harness as test/youtube-errors.test.mjs.
const videoModuleUrl = new URL("../extractors/video-extract.ts", import.meta.url).href;
const TS_NODE_ARGS = ["--import", "tsx"];

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of ["PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "GEMINI_API_KEY", "GOOGLE_GEMINI_BASE_URL", "CLOUDFLARE_API_KEY", "PI_ALLOW_BROWSER_COOKIES"]) {
		delete childEnv[key];
	}
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module", ...TS_NODE_ARGS], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

test("Gemini generate, upload, status, and delete use header auth only (no key in URL)", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-transport-"));
	const mediaPath = join(root, "synthetic.webm");
	await writeFile(mediaPath, "synthetic media", "utf8");

	const child = runChild(`
		const requests = [];
		globalThis.fetch = async (url, init = {}) => {
			const request = {
				url: String(url),
				method: init.method ?? "GET",
				headers: Object.fromEntries(new Headers(init.headers)),
			};
			requests.push(request);
			if (request.url.endsWith("/upload/v1beta/files")) {
				return new Response("", {
					status: 200,
					headers: { "x-goog-upload-url": "https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=synthetic" },
				});
			}
			if (request.url.includes("upload_id=synthetic")) {
				return new Response(JSON.stringify({ file: { name: "files/synthetic", uri: "files/synthetic" } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (request.url.endsWith("/v1beta/files/synthetic") && request.method === "GET") {
				return new Response(JSON.stringify({ state: "ACTIVE" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (request.url.includes(":generateContent")) {
				return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "# Synthetic video" }] } }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (request.url.endsWith("/v1beta/files/synthetic") && request.method === "DELETE") {
				return new Response("", { status: 204 });
			}
			throw new Error("Unexpected fetch: " + request.url);
		};

		const { extractVideo } = await import(${JSON.stringify(videoModuleUrl)});
		const result = await extractVideo({
			absolutePath: ${JSON.stringify(mediaPath)},
			mimeType: "video/webm",
			sizeBytes: 15,
		});
		await new Promise(resolve => setImmediate(resolve));
		console.log(JSON.stringify({ result, requests }));
	`, {
		HOME: root,
		USERPROFILE: root,
		PI_CODING_AGENT_DIR: root,
		GEMINI_API_KEY: "synthetic-gemini-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.result.content, "# Synthetic video");
	assert.deepEqual(output.requests.map((r) => r.method), ["POST", "PUT", "GET", "POST", "DELETE"]);
	for (const request of output.requests) {
		assert.equal(request.headers["x-goog-api-key"], "synthetic-gemini-key", `missing x-goog-api-key on ${request.method} ${request.url}`);
		const url = new URL(request.url);
		assert.equal(url.searchParams.has("key"), false, `key query param leaked on ${request.url}`);
		assert.equal(url.searchParams.has("api_key"), false, `api_key query param leaked on ${request.url}`);
		assert.equal(request.url.includes("synthetic-gemini-key"), false, `raw key present in URL ${request.url}`);
	}
});

// Source-grep regression guard (P1 acceptance): no Gemini URL build may reintroduce
// a `?key=` / `&key=` query param. Comments are stripped first so the deprecation
// note on buildKeyParam (which mentions `?key=`) is not a false hit — same idiom as
// test/provider-diversity-optin.test.mjs.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const GEMINI_SOURCES = [
	"../providers/gemini-api.ts",
	"../providers/gemini-search.ts",
	"../providers/gemini-url-context.ts",
	"../extractors/video-extract.ts",
];

test("no Gemini URL build uses a key query param; gemini-api emits x-goog-api-key", () => {
	for (const rel of GEMINI_SOURCES) {
		const code = stripComments(readFileSync(new URL(rel, import.meta.url), "utf8"));
		assert.doesNotMatch(code, /\?key=/, `${rel} still builds a ?key= URL`);
		assert.doesNotMatch(code, /&key=/, `${rel} still builds a &key= URL`);
	}
	const apiCode = stripComments(readFileSync(new URL("../providers/gemini-api.ts", import.meta.url), "utf8"));
	assert.match(apiCode, /"x-goog-api-key": apiKey/, "gemini-api.ts must emit the x-goog-api-key header");
});
