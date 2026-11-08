# Changelog

## [Unreleased]

### Changed

- Upgraded `@earendil-works/pi-ai` / `pi-coding-agent` / `pi-tui` to `^1.5.0`. This resolves all npm audit findings (undici, minimatch, brace-expansion advisories) and picks up pi's streaming and rendering performance fixes.
- Tool parameter schemas (`moonshot_search`, `moonshot_fetch`, `kimi_datasource`) now use `@earendil-works/pi-schema` builders instead of TypeBox, following pi 1.5.0's migration. The generated JSON Schema is unchanged.

### Security

- Device-code login now rejects verification URLs that are not `http:`/`https:`, mirroring pi 1.5.0's fix for built-in OAuth providers. A malicious or buggy authorization server can no longer hand pi a `file:` or custom-scheme URL to open.

### Added

- The `/kimi-coding` settings dialog now reports pi as blocked on user input (OSC 7501 program status) while it is open, so supporting terminals show the correct waiting state.
- This changelog: pi 1.5.0 shows extension update notes on the next launch after an update.
- The `/kimi-settings` dialog now exposes **Keep thinking** (`model.thinkingKeep`: `default` / `all` / `last` / `none`), controlling the `thinking.keep` value sent to the Kimi API — i.e. how much reasoning history the server retains across turns. The wire and config plumbing already existed; this makes it adjustable without editing JSON.
- `kimi_datasource` now syncs its data-source catalog from the official plugin marketplace (`/coding/v1/plugins/marketplace`) with a lazy 24h disk cache (`~/.kimi-code/kimi-datasource-catalog.json`). The bundled snapshot moves from 12 to 35 sources (adds `china_*`, `who`/`fao`/`oecd`/`fred`, `chembl`/`pubchem`/`pdb`/`uniprot` and other science sources, `dongcai`/`cls`/`finance_research`), `data_source_name` is no longer a closed enum so server-side additions are never rejected by a stale client schema, and unknown names trigger one forced catalog refresh before being rejected with the current source list.
- Model discovery now prefers the unified `/models` schema (`limit.context`, `reasoning.type`/`reasoning.effort.valid`/`default`, `modalities.input`) that the official kimi-code client switched to in #4209, keeping the legacy flat fields (`context_length`, `supports_reasoning`, `think_efforts`, ...) as fallback while the server still sends both.
- Kimi's hard quota exhaustion (HTTP 429 with `exceeded_current_quota_error`) is now rewritten into actionable guidance — it is not a transient rate limit and retries will keep failing — pointing at `/kimi-settings` for usage, mirroring upstream kimi-code #4477/#4703. Plain transient 429s are untouched.
