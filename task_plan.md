# Regeneration reuse implementation plan

## Follow-up — Requested bug review

Complete. Reproduced and fixed connection validation/UI issues, URL joining with query/fragment components, model-list timeout/cancellation, and stale preparation across final connection/history-window awaits. Added regression tests, including scope/input/settings/refresh/pause changes before installation. Final suite: 1,008 passed, 2 environment-dependent skips, 0 failures. Syntax/entry checks (187 files), install build (75 files), and diff whitespace check passed. Live authenticated provider and SillyTavern validation remain unavailable.

## Follow-up — OpenRouter integration

Complete: OpenRouter preset added to the existing separate-connection form; official-origin request parameters adapted inside the compatible transport; model discovery, generation/streaming protocol, credential isolation, persistence and inherited host routing covered by tests; setup documented. Final full suite: 998 passed, 2 environment-dependent skips, no failures; syntax/entry checks passed for 187 files and the 75-file install build succeeded. A live unauthenticated public model-list request returned 476 models. Authenticated generation and live SillyTavern validation remain untested. Existing regeneration work remains intact.

Date: 2026-11-22 (America/Los_Angeles)
Baseline: `75a523f` (`release: 1.1.6`)

## Goal and scope

Reduce Fish Memory's repeated preparation and unnecessary auxiliary selection calls when regenerating the same user turn. Preserve current branch reconciliation, source checks, cancellation, prompt contents, and memory correctness.

The user has requested implementation. This plan extends the existing `SelectionReuse` mechanism; it does not introduce another cache service or change the save schema.

## Current phase

Implementation and local verification are complete. Phases 1–3 and Phase 4's automated tests, build, performance comparison, and documentation are done. Live integration validation remains pending because no SillyTavern session is available in this environment.

## Target behavior

| Situation | Selection | Fish prompt preparation |
| --- | --- | --- |
| First send for a new user turn | Call the auxiliary selector | Assemble from current validated memory |
| Regenerate the same turn with unchanged inputs | Reuse selected IDs | Reuse validated prepared payload where available |
| Automatic maintenance only reorganized material the selector already read | Keep the existing resolver's guarded ID reuse | Reassemble changed summary, inventory, and entry text |
| Browse an existing latest-reply candidate, then regenerate the same preceding turn | Retain the previous selection as a candidate; validate against the projected branch | Reuse only if payload dependencies still match |
| Earlier history, source, scope, manual memory, or auxiliary inputs changed | Re-evaluate; select again when the existing validity contract requires it | Assemble current content |
| One-shot refresh or `refresh` mode | Call the selector | Assemble and replace the accepted cache entry |
| `ask` mode on a qualifying player reroll | Preserve the existing reuse/refresh choice | Apply the same validation after the choice |
| Missing cache, reload, or chat switch | Use normal preparation | Build a new current-chat cache entry |

Each regeneration still requests a new answer from SillyTavern's main model. These changes address Fish's preparation and auxiliary calls.

## Phase 1 — Explain and measure reuse

Status: complete

Deliverable: one change exposing the actual reuse decision and preparation cost without changing cache eligibility.

- Extend `SelectionReuse.resolve` to report a bounded hit/miss reason as part of the same evaluation. Update its controller caller together; do not run validation twice just to explain a miss.
- Distinguish exact reuse, compatible automatic maintenance, no cached selection, explicit refresh, changed turn/history, changed eligibility, changed memory, and changed auxiliary/source inputs. Use a generic changed-input reason where a finer attribution would require expensive or sensitive diffs.
- Preserve `selectionSource: 'fresh' | 'reused'`. Add reason and stage timing metadata to existing diagnostics. Keep one current-chat `lastPreparation` record for success, failure, cancellation, or native bypass; an unsuccessful attempt must not look like the previous successful `lastPlan`.
- Measure waiting for the store, reading/validating sources, projecting memory, building fingerprints, resolving selection, the auxiliary call, assembling the plan, applying the history window, and total preparation. Account for both source checks; do not include native model generation in Fish preparation time.
- Start activity copy with "Preparing this turn's memories". Show "Selecting memories" only when the auxiliary selector runs, and "Reusing this turn's memories" for a hit. Keep detailed reasons/timings in the current-turn/diagnostic view rather than adding a modal.
- Update the existing reuse explanation so it does not claim memory text is unchanged when compatible automatic maintenance has changed it.
- Export the bounded attempt metadata through the existing problem exporter. Keep raw fingerprints, native connection settings, keys, and duplicated story text out of new fields.

Primary files: `src/runtime/selection-reuse.js`, `src/runtime/controller.js`, `src/ui/panel.js`, `src/diagnostics/problem-export.js`.

Tests: extend `test/selection-reuse.test.js`, `test/activity-runtime.test.js`, `test/economy-ui.test.js`, and `test/problem-export.test.js` for decisions, copy, failed attempts, and export boundaries.

Acceptance: an unchanged reroll reports reuse with zero new selector calls; an intentional miss gives a useful reason; failed/stopped sends retain correct attempt diagnostics; diagnostics never enter auxiliary prompts or saved memory. Capture baseline stage timings before Phase 2.

## Phase 2 — Reuse unchanged preparation

Status: complete

Deliverable: a bounded fast path inside the existing send preparation and cache lifecycle.

- Share the normalized turn frame and serialized fingerprint inputs within one preparation. Cache compiled rules/derived source comparisons only while the verified source input and relevant baseline are unchanged. Use Phase 1 timings to prioritize the repeated work.
- Keep live source reads/validation at the existing correctness boundaries. Do not assume that absent host update events prove a worldbook is unchanged; third-party tools can modify it.
- Extend the existing single-entry cache with at most one prepared Fish payload. Cache the reusable data from `assemblePromptPlan`, not the whole native request or a second copy of the full save/journal.
- Permit a prepared-payload hit only after selection validity and current dependencies are established: save/chat identity, normalized preceding branch and player text, effective projected memory, selected/mandatory/triggered/gated IDs, enabled entries, source metadata, scope, inventory state, rules, preset application/preferences, regex projection, observed MVU state, and relevant settings/connection identity.
- Do not treat a save revision as sufficient proof: the same saved state can project onto different branches. A changed revision may conservatively require reassembly; no new global revision system is needed.
- On an exact valid hit, clone/reapply the payload. On compatible ID reuse with changed memory, run `assemblePromptPlan` against current projected data without calling the selector again.
- Generate a fresh request ID and observation state every time. Recompute history-window actions from current message identities and coverage. Keep native timed-worldbook checks, current-run ownership, cancellation, and final freshness checks.
- Stage new reusable data and publish it only after `host.setPlan` succeeds, matching the existing `stage/commit` contract. Preview, cancellation, failure, or a late result cannot replace the accepted cache or consume a one-shot refresh.
- Retain current `reuse`, `refresh`, and `ask` behavior. After a delayed ask response, revalidate changes before accepting reuse.
- Keep cache state in page memory, clear it on chat change/reinitialization as appropriate, and store no provider credentials in payloads.

Primary files: `src/runtime/selection-reuse.js`, `src/runtime/controller.js`, `src/runtime/prompt-plan.js`; touch the adapter only where current source/identity checks require it.

Tests: extend `test/selection-reuse.test.js`, `test/host-lifecycle.test.js`, `test/runtime.test.js`, `test/source-book.test.js`, and `test/window-lifecycle.test.js`. Add focused assertions for fresh request IDs, payload isolation, source edits during preparation, and history coverage.

Acceptance: repeated unchanged rerolls add zero selector calls and avoid the identified repeated assembly/derived work. Compare normalized outgoing Fish content with normal assembly; only request metadata/timings may differ. If storing a prepared payload costs more than it avoids, retain the measured derived-work improvements and document omitting that cache rather than shipping an unproven optimization.

## Phase 3 — Retain valid selections across latest-reply browsing

Status: complete

Deliverable: switching existing candidates for the latest reply no longer unconditionally discards an otherwise valid selection.

- Pass/use the existing swipe index and normalized turn identity to distinguish latest-reply browsing from changing an earlier branch. Retain at most the current-turn selection as an untrusted candidate for later validation.
- Continue running `#storyChanged`, cancellation, reconciliation, rollback, history-window synchronization, and eligible maintenance. Remove only the unconditional cache eviction for the precisely identified latest-reply case.
- When the next generation begins, compare against `generationSnapshot` and the projected memory before the reply being replaced. Reject reuse if reconciliation, manual changes, scopes, source updates, or earlier history changed the effective inputs.
- Preserve full invalidation for ordinary message deletion, swipe deletion, an earlier candidate change, chat change, or uncertain identity. Keep the existing special handling of the native tail deletion during regeneration.
- Treat an unfilled swipe as generation, not browsing. Retain existing adapter ownership checks and stop/failure restoration behavior.
- Replace the existing broad "switching an existing candidate invalidates reuse" test with separate same-turn-hit and changed-branch-miss cases. Prove the retained candidate cannot leak a discarded reply's facts; do not merely relax the old assertion.

Primary files: `src/adapters/sillytavern.js`, `src/runtime/controller.js`, `src/runtime/selection-reuse.js`.

Tests: extend `test/selection-reuse.test.js`, `test/reroll.test.js`, `test/candidate-identity.test.js`, and `test/deletion-rollback.test.js` with real adapter event sequences.

Acceptance: first send, generate alternatives, browse A/B, then regenerate the same unchanged user turn requires no additional selection solely because of browsing. Changing an earlier reply or effective memory still rejects stale reuse. Correct rollback/history restoration holds even if manual maintenance previously included the replaced answer.

## Phase 4 — Verify behavior, performance, and user documentation

Status: local verification complete; live integration pending (no available SillyTavern session)

Deliverable: test evidence, measured avoided work, and documentation matching the final implementation.

- Verify the default `maintenanceKeepRecent: 1` continues deferring the newest reply and its player message. Repeated regeneration is not additional eligible story for maintenance. Retain manual "organize now" behavior and required catch-up of older pending history.
- Cover both the inherited native auxiliary connection and a separate connection, plus `ask`, `refresh`, one-shot refresh, lazy mode, and optional MVU/scope behavior.
- Compare baseline and optimized preparation using the same small and large synthetic saves, settings, and controlled auxiliary response. Report entry/message counts, selector call counts, derived-work/assembly counts, median and p95 preparation time. Timing reports are evidence, not brittle unit-test thresholds or promised provider savings.
- In an isolated initialized test chat, send once, regenerate three times, browse alternatives, edit an earlier message, and regenerate again. Check current-turn diagnostics, actual auxiliary request counts, injected memories, and retained raw history. Repeat a stop and chat-switch case. Record host/template versions; unit tests alone do not certify live integration.
- Update the reroll/reuse explanation in `README.md` and add a changelog entry in `docs/public/CHANGELOG.md`. Explain cache lifetime, refresh controls, and why changed inputs can require selection again.
- Reuse existing modules. If a new runtime file proves necessary, add it to `scripts/build.mjs` and verify packaging. No version bump or release is needed for this implementation.

Acceptance: the matrix below passes, the full test suite and syntax/build checks pass, and a performance report distinguishes avoided auxiliary calls from remaining local/native work. Any unavailable live verification is stated explicitly rather than marked complete.

## Regression matrix

| Scenario | Required result |
| --- | --- |
| Initial send + three unchanged regenerations | One selector call total; distinct request IDs; equivalent current Fish context |
| Same text on a later user turn | New selection, not a hit on the earlier turn |
| Change earlier text while message IDs stay the same | Reuse rejected when selector input changed |
| Automatic maintenance of already-read history | IDs may be reused; updated summary/inventory/entry bodies are injected |
| Newly exposed history, manual entry/summary/inventory edit, or scope change | Revalidate and reject stale selection/payload |
| Worldbook binding/content/switches or author rules change | Existing source-change behavior wins; stale payload never installed |
| Source/input changes during source checks, a model call, or ask dialog | Final validation rejects stale work |
| Connection, preset, regex, observed MVU, or relevant selection settings change | Existing input invalidation remains effective |
| Browse latest-reply A/B then regenerate | Retain candidate and reuse only if preceding turn/effective data still match |
| Earlier candidate change, real deletion, swipe deletion, or native regeneration tail deletion | Correctly distinguish branch changes from expected native replacement |
| Cancel, failed retry, late completion, or chat switch | No late plan/cache commit; no cross-chat diagnostics or memory |
| Refresh/ask/preview | Existing choices and one-shot consumption preserved; preview does not overwrite accepted sending state |
| Pending history, missing summary, timed native worldbook effects | Raw-history preservation remains correct |
| Default maintenance deferral and explicit organize-now | Latest reply deferred automatically; manual inclusion/rollback still works |

## Validation commands

Run targeted tests for each changed area while implementing. The baseline regeneration command is:

```powershell
node --test --test-reporter=spec test/selection-reuse.test.js test/host-lifecycle.test.js test/reroll.test.js
```

After integration:

```powershell
npm test
npm run check
npm run build
```

Reuse applicable existing fixtures for activity/UI/export, source changes, deletion/rollback, maintenance cadence, scopes/MVU, and history-window coverage. Verify only once after the final code change unless failures or new concerns require another run.

## Scope decisions

| Decision | Reason |
| --- | --- |
| Four sequential implementation changes | Diagnostics establish the cause; optimization and swipe handling can then be reviewed separately. |
| Single current-turn cache, in page memory | Matches existing behavior and bounds retained private content. Persistent/multi-turn cache is unnecessary for immediate rerolls. |
| Selection reuse and payload reuse have different validity checks | Background maintenance can preserve the selected IDs while changing what must be injected. |
| Keep existing history/source/branch checks | Speed must not reintroduce discarded facts or omit unremembered dialogue. |
| Keep native connection invalidation conservative | Narrowing broad host settings signatures requires evidence about auxiliary input effects. |
| No new packages, cache service, save schema, or maintenance default | Existing modules and settings cover the requested behavior. |

## Known limits and next action

The user's live delay has not been reproduced. Local verification passed: 986 tests passed, 2 environment-dependent checks skipped, no failures; syntax/entry checks passed for 186 files and the candidate install build contains 75 files. The final selection-specific rerun also passed all 34 tests after making its asynchronous waits deterministic.

In controlled fixtures, 30 measured unchanged rerolls made no additional selection calls. The small fixture's median local preparation fell from 2.96 to 1.80 ms; the large fixture's from 35.68 to 19.18 ms. Source reads and history checks remain active. See `findings.md` for p95 timings, counts, and limitations; these are not live provider or end-to-end generation measurements.

Next validation when a live host is available: run the isolated-chat scenario in Phase 4 and record SillyTavern/template versions. No runtime deployment or release was performed.

## Errors encountered

Planning had no errors. During Phase 2, a runtime test expected the established candidate-change error wording; restored that wording while keeping the stricter content/input freshness check.

The final settings guard initially rejected disabling MVU during its pending read. Restarted preparation with the current settings before selection to preserve the supported behavior.

A native reroll fixture used a deliberately out-of-range compaction interval; its new settings update now supplies a valid interval before exercising the scenario.

The first full suite encountered Windows EPERM while the existing build test created a symbolic link. The output-boundary test now uses a directory junction on Windows. The separate file-symlink check explicitly skips only Windows EPERM; the offline archive check also skips here because zip/unzip are unavailable. No OS privileges or production build protections changed.

Two runtime tests used a fixed number of event-loop turns while awaiting WebCrypto. Replaced those waits, plus the selection race-test waits, with bounded deadlines and an explicit phase assertion. All behavior assertions remain.
