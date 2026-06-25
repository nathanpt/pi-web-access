import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getWebSearchConfigDir, getWebSearchConfigPath } from "./utils.js";

/**
 * Centralized owner of the `~/.pi/web-search.json` config file (XDG-resolved
 * via `utils.ts`). This replaces the per-provider `loadConfig()` clones: all
 * config reads/writes now route through one module so precedence, parse-error
 * handling, and caching stay consistent.
 *
 * Precedence (env > file > defaults) is enforced at the *access* sites
 * (provider `getApiKey()` etc. check their env var before the file value),
 * not here. This module owns the raw file shape only.
 *
 * Note: `WebSearchConfig` in `workflow.ts` covers only the routing/workflow
 * fields; this raw type is the full file shape including provider credentials
 * and browser-cookie settings.
 */
export interface RawWebSearchConfig {
	// Provider routing
	provider?: unknown;
	providerPriority?: unknown;
	// Workflow / curator
	workflow?: unknown;
	allowCurator?: unknown;
	curatorTimeoutSeconds?: unknown;
	summaryModel?: unknown;
	webSearch?: { enabled?: boolean };
	shortcuts?: { curate?: string; activity?: string };
	// Provider credentials
	exaApiKey?: unknown;
	perplexityApiKey?: unknown;
	parallelApiKey?: unknown;
	geminiApiKey?: unknown;
	geminiBaseUrl?: unknown;
	cloudflareApiKey?: unknown;
	// Browser cookies
	chromeProfile?: unknown;
	allowBrowserCookies?: unknown;
}

let cachedConfig: RawWebSearchConfig | null = null;

/**
 * Load and cache the raw config file. Missing file ⇒ `{}` (empty config, all
 * defaults). A malformed file throws (matches the prior per-provider behavior
 * so callers' catch paths are unchanged). The cache is shared process-wide;
 * call {@link clearWebSearchConfigCache} after any write that must be observed.
 */
export function loadWebSearchConfig(): RawWebSearchConfig {
	if (cachedConfig) return cachedConfig;
	const path = getWebSearchConfigPath();
	if (!existsSync(path)) {
		cachedConfig = {};
		return cachedConfig;
	}
	const raw = readFileSync(path, "utf-8");
	try {
		cachedConfig = JSON.parse(raw) as RawWebSearchConfig;
		return cachedConfig;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${path}: ${message}`);
	}
}

/**
 * Drop the cached config so the next {@link loadWebSearchConfig} re-reads the
 * file. Necessary after {@link saveWebSearchConfig} (which calls this) and for
 * any command that mutates config out-of-band. Previously each provider cached
 * independently and never invalidated — a latent staleness bug that the
 * `/webaccess` command makes worse, so this is the fix.
 */
export function clearWebSearchConfigCache(): void {
	cachedConfig = null;
}

/**
 * Merge `updates` into the on-disk config and clear the cache. Preserves any
 * fields not present in `updates`. Creates the config directory if missing.
 * Matches the previous `index.ts` `saveConfig` semantics (merge, not replace),
 * now shared by all callers.
 */
export function saveWebSearchConfig(updates: Partial<RawWebSearchConfig>): void {
	const path = getWebSearchConfigPath();
	let config: Record<string, unknown> = {};
	if (existsSync(path)) {
		const raw = readFileSync(path, "utf-8");
		try {
			config = JSON.parse(raw) as Record<string, unknown>;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`Failed to parse ${path}: ${message}`);
		}
	}
	Object.assign(config, updates);
	const dir = getWebSearchConfigDir();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
	clearWebSearchConfigCache();
}

/**
 * Normalize an API-key-shaped value: trim whitespace, reject empty/non-strings.
 * Shared by every provider's `getApiKey()` so the "is this key actually set?"
 * check is identical everywhere (env var and file value paths).
 */
/**
 * Detect a placeholder/template API key that a user copy-pasted from docs or
 * left as a default (e.g. `"your-key"`, `"<your-api-key>"`, `"placeholder"`).
 * Such a value is never a valid credential: treating it as missing lets the
 * provider gracefully fall through to the next in the fallback chain instead
 * of being selected and then 401-ing at call time. Conservative by design —
 * real keys are high-entropy strings, so false positives are near-impossible.
 * Exported for testing.
 */
const PLACEHOLDER_EXACT = new Set([
	"placeholder",
	"example",
	"example-key",
	"sample",
	"demo",
	"dummy",
	"changeme",
	"change-me",
	"replace-me",
	"replace_me",
	"todo",
	"xxx",
	"xxxx",
	"test",
	"foo",
	"bar",
	"baz",
]);

export function isPlaceholderKey(value: string): boolean {
	const trimmed = value.trim();
	if (trimmed.length === 0) return false;
	const lower = trimmed.toLowerCase();
	if (PLACEHOLDER_EXACT.has(lower)) return true;
	// Template-style: <...> brackets, or the canonical "your-key" / "your_api_key"
	// family (covers your-key, your_key, your key, your-key-here, your-api-key).
	if (/^<.+>$/.test(trimmed)) return true;
	if (/^your[-_\s]?(api[-_\s]?)?key/i.test(trimmed)) return true;
	return false;
}

export function normalizeApiKey(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	if (normalized.length === 0) return null;
	if (isPlaceholderKey(normalized)) return null;
	return normalized;
}

/**
 * Normalize an optional string field (e.g. `chromeProfile`): trim, reject
 * empty → `undefined`. Mirrors `normalizeChromeProfile` in the gemini-web
 * provider without importing it (config.ts must not depend on providers —
 * they depend on this module).
 */
export function normalizeOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

// ===========================================================================
// Slice 2 — effective config, provider credential status, redaction
// ===========================================================================
//
// These power the `/webaccess` summary. Two rules:
//   1. Secrets are NEVER returned as values — only provenance
//      (`"env" | "config" | "missing"`). Redaction is structural, not a
//      post-hoc mask, so a value can't leak through a missed field.
//   2. Pure helpers take their inputs as params so they're unit-testable
//      without manipulating process.env in-process.

export type CredentialProvenance = "env" | "config" | "missing";

/**
 * Decide where a credential effectively comes from: an env var wins over a
 * config-file value (precedence: env > file > missing). Pure — pass both
 * values explicitly for testing.
 */
export function resolveCredentialProvenance(
	envValue: unknown,
	configValue: unknown,
): CredentialProvenance {
	if (normalizeApiKey(envValue)) return "env";
	if (normalizeApiKey(configValue)) return "config";
	return "missing";
}

export interface CredentialSource {
	provider: string;
	env: string;
	configKey: keyof RawWebSearchConfig;
	/** True if the provider can still operate without a key (e.g. Exa MCP). */
	mcpFallback?: boolean;
}

const CREDENTIAL_SOURCES: CredentialSource[] = [
	{ provider: "exa", env: "EXA_API_KEY", configKey: "exaApiKey", mcpFallback: true },
	{ provider: "perplexity", env: "PERPLEXITY_API_KEY", configKey: "perplexityApiKey" },
	{ provider: "parallel", env: "PARALLEL_API_KEY", configKey: "parallelApiKey" },
	{ provider: "gemini", env: "GEMINI_API_KEY", configKey: "geminiApiKey" },
];

/** Look up the credential source record for a concrete provider name. */
export function getCredentialSource(provider: string): CredentialSource | undefined {
	return CREDENTIAL_SOURCES.find((s) => s.provider === provider);
}

/** All credential sources (provider → env/config-key mapping). Read-only view. */
export function getAllCredentialSources(): readonly CredentialSource[] {
	return CREDENTIAL_SOURCES;
}

export interface ProviderCredentialStatus {
	provider: string;
	provenance: CredentialProvenance;
	/** True if this provider would be selectable (has a key, or has an MCP fallback). */
	available: boolean;
	/** Human-readable caveat surfaced in the summary (never a secret value). */
	note?: string;
}

/**
 * Build the provider credential readiness table. Computed from raw config +
 * env, NOT by calling the provider `isXxxAvailable()` functions — config.ts
 * must stay free of provider imports (providers depend on this module).
 * `available` mirrors provider semantics: Exa is always available (MCP
 * fallback); the rest require a key. Gemini additionally notes a configured
 * Cloudflare AI Gateway, which is an alternate auth path.
 */
export function getProviderCredentialStatus(
	config: RawWebSearchConfig = loadWebSearchConfig(),
	env: NodeJS.ProcessEnv = process.env,
): ProviderCredentialStatus[] {
	return CREDENTIAL_SOURCES.map((source) => {
		const provenance = resolveCredentialProvenance(
			env[source.env],
			config[source.configKey],
		);
		const hasKey = provenance !== "missing";
		let note: string | undefined;
		if (!hasKey && source.mcpFallback) {
			note = "MCP fallback available (no key needed)";
		}
		if (source.provider === "gemini" && !hasKey) {
			const gateway = isGatewayConfiguredFrom(config, env);
			if (gateway) note = "Cloudflare AI Gateway configured";
		}
		return {
			provider: source.provider,
			provenance,
			available: hasKey || !!source.mcpFallback || (source.provider === "gemini" && isGatewayConfiguredFrom(config, env)),
			note,
		};
	});
}

/**
 * Mirror of `gemini-api.ts` gateway detection, computed from raw values so
 * config.ts needs no provider import. A gateway is configured when the base
 * URL points at Cloudflare AND a Cloudflare key is present (env or file).
 */
function isGatewayConfiguredFrom(
	config: RawWebSearchConfig,
	env: NodeJS.ProcessEnv,
): boolean {
	const baseUrl = normalizeOptionalString(env.GOOGLE_GEMINI_BASE_URL)
		?? normalizeOptionalString(config.geminiBaseUrl);
	if (!baseUrl || !baseUrl.includes("gateway.ai.cloudflare.com")) return false;
	return resolveCredentialProvenance(env.CLOUDFLARE_API_KEY, config.cloudflareApiKey) !== "missing";
}

export interface EffectiveConfig {
	/** XDG-resolved path to the config file (always shown in the summary). */
	configPath: string;
	/** Raw provider value from the file; defaults to `"auto"` when unset. */
	provider: unknown;
	providerPriority: unknown;
	workflow: unknown;
	/** Default true; only false when explicitly set `allowCurator: false`. */
	allowCurator: boolean;
	summaryModel: unknown;
	webSearchEnabled: boolean;
	allowBrowserCookies: boolean;
	browserCookieProvenance: CredentialProvenance;
	chromeProfile: string | undefined;
}

/**
 * Compute the effective (display) config: raw file values with defaults
 * applied and provenance resolved for the browser-cookie toggle. Precedence
 * (env > file > defaults) is honored for cookie access; other fields are
 * file-driven because they have no env-var override today.
 */
export function getEffectiveConfig(
	config: RawWebSearchConfig = loadWebSearchConfig(),
	env: NodeJS.ProcessEnv = process.env,
): EffectiveConfig {
	const cookieEnv = env.PI_ALLOW_BROWSER_COOKIES === "1" || env.FEYNMAN_ALLOW_BROWSER_COOKIES === "1";
	const cookieConfig = config.allowBrowserCookies === true;
	return {
		configPath: getWebSearchConfigPath(),
		provider: config.provider ?? "auto",
		providerPriority: config.providerPriority,
		workflow: config.workflow,
		allowCurator: config.allowCurator !== false,
		summaryModel: config.summaryModel,
		webSearchEnabled: config.webSearch?.enabled !== false,
		allowBrowserCookies: cookieEnv || cookieConfig,
		browserCookieProvenance: cookieEnv ? "env" : cookieConfig ? "config" : "missing",
		chromeProfile: normalizeOptionalString(config.chromeProfile),
	};
}
