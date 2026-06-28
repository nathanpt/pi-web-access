import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Source-contract guard for the provider-diversity providers (Tavily, Brave,
// OpenAI). They land OPT-IN per the vendor-agnostic posture: present in the
// SearchProvider union + ALL_PROVIDERS + both exhaustive switches (so they're
// routable via explicit `provider:` / `providerPriority`), but deliberately
// ABSENT from DEFAULT_AUTO_ORDER so a configured key never silently routes
// queries into the auto chain. Mirrors the searxng/olostep/parallel-was posture.

const src = readFileSync(new URL("../providers/gemini-search.ts", import.meta.url), "utf8");
const autoOrderLine = src.match(/const DEFAULT_AUTO_ORDER[^;]*;/)?.[0] ?? "";

const OPT_IN = ["brave", "tavily", "openai"];

for (const name of OPT_IN) {
	test(`${name} is in the SearchProvider union + ALL_PROVIDERS (routable)`, () => {
		assert.match(src, new RegExp(`"${name}"`), `${name} missing from union/sets`);
		assert.match(src, new RegExp(`new Set\\(\\[[^\\]]*"${name}"`));
	});

	test(`${name} is NOT in DEFAULT_AUTO_ORDER (opt-in only)`, () => {
		assert.doesNotMatch(
			autoOrderLine,
			new RegExp(`"${name}"`),
			`${name} must stay out of DEFAULT_AUTO_ORDER to remain opt-in`,
		);
	});
}

test("OpenAI provider is key-only (no model-registry / Codex-subscription path — D3)", () => {
	// The deferred Codex-subscription auth uses getModel from
	// @earendil-works/pi-ai/compat + ctx.modelRegistry — we ported the key-only
	// fallback path. Guards on the CODE surface (imports + fn signatures),
	// excluding the explanatory comment that documents the deferral.
	const mod = readFileSync(new URL("../providers/openai-search.ts", import.meta.url), "utf8");
	// Strip block + line comments so the deferral note isn't mistaken for code.
	const code = mod.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	assert.doesNotMatch(code, /@earendil-works\/pi-ai\/compat/);
	assert.doesNotMatch(code, /modelRegistry/);
	assert.match(mod, /export function isOpenAISearchAvailable\(\): boolean/);
	assert.match(mod, /export async function searchWithOpenAI\(query: string, options: SearchOptions = \{\}\)/);
});
