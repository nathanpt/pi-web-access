export interface WebSearchConfig {
	provider?: string;
	providerPriority?: unknown;
	workflow?: string;
	allowCurator?: unknown;
	curatorTimeoutSeconds?: unknown;
	summaryModel?: string;
	webSearch?: {
		enabled?: boolean;
	};
	shortcuts?: {
		curate?: string;
		activity?: string;
	};
	ssrf?: {
		/** CIDR ranges exempted from the SSRF guard (e.g. fake-IP proxy ranges). */
		allowRanges?: string[];
	};
}

export type WebSearchWorkflow = "none" | "summary-review" | "auto-summary";

export function isCuratorAllowed(config: WebSearchConfig | undefined): boolean {
	return config?.allowCurator !== false;
}

export function resolveWorkflow(input: unknown, hasUI: boolean, allowCurator = true): WebSearchWorkflow {
	const normalized = typeof input === "string" ? input.trim().toLowerCase() : "";
	// `auto-summary` generates a summary without opening the browser curator, so
	// it is allowed even when the curator is disabled or there is no UI (headless).
	if (normalized === "auto-summary") return "auto-summary";
	if (!allowCurator) return "none";
	if (!hasUI) return "none";
	if (normalized === "none") return "none";
	return "summary-review";
}

export function getWorkflowValues(config: WebSearchConfig | undefined): WebSearchWorkflow[] {
	// auto-summary never opens the browser, so it stays available even when the
	// curator is disabled (allowCurator: false) — that becomes a headless mode.
	return isCuratorAllowed(config) ? ["none", "summary-review", "auto-summary"] : ["none", "auto-summary"];
}
