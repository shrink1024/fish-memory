# Regeneration reuse progress

## Requested bug review and fixes

- User requested a bug check and fixes. Reviewed OpenRouter transport, connection UI/persistence, and regeneration cache/lifecycle with independent parallel reviews.
- Reproduced and fixed blank model IDs replacing working connections, a stale model dropdown after changing endpoint, request paths appended after query/fragment components, and model-list cancellation being lost during body parsing.
- Added a 15-second model-list deadline using existing abort helpers; a stalled request releases the UI and a late response cannot publish results. Focused connection/transport tests pass.
- Reproduced regeneration scope changes during the final connection await and history-window application installing stale prompt data. Revision/enabled checks now follow the final connection await; a final private activity guard checks revision, settings, refresh state, connection token, and message text/draft immediately before host installation. Pausing memory during window application restores native flow.
- Six lifecycle regression cases passed, including scope/input/settings/refresh/pause changes. Independent sanity review found no additional concrete regression in connection fixes.
- Final verification: 1,010 tests total, 1,008 passed, 0 failed, 2 existing environment-dependent skips. Syntax/entry checks passed for 187 files; the 75-file candidate install build succeeded. No live authenticated generation or SillyTavern session was tested.

## OpenRouter follow-up

- User requested OpenRouter API call support. Reusing existing compatible connection storage and model picker.
- Added an explicit OpenRouter connection preset with the official API base URL; choosing it clears credentials from the previous form. Protocol work and an independent integration review completed in parallel.
- Official docs verified unified `reasoning.effort` and configured `max_completion_tokens`; generic compatible gateways retain their existing mapping. No new connection storage schema or runtime module was needed.
- Choice-level errors now reject partial responses, including streams. API keys join custom-header values in diagnostic redaction; tests cover saved and unsaved keys echoed by a provider.
- UI/persistence/header focused tests passed (15). Protocol/transport focused tests passed (53), followed by an inherited OpenRouter routing regression.
- Live public `/api/v1/models` read succeeded through the production `listModels` helper with no key, returning 476 model IDs. No authenticated generation or paid requests were performed.
- Final full suite passed: 1,000 tests, 998 passed, 0 failed, 2 existing environment skips. Build passed syntax/entry checks for 187 files and produced the 75-file candidate install directory. `git diff --check` passed.
- Updated README, compatibility notes and unreleased changelog. OpenRouter implementation is complete; real credential/provider and live host testing remain unperformed.

## 2026-11-22 — Plan creation

- Request: create implementation plans for the regeneration improvements discussed in this chat.
- Repository: `C:/Users/Lilan/Documents/github/fish-memory`.
- Confirmed a clean starting worktree at `75a523f` and no existing planning files or repository `AGENTS.md`.
- Created `task_plan.md`, `findings.md`, and `progress.md`.
- Completed source mapping for the cache, controller, adapter, prompt assembly, diagnostics/export, UI, and packaging.
- Wrote four ordered implementation phases, their file/test scope, a reuse contract, a regression matrix, and performance/live verification requirements.
- Recorded the difference between selected-ID reuse and prepared-payload reuse, and the need to preserve source/branch checks.
- The session recovery helper completed successfully with no previous-session report.
- Verified all referenced source/test/document paths exist and the documents contain no template placeholders.
- Confirmed the worktree contains only the three new planning documents; runtime, tests, scripts, and manifests have no changes.
- Planning and artifact verification are complete. All implementation phases remain pending.

## Verification already available

| Check | Result | Scope |
| --- | --- | --- |
| Selection reuse, host lifecycle, and reroll tests | 55 passed, 0 failed | Ran in the preceding investigation in this chat on the unchanged source |
| Live SillyTavern reproduction or timing | Not performed | Required to attribute the reported delay |
| Planning file references and placeholders | Passed | All three planning documents |
| Runtime/test/script/manifest diff | Empty | Planning-only changes confirmed |

## Next action

Implementation is complete. When a live SillyTavern session is available, run the isolated-chat validation described in Phase 4 of `task_plan.md`.

## 2026-11-22 — Implementation

- User authorized following the implementation plan.
- Re-read all planning files and checked repository instructions and worktree. Only the planning files were untracked; no pre-existing runtime changes.
- Phase 1 started. Existing cache validity checks remain the baseline.
- Phase 1 implemented: structured reuse reasons, current-chat attempt outcomes/timings, accurate activity/current-turn copy, and bounded problem-export metadata.
- Targeted verification: 98 tests passed across selection reuse, activity, economy UI, problem export, host lifecycle, and reroll suites.
- Next: capture the instrumented baseline and implement measured preparation reuse.
- Captured baseline using `.local/benchmark-regeneration.mjs`: 20 entries / 25 messages: median 3.22 ms, p95 4.47 ms; 300 entries / 121 messages: median 37.82 ms, p95 40.17 ms. Each ran 30 measured rerolls after 5 warmups with one selector call total. Large-save source checks accounted for 20.87 ms median.
- Phase 2 added shared fingerprint framing, verified source-comparison/rule reuse, and a single prepared payload in the existing cache; live source reads and history-window checks remain.
- Targeted tests caught a changed error string expected by the runtime test. Preserved the existing candidate-change wording while retaining the added text/input check.
- Added regression cases for prepared-payload isolation, fresh request IDs, failed host installation, inventory catch-up state, in-place source edits, late native switches, and text edits under stable message IDs.
- Phase 3 now retains only a validated latest-turn candidate on browsing; unknown/earlier swipes and deletions still invalidate it. Reconciliation/cancellation remain active.
- A targeted test caught the existing supported case of disabling MVU during its pending read. Preparation now restarts with the updated settings before any selection call, preserving that behavior and final freshness validation.
- The new native browsing test initially inherited an out-of-range fixture compaction interval; supplied a valid interval for its settings update. The adapter sequence now passes and proves discarded facts are absent while latest-reply maintenance remains deferred.
- Focused verification after the final freshness guards: 109 tests passed (selection reuse, runtime, reroll, activity, source-book).
- Updated README and an unreleased changelog entry. Phases 1–3 are complete; Phase 4 is in progress.
- First full run: 987 tests, 985 passed, 1 skipped, 1 failed. The failure is the existing build security test attempting a Windows symbolic link without permission (EPERM), not a regeneration assertion. Investigating a portable way to exercise the same boundary without changing OS privileges.
- `npm run check` passed (186 files).
- Computer-use inventory found no available SillyTavern session; the local Node processes were Codex tooling. Live host/provider validation is unavailable in the current environment.
- The build protection test now uses a Windows directory junction; its file-symlink case is separate and skips Windows EPERM explicitly. Offline archive verification also skips because zip/unzip are absent. Production build protections are unchanged.
- A subsequent full run exposed two timing-sensitive tests that counted event-loop turns while awaiting WebCrypto. Converted them to bounded timeouts; also made selection race tests explicitly wait for selection to begin before changing inputs.
- Full verification passed: 988 tests, 986 passed, 0 failed, 2 skipped. The final targeted selection run after improving its waits passed all 34 tests.
- A focused payload microcheck found a large full-object clone slightly slower than fresh assembly. Copying entries separately preserved isolation and reduced the large-fixture microcheck median from 1.34 to 1.16 ms (assembly 1.26 ms); no new helper/module or package was required.
- Final controlled benchmark (same fixtures, 5 warmups + 30 measured rerolls): small median/p95 2.96/4.33 → 1.80/2.25 ms; large 35.68/38.31 → 19.18/21.31 ms. Both versions used one selector call total and 73 live source reads. Measured derived comparisons fell from 60 to 0, and payload hits replaced all 30 assemblies. Details and limits are recorded in `findings.md`.
- Final `npm run build` passed, including syntax/entry checks for 186 files. Produced the 75-file candidate install directory at `.local/build/st-dynamic-world-memory`; no deployment, release, or version bump.
- Phases 1–3 and Phase 4 local verification/documentation are complete. Live host/provider validation remains explicitly pending due to environment availability.
