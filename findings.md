# Regeneration reuse findings

## Requested bug review — fixed findings

Assumed use: one browser running Fish Memory, with asynchronous host updates and optional concurrent maintenance.

- A connection with a blank model ID could replace a working saved connection, then disappear on reload because stored profiles require a model. Validation now rejects it before switching or saving.
- Editing the API base URL left the previous server's model dropdown enabled until a render. The dropdown now disables immediately for a different endpoint.
- Appending API routes to a complete URL put the route inside its query or fragment. Routes now append to the parsed pathname, preserve query parameters, and discard fragments.
- A cancelled model-list body read could return a late valid list; a stalled request also left the UI busy indefinitely. Cancellation is checked after body parsing and the controller enforces a 15-second deadline around the whole operation, including non-cooperative requests.
- A memory scope change during the final native connection signature read could install the old scope plan. The memory revision and enabled-state checks now follow that await.
- Scope, input, settings, or one-shot refresh changes during history-window application could also install a stale plan. Final synchronous validation runs immediately before installation, excluding expected hidden-state changes made by the window operation. Disabling memory restores native flow instead of installing the old Fish plan.

New targeted regressions reproduce the failure cases. Final full suite: 1,008 passed, 2 environment-dependent skips, no failures. Syntax/entry and install-build checks passed. The earlier performance measurements below precede this review's final validation guards; they were not remeasured during the bug review. Live authenticated OpenRouter generation and SillyTavern interaction remain untested.

## OpenRouter follow-up findings

- Existing separate connections already provided bearer authentication, model listing, local persistence and streaming. Added a named UI preset using `https://openrouter.ai/api/v1`, storing the same `compatible` connection format.
- Only the exact official HTTPS origin enables OpenRouter-specific reasoning/output parameters. Model IDs keep their provider namespace. Similar-looking hosts and custom gateways retain generic transport behavior; provider settings inherited from SillyTavern continue through its parameter builder.
- Protocol references: [Chat Completions](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion), [reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens), [errors](https://openrouter.ai/docs/api_reference/errors-and-debugging). OpenRouter uses `reasoning.effort`; explicit output limits use `max_completion_tokens`, while blank limits remain omitted.
- Choice-level errors can accompany partial JSON in HTTP-200 responses; regular and streaming transports now reject these before accepting content. Existing sanitized auth, credit and rate-limit errors are reused. Public model-list retrieval is not proof of valid credentials.
- Independent review found API keys needed the same diagnostic echo redaction as custom headers. Both configured and model-list draft keys are now registered; regression tests verify views, exports and echoed responses exclude them.
- Validation: 998 passed / 2 environment-dependent skips / 0 failures; 187-file syntax/entry check and 75-file install build passed. Live public model listing succeeded without a key (476 IDs at validation time). No authenticated generation or live SillyTavern test was performed.

Date: 2026-11-22 (America/Los_Angeles)
Baseline: `75a523f` (`release: 1.1.6`)

## Confirmed baseline behavior

- `src/core/state.js` defaults to `rerollSelection: 'reuse'` and `maintenanceKeepRecent: 1`.
- `src/runtime/selection-reuse.js` already caches the last successful selection. It normalizes the current draft and stored player message into the same user turn.
- `Controller.#buildPlan` checks that cache after loading rules, projecting memory, applying gates, preparing recent messages, optionally reading MVU, and calculating selection fingerprints.
- `Controller.#withSelection` displays a selecting label before the reuse decision is known.
- The current-turn reuse copy also says input and memory did not change, although the resolver permits some automatic maintenance; that explanation should describe ID reuse without promising identical memory text.
- `Controller.#buildPlan` calls `#assertSourceCurrent` after selecting or reusing; that reads rules/source data again before accepting the result.
- `Controller.messageSwiped()` explicitly invalidates selection reuse. The adapter distinguishes selecting an existing candidate from requesting an unfilled swipe.
- `generationSnapshot` excludes the assistant reply being replaced; projected memory must likewise exclude its facts.
- Automatic maintenance of already-read history can preserve selection reuse. Manual edits and newly exposed history invalidate it.
- The existing `selectionSource` diagnostic and the current-turn UI already distinguish `fresh` from `reused`; no new diagnostics subsystem is needed.

## Evidence and limitations

The preceding investigation ran `node --test --test-reporter=spec test/selection-reuse.test.js test/host-lifecycle.test.js test/reroll.test.js`: 55 tests passed, 0 failed. These are controlled tests, not a live latency measurement. The user's actual delay and any live cache miss remain unconfirmed.

## Integration map

| Area | Existing code | Consequence for implementation |
| --- | --- | --- |
| Selection cache | `src/runtime/selection-reuse.js`: `selectionFrame`, `selectionReuseKey`, `SelectionReuse.resolve/stage/commit` | Extend the single-entry cache and preserve commit-after-acceptance behavior. |
| Send orchestration | `src/runtime/controller.js`: `#withSelection`, `#loadRules`, `#buildPlan`, `#generationBefore` | Measure the actual stages before removing repeated derived work. |
| Prompt data | `src/runtime/prompt-plan.js`: `assemblePromptPlan` | A reusable payload must match the current effective entries, summary, inventory, scope, gates, and mandatory selections. |
| Branch correctness | `src/adapters/sillytavern.js`: `captureReplacement`, `generationSnapshot`; `src/core/store.js`: `project` | A reply being replaced is absent from both the selection input and projected narrative memory. |
| Candidate switches | Adapter `MESSAGE_SWIPED` listener; controller `messageSwiped` and `#storyChanged` | Preserve reconciliation and cancellation even when retaining a candidate cache entry for later validation. |
| Current-turn diagnostics | Controller `#recordPlan`; `src/ui/panel.js`: `renderRound` / `renderPlan` | Add bounded reason/timing metadata and clear user-facing copy to the current surfaces. |
| Problem exports | `src/diagnostics/problem-export.js` exports `controller.diagnostics.lastPlan` | Add diagnostics without exposing connection signatures or duplicating story text. Failed attempts need a separate bounded record because no plan is installed. |
| Host connection input | Adapter `selectionContextSignature` serializes native settings when using the native connection, plus character/user names | Keep this value private. Narrowing its invalidation is a separate change requiring evidence of which settings affect auxiliary requests. |
| History omission | Controller `planWindow` and adapter `filterOutgoingHistory` | Recompute against current message identities and verify native timed worldbook effects for every request. |
| Packaging | `scripts/build.mjs` uses explicit runtime/player/source inventories | Planning files are excluded from distributions. If implementation adds a runtime file, update the inventory and build test. |

## Design constraints

- A hit must remain scoped to the current chat/save, normalized user turn, preceding branch, effective memory, and auxiliary inputs. Identical text in a later user turn is a different request.
- The existing selection cache can accept automatic maintenance/compaction of material the selector already saw. Its safeguards must remain; a whole-prompt cache must be stricter.
- `MemoryStore.project` returns a clone for a compatible prefix or replays the journal on a prospective branch. A saved revision alone does not identify the correct projected branch.
- Source data is read both before selection and when validating its result. The second check protects against edits during asynchronous work; it must not be removed solely because no model call occurred.
- Reuse prepared Fish payload data only. Allocate fresh request IDs and observations; do not replay native prompt bodies, trace registrations, history omission actions, abort signals, or locks.
- Browsing an existing candidate and generating an unfilled swipe are different adapter paths. Optimize the former without weakening the latter's existing lifecycle handling.
- `#storyChanged` can cancel work, reconcile storage, restore history coverage, and resume eligible maintenance. Retaining a cache candidate must not bypass any of those behaviors.
- Successful plan diagnostics do not capture a failed/cancelled selection attempt. The initial observability change needs one bounded attempt record that survives failure and is cleared on chat change.
- Connection request metrics already record provider duration. Preparation timing should complement those metrics rather than introduce a second request log.
- `SelectionReuse.resolve` has one production call site in `Controller.#buildPlan`; update its result contract and that caller together. The UI exposes the outcome through `Controller.view().selectionReuse` and plan diagnostics.

## Measurements and live follow-up

1. Whether the reported delay is a fresh auxiliary call, source loading, branch projection, fingerprinting, rendering, or native generation.
2. Which invalidation reason occurs during the user's repeated regenerations.
3. Payload-copy cost was measured below; live impact still depends on book shape, rules, and host.
4. How the optimized path behaves with a real card/template and host event ordering. Unit tests cover simulated ordering only.

## Implementation observations

- Phase 1 tests pass (98 tests). A cache hit now skips the selecting label; failed attempts have their own bounded diagnostic record instead of relying on the last installed plan.
- Source checking canonicalizes entry metadata repeatedly. Native switches are deliberately excluded from source-change errors, so final preparation must separately verify switch/raw-rule changes during asynchronous work.
- `inventoryDisabledAt` lives outside `save.data`; prepared-payload validity must include it even when the selection key matches.

## Final implementation and verification

- The single current-turn selection cache now also retains one isolated Fish payload. Exact hits reapply it with a fresh request ID; compatible automatic maintenance reuses selected IDs but assembles current text. The cache is published only after successful host installation.
- Latest-reply browsing retains a candidate for validation. An adapter-level test browses A/B after a remembered reply, then regenerates without another selector call and without injecting discarded facts. Earlier/unknown swipes and deletions still invalidate.
- Live source inputs and the baseline fields used by source comparison are serialized and compared before reusing derived comparisons. Rule compilation is reused only for an identical script. Source reads, branch projection, history-window actions, and final freshness checks still run.
- Current-chat diagnostics record reason, stage times, and success/failure/cancellation/native outcome without storing private connection signatures. The current-turn UI and existing problem export expose them.
- Full suite: 988 tests, 986 passed, 0 failed, 2 skipped. Final selection-suite rerun after strengthening its async waits: 34 passed. Syntax/entry checks: 186 files. Candidate install build: 75 files at `.local/build/st-dynamic-world-memory`, version remains 1.1.6.
- Windows skips: creating a file symbolic link requires Developer Mode/elevated privileges; archive verification requires zip/unzip. Directory-junction output protection is tested successfully. No production build protection was relaxed.

## Final controlled performance comparison

Environment: Windows, Node v24.9.0. Baseline is the Phase 1 instrumented source before optimization, retained at `.local/regeneration-before-2026-11-22`. Both versions use the same no-network host, settings, source text, and controlled selector response. Each fixture runs an initial send, 5 warmup rerolls, and 30 measured rerolls. Small: 20 source entries and 25 messages; large: 300 entries and 121 messages. Each source entry contains roughly 1.3 KB of text. Live native generation, provider latency, and real UI rendering are excluded.

| Fixture | Baseline median / p95 | Final median / p95 | Source-check stage median, before → after |
| --- | --- | --- | --- |
| 20 entries / 25 messages | 2.96 / 4.33 ms | 1.80 / 2.25 ms | 1.48 → 0.44 ms |
| 300 entries / 121 messages | 35.68 / 38.31 ms | 19.18 / 21.31 ms | 19.95 → 5.02 ms |

| Work count, per fixture | Baseline | Final |
| --- | --- | --- |
| Selector calls including the first send | 1 | 1 |
| Live source reads including startup/warmup | 73 | 73 |
| Derived source comparisons during 30 measured rerolls | 60 | 0 |
| Prompt assemblies during 30 measured rerolls | 30 | 0 |
| Prepared-payload hits during 30 measured rerolls | 0 | 30 |

Most savings come from avoiding repeated canonical source comparison, with shared fingerprint framing and reuse of the accepted snapshot also reducing work. Payload copying is a small part: median assembly/copy stage was 0.12 → 0.10 ms for the small fixture and 1.43 → 1.42 ms for the large fixture. Copying the entire large payload in one structured-clone call was initially slower than assembly; copying entries separately preserves isolation and avoids that regression. An alternating 200-sample microcheck measured large-fixture medians of 1.26 ms for assembly, 1.34 ms for one full clone, and 1.16 ms for separate entry copies. This is local measurement evidence, not a guaranteed speedup on other devices.

Reproduction artifacts are local and ignored by Git: `.local/benchmark-regeneration.mjs`, `.local/benchmark-payload.mjs`, `.local/regeneration-measure-before-2026-11-22`, `.local/regeneration-measure-after-2026-11-22`, and `.local/regeneration-benchmark-{before,after}.jsonl`. The measurement copies add only a counter inside `sourceBookChanges`; production code has no benchmark counters.

No live SillyTavern session was available. The host/template/provider scenario in Phase 4 remains pending; simulated adapter event tests do not certify a live integration or explain the user's exact original delay.

## Recovery check

The planning skill's `session-catchup.py` exited successfully with no report. No prior planning files were found; the current chat and repository are the planning baseline.
