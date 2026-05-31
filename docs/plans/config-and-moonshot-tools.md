# Plan — Extension Config File + Optional Moonshot Tools

Status: implemented on `feat/optional-moonshot-tools`. Tracked separately from `feat/upstream-alignment`.

## Scope

Add a JSON config file that this extension reads from a stable location, and use it to opt-in to two server-side tools exposed by the Kimi Coding endpoint: `moonshot_search` and `moonshot_fetch`. Both tools stay disabled unless the user explicitly enables them.

Out of scope (intentionally): JSONC (comment) support, environment-variable overrides for the new config keys, local HTTP fallback for the fetch tool, migration of existing `KIMI_CODE_*` env vars into the new file, hot reload.

Follow-up implemented in the same branch: `/kimi-settings` shows Kimi usage, edits home/project config, and updates the active tool set for the current session.

## Why now

- The provider already needs more than env vars can comfortably hold (e.g. on/off switches for individual tools, future per-feature tuning).
- `moonshot_search` / `moonshot_fetch` are real endpoints reachable with the OAuth token this provider already manages (see `kimi-cli/src/kimi_cli/auth/platforms.py:55-65`), but they should not auto-activate — users on different stacks (MCP web tools, pi without web needs) should not get them by surprise.

## Config file

Two-tier lookup mirroring `pi-mono/packages/coding-agent/examples/extensions/preset.ts`:

| Tier    | Path                                   | Precedence                  |
| ------- | -------------------------------------- | --------------------------- |
| home    | `~/.pi/pi-provider-kimi-code.json`     | base                        |
| project | `<cwd>/.pi/pi-provider-kimi-code.json` | overrides home (deep merge) |

JSON, not JSONC. Comment support can be revisited in v2.

### Schema (v1)

```json
{
  "tools": {
    "moonshot_search": { "enabled": false, "default_collapsed": true },
    "moonshot_fetch": { "enabled": false, "default_collapsed": true }
  }
}
```

Defaults when keys are missing: `enabled: false` and `default_collapsed: true` for both tools. Missing file is the same as `{}`.

Top-level shape is intentionally flat (`tools` namespace under root) so we can add sibling sections later (e.g. `model`, `upload`, `protocol`) without nesting churn.

### Loader contract

`loadKimiCodeConfig({ cwd, home }): KimiCodeConfig`

- Reads both files if present, ignores either if the file is missing or malformed.
- On malformed JSON: log via `console.error` (matching `preset.ts`), use defaults, do not throw.
- Returns a resolved object with every field defaulted (no `undefined` checks at the call sites).
- Pure given its inputs (takes `cwd` / `home` injection so tests don't touch real filesystem state).

## Tool implementations

Both tools live in a new file (e.g. `tools/moonshot.ts`) or in `index.ts` if the diff stays small; pick at PR time based on file length.

### `moonshot_search`

- typebox params:
  - `query: string` (required)
  - `limit: number` (default 5, clamp 1..20)
  - `include_content: boolean` (default false)
- HTTP: `POST ${baseV1}/search`
  - `baseV1` = the OpenAI-compatible base URL `https://api.kimi.com/coding/v1`, regardless of the active wire protocol; we keep this independent of `KIMI_CODE_PROTOCOL`.
- Headers: `getCommonHeaders()` + `Authorization: Bearer <oauth.access>` + `X-Msh-Tool-Call-Id: <runtime tool call id>`.
- Body: `{ text_query, limit, enable_page_crawling, timeout_seconds: 30 }`.
- Client-side timeout: 180 s (matches upstream).
- Return shape: forward the server's `search_results` array as a structured `ToolResult` (one entry per result with url + title + snippet; include `content` field when `include_content` was true).

### `moonshot_fetch`

- typebox params:
  - `url: string` (required)
- HTTP: `POST ${baseV1}/fetch`, body `{ url }` (confirmed against `kimi-cli/src/kimi_cli/tools/web/fetch.py`).
- No local fallback. If the service returns non-2xx, the tool returns an error result; we do not retry locally or extract text with a 3rd-party library.
- Same headers / auth path as search.

## Authentication

Tools resolve credentials at call time via `AuthStorage.create().get("kimi-coding")`. If no OAuth credential is present:

- Return an error result asking the user to run `/login kimi-coding`.
- Do not fall back to `KIMI_API_KEY` — these endpoints expect Plan subscriber tokens.

## Registration logic

```text
extension entry:
  config = loadKimiCodeConfig({ cwd, home })
  pi.registerProvider(...)                                  // existing
  if (config.tools.moonshot_search.enabled) {
    pi.registerTool(buildMoonshotSearchTool())
  }
  if (config.tools.moonshot_fetch.enabled) {
    pi.registerTool(buildMoonshotFetchTool())
  }
```

When a tool is disabled, do not register it (rather than registering + hiding) — that keeps the agent's available tool set clean for users who have not opted in.

## Tests

All under `tests/`, continuing to use `node:test`. No new devDeps.

| File                                   | What it asserts                                                                                                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/config.test.ts`                 | default when no file; global only; project overrides global; malformed JSON tolerated; only `tools.moonshot_search.enabled` set still produces a full default-shaped object |
| `tests/extension-registration.test.ts` | missing config registers no Moonshot tools; enabled config registers only the selected Moonshot tools                                                                       |
| `tests/moonshot-search.test.ts`        | mock `fetch` to validate URL + body + headers shape; result-shape mapping; missing OAuth returns an error result; collapsed TUI rendering                                   |
| `tests/moonshot-fetch.test.ts`         | same envelope as search; exact body field name confirmed against upstream; non-2xx service responses do not fall back to local fetch; collapsed TUI rendering               |

## Documentation

README gets a new section "Optional Moonshot tools" placed after "Environment variables". It includes:

- One-paragraph description (search + fetch are Kimi Coding server-side tools, not pi built-ins)
- The exact config file path and example JSON
- Behavior notes: requires OAuth login, requires an active Kimi Code Plan, both default off
- Brief comparison with MCP-provided web tools so users don't double up
- Whitelist / subscription caveat for downstream readers who may not be Plan subscribers (the warning belongs in user-facing docs even when it doesn't apply to the author)

`docs/ENV.md` is unchanged for now — the env-var surface is unaffected.

## Branch / PR strategy

Two stacked PRs preferred:

1. **PR A — `feat/extension-config-file`**
   - `loadKimiCodeConfig` implementation
   - JSON schema + defaults
   - `tests/config.test.ts`
   - No tool registration, no README change beyond a single line pointing forward
   - Lands as standalone platform; future config sections (e.g. moving env-vars in v2) build on it.

2. **PR B — `feat/optional-moonshot-tools`** (base = PR A)
   - `tools/moonshot.ts` (or inline)
   - Two tool registrations gated on PR A's loader
   - `tests/moonshot-search.test.ts` + `tests/moonshot-fetch.test.ts`
   - README "Optional Moonshot tools" section

If the diff turns out trivial, the two can collapse into one PR with atomic commits per concern. Decide at draft-PR time.

Branch must base off `main` _after_ `feat/upstream-alignment` is merged. Do not start until then.

## Risks / open questions

- **`moonshot_fetch` body schema**: confirmed against `kimi-cli/src/kimi_cli/tools/web/fetch.py`; upstream service request body is `{ url }`.
- **Tool naming**: `moonshot_search` matches the upstream service name. If we want a more user-facing name (e.g. `kimi_web_search`), align it now to avoid rename later.
- **Tool discoverability**: opt-in by config file is the safest default but reduces discoverability. README notes that these tools are only available after config enables them.
- **MCP overlap**: if the user already has an MCP server providing web search/fetch, enabling these creates two competing tools the model could pick from. The README should explicitly recommend picking one or the other.

## Definition of done

- `pi-provider-kimi-code.json` is read from both tiers; project overrides global.
- With an empty / missing config file, the provider behaves exactly as today (zero new tools registered, no new dependencies, no observable change).
- With `tools.moonshot_search.enabled: true` and a logged-in user, `moonshot_search` is available to the agent and successfully returns results for a simple query.
- Same with `moonshot_fetch`.
- README explains the file and both tools.
- All existing tests still pass, new tests cover the loader and both tools' HTTP shape.
