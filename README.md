<p>
  <img src="banner.png" alt="pi-web-access" width="1100">
</p>

# Pi Web Access

**Web search, content extraction, and video understanding for Pi agent. Zero-config Exa search, optional browser-cookie Gemini Web, or bring your own API keys.**

[![CI](https://img.shields.io/github/actions/workflow/status/nathanpt/pi-web-access/ci.yml?style=for-the-badge&label=CI)](https://github.com/nathanpt/pi-web-access/actions/workflows/ci.yml)
[![Status: Maintained Fork](https://img.shields.io/badge/Status-Maintained%20Fork-blue?style=for-the-badge)](#maintenance--fork-status)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows*-blue?style=for-the-badge)]()

> ⚠️ **Maintained fork.** This is an actively maintained fork of
> [`nicobailon/pi-web-access`](https://github.com/nicobailon/pi-web-access). The
> upstream project is **no longer maintained** (30+ open PRs unactioned since
> **5/4/26**). `upstream` stays pointed at the original and its outstanding PRs are
> being merged into this fork. **Not published to npm** — install it from GitHub
> with `pi install git:github.com/nathanpt/pi-web-access`. See
> [Maintenance & Fork Status](#maintenance--fork-status) below.

https://github.com/user-attachments/assets/cac6a17a-1eeb-4dde-9818-cdf85d8ea98f

## Why Pi Web Access

**Zero Config** — Works out of the box with Exa MCP (no API key needed). Add API keys for Exa, Perplexity, Gemini API, or Parallel for more control, or opt into browser-cookie access for Gemini Web.

**Video Understanding** — Point it at a YouTube video or local screen recording and ask questions about what's on screen. Full transcripts, visual descriptions, and frame extraction at exact timestamps.

**Smart Fallbacks** — Every capability has a fallback chain, so something always works. Search tries Exa (direct API if keyed, MCP if not), then Perplexity, then Gemini API, then Gemini Web when browser cookies are enabled — or define your **own order** with `provider: "priority"`. YouTube tries Gemini Web → API → Perplexity. Blocked pages retry through Jina Reader and Gemini extraction.

**Headless-Friendly** — `workflow: "auto-summary"` generates a model summary inline without ever opening a browser, so it works in `-p` / CI / SSH sessions. Pair with `allowCurator: false` for a fully headless setup.

**Billing Safety** — Curator summaries respect Pi's `enabledModels` allowlist when configured, and fall back to a deterministic no-billing summary instead of charging you for an unrelated catalog model.

**GitHub Cloning** — GitHub URLs are cloned locally instead of scraped. The agent gets real file contents and a local path to explore, not rendered HTML.

### Features at a glance

| Capability | What you get |
| --- | --- |
| 🔍 **Web search** | Exa (zero-config MCP) · Perplexity · Gemini (API + browser-cookie Web) · Parallel — with a fallback chain or your own `providerPriority` order |
| 📄 **Content fetch** | Readability + RSC + Jina Reader + Gemini extraction, GitHub clone, PDF text, SSRF-safe |
| 🎥 **Video understanding** | YouTube transcripts & visual Q&A, local-video frame extraction at timestamps |
| 🧠 **Headless summaries** | `auto-summary` workflow — model summaries without the browser curator |
| ⚙️ **Provider control** | `provider: "priority"` + `providerPriority` list to set the exact try-order |
| 🛡️ **Billing safety** | Summaries honor `enabledModels`; deterministic fallback when none is enabled |
| 📁 **XDG config** | `PI_CODING_AGENT_DIR` → `XDG_CONFIG_HOME/pi` → `~/.pi` |
| 🔌 **Bring your own gateway** | `GOOGLE_GEMINI_BASE_URL` + Cloudflare AI Gateway / LiteLLM / Helicone routing |

See [Tools](#tools), [Capabilities](#capabilities), and [Configuration](#configuration) for the full surface area. Built by [Nico Bailon](https://github.com/nicobailon) (original) and [Nathan Peet](https://github.com/nathanpt) (this fork) — see [Contributors](CONTRIBUTORS.md).

## Install

This fork is **not published to npm** — the `pi-web-access` package on npm is the
original, now-unmaintained upstream version. Install this fork directly from
GitHub:

```bash
pi install git:github.com/nathanpt/pi-web-access
```

> Prefer HTTPS? `pi install https://github.com/nathanpt/pi-web-access` works too.
> To try it without installing: `pi -e git:github.com/nathanpt/pi-web-access`.
> See [Maintenance & Fork Status](#maintenance--fork-status) for background.

Works immediately with no API keys — Exa MCP provides zero-config search. For more providers or direct API access, add keys to `~/.pi/web-search.json`:

```json
{
  "exaApiKey": "exa-...",
  "perplexityApiKey": "pplx-...",
  "geminiApiKey": "AIza...",
  "parallelApiKey": "parallel-key..."
}
```

In `auto` mode (default), `web_search` tries Exa first (direct API if keyed, MCP if not), then Perplexity, then Gemini API, then Gemini Web when browser-cookie access is enabled. For full control over the order, set a `providerPriority` list in config (e.g. `["perplexity", "exa", "gemini"]`) and select `provider: "priority"` — providers are tried in that order, skipping any that are unavailable and falling through on error. If `providerPriority` is unset or invalid, `priority` falls back to the built-in `auto` order. The `parallel` provider is opt-in only — set `provider: "parallel"` explicitly (it is not part of auto selection or fallback ordering, though you may include it in a `providerPriority` list) and requires a Parallel API key.

Optional dependencies for video frame extraction:

```bash
brew install ffmpeg   # frame extraction, video thumbnails, local video duration
brew install yt-dlp   # YouTube stream URLs for frame extraction
```

Without these, video content analysis (transcripts, visual descriptions via Gemini) still works. The binaries are only needed for extracting individual frames as images.

Requires Pi v0.37.3+.

## Quick Start

```typescript
// Search the web
web_search({ query: "TypeScript best practices 2025" })

// Fetch a page
fetch_content({ url: "https://docs.example.com/guide" })

// Clone a GitHub repo
fetch_content({ url: "https://github.com/owner/repo" })

// Understand a YouTube video
fetch_content({ url: "https://youtube.com/watch?v=abc", prompt: "What libraries are shown?" })

// Analyze a screen recording
fetch_content({ url: "/path/to/recording.mp4", prompt: "What error appears on screen?" })
```

## Tools

### web_search

Search the web via Exa, Perplexity AI, Gemini, or Parallel. Returns a synthesized answer with source citations.

```typescript
web_search({ query: "rust async programming" })
web_search({ queries: ["query 1", "query 2"] })
web_search({ query: "latest news", numResults: 10, recencyFilter: "week" })
web_search({ query: "...", domainFilter: ["github.com"] })
web_search({ query: "...", provider: "exa" })
web_search({ query: "...", provider: "parallel" })
web_search({ query: "...", includeContent: true })
web_search({ queries: ["query 1", "query 2"], workflow: "none" })
web_search({ queries: ["query 1", "query 2"], workflow: "summary-review" })
web_search({ queries: ["query 1", "query 2"], workflow: "auto-summary" })
```

| Parameter | Description |
|-----------|-------------|
| `query` / `queries` | Single query or batch of queries. Batched raw searches run concurrently with ordered output. |
| `numResults` | Results per query (default: 5, max: 20) |
| `recencyFilter` | `day`, `week`, `month`, or `year` |
| `domainFilter` | Limit to domains (prefix with `-` to exclude) |
| `provider` | `auto` (default), `priority`, `exa`, `perplexity`, `gemini`, or `parallel` (opt-in; not part of auto/fallback). Use `priority` to honor the `providerPriority` order |
| `includeContent` | Fetch full page content from sources in background |
| `workflow` | `none` (skip curator), `summary-review` (auto-generate summary draft after search completion, default unless `allowCurator` is false), or `auto-summary` (generate a summary without opening the curator — works headless) |

### code_search

Search for code examples, documentation, and API references via Exa MCP. No API key required. Uses Exa's code-context MCP tool when available and falls back to code-focused web search when that tool is unavailable.

```typescript
code_search({ query: "React useEffect cleanup pattern" })
code_search({ query: "Express middleware error handling", maxTokens: 10000 })
```

| Parameter | Description |
|-----------|-------------|
| `query` | Programming question, API, library, or debugging topic |
| `maxTokens` | Maximum tokens of context to return (default: 5000, max: 50000) |

### fetch_content

Fetch URL(s) and extract readable content as markdown. Automatically detects and handles GitHub repos, YouTube videos, PDFs, local video files, and regular web pages.

```typescript
fetch_content({ url: "https://example.com/article" })
fetch_content({ urls: ["url1", "url2", "url3"] })
fetch_content({ url: "https://github.com/owner/repo" })
fetch_content({ url: "https://youtube.com/watch?v=abc", prompt: "What libraries are shown?" })
fetch_content({ url: "/path/to/recording.mp4", prompt: "What error appears on screen?" })
fetch_content({ url: "https://youtube.com/watch?v=abc", timestamp: "23:41-25:00", frames: 4 })
```

| Parameter | Description |
|-----------|-------------|
| `url` / `urls` | Single URL/path or multiple URLs |
| `prompt` | Question to ask about a YouTube video or local video file |
| `timestamp` | Extract frame(s) — single (`"23:41"`), range (`"23:41-25:00"`), or seconds (`"85"`) |
| `frames` | Number of frames to extract (max 12) |
| `forceClone` | Clone GitHub repos that exceed the 350MB size threshold |

### get_search_content

Retrieve stored content from previous searches or fetches. Content over 30,000 chars is truncated in tool responses but stored in full for retrieval here.

```typescript
get_search_content({ responseId: "abc123", urlIndex: 0 })
get_search_content({ responseId: "abc123", url: "https://..." })
get_search_content({ responseId: "abc123", query: "original query" })
```

## Capabilities

### GitHub repos

GitHub URLs are cloned locally instead of scraped. The agent gets real file contents and a local path to explore with `read` and `bash`. Root URLs return the repo tree + README, `/tree/` paths return directory listings, `/blob/` paths return file contents.

Repos over 350MB get a lightweight API-based view instead of a full clone (override with `forceClone: true`). Commit SHA URLs are handled via the API. Clones are cached for the session and wiped on session change. Private repos require the `gh` CLI.

### YouTube videos

YouTube URLs are processed via Gemini for full video understanding — visual descriptions, transcripts with timestamps, and chapter markers. Pass a `prompt` to ask specific questions about the video. Results include the video thumbnail so the agent gets visual context alongside the transcript.

Fallback: Gemini Web when browser cookies are enabled → Gemini API → Perplexity (text summary only). Handles all URL formats: `/watch?v=`, `youtu.be/`, `/shorts/`, `/live/`, `/embed/`, `/v/`.

### Local video files

Pass a file path (`/`, `./`, `../`, or `file://` prefix) to analyze video content via Gemini. Supports MP4, MOV, WebM, AVI, and other common formats up to 50MB. Pass a `prompt` to ask about specific content. If ffmpeg is installed, a thumbnail frame is included alongside the analysis.

Fallback: Gemini API (Files API upload) → Gemini Web when browser cookies are enabled.

### Video frame extraction

Use `timestamp` and/or `frames` on any YouTube URL or local video file to extract visual frames as images.

```typescript
fetch_content({ url: "...", timestamp: "23:41" })                       // single frame
fetch_content({ url: "...", timestamp: "23:41-25:00" })                 // range, 6 frames
fetch_content({ url: "...", timestamp: "23:41-25:00", frames: 3 })      // range, custom count
fetch_content({ url: "...", timestamp: "23:41", frames: 5 })            // 5 frames at 5s intervals
fetch_content({ url: "...", frames: 6 })                                // sample whole video
```

Requires `ffmpeg` (and `yt-dlp` for YouTube). Timestamps accept `H:MM:SS`, `MM:SS`, or bare seconds.

### PDFs

PDF URLs are extracted as text and saved to `~/Downloads/` as markdown. The agent can then `read` specific sections without loading the full document into context. Text-based extraction only — no OCR.

### Blocked pages

When Readability fails or returns only a cookie notice, the extension retries via Jina Reader (handles JS rendering server-side, no API key needed), then Parallel Extract (when a Parallel API key is configured — a server-side renderer that also handles PDFs), then Gemini URL Context API, then Gemini Web extraction when browser cookies are enabled. Handles SPAs, JS-heavy pages, and anti-bot protections transparently. Also parses Next.js RSC flight data when present.

## How It Works

```
web_search(query)
  → Exa (direct API with key, MCP without) → Perplexity → Gemini API → Gemini Web (if browser cookies enabled)

fetch_content(url)
  → Video file?  Gemini API (Files API) → Gemini Web (if browser cookies enabled)
  → GitHub URL?  Clone repo, return file contents + local path
  → YouTube URL? Gemini Web (if browser cookies enabled) → Gemini API → Perplexity
  → HTTP fetch → PDF? Extract text, save to ~/Downloads/
               → HTML? Readability → RSC parser → Jina Reader → Parallel Extract (if keyed) → Gemini fallback
               → Text/JSON/Markdown? Return directly
```

## Skills

### librarian

Bundled research workflow for investigating open-source libraries. Combines GitHub cloning, web search, and git operations (blame, log, show) to produce evidence-backed answers with permalinks. Pi loads it automatically based on your prompt. Also available via `/skill:librarian` with [pi-skill-palette](https://github.com/nicobailon/pi-skill-palette).

## Commands

### /websearch

Open the search curator directly. Runs searches and lets you review, add, select results, and approve a summary before it is sent back to the agent — no LLM round-trip needed.

```
/websearch                                               # empty page, type your own searches
/websearch react hooks, next.js caching                  # pre-fill with comma-separated queries
```

Results get injected into the conversation when you approve the summary or click "Send selected results without summary". On timeout, the curator auto-submits and falls back to a deterministic summary if no approved draft is present.

### /curator

Toggle or configure the curator workflow at runtime.

```
/curator                    # toggle on/off
/curator on                 # enable curator (summary-review)
/curator off                # disable curator (raw results only)
/curator summary-review     # explicit workflow
/curator auto-summary       # generate a summary without opening the curator
/curator never              # hard-disable curator regardless of per-call workflow
/curator allow              # allow curator again without enabling it
```

Persists to `~/.pi/web-search.json` and takes effect on the next `web_search` call. When disabled, `web_search` returns raw results without opening the curator window. `auto-summary` never opens the browser, so it stays available even when the curator is hard-disabled — making `allowCurator: false` a headless mode that still produces model-generated summaries. Set `"allowCurator": false` directly or run `/curator never` to hard-disable the browser curator, including per-call `workflow: "summary-review"` overrides and `/curator on`.

### /search

Browse stored search results interactively. Lists all results from the current session with their response IDs for easy retrieval.

### /google-account

Show the active Google account currently authenticated for Gemini Web. Useful when multiple Chromium profiles exist or `chromeProfile` is set in config.

## Activity Monitor

Toggle with **Ctrl+Shift+W** to see live request/response activity:

```
─── Web Search Activity ────────────────────────────────────
  API  "typescript best practices"     200    2.1s ✓
  GET  docs.example.com/article        200    0.8s ✓
  GET  blog.example.com/post           404    0.3s ✗
────────────────────────────────────────────────────────────
```

## Configuration

All config lives in `web-search.json`, resolved with XDG precedence: `$PI_CODING_AGENT_DIR` → `$XDG_CONFIG_HOME/pi` → `~/.pi` (i.e. `~/.pi/web-search.json` by default, matching pi-core). Every field is optional.

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

`EXA_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, `PARALLEL_API_KEY`, `GOOGLE_GEMINI_BASE_URL`, and `CLOUDFLARE_API_KEY` env vars take precedence over config file values. `GOOGLE_GEMINI_BASE_URL` overrides the Gemini API host for all Gemini calls (search, URL context, video) — set it to a bare host with no trailing slash and no version segment (e.g. `https://my-gateway.example.com/gemini`), matching the [official Gemini CLI convention](https://www.geminicli.com/docs/reference/configuration). `geminiBaseUrl` in config is the equivalent file-based override. When the configured host contains `gateway.ai.cloudflare.com`, authentication automatically switches to `cf-aig-authorization: Bearer <token>` using `CLOUDFLARE_API_KEY` (or `cloudflareApiKey` in config), and no `GEMINI_API_KEY` is required. Note: video file upload always goes to Google's upload endpoint directly; gateway users without a `GEMINI_API_KEY` will fall back to Gemini Web for video extraction. `provider` sets the default search provider: `"auto"` (default), `"priority"`, `"exa"`, `"perplexity"`, `"gemini"`, or `"parallel"`. This is also updated automatically when you change the provider in the curator UI. `providerPriority` (an array of provider names, e.g. `["perplexity", "exa", "gemini"]`) sets the order tried when `provider` is `"priority"`; unknown names, duplicates, and the meta-values `"auto"`/`"priority"` are dropped. If unset or empty, `"priority"` falls back to the built-in `auto` order. The `parallel` provider is opt-in: it must be selected explicitly via the `provider` parameter or config and is not included in `auto` selection or fallback ordering (though you may list it in `providerPriority`); it requires a Parallel API key (`parallelApiKey` or `PARALLEL_API_KEY`). `workflow` sets the default curator mode: `"summary-review"` (default, opens curator with auto-generated summary draft), `"auto-summary"` (generates a summary without opening the curator — works headless / in `-p` mode), or `"none"` (raw results, no curator). Overridden per-call via the `workflow` parameter on `web_search`, or toggled at runtime with `/curator`. Set `allowCurator` to `false` to force raw results even if a tool call asks for `workflow: "summary-review"`; when false, `/curator on` is rejected and the tool schema only advertises `workflow: "none"` and `"auto-summary"` (auto-summary never opens the browser, so it remains available as a headless summary path). Set `webSearch.enabled` to `false` to unregister the `web_search` tool entirely (the `fetch_content`, `get_search_content`, and `code_search` tools remain available); defaults to `true`. `chromeProfile` overrides the Chromium profile directory used for Gemini Web cookie lookup. `allowBrowserCookies` enables Chromium cookie extraction for Gemini Web; it defaults to `false` to avoid surprise macOS Keychain prompts. You can also set `PI_ALLOW_BROWSER_COOKIES=1`. `searchModel` overrides the Gemini API model used by `web_search` without changing URL, YouTube, or video extraction defaults. `summaryModel` sets the default model used for generating summary drafts in the curator UI (e.g. `"anthropic/claude-haiku-4-5"`, `"openai-codex/gpt-5.3-codex-spark"`, or `"openrouter/nvidia/nemotron-3-super-120b-a12b:free"`). Only models available in your model registry are eligible; if the configured model is unavailable, the default falls back to the built-in preference list. When Pi `enabledModels` is configured, curator summaries are limited to that allowlist; if no enabled summary model is available, the curator returns a deterministic summary instead of calling an unrelated model. `curatorTimeoutSeconds` controls the initial curator idle timeout (default `20`, max `600`); users can still adjust the timer in the curator UI.

### Shortcuts

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

## Maintenance & Fork Status

This repository is an **actively maintained fork** of
[`nicobailon/pi-web-access`](https://github.com/nicobailon/pi-web-access). The
upstream project is no longer maintained — **30+ open pull requests have gone
unactioned since 5/4/26**.

**How this fork is run:**

- **`upstream` → original repo** (`nicobailon/pi-web-access`). The `upstream` git
  remote stays pointed at the original so its history and outstanding PRs can be
  pulled in.
- **PRs are being merged here.** The open PRs from upstream are being reviewed and
  pulled into this fork incrementally.
- **Not on npm (for now).** Do **not** install via `pi install npm:pi-web-access` —
  that pulls the original, unmaintained version. Install this fork from GitHub
  instead:

  ```bash
  pi install git:github.com/nathanpt/pi-web-access
  ```

Contributions (fixes, features, cherry-picked upstream PRs) are welcome as PRs
against **this fork**. See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the
development setup, test conventions, the cherry-pick-with-attribution workflow,
and how outstanding upstream PRs are being merged here. Contributors are listed
in **[CONTRIBUTORS.md](CONTRIBUTORS.md)**. When referencing
upstream commits or PRs, please cite the original author's work.

<details>
<summary>Files</summary>

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry, tool definitions, commands, widget |
| `extract.ts` | URL/file path routing, HTTP extraction, fallback orchestration |
| `activity.ts` | Activity tracking for the observability widget |
| `storage.ts` | Session-aware result storage (powers `get_search_content`) |
| `utils.ts` | Shared formatting and error helpers |
| `workflow.ts` | Curator workflow resolution (`/curator` on/off/none/auto-summary) |
| `chrome-cookies.ts` | macOS/Linux Chromium-based cookie extraction (Keychain/secret-tool + SQLite) |
| `providers/exa.ts` | Exa.ai search provider — direct API and MCP proxy, budget tracking |
| `providers/perplexity.ts` | Perplexity API client with rate limiting |
| `providers/parallel.ts` | Parallel search provider — `api.parallel.ai` web search, `provider: "parallel"` (opt-in) |
| `providers/gemini-search.ts` | Search routing across Exa, Perplexity, Gemini API, Gemini Web |
| `providers/gemini-api.ts` | Gemini REST API client (generateContent) |
| `providers/gemini-web.ts` | Gemini Web client (cookie auth, StreamGenerate) |
| `providers/gemini-web-config.ts` | Gemini Web profile and browser-cookie opt-in config |
| `providers/gemini-url-context.ts` | Gemini URL Context + Web extraction fallbacks |
| `providers/code-search.ts` | Code/docs search via Exa MCP |
| `extractors/github-extract.ts` | GitHub URL parsing, clone cache, content generation |
| `extractors/github-api.ts` | GitHub API fallback for large repos and commit SHAs |
| `extractors/youtube-extract.ts` | YouTube detection, three-tier extraction, frame extraction |
| `extractors/video-extract.ts` | Local video detection, Files API upload, Gemini analysis |
| `extractors/pdf-extract.ts` | PDF text extraction, saves to markdown |
| `extractors/rsc-extract.ts` | RSC flight data parser for Next.js pages |
| `curator/curator-page.ts` | HTML/CSS/JS generation for the curator UI with markdown rendering |
| `curator/curator-server.ts` | Ephemeral HTTP server with SSE streaming and state machine |
| `curator/summary-review.ts` | Summary prompt construction, model-based draft generation, and deterministic fallback summary |
| `skills/librarian/` | Bundled skill for library research |

</details>
