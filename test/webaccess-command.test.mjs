import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// webaccess-command.ts is pure (config.ts + workflow.ts deps only, no host
// modules), so it imports directly under tsx. Writes go to the real config
// path, so each test isolates a temp HOME and clears XDG precedence env.
function isolate() {
	const home = mkdtempSync(join(tmpdir(), "wa-cmd-"));
	// Must delete XDG precedence env DIRECTLY on process.env (Object.assign
	// only adds keys; it won't remove an inherited PI_CODING_AGENT_DIR).
	// This is the AGENTS.md XDG test-isolation gotcha.
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.XDG_CONFIG_HOME;
	// Drop the module-level config cache so each test reads its own temp file.
	clearWebSearchConfigCache();
	return home;
}
function cleanup(home) {
	rmSync(home, { recursive: true, force: true });
}
function configPath(home) {
	return join(home, ".pi", "web-search.json");
}
function readConfig(home) {
	const p = configPath(home);
	return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : {};
}

const {
	validateProvider,
	validateWorkflow,
	validateBoolean,
	validateProviderPriority,
	validateSearchModel,
	validateCuratorTimeout,
	validateApiKey,
	handleWebAccessCommand,
	formatWebAccessSummary,
	SET_FIELDS,
} = await import("../webaccess-command.ts");
const { clearWebSearchConfigCache } = await import("../config.ts");

// ---- pure validators ----

test("validateProvider accepts known + rejects unknown", () => {
	assert.equal(validateProvider("perplexity").ok, true);
	assert.equal(validateProvider("auto").value, "auto");
	assert.equal(validateProvider("parallel").ok, true);
	assert.equal(validateProvider("bogus").ok, false);
	assert.match(validateProvider("bogus").error ?? "", /unknown provider/);
});

test("validateWorkflow gates auto-summary/summary-review on allowCurator", () => {
	assert.equal(validateWorkflow("none", true).ok, true);
	assert.equal(validateWorkflow("summary-review", true).ok, true);
	assert.equal(validateWorkflow("summary-review", false).ok, false);
	// auto-summary stays valid when curator disabled (headless mode)
	assert.equal(validateWorkflow("auto-summary", false).ok, true);
});

test("validateBoolean accepts on/off/true/false", () => {
	assert.deepEqual(validateBoolean("on", "x").value, true);
	assert.deepEqual(validateBoolean("off", "x").value, false);
	assert.deepEqual(validateBoolean("TRUE", "x").value, true);
	assert.equal(validateBoolean("maybe", "x").ok, false);
});

test("validateProviderPriority dedupes + rejects unknowns", () => {
	const r = validateProviderPriority("exa, perplexity, exa, gemini");
	assert.equal(r.ok, true);
	assert.deepEqual(r.value, ["exa", "perplexity", "gemini"]);
	assert.equal(validateProviderPriority("exa,bogus").ok, false);
	// meta-values are rejected in priority lists
	assert.equal(validateProviderPriority("auto,gemini").ok, false);
});

test("validateSearchModel rejects empty + whitespace", () => {
	assert.equal(validateSearchModel("gemini-2.5-flash").value, "gemini-2.5-flash");
	assert.equal(validateSearchModel("has space").ok, false);
	assert.equal(validateSearchModel("").ok, false);
});

test("validateCuratorTimeout bounds 1..600", () => {
	assert.equal(validateCuratorTimeout("30").value, 30);
	assert.equal(validateCuratorTimeout("0").ok, false);
	assert.equal(validateCuratorTimeout("601").ok, false);
	assert.equal(validateCuratorTimeout("abc").ok, false);
});

// ---- command handler (summary) ----

test("summary with no args renders provider table + redacts secrets", () => {
	const home = isolate();
	try {
		mkdirSync(join(home, ".pi"), { recursive: true });
		writeFileSync(configPath(home), JSON.stringify({ exaApiKey: "SECRET-EXA-123", provider: "exa" }));
		const { text, wrote } = handleWebAccessCommand("");
		assert.equal(wrote, false);
		assert.match(text, /Config file/);
		assert.match(text, /\| provider \|/);
		assert.match(text, /default provider.*exa/);
		// no secret leaks into the summary
		assert.equal(text.includes("SECRET"), false, "secret leaked into summary");
	} finally {
		cleanup(home);
	}
});

// ---- command handler (set mode + persistence) ----

test("set provider writes + invalidates cache", () => {
	const home = isolate();
	try {
		const { text, wrote } = handleWebAccessCommand("provider perplexity");
		assert.equal(wrote, true);
		assert.match(text, /Updated.*provider.*perplexity/);
		assert.equal(readConfig(home).provider, "perplexity");
	} finally {
		cleanup(home);
	}
});

test("set workflow writes and is read back by a subsequent summary", () => {
	const home = isolate();
	try {
		handleWebAccessCommand("workflow none");
		const { text } = handleWebAccessCommand("");
		assert.match(text, /workflow.*none/);
	} finally {
		cleanup(home);
	}
});

test("set provider-priority persists the list", () => {
	const home = isolate();
	try {
		const { wrote } = handleWebAccessCommand("provider-priority exa,gemini,parallel");
		assert.equal(wrote, true);
		assert.deepEqual(readConfig(home).providerPriority, ["exa", "gemini", "parallel"]);
	} finally {
		cleanup(home);
	}
});

test("set allow-browser-cookies on/off persists boolean", () => {
	const home = isolate();
	try {
		handleWebAccessCommand("allow-browser-cookies on");
		assert.equal(readConfig(home).allowBrowserCookies, true);
		handleWebAccessCommand("allow-browser-cookies off");
		assert.equal(readConfig(home).allowBrowserCookies, false);
	} finally {
		cleanup(home);
	}
});

test("set search-model persists", () => {
	const home = isolate();
	try {
		handleWebAccessCommand("search-model gemini-2.5-flash");
		assert.equal(readConfig(home).summaryModel, "gemini-2.5-flash");
	} finally {
		cleanup(home);
	}
});

test("set curator-timeout persists integer", () => {
	const home = isolate();
	try {
		handleWebAccessCommand("curator-timeout 45");
		assert.equal(readConfig(home).curatorTimeoutSeconds, 45);
	} finally {
		cleanup(home);
	}
});

test("validation failure does NOT write", () => {
	const home = isolate();
	try {
		const { wrote, text } = handleWebAccessCommand("provider bogus");
		assert.equal(wrote, false);
		assert.match(text, /Validation failed/);
		assert.equal(existsSync(configPath(home)), false, "file should not have been created");
	} finally {
		cleanup(home);
	}
});

test("unknown field returns help, does not write", () => {
	const home = isolate();
	try {
		const { wrote, text } = handleWebAccessCommand("unknown-field x");
		assert.equal(wrote, false);
		assert.match(text, /Unknown field/);
		assert.match(text, /provider, workflow/);
	} finally {
		cleanup(home);
	}
});

test("SET_FIELDS covers all documented set targets", () => {
	assert.deepEqual([...SET_FIELDS], [
		"provider", "workflow", "provider-priority", "allow-browser-cookies", "search-model", "curator-timeout",
	]);
});

test("formatWebAccessSummary never leaks secrets even with all keys set", () => {
	const home = isolate();
	try {
		mkdirSync(join(home, ".pi"), { recursive: true });
		writeFileSync(configPath(home), JSON.stringify({
			exaApiKey: "SECRET-EXA",
			perplexityApiKey: "SECRET-PPLX",
			parallelApiKey: "SECRET-PAR",
			geminiApiKey: "SECRET-GEM",
			cloudflareApiKey: "SECRET-CF",
			chromeProfile: "Default",
			allowBrowserCookies: true,
		}));
		const text = formatWebAccessSummary();
		assert.equal(text.includes("SECRET"), false, `secrets leaked: ${text}`);
	} finally {
		cleanup(home);
	}
});

// ---- validateApiKey ----

test("validateApiKey rejects empty + placeholders, accepts real keys", () => {
	assert.equal(validateApiKey("").ok, false);
	assert.equal(validateApiKey("your-key").ok, false);
	assert.equal(validateApiKey("your_api_key").ok, false);
	assert.equal(validateApiKey("<insert-key>").ok, false);
	assert.equal(validateApiKey("sk-real-key-12345").ok, true);
	assert.equal(validateApiKey("sk-real-key-12345").value, "sk-real-key-12345");
	// whitespace is trimmed
	assert.equal(validateApiKey("  sk-real  ").value, "sk-real");
});

// ---- set-key command ----

test("set-key writes the key under the provider's config key + invalidates cache", () => {
	const home = isolate();
	try {
		const { text, wrote } = handleWebAccessCommand("set-key parallel sk-par-abcdef1234");
		assert.equal(wrote, true);
		// confirmation never echoes the full key
		assert.equal(text.includes("sk-par-abcdef1234"), false, "full key echoed in confirmation");
		assert.match(text, /Set.*parallel.*ends in …1234/);
		// persisted under parallelApiKey (not "parallel")
		const cfg = readConfig(home);
		assert.equal(cfg.parallelApiKey, "sk-par-abcdef1234");
		assert.equal(cfg.parallel, undefined, "wrote under provider name instead of config key");
	} finally {
		cleanup(home);
	}
});

test("set-key works for every concrete provider", () => {
	const home = isolate();
	try {
		for (const [provider, configKey] of [
			["exa", "exaApiKey"],
			["perplexity", "perplexityApiKey"],
			["parallel", "parallelApiKey"],
			["gemini", "geminiApiKey"],
		]) {
			const { wrote } = handleWebAccessCommand(`set-key ${provider} realkey-${provider}-9999`);
			assert.equal(wrote, true, `${provider} set-key failed`);
			assert.equal(readConfig(home)[configKey], `realkey-${provider}-9999`);
		}
	} finally {
		cleanup(home);
	}
});

test("set-key rejects unknown provider + lists valid ones", () => {
	const home = isolate();
	try {
		const { wrote, text } = handleWebAccessCommand("set-key bogus somekey");
		assert.equal(wrote, false);
		assert.match(text, /unknown provider.*bogus/);
		assert.match(text, /exa, perplexity, parallel, gemini/);
		// meta-values are not credential providers
		assert.equal(handleWebAccessCommand("set-key auto somekey").wrote, false);
		assert.equal(handleWebAccessCommand("set-key priority somekey").wrote, false);
	} finally {
		cleanup(home);
	}
});

test("set-key with no key / placeholder key fails without writing", () => {
	const home = isolate();
	try {
		assert.equal(handleWebAccessCommand("set-key parallel").wrote, false);
		assert.equal(handleWebAccessCommand("set-key parallel your-key").wrote, false);
		assert.equal(handleWebAccessCommand("set-key parallel your_api_key").wrote, false);
		assert.equal(readConfig(home).parallelApiKey, undefined);
	} finally {
		cleanup(home);
	}
});

// ---- summary hints ----

test("summary shows 'Setting API keys' hints for missing providers", () => {
	const home = isolate();
	try {
		// no config, no env → all providers missing
		const text = formatWebAccessSummary();
		assert.match(text, /\*\*Setting API keys\*\*/);
		// both methods surfaced, with correct env var names
		assert.match(text, /\/webaccess set-key parallel <key>.+env `PARALLEL_API_KEY`/);
		assert.match(text, /\/webaccess set-key perplexity <key>.+env `PERPLEXITY_API_KEY`/);
		// exa notes the MCP fallback makes its key optional
		assert.match(text, /set-key exa <key>.+optional — MCP fallback/);
	} finally {
		cleanup(home);
	}
});

test("summary hides the hints section once a key is set", () => {
	const home = isolate();
	try {
		mkdirSync(join(home, ".pi"), { recursive: true });
		writeFileSync(configPath(home), JSON.stringify({ parallelApiKey: "real-par-key" }));
		const text = formatWebAccessSummary();
		// parallel is no longer missing → its hint line is absent (the generic
		// footer uses `<provider>`, not a concrete name, so this is safe)
		assert.equal(/set-key parallel <key>/.test(text), false, "parallel hint shown despite key being set");
		// the other three are still missing → still hinted
		assert.match(text, /set-key perplexity <key>/);
		assert.match(text, /set-key exa <key>/);
	} finally {
		cleanup(home);
	}
});
