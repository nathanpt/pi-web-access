# Commands & Activity Monitor

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
