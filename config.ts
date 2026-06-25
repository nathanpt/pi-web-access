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
export function normalizeApiKey(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}
