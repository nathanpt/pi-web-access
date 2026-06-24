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
## Documentation

The README is a landing page — full reference lives in [`docs/`](docs/):

| Topic | What's covered |
| --- | --- |
| 🛠️ [Tools](docs/tools.md) | `web_search`, `code_search`, `fetch_content`, `get_search_content` — parameters & examples |
| 🎯 [Capabilities](docs/capabilities.md) | GitHub cloning, YouTube, local video, PDFs, blocked pages, and the full fallback-chain diagram |
| ⌨️ [Commands](docs/commands.md) | `/websearch`, `/curator`, `/search`, `/google-account`, and the activity monitor |
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
