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
	loadWebSearchConfig,
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
	"allow-curator",
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

/** Concrete credential providers accepted by `/webaccess set-key`. */
const KEY_PROVIDERS = getAllCredentialSources().map((s) => s.provider);

/**
 * Render a complete reference page for `/webaccess`. Surfaces every field
 * with its accepted values, plus `set-key`, so users have a one-stop answer
 * to "what can this command do?" without reading the docs.
 */
export function formatWebAccessHelp(): string {
	const lines: string[] = [];
	lines.push("**/webaccess** — inspect or update pi-web-access config.");
	lines.push("");
	lines.push("```");
	lines.push("/webaccess                                            # show summary (default)");
	lines.push("/webaccess help                                       # this page (also: -h, --help)");
	lines.push("");
	lines.push("# routing");
	// Routing providers derive from the credential sources so the help stays
	// truthful as providers are added (auto/priority are the meta-modes).
	const routingProviders = KEY_PROVIDERS.join("|");
	lines.push(`/webaccess provider <auto|priority|${routingProviders}>`);
	lines.push(`/webaccess provider-priority <${KEY_PROVIDERS.join(",")}>   # order for 'priority'`);
	lines.push("/webaccess workflow <none|summary-review|auto-summary>");
	lines.push("/webaccess allow-curator <on|off>                                # off = headless-only (summary-review -> none)");
	lines.push("/webaccess search-model <model-id>                              # '' to clear");
	lines.push("/webaccess curator-timeout <1-600>                              # seconds");
	lines.push("");
	lines.push("# credentials");
	lines.push(`/webaccess set-key <${KEY_PROVIDERS.join("|")}> <key>              # writes config, never echoed`);
	lines.push(`/webaccess clear-key <${KEY_PROVIDERS.join("|")}>                 # removes key from config`);
	lines.push(`/webaccess test-key <${KEY_PROVIDERS.join("|")}> [key]             # dry-run a real API call (uses saved key if [key] omitted)`);
	lines.push("/webaccess allow-browser-cookies <on|off>                       # Gemini Web cookie auth");
	lines.push("");
	lines.push("# utilities");
	lines.push("/webaccess export                                        # redacted JSON dump for sharing");
	lines.push("/webaccess doctor                                        # config-consistency diagnostics");
	lines.push("```");
	lines.push("");
	lines.push("Precedence: `env > config > defaults`. A value set via env shows as `env` and is not overwritten by a set. Secrets are never displayed — only provenance.");
	lines.push("");
	lines.push("_See also: `docs/commands.md` and `docs/configuration.md`._");
	return lines.join("\n");
}

/** Args that request the help page (case-insensitive). */
const HELP_ARGS = new Set(["help", "-h", "--help"]);

/**
 * Render the raw config as JSON with every `*ApiKey` field redacted to a
 * provenance marker, for backup/sharing/diffing. Non-secret fields are shown
 * verbatim. The config path is included as a comment line so the dump is
 * self-describing. Safe to share — secrets never appear.
 */
export function formatWebAccessExport(): string {
	const raw = loadWebSearchConfig() as Record<string, unknown>;
	const eff = getEffectiveConfig();
	const provenance = new Map<string, string>();
	for (const s of getProviderCredentialStatus(raw)) {
		provenance.set(getCredentialSource(s.provider)?.configKey as string, s.provenance);
	}
	const redacted: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(raw)) {
		if (/ApiKey$/i.test(k)) {
			const prov = provenance.get(k);
			redacted[k] = prov ? `<redacted: ${prov}>` : "<redacted>";
		} else {
			redacted[k] = v;
		}
	}
	const body = Object.keys(redacted).length === 0 ? "{}" : JSON.stringify(redacted, null, 2);
	const fence = "```";
	return `**Export** (config file: ${eff.configPath}):\n\n${fence}json\n${body}\n${fence}`;
}

/** A single doctor finding. `severity` drives rendering; `fix` is optional. */
export interface DoctorFinding {
	severity: "error" | "warn" | "ok";
	/** Short label for the check (shown in the report). */
	check: string;
	/** Human-readable description of the finding. */
	detail: string;
	/** Optional one-liner command that resolves it. */
	fix?: string;
}

/**
 * Run config-consistency diagnostics. Pure: derived from the effective config
 * + credential status + raw file values (to catch placeholder keys). Surfaces
 * latent misconfigurations the summary can't express — values that look set
 * but will be silently ignored, skipped, or 401 at call time.
 *
 * Note: does NOT check `summaryModel` against `enabledModels` (billing scope)
 * — that needs the host's cwd/trust context and is deferred.
 */
export function runDoctor(): DoctorFinding[] {
	const findings: DoctorFinding[] = [];
	const eff = getEffectiveConfig();
	const status = getProviderCredentialStatus();
	const availableByProvider = new Map(status.map((s) => [s.provider, s.available]));
	const raw = loadWebSearchConfig() as Record<string, unknown>;

	// 1. provider=priority requires a non-empty, concrete providerPriority list.
	if (eff.provider === "priority") {
		const pp = eff.providerPriority;
		const isEmpty = !Array.isArray(pp) || pp.length === 0;
		if (isEmpty) {
			findings.push({
				severity: "error",
				check: "provider=priority",
				detail: "default provider is `priority` but `providerPriority` is unset/empty — searches fall back to the built-in auto order silently.",
				fix: "/webaccess provider-priority exa,perplexity,gemini,parallel",
			});
		}
	}

	// 2. Any selected/prioritized concrete provider that is unavailable will be
	//    skipped (priority) or fail (forced). Exa is always available (MCP
	//    fallback) so it never trips this.
	const concreteSelected = new Set<string>();
	if (typeof eff.provider === "string" && KEY_PROVIDERS.includes(eff.provider)) {
		concreteSelected.add(eff.provider);
	}
	if (Array.isArray(eff.providerPriority)) {
		for (const p of eff.providerPriority as unknown[]) {
			if (typeof p === "string" && KEY_PROVIDERS.includes(p)) concreteSelected.add(p);
		}
	}
	for (const provider of concreteSelected) {
		if (!availableByProvider.get(provider)) {
			findings.push({
				severity: "warn",
				check: `provider: ${provider}`,
				detail: `\`${provider}\` is selected${eff.provider === provider ? " as the default" : " in providerPriority"} but has no API key — it will be skipped/fail at search time.`,
				fix: `/webaccess set-key ${provider} <key>`,
			});
		}
	}

	// 3. A saved key that looks like a placeholder slipped through (hand-edit,
	//    migration, pre-validation file). It reads as "set" but will 401.
	for (const source of getAllCredentialSources()) {
		const v = raw[source.configKey];
		if (typeof v === "string" && v.trim() && isPlaceholderKey(v)) {
			findings.push({
				severity: "error",
				check: `key: ${source.provider}`,
				detail: `the saved \`${String(source.configKey)}\` looks like a placeholder (\`${v.trim()}\`) — it will be treated as set but fail authentication.`,
				fix: `/webaccess set-key ${source.provider} <real-key>`,
			});
		}
	}

	// 4. workflow=summary-review is silently downgraded to `none` when the
	//    curator is disabled — the stored value is inert.
	if (eff.workflow === "summary-review" && !eff.allowCurator) {
		findings.push({
			severity: "warn",
			check: "workflow vs curator",
				detail: "`workflow` is `summary-review` but `allowCurator` is false — it resolves to `none` (raw results). Use `auto-summary` for a headless summary.",
			fix: "/webaccess workflow auto-summary",
		});
	}

	return findings;
}

/** Render doctor findings as markdown. Emits a clean bill of health when empty. */
export function formatDoctor(): string {
	const findings = runDoctor();
	if (findings.length === 0) {
		return "**doctor:** no config issues found. :white_check_mark:";
	}
	const icon = { error: ":x:", warn: ":warning:", ok: ":white_check_mark:" } as const;
	const lines: string[] = ["**doctor** — config diagnostics:", ""];
	for (const f of findings) {
		let line = `${icon[f.severity]} **${f.check}** — ${f.detail}`;
		if (f.fix) line += ` \`Fix: ${f.fix}\``;
		lines.push(line);
	}
	return lines.join("\n");
}

/** Parsed `/webaccess test-key` args. `candidateKey` is set when testing an
 * arbitrary key without saving it; omitted means test the configured key. */
export interface KeyTestArgs {
	provider: string;
	candidateKey?: string;
}

/**
 * Parse `/webaccess test-key <provider> [key]` into a provider + optional
 * candidate key. Pure — does no network I/O (the live call happens in
 * `index.ts`). Rejects `auto`/`priority` (not credential providers) and
 * placeholder key values. Returns an `error` string on invalid input.
 */
export function parseTestKeyArgs(rawValue: string): { ok: true; value: KeyTestArgs } | { ok: false; error: string } {
	rawValue = rawValue.trim();
	const idx = rawValue.indexOf(" ");
	const provider = (idx === -1 ? rawValue : rawValue.slice(0, idx)).trim().toLowerCase();
	const key = idx === -1 ? "" : rawValue.slice(idx + 1).trim();
	if (!provider) {
		return { ok: false, error: `provider is required. Usage: \`/webaccess test-key <provider> [key]\`. Valid: ${KEY_PROVIDERS.join(", ")}.` };
	}
	if (!getCredentialSource(provider)) {
		return { ok: false, error: `unknown provider \`${provider}\`. Valid: ${KEY_PROVIDERS.join(", ")}.` };
	}
	if (key) {
		const kr = validateApiKey(key);
		if (!kr.ok) return { ok: false, error: kr.error ?? "invalid key" };
		return { ok: true, value: { provider, candidateKey: kr.value as string } };
	}
	return { ok: true, value: { provider } };
}

/**
 * Parse and execute a `/webaccess` invocation. `args` is the raw arg string.
 * Pure for reads/invalid; a write occurs only when validation passes.
 */
export function handleWebAccessCommand(args: string): WebAccessResult {
	const trimmed = args.trim();
	if (!trimmed || HELP_ARGS.has(trimmed.toLowerCase())) {
		if (!trimmed) return { text: formatWebAccessSummary(), wrote: false };
		return { text: formatWebAccessHelp(), wrote: false };
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

	// `clear-key <provider>`: removes a provider API key from the config file.
	// Symmetric counterpart to `set-key`. Cannot unset env vars — if the key is
	// sourced from env, the user is told to unset it themselves.
	if (field === "clear-key") {
		return handleClearKey(rawValue);
	}

	// `export`: print the config as JSON with secrets redacted (no write).
	if (field === "export") {
		return { text: formatWebAccessExport(), wrote: false };
	}

	// `doctor`: run config-consistency diagnostics (no write).
	if (field === "doctor") {
		return { text: formatDoctor(), wrote: false };
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
		case "allow-curator":
			result = validateBoolean(rawValue, field);
			configUpdate = result.ok ? { allowCurator: result.value } : {};
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
	let text = formatSetConfirmation(field, result.value);
	// Heads-up: disabling the curator makes workflow=summary-review inert
	// (it silently resolves to `none`). The doctor check flags this too, but
	// surfacing it at set time saves a confused user from a later search that
	// returns raw results unexpectedly. Suggest auto-summary (still headless).
	if (field === "allow-curator" && result.value === false) {
		const wf = getEffectiveConfig().workflow;
		if (wf === "summary-review") {
			text += "  ⚠️ your `workflow` is `summary-review`, which resolves to `none` while the curator is off. Run `/webaccess workflow auto-summary` for a headless summary.";
		}
	}
	return { text, wrote: true };
}

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

/**
 * Execute `/webaccess clear-key <provider>`. Removes the provider's API key
 * from the config file. Provenance-aware: a key set via env var can't be
 * cleared here (the process env is not ours to mutate), so the user is told
 * to unset it instead. A missing key is a no-op with a friendly note.
 */
function handleClearKey(rawValue: string): WebAccessResult {
	const provider = rawValue.trim().toLowerCase();
	if (!provider) {
		return { text: `**Validation failed:** provider is required. Usage: \`/webaccess clear-key <provider>\`. Valid providers: ${KEY_PROVIDERS.join(", ")}.`, wrote: false };
	}
	const source = getCredentialSource(provider);
	if (!source) {
		return { text: `**Validation failed:** unknown provider \`${provider}\`. Valid: ${KEY_PROVIDERS.join(", ")}.`, wrote: false };
	}

	// Provenance decides what "clear" means: env vars are immutable from here,
	// config keys can be deleted, and a missing key is nothing to do.
	const status = getProviderCredentialStatus().find((s) => s.provider === provider);
	if (status?.provenance === "env") {
		return {
			text: `Can't clear \`${provider}\`: the key is set via the \`${source.env}\` env var, which \`/webaccess\` can't modify. Unset the variable in your shell/session instead.`,
			wrote: false,
		};
	}
	if (status?.provenance === "missing") {
		return { text: `Nothing to clear: no \`${provider}\` API key is set (config or env).`, wrote: false };
	}

	// provenance === "config": delete by setting undefined — JSON.stringify
	// drops undefined-valued keys, so the entry is removed from the file.
	saveWebSearchConfig({ [source.configKey]: undefined } as Partial<RawWebSearchConfig>);
	return {
		text: `**Cleared** \`${provider}\` API key from the config file. Use \`/webaccess\` to verify.`,
		wrote: true,
	};
}
