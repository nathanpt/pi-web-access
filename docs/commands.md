# Commands & Activity Monitor

## /webaccess

Inspect or update the extension's config without hand-editing `~/.pi/web-search.json`. With no arguments it prints a **summary**: the config-file path, routing settings (default provider, provider priority, workflow, curator, search model), a provider-credential table showing where each key comes from (`env` / `config` / `missing`) and whether the provider is selectable, and the browser-cookie status. **Secrets are never displayed** — only provenance.

```
/webaccess                                              # show effective config + provider status
/webaccess provider perplexity                          # set default search provider
/webaccess provider auto                                # back to built-in auto order
/webaccess workflow none                                # raw results, no curator
/webaccess workflow summary-review                       # open curator with summary draft (default)
/webaccess workflow auto-summary                         # headless summary, no browser
/webaccess provider-priority exa,perplexity,gemini       # order tried when provider is "priority"
/webaccess allow-browser-cookies on                      # enable Chromium cookie extraction
/webaccess allow-browser-cookies off
/webaccess search-model gemini-2.5-flash                 # override the web_search model
/webaccess curator-timeout 45                            # curator idle timeout (seconds, 1–600)
```

Every set runs through validation before writing — unknown providers, bad model patterns, malformed priority lists, and out-of-range timeouts are rejected without touching the file. Writes preserve the existing config and clear the in-memory cache, so the change is visible to providers immediately. Precedence (`env > config > defaults`) is preserved: a value set via env var is shown as `env` and is not overwritten by a `/webaccess set`.

See also: [Configuration](configuration.md) for the full field reference.

## /websearch

Open the search curator directly. Runs searches and lets you review, add, select results, and approve a summary before it is sent back to the agent — no LLM round-trip needed.

```
/websearch                                               # empty page, type your own searches
/websearch react hooks, next.js caching                  # pre-fill with comma-separated queries
```

Results get injected into the conversation when you approve the summary or click "Send selected results without summary". On timeout, the curator auto-submits and falls back to a deterministic summary if no approved draft is present.

## /curator

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

## /search

Browse stored search results interactively. Lists all results from the current session with their response IDs for easy retrieval.

## /google-account

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
