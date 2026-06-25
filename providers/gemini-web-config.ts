import { loadWebSearchConfig } from "../config.js";

export function normalizeChromeProfile(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

export function getChromeProfileFromConfig(): string | undefined {
	return normalizeChromeProfile(loadWebSearchConfig().chromeProfile);
}

export function isBrowserCookieAccessAllowed(): boolean {
	if (process.env.PI_ALLOW_BROWSER_COOKIES === "1" || process.env.FEYNMAN_ALLOW_BROWSER_COOKIES === "1") {
		return true;
	}
	return loadWebSearchConfig().allowBrowserCookies === true;
}
