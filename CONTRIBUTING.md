# Contributing to pi-web-access

First: **thank you**. This is an actively maintained fork of
[`nicobailon/pi-web-access`](https://github.com/nicobailon/pi-web-access),
whose upstream is no longer maintained. **Contributions belong here, not
upstream** — upstream PRs go unactioned, while this fork has green CI and is
actively merging the best of those outstanding PRs. See the README's
[Maintenance & Fork Status](README.md#maintenance--fork-status) section for the
full background.

This document covers **how** to contribute. It mirrors the workflow this fork
already uses, so you know exactly what to expect.

## The two contribution paths

### 1. New fixes and features

Open a pull request against **`main`** on this fork
(`nathanpt/pi-web-access`). Follow the development setup and conventions below.
Keep PRs focused and well-described; CI must be green before merge.

### 2. Cherry-picking an outstanding upstream PR

This is the most common path — the fork is systematically reviewing and merging
the 30+ open upstream PRs. **You do not need to rebase an upstream PR yourself**,
but you're welcome to. The maintainer's established process (used for every
merged upstream PR so far) is:

1. **Cherry-pick** the upstream commits onto a fresh branch off `main`.
2. **Resolve conflicts** against the fork's diverged tree (the provider layer,
   `index.ts`, `gemini-search.ts`, `README.md`, and `package.json` are hot
   files — expect hand-rebases).
3. **Preserve attribution.** The original author stays as the commit's *author*;
   the maintainer is the *committer*. The commit body cites the upstream PR
   number and author. We never claim someone else's work.
4. **CI gate.** Push the branch, open a PR, and wait for green.
5. **Open a PR**; once CI is green, the maintainer merges it (as a merge
   commit, so the original author's commits stay attributed).

If you have an open PR on upstream, the fastest way to see it land here is to
**open an issue** on this fork linking to it with a one-line "why this matters."
That surfaces it for triage in the [upstream audit](docs/) (a local working
document).

## Development setup

```bash
git clone git@github.com:nathanpt/pi-web-access.git
cd pi-web-access
npm install          # installs devDependencies (tsx); runtime deps are small
npm test             # node --import tsx --test  (Node 22+)
```

Then load the extension into Pi from the repo directory (picks up your edits
each run):

```bash
pi -e .
```

> **Do not** install via `pi install npm:pi-web-access` — that pulls the
> original, unmaintained upstream package. This fork is not (yet) on npm.

### No build step

TypeScript is loaded **directly** by the Pi host at runtime — there is no
compile step and no emitted output. Edit the `.ts` files in place. The only
build-time tooling is `tsx`, used solely so the test runner can import `.ts`.

### Node version

**Node 22** is the target. PDF extraction and one of the guard tests rely on it.
The CI matrix is intentionally a single version (`22`) to keep signal high.

## Testing

Tests use the **Node built-in test runner** (`node:test`) with
`node:assert/strict`, written as **ESM `.mjs` files** in `test/`. Run them all:

```bash
npm test
```

Run a single file while iterating:

```bash
node --import tsx --test test/parallel.test.mjs
```

### Conventions

- **Import `.ts` source under `--import tsx`.** Plain `node` has no TypeScript
  loader (Pi registers one at runtime). Every test that needs the real source
  imports it under tsx — either directly (`import { … } from "../workflow.ts"`)
  or by spawning a child with `--import tsx` for isolation. See
  `test/pdf-extract.test.mjs`, `test/gemini-web-cookie-opt-in.test.mjs`, and
  `test/parallel.test.mjs` for the patterns.
- **Prefer testing the shipped code.** When feasible, exercise the actual export
  rather than re-implementing the logic under test — that way the test is a
  regression guard, not a mirror that drifts. (A couple of legacy tests duplicate
  code instead of importing it; new tests should not.)
- **Isolate state.** Anything that reads `~/.pi/web-search.json` or environment
  variables should run in a spawned child with a temp `HOME` and a scrubbed
  environment, so tests don't depend on or mutate the developer's real config.
- **Mind the clock.** Anything time-based (timeouts, recency filters) should use
  generous CI budgets — GitHub Actions runners are slower than a laptop. Past
  example: a 5s watchdog interval needed a 20s test budget.

## Design principles to preserve

When changing code, respect the patterns that make this extension reliable:

- **Fallback chains are the core design.** Every capability checks provider
  availability and falls through gracefully. When adding or editing a provider,
  preserve the chain and the `isXAvailable()` checks — something should always
  work.
- **`parallel` is opt-in only.** It is never added to auto-selection or default
  fallback ordering; it must be requested explicitly with `provider: "parallel"`.
- **Browser cookie access is off by default** (`allowBrowserCookies` /
  `PI_ALLOW_BROWSER_COOKIES=1`). Never enable it implicitly — it triggers macOS
  Keychain prompts.
- **Config precedence:** env vars override `~/.pi/web-search.json`, which
  overrides defaults. A provider's availability check must respect both sources.
- **External binaries degrade gracefully.** `ffmpeg`, `yt-dlp`, and `gh` are
  detected at runtime; missing them should never crash a path that doesn't need
  them.
- **Rate limits are enforced.** Perplexity is capped at 10 req/min; content
  fetches run 3 concurrent with a 30s per-URL timeout (`p-limit`).

## Commit and PR conventions

- **Write clear commit messages.** Conventional Commits prefixes (`fix:`,
  `feat:`, `test:`, `docs:`, `chore(deps):`) are used but not strictly enforced.
  Match the style of recent `main` history.
- **Keep PRs focused.** One concern per PR makes review and revert easier. If a
  cherry-pick bundles unrelated changes, the maintainer may split them across
  PRs (the readability ReDoS fix, for example, was extracted from a larger
  deps+namespace PR).
- **Attribution is non-negotiable for upstream work.** If your PR ports or
  adapts someone else's code, say so in the commit body and PR description, and
  keep the original author attributed where the commits are crafted. For
  original work authored entirely by you, standard attribution applies. PRs are
  merged as merge commits (not squashed), so commits and attribution are
  preserved in history.

## Reporting bugs and requesting features

Open an issue on **this fork**. For anything related to an upstream PR, link to
it directly so it can be triaged against the local audit. Screenshots, the exact
`pi` command or tool invocation that triggered the problem, and your
`~/.pi/web-search.json` (with secrets redacted) all help.

## License

By contributing, you agree your contributions are licensed under the project's
[MIT license](LICENSE).
