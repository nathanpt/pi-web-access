import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtractedContent } from "./extract.js";
import type { SearchResult } from "./providers/perplexity.js";
import type { SearchTrace } from "./providers/gemini-search.js";

const CACHE_TTL_MS = 60 * 60 * 1000;

export interface QueryResultData {
	query: string;
	answer: string;
	results: SearchResult[];
	error: string | null;
	provider?: string;
	/** Provider routing trace (ROADMAP item #3). Present when the result came
	 * from a live `search()` call; undefined for legacy/stored entries. */
	trace?: SearchTrace;
	/** Per-source raw content carried alongside `results` (matched by URL) so
	 * the synthesis layer can reason from primary sources instead of only the
	 * pre-filtered provider `answer`. Undefined for providers that don't return
	 * inline content and for legacy/stored entries. In-memory only. */
	inlineContent?: ExtractedContent[];
}

export interface StoredSearchData {
	id: string;
	type: "search" | "fetch";
	timestamp: number;
	queries?: QueryResultData[];
	urls?: ExtractedContent[];
}

const storedResults = new Map<string, StoredSearchData>();

export function generateId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function storeResult(id: string, data: StoredSearchData): void {
	storedResults.set(id, data);
}

export function getResult(id: string): StoredSearchData | null {
	return storedResults.get(id) ?? null;
}

export function getAllResults(): StoredSearchData[] {
	return Array.from(storedResults.values());
}

export function deleteResult(id: string): boolean {
	return storedResults.delete(id);
}

export function clearResults(): void {
	storedResults.clear();
}

function isValidStoredData(data: unknown): data is StoredSearchData {
	if (!data || typeof data !== "object") return false;
	const d = data as Record<string, unknown>;
	if (typeof d.id !== "string" || !d.id) return false;
	if (d.type !== "search" && d.type !== "fetch") return false;
	if (typeof d.timestamp !== "number") return false;
	if (d.type === "search" && !Array.isArray(d.queries)) return false;
	if (d.type === "fetch" && !Array.isArray(d.urls)) return false;
	return true;
}

export function restoreFromSession(ctx: ExtensionContext): void {
	storedResults.clear();
	const now = Date.now();

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === "web-search-results") {
			const data = entry.data;
			if (isValidStoredData(data) && now - data.timestamp < CACHE_TTL_MS) {
				storedResults.set(data.id, data);
			}
		}
	}
}
