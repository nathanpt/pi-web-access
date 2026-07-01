<p>
  <img src="banner.png" alt="pi-web-access" width="1100">
</p>

# Pi Web Access

**Web search, content extraction, and video understanding for Pi agent. Zero-config Exa search, optional browser-cookie Gemini Web, or bring your own API keys.**

[![CI](https://img.shields.io/github/actions/workflow/status/nathanpt/pi-web-access/ci.yml?style=for-the-badge&label=CI)](https://github.com/nathanpt/pi-web-access/actions/workflows/ci.yml)
[![Status: Maintained Fork](https://img.shields.io/badge/Status-Maintained%20Fork-blue?style=for-the-badge)](#maintenance--fork-status)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows*-blue?style=for-the-badge)]()

> 🍴 **Opinionated fork.** This is an actively maintained fork of
> [`nicobailon/pi-web-access`](https://github.com/nicobailon/pi-web-access).
> Upstream revived in late June 2026 (v0.11.0–v0.13.0) and now shares most of the
> feature surface. This fork adds the **`/webaccess` config command**,
> **`providerPriority` custom routing**, two extra opt-in providers (**SearXNG**,
> **Olostep**), and a retained **`code_search`** tool on top of that shared core —
> see [Differences from upstream](#differences-from-upstream). **Not published to
> npm** — install it from GitHub with
> `pi install git:github.com/nathanpt/pi-web-access`. See
> [Maintenance & Fork Status](#maintenance--fork-status) below.

<!-- https://github.com/user-attachments/assets/cac6a17a-1eeb-4dde-9818-cdf85d8ea98f -->

## Why Pi Web Access

**Zero Config** — Works out of the box with Exa MCP (no API key needed); the `auto` fallback adds Gemini (API key, gateway, or browser-cookie Web). Every paid-key provider — Perplexity, Parallel, Brave, Tavily, OpenAI — plus self-hosted SearXNG and Olostep is **opt-in**, so a configured key never silently routes (or bills). Pick any of them via `provider:` / `providerPriority`.

**Video Understanding** — Point it at a YouTube video or local screen recording and ask questions about what's on screen. Full transcripts, visual descriptions, and frame extraction at exact timestamps.

**Smart Fallbacks** — Every capability has a fallback chain, so something always works. `auto` search tries Exa (direct API if keyed, zero-config MCP if not), then Gemini (API → browser-cookie Web). Paid providers (Perplexity, Parallel, Brave, Tavily, OpenAI) and self-hosted SearXNG / Olostep are **opt-in** — never silently tried or billed — so use `provider: "priority"` + a `providerPriority` list to bring them in. YouTube tries Gemini Web → API → Perplexity. Blocked pages retry through Jina Reader, Olostep scrape, Parallel, and Gemini extraction.

**Headless-Friendly** — `workflow: "auto-summary"` generates a model summary inline without ever opening a browser, so it works in `-p` / CI / SSH sessions. Pair with `allowCurator: false` for a fully headless setup. Both are settable from the command: `/webaccess workflow auto-summary` and `/webaccess allow-curator off`.

**Billing Safety** — Curator summaries respect Pi's `enabledModels` allowlist when configured, and fall back to a deterministic no-billing summary instead of charging you for an unrelated catalog model.

**GitHub Cloning** — GitHub URLs are cloned locally instead of scraped. The agent gets real file contents and a local path to explore, not rendered HTML.

### Features at a glance

| Capability | What you get |
| --- | --- |
| 🔍 **Web search** | `auto`: Exa (zero-config MCP) · Gemini (API + browser-cookie Web). Opt-in paid/self-hosted: Perplexity · Parallel · Brave · Tavily · OpenAI · SearXNG · Olostep. Use the fallback chain or your own `providerPriority` order |
| 📄 **Content fetch** | Readability + RSC + Jina Reader + Gemini extraction, GitHub clone, PDF text, SSRF-safe |
| 🎥 **Video understanding** | YouTube transcripts & visual Q&A, local-video frame extraction at timestamps |
| 🧠 **Headless summaries** | `auto-summary` workflow — model summaries without the browser curator |
| ⚙️ **Provider control** | `provider: "priority"` + `providerPriority` list to set the exact try-order |
| 🔑 **Key management** | `/webaccess set-key` / `clear-key` / `test-key` — add, remove, or dry-run provider keys; no JSON editing |
| 🛡️ **Billing safety** | Summaries honor `enabledModels`; deterministic fallback when none is enabled |
| 📁 **XDG config** | `PI_CODING_AGENT_DIR` → `XDG_CONFIG_HOME/pi` → `~/.pi` |
| 🔌 **Bring your own gateway** | `GOOGLE_GEMINI_BASE_URL` / `OPENAI_BASE_URL` / `PERPLEXITY_BASE_URL` + Cloudflare AI Gateway / LiteLLM / Helicone / corporate-proxy routing |

See [Tools](#tools), [Capabilities](#capabilities), and [Configuration](#configuration) for the full surface area. Built by [Nico Bailon](https://github.com/nicobailon) (original) and [Nathan Peet](https://github.com/nathanpt) (this fork) — see [Contributors](CONTRIBUTORS.md).

## Install

This fork is **not published to npm** — the `pi-web-access` package on npm is
upstream's version. Install this fork directly from GitHub:

```bash
pi install git:github.com/nathanpt/pi-web-access
```

> Prefer HTTPS? `pi install https://github.com/nathanpt/pi-web-access` works too.
> To try it without installing: `pi -e git:github.com/nathanpt/pi-web-access`.
> See [Maintenance & Fork Status](#maintenance--fork-status) for background.

Works immediately with no API keys — Exa MCP provides zero-config search. For more providers or direct API access, add keys via the command (no hand-editing):

```
/webaccess set-key exa exa-...
/webaccess set-key perplexity pplx-...
/webaccess set-key gemini AIza...
/webaccess set-key parallel parallel-key...
/webaccess set-key brave BSAkey...
/webaccess set-key tavily tvly-...
/webaccess set-key olostep olostep-...
/webaccess set-key openai sk-...
```

Keys are validated and never echoed back (the confirmation shows only a last-4 fingerprint). SearXNG uses a base URL instead of a key (`/webaccess` shows its status; configure via `searxngBaseUrl` / `SEARXNG_BASE_URL`). You can also edit `~/.pi/web-search.json` directly, or set the env vars (`EXA_API_KEY`, `PERPLEXITY_API_KEY`, `GEMINI_API_KEY`, `PARALLEL_API_KEY`, `BRAVE_API_KEY`, `TAVILY_API_KEY`, `OLOSTEP_API_KEY`, `OPENAI_API_KEY`, `SEARXNG_BASE_URL`). Route the OpenAI / Perplexity providers through an OpenAI-compatible gateway with `OPENAI_BASE_URL` / `PERPLEXITY_BASE_URL` (plus `OPENAI_SEARCH_MODEL` / `PERPLEXITY_MODEL` for non-vendor model ids):

```json
{
  "exaApiKey": "exa-...",
  "perplexityApiKey": "pplx-...",
  "geminiApiKey": "AIza...",
  "parallelApiKey": "parallel-key...",
  "braveApiKey": "BSAkey...",
  "tavilyApiKey": "tvly-...",
  "olostepApiKey": "olostep-...",
  "openaiApiKey": "sk-...",
  "openaiBaseUrl": "https://my-gateway.example.com/v1",
  "perplexityBaseUrl": "https://my-gateway.example.com",
  "searxngBaseUrl": "https://search.example.com"
}
```

In `auto` mode (default), `web_search` tries providers in this order: Exa (direct API if keyed, zero-config MCP if not) → Gemini (API, then Web when browser-cookie access is enabled). **Paid-key providers are opt-in** — Perplexity, Parallel, Brave, Tavily, and OpenAI are never silently tried or billed in `auto`; add them with `provider: "<name>"` or a `providerPriority` list. For full control over the order, set a `providerPriority` list in config (e.g. `["perplexity", "exa", "gemini"]`) and select `provider: "priority"` — providers are tried in that order, skipping any that are unavailable and falling through on error. If `providerPriority` is unset or invalid, `priority` falls back to the built-in `auto` order. Placeholder values (e.g. `"your-key"`) are treated as missing, so a leftover template value never causes a 401 mid-fallback. (SearXNG and Olostep are opt-in too — configured via base URL / key explicitly.)

Optional dependencies for video frame extraction:

```bash
brew install ffmpeg   # frame extraction, video thumbnails, local video duration
brew install yt-dlp   # YouTube stream URLs for frame extraction
```

Without these, video content analysis (transcripts, visual descriptions via Gemini) still works. The binaries are only needed for extracting individual frames as images.

Requires Pi v0.37.3+.

## Quick Start

Zero-config: `web_search` works out of the box via Exa's public MCP endpoint. To wire in your own keys or change behavior, run `/webaccess` — it's the single command for inspecting status, setting/clearing/testing API keys, and running config diagnostics (`/webaccess doctor`). Run `/webaccess help` for the full reference, or see [Configuration](docs/configuration.md).

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
## Documentation

The README is a landing page — full reference lives in [`docs/`](docs/):

| Topic | What's covered |
| --- | --- |
| 🛠️ [Tools](docs/tools.md) | `web_search`, `code_search`, `fetch_content`, `get_search_content` — parameters & examples |
| 🎯 [Capabilities](docs/capabilities.md) | GitHub cloning, YouTube, local video, PDFs, blocked pages, and the full fallback-chain diagram |
| ⌨️ [Commands](docs/commands.md) | `/webaccess` (config & status), `/websearch`, `/curator`, `/search`, `/google-account`, and the activity monitor |
| ⚙️ [Configuration](docs/configuration.md) | Every config field, env vars, XDG path, gateway routing, shortcuts, limitations |
| 📚 [Skills](docs/skills.md) | The bundled `librarian` research skill |

**Bundled skill:** `librarian` investigates open-source libraries with GitHub cloning + web search + git archaeology for evidence-backed answers. See [Skills](docs/skills.md).

## Limitations

A few worth knowing up front — full detail in [Configuration](docs/configuration.md#limitations):

- Gemini Web browser-cookie access is opt-in (`allowBrowserCookies`); may prompt macOS Keychain.
- YouTube private/age-restricted videos may fail on all paths.
- PDFs are text-extracted only (no OCR); videos over ~1 hour may be truncated.

## Maintenance & Fork Status

This repository is an **actively maintained fork** of
[`nicobailon/pi-web-access`](https://github.com/nicobailon/pi-web-access).

Upstream went quiet after early May 2026, which is why this fork began. **It has
since revived**: in late June 2026 the upstream maintainer shipped v0.11.0 →
v0.12.0 → v0.13.0 and merged 15+ community PRs, independently landing most of the
features this fork had built on its own (Parallel/Tavily/Brave/OpenAI providers,
XDG config, headless `auto-summary`, `ssrf.allowRanges`, billing-safety, the
Cloudflare AI Gateway, Ctrl+O error diagnostics, and the pi 0.80 migration). The
two trees now share most of their feature surface.

So why does the fork still exist? A handful of things are **not** upstream and are
the fork's reason to keep going — the `/webaccess` command, `providerPriority`
routing, SearXNG and Olostep providers, and a retained `code_search` tool. See
[Differences from upstream](#differences-from-upstream) for the full list.

**How this fork is run:**

- **`upstream` → original repo** (`nicobailon/pi-web-access`). The `upstream` git
  remote tracks the original so its history and new work can be pulled in.
- **Track and port upstream.** Upstream's flat layout means its commits don't
  cherry-pick cleanly onto our `providers/` / `extractors/` / `curator/` structure,
  so new upstream work is ported here as manual re-implementations with credit to
  the original author.
- **Not on npm (for now).** Do **not** install via `pi install npm:pi-web-access` —
  that pulls upstream's version. Install this fork from GitHub instead:

  ```bash
  pi install git:github.com/nathanpt/pi-web-access
  ```

Contributions (fixes, features, ports of upstream work) are welcome as PRs
against **this fork**. See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the
development setup, test conventions, and the cherry-pick-with-attribution
workflow. Contributors are listed in **[CONTRIBUTORS.md](CONTRIBUTORS.md)**. When
referencing upstream commits or PRs, please cite the original author's work.

<details>
<summary>Files</summary>

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry: tool definitions, commands (`/websearch` `/curator` `/search` `/google-account` `/webaccess`), widget. Config load/save via thin wrappers over `config.ts` |
| `extract.ts` | URL/file path routing, HTTP extraction, fallback orchestration |
| `activity.ts` | Activity tracking for the observability widget |
| `storage.ts` | Session-aware result storage (powers `get_search_content`) |
| `render-search-error.ts` | Pure `buildSearchErrorPlan` powering the expandable Ctrl+O error/cancel diagnostics across all four tools |
| `ssrf-protection.ts` | Redirect-aware + DNS-resolving SSRF guard + `ssrf.allowRanges` config |
| `utils.ts` | Shared formatting and error helpers |
| `workflow.ts` | Curator workflow resolution (`/curator` on/off/none/auto-summary) |
| `chrome-cookies.ts` | macOS/Linux Chromium-based cookie extraction (Keychain/secret-tool + SQLite) |
| `config.ts` | **Centralized config owner** — load/save/normalize/redaction/precedence/status/validation for `~/.pi/web-search.json`; `normalizeApiKey` + placeholder-key detection; `getEffectiveConfig` + `getProviderCredentialStatus` power `/webaccess` |
| `webaccess-command.ts` | Pure validation + formatting for the `/webaccess` command: summary, `set-key`/`clear-key`/`test-key`/`export`/`doctor`, and field sets (provider/workflow/provider-priority/allow-browser-cookies/search-model/curator-timeout) |
| `providers/exa.ts` | Exa.ai search provider — direct API and MCP proxy, budget tracking |
| `providers/perplexity.ts` | Perplexity API client with rate limiting |
| `providers/parallel.ts` | Parallel search provider — `api.parallel.ai` web search, opt-in (reachable via `providerPriority` or `provider: "parallel"`) |
| `providers/gemini-search.ts` | Search routing across all providers — shared fallback loop (`DEFAULT_AUTO_ORDER = [exa, perplexity, gemini, parallel]`; searxng/olostep/brave/tavily/openai opt-in); Provider Trace (`SearchTrace`, `attachSearchTrace`/`getSearchTrace`); `ALL_PROVIDERS` is the single source of truth for the provider list |
| `providers/searxng.ts` | SearXNG self-hosted metasearch provider (no key; base URL) — opt-in |
| `providers/olostep.ts` | Olostep answers provider **+** `fetch_content` scrape fallback — opt-in, key-gated |
| `providers/brave.ts` | Brave Search API provider — opt-in, key-gated |
| `providers/tavily.ts` | Tavily Search API provider (native answer + `inlineContent`) — opt-in, key-gated |
| `providers/openai-search.ts` | OpenAI Responses API + built-in `web_search` tool provider — opt-in, key-gated (Codex-subscription auth deferred) |
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

## Differences from upstream

Upstream revived in late June 2026 (v0.11.0–v0.13.0) and now independently ships much of what this fork had built — Parallel, Tavily, Brave, and OpenAI providers; XDG config; headless `auto-summary`; `ssrf.allowRanges`; billing-safety via `enabledModels`; the Cloudflare AI Gateway; Ctrl+O error diagnostics; and the pi 0.80 `@earendil-works/*` migration. The differences below are what genuinely remain.

### Fork-only additions (not upstream)

- **`/webaccess` command.** A config UX for inspecting status and setting / clearing / dry-run testing provider keys, plus `doctor` diagnostics — no JSON or env-var editing. Upstream relies on hand-editing `~/.pi/web-search.json` and env vars.
- **`providerPriority` routing.** Set a custom provider try-order (e.g. `["perplexity", "exa", "gemini"]`) and select it with `provider: "priority"`. Upstream exposes only the built-in `auto` order.
- **SearXNG** (self-hosted metasearch, base-URL, no key) and **Olostep** (answers API + a `fetch_content` scrape fallback). Two extra opt-in providers upstream doesn't carry.

### Intentional, permanent divergences

- **`code_search` is retained.** Upstream removed it (`7ae547d`), citing overlap with `web_search`. We keep it: `code_search` calls Exa's distinct `get_code_context_exa` code index with token-budgeting and query tuning that `web_search` lacks. Recorded as a permanent divergence in the `0.11.0` changelog.
- **The Exa local usage cap is retained.** Upstream removed it (`2e1f454`); we keep our own budget logic (and `parallel.ts`'s), so local usage stays bounded.
- **Our own `parallel.ts`.** Upstream's Parallel integration (`d689aea`) is a different implementation; ours ships its own feature set and budget logic, so the two are not interchangeable.

### Architectural (drives how upstream work is ported)

- **Folder restructure + centralized config.** Source lives under `providers/`, `extractors/`, and `curator/` with a single `config.ts` owning `~/.pi/web-search.json` (no per-provider `loadConfig()` clones). Upstream stays a flat layout. This is why upstream commits are ported here as manual re-implementations rather than cherry-picked.

### Reconciled (no longer a divergence)

- **Namespace.** Both fork and upstream import from `@earendil-works/*` (upstream migrated in `da524f7`; we followed in `0.15.0`).
