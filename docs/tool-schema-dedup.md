# Tool Schema Dedup

Moonshot (Kimi) API rejects any single tool whose `function.parameters` serializes to more than ~15 KB. The provider applies `$defs`/`$ref` deduplication to stay under this limit.

## Problem

Pi extensions register tools with JSON Schema `parameters`. Most schemas are small (< 3 KB), but `pi-subagents`' `subagent` tool is 23.8 KB because it repeats the `acceptance` sub-schema 5 times (~10 KB of duplication). Moonshot returns 400 for any request containing this tool.

Related issues: #16, #21 (resolved in PR #25).

## Solution

`src/schema-dedup.ts` implements a multi-pass fragment extractor:

1. Scans `function.parameters` for sub-objects >= 50 bytes that appear >= 2 times.
2. Sorts candidates by size (largest first), skips paths already inside a replaced subtree.
3. Computes exact net savings: `(count * fragmentSize) - (fragmentSize + defsEntryOverhead + count * refSize)`. Extracts only when savings > 0.
4. Moves the fragment into `$defs` and replaces occurrences with `{ "$ref": "#/$defs/dN" }`.
5. Repeats up to 5 passes (newly exposed duplicates after large-block extraction).
6. Final guard: returns the original schema if the result is not smaller.

The dedup runs in `applyKimiPayloadMutations` after `normalizeOpenAIToolSchemas`, triggered when a tool's `function.parameters` exceeds 14,000 bytes. Results are cached by a SHA-256 fingerprint of the full tools array (custom recursive hasher, not `JSON.stringify`, to handle non-serializable values).

## Moonshot API Limits

Determined by systematic probing (`scripts/kimi-compat/find_size_limit.mjs` and related scripts):

| Dimension                      | Limit                             | Verification                             |
| ------------------------------ | --------------------------------- | ---------------------------------------- |
| Per-tool `function.parameters` | ~15,000 bytes (literal JSON)      | Binary search on synthetic schemas       |
| Total tools payload            | No limit observed (146 KB passed) | 5-tool payload with large schemas        |
| `function.description`         | No limit observed (50 KB passed)  | Single tool with padded description      |
| `$ref` expansion               | Not expanded before size check    | Deduped 24 KB schema accepted as 13.7 KB |
| `$ref` nesting                 | Supported (refs inside `$defs`)   | Nested and recursive self-refs both OK   |

## Eval Corpus

58 tools harvested from the top 16 Pi extensions (by GitHub stars) that register at least one tool. Harvested using `scripts/kimi-compat/harvest_ext_tools.mjs` with a mock `ExtensionAPI`.

| Extension                          | Stars | Tools                                      | Largest (bytes) |
| ---------------------------------- | ----- | ------------------------------------------ | --------------- |
| @ff-labs/pi-fff                    | 8,994 | ffgrep, fffind                             | 1,340           |
| @plannotator/pi-extension          | 6,326 | plannotator_submit_plan                    | 216             |
| gentle-engram                      | 4,496 | 19 memory tools                            | 646             |
| pi-lean-ctx                        | 2,775 | 6 context tools                            | 753             |
| pi-subagents                       | 2,244 | subagent                                   | 23,803          |
| pi-mcp-adapter                     | 897   | mcp                                        | 886             |
| pi-web-access                      | 662   | 4 web tools                                | 1,638           |
| @tintinweb/pi-subagents            | 487   | Agent, get_subagent_result, steer_subagent | 2,022           |
| @juicesharp/rpiv-web-tools         | 405   | web_search, web_fetch                      | 292             |
| @juicesharp/rpiv-todo              | 405   | todo                                       | 1,401           |
| @juicesharp/rpiv-ask-user-question | 405   | ask_user_question                          | 2,039           |
| @juicesharp/rpiv-advisor           | 405   | advisor                                    | 33              |
| pi-cursor-sdk                      | 194   | cursor_ask_question, cursor_activate_skill | 2,384           |
| pi-lens                            | 187   | 6 LSP/linter tools                         | 3,010           |
| pi-studio                          | 170   | 4 REPL/export tools                        | 2,471           |
| pi-hermes-memory                   | 145   | 4 memory tools                             | 1,797           |

Extensions that were evaluated but register zero tools (command/renderer/hook only): context-mode (17,738 stars), cc-safety-net (1,403), @a5c-ai/babysitter-pi (1,363), glimpseui (890), @aliou/pi-guardrails (188), @juicesharp/rpiv-workflow (405), @juicesharp/rpiv-voice (405), pi-powerline-footer (305), pi-rtk-optimizer (172).

## Results

| Source              | Tool                | Raw (bytes) | Normalized (bytes) | Status           |
| ------------------- | ------------------- | ----------- | ------------------ | ---------------- |
| pi-subagents        | subagent            | 23,803      | 13,706             | Fixed (was OVER) |
| pi-lens             | lsp_navigation      | 3,010       | 3,010              | OK               |
| pi-lens             | ast_grep_search     | 2,660       | 2,660              | OK               |
| pi-studio           | studio_export_pdf   | 2,471       | 2,471              | OK               |
| pi-cursor-sdk       | cursor_ask_question | 2,384       | 2,384              | OK               |
| rpiv-ask-user       | ask_user_question   | 2,039       | 2,039              | OK               |
| tintinweb-subagents | Agent               | 2,022       | 2,022              | OK               |
| pi-hermes-memory    | skill_manage        | 1,797       | 1,797              | OK               |
| pi-web-access       | fetch_content       | 1,638       | 1,638              | OK               |
| pi-lens             | ast_grep_replace    | 1,466       | 1,466              | OK               |

All other 48 tools are under 1,500 bytes and pass through unchanged. Only `pi-subagents/subagent` exceeds the 15 KB limit and requires dedup.

The dedup reduces `subagent` from 23,803 to 13,706 bytes (42% reduction) by extracting 3 repeated fragments into `$defs`. Moonshot accepts the deduped schema (verified with live API calls).

## Scripts Reference

All scripts are in `scripts/kimi-compat/`:

| Script                  | Purpose                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `harvest_ext_tools.mjs` | Headless tool-schema harvester: loads Pi extensions via mock ExtensionAPI, records `registerTool()` payloads |
| `test_ext_compat.mjs`   | Per-tool raw vs normalized size report; live Kimi REJECT/OK when `KIMI_API_KEY` is set                       |
| `find_size_limit.mjs`   | Binary search for Moonshot's per-tool `function.parameters` byte limit                                       |
| `find_total_limit.mjs`  | Probe for total tools payload size limit                                                                     |
| `test_ref_support.mjs`  | Verify Moonshot supports `$defs`/`$ref` in tool schemas                                                      |
| `test_ref_nested.mjs`   | Verify nested and recursive `$ref` support                                                                   |
| `test_ref_expand.mjs`   | Verify Moonshot does not expand `$ref` before checking size                                                  |
| `test_desc_limit.mjs`   | Probe `function.description` size limit                                                                      |
| `test_ref_dedup.mjs`    | End-to-end dedup prototype: dedup captured schema and send to Kimi                                           |
| `capture_proxy.mjs`     | MITM proxy to capture Pi-to-Kimi request payloads                                                            |
| `dump_raw_request.mjs`  | Dump raw HTTP request body from a capture file                                                               |
| `inspect_captures.mjs`  | Summarize captured request files (tool count, sizes)                                                         |
| `replay_capture.mjs`    | Replay a captured request body against Kimi API                                                              |

Corpus data: `scripts/kimi-compat/corpus/all-tools.json` (58 tools, generated by `harvest_ext_tools.mjs`).
