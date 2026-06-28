import assert from "node:assert/strict";
import { test } from "node:test";

// Exercises the real ssrf-protection module — true regression guards on the
// shipped code. Covers the trustEnvProxy path added by the PR #109 port.
import { envProxyApplies, validateRemoteUrl } from "../ssrf-protection.ts";

// envProxyApplies / hostnameMatchesNoProxy read process.env at call time, so we
// snapshot + restore around each case to keep tests hermetic within the process.
function withEnv(env, fn) {
	return async () => {
		const snapshot = { ...process.env };
		try {
			for (const [k, v] of Object.entries(env)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
			await fn();
		} finally {
			for (const k of Object.keys(process.env)) {
				if (!(k in snapshot)) delete process.env[k];
			}
			for (const [k, v] of Object.entries(snapshot)) process.env[k] = v;
		}
	};
}

// --- envProxyApplies (pure, env-driven) ---------------------------------

test("envProxyApplies returns false when no proxy env var is set", withEnv({}, () => {
	assert.equal(envProxyApplies(new URL("https://example.com/"), "example.com"), false);
}));

test("envProxyApplies returns true when HTTPS_PROXY covers the https URL", withEnv({ HTTPS_PROXY: "http://proxy:3128" }, () => {
	assert.equal(envProxyApplies(new URL("https://example.com/"), "example.com"), true);
}));

test("envProxyApplies honors lowercase http_proxy variant", withEnv({ http_proxy: "http://proxy:3128" }, () => {
	assert.equal(envProxyApplies(new URL("http://example.com/"), "example.com"), true);
}));

test("envProxyApplies honors ALL_PROXY fallback", withEnv({ ALL_PROXY: "http://proxy:3128" }, () => {
	assert.equal(envProxyApplies(new URL("https://example.com/"), "example.com"), true);
}));

test("envProxyApplies returns false when NO_PROXY exempts the exact host", withEnv({ HTTPS_PROXY: "http://proxy:3128", NO_PROXY: "example.com" }, () => {
	assert.equal(envProxyApplies(new URL("https://example.com/"), "example.com"), false);
}));

test("envProxyApplies treats a bare '*' NO_PROXY as exempt-everything", withEnv({ HTTPS_PROXY: "http://proxy:3128", NO_PROXY: "*" }, () => {
	assert.equal(envProxyApplies(new URL("https://api.example.com/"), "api.example.com"), false);
}));

test("envProxyApplies matches NO_PROXY subdomain (suffix, not substring)", withEnv({ HTTPS_PROXY: "http://proxy:3128", NO_PROXY: ".example.com" }, () => {
	// Suffix match: subdomain and apex both exempted (curl-style leading-dot).
	assert.equal(envProxyApplies(new URL("https://api.example.com/"), "api.example.com"), false);
	assert.equal(envProxyApplies(new URL("https://example.com/"), "example.com"), false);
	// Must be a true suffix, not a substring: notexample.com is NOT exempted.
	assert.equal(envProxyApplies(new URL("https://notexample.com/"), "notexample.com"), true);
}));

// --- validateRemoteUrl trustEnvProxy integration -----------------------

// A lookup that resolves to a private address — proves the DNS preflight ran.
const privateLookup = async () => [{ address: "192.168.1.5", family: 4 }];
// A lookup that throws — proves the DNS preflight ran (and failed loudly).
const throwingLookup = async (hostname) => {
	throw new Error(`lookup should not be called for ${hostname}`);
};

test("validateRemoteUrl runs DNS preflight by default (trustEnvProxy unset)", async () => {
	await assert.rejects(
		validateRemoteUrl("https://example.test/", { lookup: privateLookup }),
		/Blocked internal address/,
	);
});

test("trustEnvProxy skips DNS preflight for a proxied host (lookup never called)", withEnv({ HTTPS_PROXY: "http://proxy:3128" }, async () => {
	// Would otherwise resolve to private / throw — but DNS is skipped, so this resolves.
	const url = await validateRemoteUrl("https://example.test/", {
		trustEnvProxy: true,
		lookup: throwingLookup,
	});
	assert.equal(url.hostname, "example.test");
}));

test("trustEnvProxy still runs DNS preflight when NO_PROXY exempts the host", withEnv({ HTTPS_PROXY: "http://proxy:3128", NO_PROXY: "example.test" }, async () => {
	// NO_PROXY exempts the host → proxy won't be used → DNS must run → private IP blocked.
	await assert.rejects(
		validateRemoteUrl("https://example.test/", { trustEnvProxy: true, lookup: privateLookup }),
		/Blocked internal address/,
	);
}));

test("trustEnvProxy still blocks a literal internal IP (order guarantee)", withEnv({ HTTPS_PROXY: "http://proxy:3128" }, async () => {
	await assert.rejects(
		validateRemoteUrl("https://192.168.1.1/", { trustEnvProxy: true, lookup: throwingLookup }),
		/Blocked internal address/,
	);
}));

test("trustEnvProxy still blocks localhost (order guarantee)", withEnv({ HTTPS_PROXY: "http://proxy:3128" }, async () => {
	await assert.rejects(
		validateRemoteUrl("https://localhost/", { trustEnvProxy: true, lookup: throwingLookup }),
		/Blocked internal hostname/,
	);
}));

test("trustEnvProxy without any proxy env var still runs DNS preflight", async () => {
	// No proxy configured → trustEnvProxy is a no-op → private IP blocked via DNS.
	await assert.rejects(
		validateRemoteUrl("https://example.test/", { trustEnvProxy: true, lookup: privateLookup }),
		/Blocked internal address/,
	);
});
