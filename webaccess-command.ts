/**
 * `/webaccess` command logic — validation + summary formatting, separated from
 * `index.ts` so the pure parts are unit-testable (index.ts can't be imported
 * under tsx; it pulls in host modules). The command registration in `index.ts`
 * is a thin wrapper over {@link handleWebAccessCommand}.
 *
 * Reads go through `config.ts` (Slice 1); writes through `saveWebSearchConfig`,
 * which clears the shared cache so the change is visible to providers and
 * gemini-search's normalized view on the next read.
 */

import type { RawWebSearchConfig } from "./config.js";
import {
	saveWebSearchConfig,
	getEffectiveConfig,
	getProviderCredentialStatus,
	getCredentialSource,
	getAllCredentialSources,
	isPlaceholderKey,
} from "./config.js";

export type SearchProvider = "auto" | "priority" | "perplexity" | "gemini" | "exa" | "parallel";
const VALID_PROVIDERS: ReadonlySet<string> = new Set(["auto", "priority", "perplexity", "gemini", "exa", "parallel"]);

export interface ValidationResult {
	ok: boolean;
	value?: unknown;
	error?: string;
}

/** Validate a `provider` value for `/webaccess provider <value>`. */
export function validateProvider(value: string): ValidationResult {
	const normalized = value.trim().toLowerCase();
	if (!normalized) return { ok: false, error: "provider value is required" };
	if (!VALID_PROVIDERS.has(normalized)) {
		return { ok: false, error: `unknown provider "${value}". Valid: ${[...VALID_PROVIDERS].join(", ")}` };
	}
	return { ok: true, value: normalized as SearchProvider };
}

/** Validate a `workflow` value for `/webaccess workflow <value>`. */
export function validateWorkflow(value: string, allowCurator: boolean): ValidationResult {
	const normalized = value.trim().toLowerCase();
	const allowed = allowCurator
		? new Set(["none", "summary-review", "auto-summary"])
		: new Set(["none", "auto-summary"]);
	if (!normalized) return { ok: false, error: "workflow value is required" };
	if (!allowed.has(normalized)) {
		return { ok: false, error: `unknown workflow "${value}". Valid: ${[...allowed].join(", ")}` };
	}
	return { ok: true, value: normalized };
}

/** Validate a boolean toggle (`on`/`off`/`true`/`false`). */
export function validateBoolean(value: string, field: string): ValidationResult {
	const normalized = value.trim().toLowerCase();
	if (normalized === "on" || normalized === "true") return { ok: true, value: true };
	if (normalized === "off" || normalized === "false") return { ok: true, value: false };
	return { ok: false, error: `${field} must be on/off (got "${value}")` };
}

/** Validate a provider-priority list for `/webaccess provider-priority <a,b,c>`. */
export function validateProviderPriority(value: string): ValidationResult {
	const raw = value.trim();
	if (!raw) return { ok: false, error: "provider-priority value is required" };
	const CONCRETE = ["exa", "perplexity", "gemini", "parallel"];
	const tokens = raw.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
	if (tokens.length === 0) return { ok: false, error: "provider-priority value is required" };
	const unknown = tokens.filter((t) => !CONCRETE.includes(t));
	if (unknown.length > 0) {
		return { ok: false, error: `unknown providers: ${unknown.join(", ")}. Valid concrete providers: ${CONCRETE.join(", ")}` };
	}
	const deduped = [...new Set(tokens)];
	return { ok: true, value: deduped };
}

/** Validate a search-model id (non-empty string). */
export function validateSearchModel(value: string): ValidationResult {
	const normalized = value.trim();
	if (!normalized) return { ok: false, error: "search-model value is required" };
	if (/\s/.test(normalized)) return { ok: false, error: `search-model must not contain whitespace (got "${value}")` };
	return { ok: true, value: normalized };
}

/** Validate an API key value for `/webaccess set-key <provider> <key>`. */
export function validateApiKey(value: string): ValidationResult {
	const normalized = value.trim();
	if (!normalized) return { ok: false, error: "api key value is required" };
	if (isPlaceholderKey(normalized)) {
		return { ok: false, error: "that looks like a placeholder (e.g. \"your-key\"), not a real key" };
	}
	return { ok: true, value: normalized };
}

/** Validate a curator-timeout-seconds value (positive integer, capped). */
export function validateCuratorTimeout(value: string): ValidationResult {
	const normalized = value.trim();
	if (!/^\d+$/.test(normalized)) return { ok: false, error: `curator-timeout must be a whole number of seconds (got "${value}")` };
	const n = Number(normalized);
	if (n < 1) return { ok: false, error: "curator-timeout must be at least 1 second" };
	if (n > 600) return { ok: false, error: "curator-timeout must be at most 600 seconds" };
	return { ok: true, value: n };
}

const BOOL_FIELDS = ["allow-browser-cookies"] as const;

/** Known set-fields for `/webaccess <field> <value>`. */
export const SET_FIELDS = [
	"provider",
	"workflow",
	"provider-priority",
	"allow-browser-cookies",
	"search-model",
	"curator-timeout",
] as const;
export type SetField = (typeof SET_FIELDS)[number];

export interface WebAccessResult {
	/** Markdown text to render to the user (summary or a set confirmation). */
	text: string;
	/** Whether a write occurred (so callers can report success/failure). */
	wrote: boolean;
}

function provenanceLabel(p: "env" | "config" | "missing"): string {
	if (p === "env") return "set via env";
	if (p === "config") return "set via config";
	return "missing";
}

function boolLabel(b: boolean): string {
	return b ? "on" : "off";
}

/**
 * Render the effective-config summary as markdown. Secrets are never included
 * — `getProviderCredentialStatus` returns only provenance.
 */
export function formatWebAccessSummary(): string {
	const eff = getEffectiveConfig();
	const status = getProviderCredentialStatus();
	const lines: string[] = [];

	lines.push(`**Config file:** \`${eff.configPath}\``);
	lines.push("");
	lines.push("**Routing**");
	lines.push(`- default provider: \`${String(eff.provider)}\``);
	lines.push(`- provider priority: ${eff.providerPriority ? `\`${JSON.stringify(eff.providerPriority)}\`` : "_(unset — uses built-in auto order)_"}`);
	lines.push(`- workflow: \`${eff.workflow ?? "summary-review (default)"}\``);
	lines.push(`- allow curator: ${boolLabel(eff.allowCurator)}`);
	lines.push(`- search model: \`${eff.summaryModel ?? "_(model-registry default)_"}\``);
	lines.push(`- web search tool enabled: ${boolLabel(eff.webSearchEnabled)}`);
	lines.push("");
	lines.push("**Provider credentials**");
	lines.push("");
	lines.push("| provider | status | available | note |");
	lines.push("|---|---|---|---|");
	for (const s of status) {
		lines.push(`| ${s.provider} | ${provenanceLabel(s.provenance)} | ${boolLabel(s.available)} | ${s.note ?? ""} |`);
	}
	// Actionable hints: for every provider whose key is missing, show BOTH
	// ways to set it (the set-key command + the env var). This is the section
	// that answers "how do I add an API key?" directly from the summary.
	const hintLines: string[] = [];
	for (const s of status) {
		if (s.provenance !== "missing") continue;
		const src = getCredentialSource(s.provider);
		if (!src) continue;
		const optional = src.mcpFallback ? " _(optional — MCP fallback works without a key)_" : "";
		hintLines.push(`- ${s.provider}: \`/webaccess set-key ${s.provider} <key>\` or env \`${src.env}\`${optional}`);
	}
	if (hintLines.length > 0) {
		lines.push("");
		lines.push("**Setting API keys**");
		lines.push(...hintLines);
	}
	lines.push("");
	lines.push("**Browser cookies**");
	lines.push(`- allow browser cookies: ${boolLabel(eff.allowBrowserCookies)} _(${provenanceLabel(eff.browserCookieProvenance)})_`);
	if (eff.chromeProfile) lines.push(`- chrome profile: \`${eff.chromeProfile}\``);
	lines.push("");
	lines.push("_Use `/webaccess <field> <value>` to change a setting. Fields: " +
		"provider, workflow, provider-priority, allow-browser-cookies, search-model, curator-timeout. " +
		"Set an API key with `/webaccess set-key <provider> <key>`._");

	return lines.join("\n");
}

function formatSetConfirmation(field: string, value: unknown): string {
	const display = typeof value === "string" ? value : JSON.stringify(value);
	return `**Updated** \`${field}\` → \`${display}\``;
}

/**
 * Parse and execute a `/webaccess` invocation. `args` is the raw arg string.
 * Pure for reads/invalid; a write occurs only when validation passes.
 */
export function handleWebAccessCommand(args: string): WebAccessResult {
	const trimmed = args.trim();
	if (!trimmed) {
		return { text: formatWebAccessSummary(), wrote: false };
	}

	const spaceIdx = trimmed.indexOf(" ");
	const field = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
	const rawValue = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

	// `set-key <provider> <key>`: writes a provider API key to the config
	// file. Handled before the SET_FIELDS switch because its arg shape differs
	// (provider + key, not a single field value) and because the key is a
	// secret — the confirmation must not echo it.
	if (field === "set-key") {
		return handleSetKey(rawValue);
	}

	if (!SET_FIELDS.includes(field as SetField)) {
		return {
			text: `Unknown field \`${field}\`. Valid: ${[...SET_FIELDS].join(", ")}. Or run \`/webaccess\` with no args for the summary.`,
			wrote: false,
		};
	}

	// Validate against the *current* effective config (e.g. allowCurator gates workflow).
	const current = getEffectiveConfig();

	let result: ValidationResult;
	let configUpdate: Partial<RawWebSearchConfig>;
	switch (field) {
		case "provider":
			result = validateProvider(rawValue);
			configUpdate = result.ok ? { provider: result.value } : {};
			break;
		case "workflow":
			result = validateWorkflow(rawValue, current.allowCurator);
			configUpdate = result.ok ? { workflow: result.value } : {};
			break;
		case "provider-priority":
			result = validateProviderPriority(rawValue);
			configUpdate = result.ok ? { providerPriority: result.value } : {};
			break;
		case "allow-browser-cookies":
			result = validateBoolean(rawValue, field);
			configUpdate = result.ok ? { allowBrowserCookies: result.value } : {};
			break;
		case "search-model":
			result = validateSearchModel(rawValue);
			configUpdate = result.ok ? { summaryModel: result.value } : {};
			break;
		case "curator-timeout":
			result = validateCuratorTimeout(rawValue);
			configUpdate = result.ok ? { curatorTimeoutSeconds: result.value } : {};
			break;
	}

	if (!result.ok) {
		return { text: `**Validation failed:** ${result.error}`, wrote: false };
	}

	saveWebSearchConfig(configUpdate);
	return { text: formatSetConfirmation(field, result.value), wrote: true };
}

/** Concrete credential providers accepted by `/webaccess set-key`. */
const KEY_PROVIDERS = getAllCredentialSources().map((s) => s.provider);

/**
 * Execute `/webaccess set-key <provider> <key>`. Writes the key to the config
 * file (creating it if absent). The key is never echoed back — the
 * confirmation only proves it was accepted, with a last-4 fingerprint so the
 * user can sanity-check they pasted the right one.
 */
function handleSetKey(rawValue: string): WebAccessResult {
	const idx = rawValue.indexOf(" ");
	const provider = (idx === -1 ? rawValue : rawValue.slice(0, idx)).trim().toLowerCase();
	const key = idx === -1 ? "" : rawValue.slice(idx + 1).trim();

	if (!provider) {
		return { text: `**Validation failed:** provider is required. Usage: \`/webaccess set-key <provider> <key>\`. Valid providers: ${KEY_PROVIDERS.join(", ")}.`, wrote: false };
	}
	const source = getCredentialSource(provider);
	if (!source) {
		return { text: `**Validation failed:** unknown provider \`${provider}\`. Valid: ${KEY_PROVIDERS.join(", ")}.`, wrote: false };
	}
	const keyResult = validateApiKey(key);
	if (!keyResult.ok) {
		return { text: `**Validation failed:** ${keyResult.error}`, wrote: false };
	}

	// Write via the config key (e.g. parallelApiKey), not the provider name.
	saveWebSearchConfig({ [source.configKey]: keyResult.value } as Partial<RawWebSearchConfig>);
	const fingerprint = keyResult.value.slice(-4);
	return {
		text: `**Set** \`${provider}\` API key (saved to config; ends in …${fingerprint}). Use \`/webaccess\` to verify.`,
		wrote: true,
	};
}
