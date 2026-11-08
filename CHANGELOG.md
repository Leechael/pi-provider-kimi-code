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
