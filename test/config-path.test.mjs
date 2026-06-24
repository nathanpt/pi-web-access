import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Tests for XDG web-search config resolution (ports upstream 4d6b7cc / #89).
// Adapted to this fork: utils.ts lives at repo root; the provider modules live
// in providers/ (gemini-api, perplexity). Uses the child-process isolation
// pattern from test/parallel.test.mjs / test/config-path.test.mjs (upstream).

const utilsUrl = new URL("../utils.ts", import.meta.url).href;
const perplexityUrl = new URL("../providers/perplexity.ts", import.meta.url).href;
const geminiApiUrl = new URL("../providers/gemini-api.ts", import.meta.url).href;

const TS_NODE_ARGS = ["--import", "tsx"];

function runChild(script, env) {
	const childEnv = { ...process.env };
	// Strip inherited provider keys so availability is fully controlled by the test.
	for (const key of ["PERPLEXITY_API_KEY", "GEMINI_API_KEY", "CLOUDFLARE_API_KEY"]) {
		delete childEnv[key];
	}
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete childEnv[key];
		else childEnv[key] = value;
	}
	return spawnSync(process.execPath, ["--input-type=module", ...TS_NODE_ARGS], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

test("config path uses PI_CODING_AGENT_DIR before XDG_CONFIG_HOME", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-config-path-"));
	const agentDir = join(root, "agent-dir");
	const xdgDir = join(root, "xdg");
	await mkdir(agentDir, { recursive: true });
	await mkdir(join(xdgDir, "pi"), { recursive: true });
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify({ perplexityApiKey: "pplx-from-agent" }) + "\n", "utf8");
	await writeFile(join(xdgDir, "pi", "web-search.json"), JSON.stringify({}) + "\n", "utf8");

	const child = runChild(
		`const { getWebSearchConfigDir, getWebSearchConfigPath } = await import(${JSON.stringify(utilsUrl)});
		const { isPerplexityAvailable } = await import(${JSON.stringify(perplexityUrl)});
		console.log(JSON.stringify({ dir: getWebSearchConfigDir(), path: getWebSearchConfigPath(), available: isPerplexityAvailable() }));`,
		{
			PI_CODING_AGENT_DIR: agentDir,
			XDG_CONFIG_HOME: xdgDir,
			HOME: join(root, "home"),
			USERPROFILE: join(root, "home"),
		},
	);

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), {
		dir: agentDir,
		path: join(agentDir, "web-search.json"),
		available: true,
	});
});

test("config path uses XDG_CONFIG_HOME/pi when PI_CODING_AGENT_DIR is unset", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-xdg-config-"));
	const xdgDir = join(root, "xdg");
	await mkdir(join(xdgDir, "pi"), { recursive: true });
	await writeFile(join(xdgDir, "pi", "web-search.json"), JSON.stringify({ geminiApiKey: "gemini-from-xdg" }) + "\n", "utf8");

	const child = runChild(
		`const { getWebSearchConfigDir, getWebSearchConfigPath } = await import(${JSON.stringify(utilsUrl)});
		const { isGeminiApiAvailable } = await import(${JSON.stringify(geminiApiUrl)});
		console.log(JSON.stringify({ dir: getWebSearchConfigDir(), path: getWebSearchConfigPath(), available: isGeminiApiAvailable() }));`,
		{
			PI_CODING_AGENT_DIR: undefined,
			XDG_CONFIG_HOME: xdgDir,
			HOME: join(root, "home"),
			USERPROFILE: join(root, "home"),
		},
	);

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), {
		dir: join(xdgDir, "pi"),
		path: join(xdgDir, "pi", "web-search.json"),
		available: true,
	});
});

test("config path falls back to ~/.pi when neither env var is set", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-home-config-"));
	const home = join(root, "home");
	await mkdir(join(home, ".pi"), { recursive: true });
	await writeFile(join(home, ".pi", "web-search.json"), JSON.stringify({ perplexityApiKey: "pplx-from-home" }) + "\n", "utf8");

	const child = runChild(
		`const { getWebSearchConfigDir, getWebSearchConfigPath } = await import(${JSON.stringify(utilsUrl)});
		const { isPerplexityAvailable } = await import(${JSON.stringify(perplexityUrl)});
		console.log(JSON.stringify({ dir: getWebSearchConfigDir(), path: getWebSearchConfigPath(), available: isPerplexityAvailable() }));`,
		{
			PI_CODING_AGENT_DIR: undefined,
			XDG_CONFIG_HOME: undefined,
			HOME: home,
			USERPROFILE: home,
		},
	);

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), {
		dir: join(home, ".pi"),
		path: join(home, ".pi", "web-search.json"),
		available: true,
	});
});
