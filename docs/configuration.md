# Configuration

All config lives in `web-search.json`, resolved with XDG precedence: `$PI_CODING_AGENT_DIR` → `$XDG_CONFIG_HOME/pi` → `~/.pi` (i.e. `~/.pi/web-search.json` by default, matching pi-core). Every field is optional.

> **Prefer not to hand-edit JSON?** Run [`/webaccess`](commands.md#webaccess) to inspect the effective config (with provider status + secret provenance), manage API keys (`/webaccess set-key <provider> <key>`, `clear-key`, `test-key`), run config diagnostics (`/webaccess doctor`), and update common fields from the command line. It validates input before saving and preserves precedence (`env > config > defaults`). This page documents the full field set for both modes.

```json
{
  "exaApiKey": "exa-...",
  "perplexityApiKey": "pplx-...",
  "geminiApiKey": "AIza...",
  "parallelApiKey": "parallel-key...",
  "geminiBaseUrl": "https://my-gateway.example.com/gemini",
  "cloudflareApiKey": "...",
  "provider": "exa",
  "chromeProfile": "Profile 2",
  "allowBrowserCookies": false,
  "searchModel": "gemini-2.5-flash",
  "summaryModel": "anthropic/claude-haiku-4-5",
  "workflow": "summary-review",
  "allowCurator": true,
  "webSearch": { "enabled": true },
  "curatorTimeoutSeconds": 20,
  "githubClone": {
    "enabled": true,
    "maxRepoSizeMB": 350,
    "cloneTimeoutSeconds": 30,
    "clonePath": "/tmp/pi-github-repos"
  },
  "youtube": {
    "enabled": true,
    "preferredModel": "gemini-3-flash-preview"
  },
  "video": {
    "enabled": true,
    "preferredModel": "gemini-3-flash-preview",
    "maxSizeMB": 50
  },
  "shortcuts": {
    "curate": "ctrl+shift+s",
    "activity": "ctrl+shift+w"
  }
}
```

`EXA_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, `PARALLEL_API_KEY`, `GOOGLE_GEMINI_BASE_URL`, and `CLOUDFLARE_API_KEY` env vars take precedence over config file values. `GOOGLE_GEMINI_BASE_URL` overrides the Gemini API host for all Gemini calls (search, URL context, video) — set it to a bare host with no trailing slash and no version segment (e.g. `https://my-gateway.example.com/gemini`), matching the [official Gemini CLI convention](https://www.geminicli.com/docs/reference/configuration). `geminiBaseUrl` in config is the equivalent file-based override. When the configured host contains `gateway.ai.cloudflare.com`, authentication automatically switches to `cf-aig-authorization: Bearer <token>` using `CLOUDFLARE_API_KEY` (or `cloudflareApiKey` in config), and no `GEMINI_API_KEY` is required. Note: video file upload always goes to Google's upload endpoint directly; gateway users without a `GEMINI_API_KEY` will fall back to Gemini Web for video extraction. `provider` sets the default search provider: `"auto"` (default), `"priority"`, `"exa"`, `"perplexity"`, `"gemini"`, or `"parallel"`. This is also updated automatically when you change the provider in the curator UI. `providerPriority` (an array of provider names, e.g. `["perplexity", "exa", "gemini"]`) sets the order tried when `provider` is `"priority"`; unknown names, duplicates, and the meta-values `"auto"`/`"priority"` are dropped. If unset or empty, `"priority"` falls back to the built-in `auto` order. The built-in `auto` order is Exa → Perplexity → Gemini → Parallel: `parallel` is tried last, only when the other providers are unavailable or have failed, so a configured Parallel key acts as a safety net (you can still select it explicitly with `provider: "parallel"`); it requires a Parallel API key (`parallelApiKey` or `PARALLEL_API_KEY`). Placeholder values such as `"your-key"`, `"<your-api-key>"`, or `"placeholder"` are treated as missing for every provider, so a leftover template value from the docs never causes a 401 mid-fallback. `workflow` sets the default curator mode: `"summary-review"` (default, opens curator with auto-generated summary draft), `"auto-summary"` (generates a summary without opening the curator — works headless / in `-p` mode), or `"none"` (raw results, no curator). Overridden per-call via the `workflow` parameter on `web_search`, or toggled at runtime with `/curator`. Set `allowCurator` to `false` to force raw results even if a tool call asks for `workflow: "summary-review"`; when false, `/curator on` is rejected and the tool schema only advertises `workflow: "none"` and `"auto-summary"` (auto-summary never opens the browser, so it remains available as a headless summary path). Toggle it with `/webaccess allow-curator on|off` (the hard headless lever — pair with `/webaccess workflow auto-summary` for a fully headless setup). Set `webSearch.enabled` to `false` to unregister the `web_search` tool entirely (the `fetch_content`, `get_search_content`, and `code_search` tools remain available); defaults to `true`. `chromeProfile` overrides the Chromium profile directory used for Gemini Web cookie lookup. `allowBrowserCookies` enables Chromium cookie extraction for Gemini Web; it defaults to `false` to avoid surprise macOS Keychain prompts. You can also set `PI_ALLOW_BROWSER_COOKIES=1`. `searchModel` overrides the Gemini API model used by `web_search` without changing URL, YouTube, or video extraction defaults. `summaryModel` sets the default model used for generating summary drafts in the curator UI (e.g. `"anthropic/claude-haiku-4-5"`, `"openai-codex/gpt-5.3-codex-spark"`, or `"openrouter/nvidia/nemotron-3-super-120b-a12b:free"`). Only models available in your model registry are eligible; if the configured model is unavailable, the default falls back to the built-in preference list. When Pi `enabledModels` is configured, curator summaries are limited to that allowlist; if no enabled summary model is available, the curator returns a deterministic summary instead of calling an unrelated model. `curatorTimeoutSeconds` controls the initial curator idle timeout (default `20`, max `600`); users can still adjust the timer in the curator UI.

## Shortcuts

Both shortcuts are configurable via `~/.pi/web-search.json`:

```json
{
  "shortcuts": {
    "curate": "ctrl+shift+s",
    "activity": "ctrl+shift+w"
  }
}
```

Values use the same format as pi keybindings (e.g. `ctrl+s`, `ctrl+shift+s`, `alt+r`). Changes take effect on next pi restart.

Set `"enabled": false` under any feature to disable it. Config changes require a Pi restart.

Rate limits: Perplexity is capped at 10 requests/minute (client-side). Content fetches run 3 concurrent with a 30s timeout per URL.

## Limitations

- Chromium cookie extraction for Gemini Web is opt-in via `allowBrowserCookies: true` or `PI_ALLOW_BROWSER_COOKIES=1`. On macOS, enabling it may trigger a Keychain dialog; Linux uses `secret-tool` when available and falls back to Chromium's default password otherwise.
- YouTube private/age-restricted videos may fail on all extraction paths.
- Gemini can process videos up to ~1 hour; longer videos may be truncated.
- PDFs are text-extracted only (no OCR for scanned documents).
- GitHub branch names with slashes may misresolve file paths; the clone still works and the agent can navigate manually.
- Non-code GitHub URLs (issues, PRs, wiki) fall through to normal web extraction.
