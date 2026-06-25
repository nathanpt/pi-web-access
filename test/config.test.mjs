import assert from "node:assert/strict";
import { test } from "node:test";

// config.ts is pure (only utils.ts dep, no host modules), so it imports
// directly under tsx — no child-process isolation needed for the pure
// helpers. getEffectiveConfig/getProviderCredentialStatus take optional
// (config, env) args so we test provenance/precedence without touching
// the real process.env or ~/.pi/web-search.json.
const {
	resolveCredentialProvenance,
	getProviderCredentialStatus,
	getEffectiveConfig,
	normalizeApiKey,
	normalizeOptionalString,
} = await import("../config.ts");

test("normalizeApiKey trims and rejects empties/non-strings", () => {
	assert.equal(normalizeApiKey("  abc  "), "abc");
	assert.equal(normalizeApiKey(""), null);
	assert.equal(normalizeApiKey("   "), null);
	assert.equal(normalizeApiKey(123), null);
	assert.equal(normalizeApiKey(undefined), null);
});

test("normalizeOptionalString returns undefined for empty/non-string", () => {
	assert.equal(normalizeOptionalString("  prof  "), "prof");
	assert.equal(normalizeOptionalString(""), undefined);
	assert.equal(normalizeOptionalString(null), undefined);
});

test("resolveCredentialProvenance honors env > config > missing", () => {
	assert.equal(resolveCredentialProvenance("env-key", "file-key"), "env");
	assert.equal(resolveCredentialProvenance(undefined, "file-key"), "config");
	assert.equal(resolveCredentialProvenance("   ", "   "), "missing");
	assert.equal(resolveCredentialProvenance(undefined, undefined), "missing");
	// whitespace-only is treated as unset (not a real credential)
	assert.equal(resolveCredentialProvenance("  ", "file-key"), "config");
});

test("getProviderCredentialStatus reports provenance per provider", () => {
	const status = getProviderCredentialStatus(
		{ exaApiKey: "file-exa", geminiApiKey: "  " },
		{ PERPLEXITY_API_KEY: "env-pplx", PARALLEL_API_KEY: "   " },
	);
	const byName = Object.fromEntries(status.map((s) => [s.provider, s]));

	assert.equal(byName.exa.provenance, "config");
	assert.equal(byName.exa.available, true);

	assert.equal(byName.perplexity.provenance, "env");
	assert.equal(byName.perplexity.available, true);

	// parallel has no key anywhere → missing, unavailable (no MCP fallback)
	assert.equal(byName.parallel.provenance, "missing");
	assert.equal(byName.parallel.available, false);
	assert.equal(byName.parallel.note, undefined);

	// gemini missing key, no gateway → unavailable
	assert.equal(byName.gemini.provenance, "missing");
	assert.equal(byName.gemini.available, false);
});

test("exa is available without a key (MCP fallback) and notes it", () => {
	const status = getProviderCredentialStatus({}, {});
	const exa = status.find((s) => s.provider === "exa");
	assert.equal(exa.provenance, "missing");
	assert.equal(exa.available, true);
	assert.match(exa.note ?? "", /MCP fallback/);
});

test("gemini with a configured Cloudflare gateway is available without a gemini key", () => {
	const status = getProviderCredentialStatus(
		{ geminiBaseUrl: "https://my-account.gateway.ai.cloudflare.com/gemini", cloudflareApiKey: "cf-key" },
		{},
	);
	const gemini = status.find((s) => s.provider === "gemini");
	assert.equal(gemini.provenance, "missing");
	assert.equal(gemini.available, true);
	assert.match(gemini.note ?? "", /Cloudflare AI Gateway/);
});

test("gemini gateway requires BOTH gateway URL and a Cloudflare key", () => {
	// gateway URL but no cloudflare key → not available
	let status = getProviderCredentialStatus(
		{ geminiBaseUrl: "https://my-account.gateway.ai.cloudflare.com/gemini" },
		{},
	);
	const geminiNoKey = status.find((s) => s.provider === "gemini");
	assert.equal(geminiNoKey && geminiNoKey.available, false);

	// cloudflare key via env, gateway URL via config → available
	status = getProviderCredentialStatus(
		{ geminiBaseUrl: "https://my-account.gateway.ai.cloudflare.com/gemini" },
		{ CLOUDFLARE_API_KEY: "cf-env" },
	);
	const geminiWithKey = status.find((s) => s.provider === "gemini");
	assert.equal(geminiWithKey && geminiWithKey.available, true);
});

test("getProviderCredentialStatus never exposes secret values", () => {
	const status = getProviderCredentialStatus(
		{ exaApiKey: "SECRET-EXA-12345", perplexityApiKey: "SECRET-PPLX" },
		{ GEMINI_API_KEY: "SECRET-GEMINI" },
	);
	const dump = JSON.stringify(status);
	// No raw secret may appear anywhere in the status output
	assert.equal(dump.includes("SECRET"), false, `secret leaked: ${dump}`);
});

test("getEffectiveConfig applies defaults for an empty config", () => {
	const eff = getEffectiveConfig({}, {});
	assert.equal(eff.provider, "auto");
	assert.equal(eff.allowCurator, true);
	assert.equal(eff.webSearchEnabled, true);
	assert.equal(eff.allowBrowserCookies, false);
	assert.equal(eff.browserCookieProvenance, "missing");
	assert.equal(eff.chromeProfile, undefined);
	assert.equal(typeof eff.configPath, "string");
	assert.ok(eff.configPath.length > 0);
});

test("getEffectiveConfig reads file values", () => {
	const eff = getEffectiveConfig(
		{ provider: "perplexity", allowCurator: false, summaryModel: "gemini-2.5-flash", chromeProfile: "Default", webSearch: { enabled: false } },
		{},
	);
	assert.equal(eff.provider, "perplexity");
	assert.equal(eff.allowCurator, false);
	assert.equal(eff.summaryModel, "gemini-2.5-flash");
	assert.equal(eff.chromeProfile, "Default");
	assert.equal(eff.webSearchEnabled, false);
});

test("getEffectiveConfig honors env over config for browser cookies", () => {
	// env wins
	let eff = getEffectiveConfig({ allowBrowserCookies: false }, { PI_ALLOW_BROWSER_COOKIES: "1" });
	assert.equal(eff.allowBrowserCookies, true);
	assert.equal(eff.browserCookieProvenance, "env");

	// config-only
	eff = getEffectiveConfig({ allowBrowserCookies: true }, {});
	assert.equal(eff.allowBrowserCookies, true);
	assert.equal(eff.browserCookieProvenance, "config");

	// FEYNMAN_ALLOW_BROWSER_COOKIES legacy alias also recognized
	eff = getEffectiveConfig({}, { FEYNMAN_ALLOW_BROWSER_COOKIES: "1" });
	assert.equal(eff.allowBrowserCookies, true);
	assert.equal(eff.browserCookieProvenance, "env");
});

test("getEffectiveConfig never exposes secret values", () => {
	const eff = getEffectiveConfig(
		{ exaApiKey: "SECRET-EXA", geminiApiKey: "SECRET-GEM", perplexityApiKey: "SECRET-P" },
		{ PARALLEL_API_KEY: "SECRET-PAR" },
	);
	const dump = JSON.stringify(eff);
	assert.equal(dump.includes("SECRET"), false, `secret leaked: ${dump}`);
});
