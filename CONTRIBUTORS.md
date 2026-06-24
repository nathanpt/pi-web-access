# Contributors

Pi Web Access is an actively maintained fork of
[`nicobailon/pi-web-access`](https://github.com/nicobailon/pi-web-access). It
would not exist without the original project and the community PRs that have
been merged into this fork — both directly and via the
[cherry-pick-with-attribution](CONTRIBUTING.md#2-cherry-picking-an-outstanding-upstream-pr)
workflow.

> **Adding yourself:** If you contribute a PR that merges, add a row under
> *Contributors* below in the same PR. For cherry-picked upstream work, the
> original author is credited here even though the merge commit carries the
> fork maintainer as committer — full per-commit attribution lives in the git
> history and [`CHANGELOG.md`](CHANGELOG.md).

## Maintainer

| Name | Handle | Role |
| --- | --- | --- |
| Nathan Peet | [@nathanpt](https://github.com/nathanpt) | Fork maintainer. Provider-priority routing, headless `auto-summary` workflow, Parallel provider integration, the subfolder restructure, and all upstream integrations on this fork. |

## Original author

| Name | Handle | Role |
| --- | --- | --- |
| Nico Bailon | [@nicobailon](https://github.com/nicobailon) | Creator of the original `pi-web-access` extension. The bulk of this codebase — the four tools, the curator UI, Gemini Web cookie auth, the search/fetch fallback chains — is his work. |

## Contributors

Alphabetical by surname / handle. Each entry's contribution is included in
this fork (either merged directly or cherry-picked with attribution).

| Name | Handle | Contribution |
| --- | --- | --- |
| Dan Buch | [@meatballhat](https://github.com/meatballhat) | Configurable Gemini base URL + Cloudflare AI Gateway auth (#76). |
| Erik Garrison | [@ekg](https://github.com/ekg) | Curator timeout hang fix — finalized idle sessions once the timeout elapses (#98). |
| Andrea Arturo Venti Fuentes | [@av1155](https://github.com/av1155) | `@mozilla/readability` ReDoS security fix (#68). |
| Ben Marshall | [@benjmarshall](https://github.com/benjmarshall) | SSRF protection for URL fetching (#81). |
| Boris Naidis | [@borisnaidis](https://github.com/borisnaidis) | Gemini Web empty-stream-chunk fix (#54). |
| Hrand Liu | [@phoenix_vio](https://github.com/phoenix_vio) | XDG config path resolution (#89). |
| Ryan Heath | — | `lastIndexOf` summary-model resolution for URL-based model ids (#90). |
| lajarre | [@lajarre](https://github.com/lajarre) | Node 22 PDF extraction support. |
| redshift | [@sh1ftred](https://github.com/sh1ftred) | Configurable default summary model (`summaryModel` config). |
| Whamp | [@Whamp](https://github.com/Whamp) | Active-account detection in `/google-account` (#40). |
| Haoze Wu | [@waithz](https://github.com/waithz) | `fetch_content` parameter normalization (#88). |

## Acknowledgements

- Everyone who has opened an issue or PR against the original
  [`nicobailon/pi-web-access`](https://github.com/nicobailon/pi-web-access) —
  the audit of those 31 open PRs is what surfaced the gems above.
- The [Pi](https://github.com/earendil-works/pi) project, whose extension API
  this builds on.

## License

All contributions are made under the project's [MIT License](LICENSE).
