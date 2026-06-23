import assert from "node:assert/strict";
import { test, describe } from "node:test";

// ─── Self-contained validateUrl (duplicated from extract.ts for test isolation) ──

const ALLOWED_PROTOCOLS_SSRF = ["http:", "https:"];
const BLOCKED_HOST_PATTERNS = [
	/^localhost$/i,
	/^127\.\d+\.\d+\.\d+$/,
	/^169\.254\.\d+\.\d+$/,
	/^10\.\d+\.\d+\.\d+$/,
	/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
	/^192\.168\.\d+\.\d+$/,
	/^0\.0\.0\.0$/,
	/^\[::1\]$/,
	/^\[::\]$/,
];

function validateUrl(rawUrl) {
	let parsed;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new Error(`Invalid URL: "${rawUrl}"`);
	}
	if (!ALLOWED_PROTOCOLS_SSRF.includes(parsed.protocol)) {
		throw new Error(
			`URL protocol "${parsed.protocol}" is not allowed. Only http: and https: are supported.`,
		);
	}
	const hostname = parsed.hostname.toLowerCase();
	if (BLOCKED_HOST_PATTERNS.some((p) => p.test(hostname))) {
		throw new Error(
			`URL hostname "${hostname}" points to a private/internal network and is blocked.`,
		);
	}
	return parsed;
}

// ─── Unit tests ───────────────────────────────────────────────────────────────

describe("validateUrl", () => {

	test("accepts public URLs", () => {
		const cases = [
			"https://example.com",
			"http://example.com:8080/path?q=1",
			"https://sub.example.com",
			"https://8.8.8.8",
			"https://1.1.1.1",
			"http://172.32.0.1", // just outside RFC 1918 172.16-31
		];
		for (const url of cases) {
			const result = validateUrl(url);
			assert.ok(result instanceof URL, `Expected valid URL for "${url}"`);
		}
	});

	test("rejects non-HTTP protocols", () => {
		const cases = [
			"file:///etc/passwd",
			"ftp://files.example.com",
			"data:text/plain,hello",
			"javascript:alert(1)",
		];
		for (const url of cases) {
			assert.throws(
				() => validateUrl(url),
				err => err.message.includes("not allowed"),
				`Expected "${url}" to be rejected for bad protocol`
			);
		}
	});

	test("rejects loopback / localhost", () => {
		const cases = [
			"http://127.0.0.1:8080/",
			"http://127.0.0.1/",
			"http://localhost/",
			"http://LOCALHOST:3000/",
			"http://localhost:3000/path",
			"http://[::1]:5000/",
			"http://[::]/",
			"http://0.0.0.0/",
		];
		for (const url of cases) {
			assert.throws(
				() => validateUrl(url),
				err => err.message.includes("private"),
				`Expected "${url}" to be blocked as private`
			);
		}
	});

	test("rejects RFC 1918 private IPs", () => {
		const cases = [
			"http://10.0.0.1/",
			"http://10.255.255.255/",
			"http://172.16.0.1/",
			"http://172.31.255.255/",
			"http://192.168.0.1/",
			"http://192.168.255.255/",
		];
		for (const url of cases) {
			assert.throws(
				() => validateUrl(url),
				err => err.message.includes("private"),
				`Expected "${url}" to be blocked as private`
			);
		}
	});

	test("rejects link-local and cloud metadata", () => {
		const cases = [
			"http://169.254.0.1/",
			"http://169.254.169.254/latest/meta-data/",
			"http://169.254.169.254/",
		];
		for (const url of cases) {
			assert.throws(
				() => validateUrl(url),
				err => err.message.includes("private"),
				`Expected "${url}" to be blocked as private`
			);
		}
	});

	test("rejects URLs with auth — hostname is still private", () => {
		const cases = [
			"http://user:pass@127.0.0.1:8080/",
			"http://admin:admin@192.168.1.1/",
		];
		for (const url of cases) {
			assert.throws(
				() => validateUrl(url),
				err => err.message.includes("private"),
				`Expected "${url}" to be blocked as private`
			);
		}
	});

	test("throws for syntactically invalid URLs", () => {
		assert.throws(() => validateUrl(""), /Invalid URL/);
		assert.throws(() => validateUrl("not-a-url"), /Invalid URL/);
		assert.throws(() => validateUrl("http://"), /Invalid URL/);
	});

	test("error message mentions private/internal network for blocked IPs", () => {
		for (const url of ["http://127.0.0.1/", "http://169.254.169.254/"]) {
			try {
				validateUrl(url);
				assert.fail(`Expected "${url}" to throw`);
			} catch (err) {
				assert.match(err.message, /private|internal|blocked/i,
					`Error for "${url}" should reference private/blocked, got: ${err.message}`);
			}
		}
	});
});
