export interface WebSearchConfig {
	provider?: string;
	providerPriority?: unknown;
	workflow?: string;
	allowCurator?: unknown;
	curatorTimeoutSeconds?: unknown;
	summaryModel?: string;
	shortcuts?: {
		curate?: string;
		activity?: string;
	};
}

export type WebSearchWorkflow = "none" | "summary-review";

export function isCuratorAllowed(config: WebSearchConfig | undefined): boolean {
	return config?.allowCurator !== false;
}

export function resolveWorkflow(input: unknown, hasUI: boolean, allowCurator = true): WebSearchWorkflow {
	if (!allowCurator) return "none";
	if (!hasUI) return "none";
	if (typeof input === "string" && input.trim().toLowerCase() === "none") return "none";
	return "summary-review";
}

export function getWorkflowValues(config: WebSearchConfig | undefined): WebSearchWorkflow[] {
	return isCuratorAllowed(config) ? ["none", "summary-review"] : ["none"];
}
