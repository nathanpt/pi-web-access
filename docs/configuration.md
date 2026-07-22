# Configuration

All config lives in `web-search.json`, resolved with XDG precedence: `$PI_CODING_AGENT_DIR` → `$XDG_CONFIG_HOME/pi` → `~/.pi` (i.e. `~/.pi/web-search.json` by default, matching pi-core). Every field is optional.

> **Prefer not to hand-edit JSON?** Run [`/webaccess`](commands.md#webaccess) to inspect the effective config (with provider status + secret provenance), manage API keys (`/webaccess set-key <provider> <key>`, `clear-key`, `test-key`), run config diagnostics (`/webaccess doctor`), and update common fields from the command line. It validates input before saving and preserves precedence (`env > config > defaults`). This page documents the full field set for both modes.

```json
{
  "exaApiKey": "exa-...",
  "perplexityApiKey": "pplx-...",
  "geminiApiKey": "AIza...",
  "parallelApiKey": "parallel-key...",
  "parallelReasoningEffort": "low",
  "searxngBaseUrl": "https://search.example.com",
  "firecrawlBaseUrl": "http://localhost:3002",
  "firecrawlApiKey": "fc-...",
  "olostepApiKey": "olostep-...",
  "braveApiKey": "BSAkey...",
  "tavilyApiKey": "tvly-...",
  "openaiApiKey": "sk-...",
  "geminiBaseUrl": "https://my-gateway.example.com/gemini",
  "cloudflareApiKey": "...",
  "openaiBaseUrl": "https://my-gateway.example.com/v1",
  "openaiSearchModel": "azure/openai/gpt-5.5",
  "perplexityBaseUrl": "https://my-gateway.example.com",
  "perplexityModel": "sonar",
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
  },
  "ssrf": {
    "allowRanges": ["198.18.0.0/15"],
    "trustEnvProxy": true
  }
}
```

`EXA_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, `PARALLEL_API_KEY`, `PARALLEL_REASONING_EFFORT`, `BRAVE_API_KEY`, `TAVILY_API_KEY`, `OLOSTEP_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_SEARCH_MODEL`, `PERPLEXITY_BASE_URL`, `PERPLEXITY_MODEL`, `SEARXNG_BASE_URL`, `FIRECRAWL_BASE_URL`, `FIRECRAWL_API_KEY`, `FIRECRAWL_BASIC_AUTH`, `GOOGLE_GEMINI_BASE_URL`, and `CLOUDFLARE_API_KEY` env vars take precedence over config file values. `PARALLEL_REASONING_EFFORT` selects the Parallel Responses-API reasoning tier (`low` | `medium` | `high`; defaults to `low` for snappy agent-facing search — the API itself defaults to `medium`). `FIRECRAWL_BASIC_AUTH` is the raw `user:pass` for HTTP Basic auth against a reverse-proxied Firecrawl instance (the extension base64-encodes it). `GOOGLE_GEMINI_BASE_URL` overrides the Gemini API host for all Gemini calls (search, URL context, video) — set it to a bare host with no trailing slash and no version segment (e.g. `https://my-gateway.e

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

Set `"enabled": false` under any feature to disable it. Set `webSearch.enabled` to `false` to unregister the `web_search` tool (the `fetch_content`, `get_search_content`, and `code_search` tools remain registered). Config changes require a Pi restart.

Rate limits: Perplexity is capped at 10 requests/minute (client-side). Content fetches run 3 concurrent with a 30s timeout per URL.

## Limitations

- Chromium cookie extraction for Gemini Web is opt-in via `allowBrowserCookies: true` or `PI_ALLOW_BROWSER_COOKIES=1`. On macOS, enabling it may trigger a Keychain dialog; Linux uses `secret-tool` when available and falls back to Chromium's default password otherwise.
- YouTube private/age-restricted videos may fail on all extraction paths.
- Gemini can process videos up to ~1 hour; longer videos may be truncated.
- PDFs are text-extracted only (no OCR for scanned documents).
- GitHub branch names with slashes may misresolve file paths; the clone still works and the agent can navigate manually.
- Non-code GitHub URLs (issues, PRs, wiki) fall through to normal web extraction.
