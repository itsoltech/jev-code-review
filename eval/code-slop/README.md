# Code slop preset: measurements

`jev:code-slop` ([src/presets/code-slop.yml](../../src/presets/code-slop.yml)) carries the 24 rules of the code-slop rule pack (2026-09-23), translated to English. It detects concrete anti-patterns, not authorship. Each rule is a Choice between `present`, `absent` and `insufficient_context`; only `present` becomes a finding. A `candidate_regex` decides whether Jev is asked at all.

All runs use `jev-1.13.0` on 2026-09-23.

## Rule pack fixtures (60 rows)

`eval/datasets/code-slop-fixtures.jsonl` is the pack's `fixtures.jsonl`: 24 violation / counterexample pairs and 12 hard cases, including the `Effect.tryPromise` helper from the screenshot and rows whose correct answer is `insufficient_context`. Each row carries the pack's context, sent to Jev as `context`.

```sh
npm run calibrate -- --data eval/datasets/code-slop-fixtures.jsonl --config eval/code-slop/jev-review.yml
```

59 of 60 rows get the expected answer, including all `insufficient_context` rows. Two rows added on 2026-09-24 (`R002_multiline_*`) spread a nested ternary over several lines; since the pre-filter also matches runs of adjacent added lines, the violation is asked and answered `present`, and the run is 61 of 62. The one miss is `R001_positive` (a three-level pass-through chain), which Jev answers `absent` at 0.28. The `Effect.tryPromise` adapter is not reported as a wrapper chain, and without call sites the domain-error rule answers `insufficient_context`. These fixtures are synthetic and state their contract explicitly, so they are the easy case.

## Real code without a stated contract

On four merged canopy-desktop PRs (#324, #332, #338, #342, about 200 hunks) with `eval/code-slop/canopy.yml`, Jev answered `absent` for almost every question and `insufficient_context` mostly for `api-mismatch` (no declarations in a diff). One answer crossed the 0.6 threshold. Canopy is reviewed code, so few findings are plausible, but this run has no labels and says nothing about recall.

To measure recall on real code, `eval/datasets/code-slop-mutations.jsonl` takes real canopy calls and tests and injects unambiguous patterns, with the unmodified version as the counterexample:

| Rule | Rows (violations) | Precision / recall | Confirmed / needs human / missed |
| --- | --- | --- | --- |
| useless-catch (catch that only rethrows, vs. logs and rethrows) | 20 (10) | 100% / 100% | 10 / 0 / 0 |
| async-promise-executor (`new Promise(async ...)`) | 20 (10) | 100% / 100% | 10 / 0 / 0 |
| test-without-real-assertion (`expect(true).toBe(true)`) | 20 (10) | 100% / 100% | 10 / 0 / 0 |
| unawaited-async-work (`forEach(async ...)` vs. `for...of`) | 20 (10) | 100% / 70% | 7 / 3 / 0 |

Two of the real tests were answered `insufficient_context` instead of `absent`; neither became a finding.

## Not measured

Rules that depend on a contract the diff does not show (failure-as-success, falsy-fallback, ignored-parameter, duplicated-business-rule, speculative-extension, domain-error-in-generic-helper) are only measured on the pack's fixtures, where the contract is given. In a real review they need `context.project_notes` or they will answer `insufficient_context`. Severities follow the pack's defaults (high → major, medium → minor, low → info) and are a starting policy, not a measurement; run the preset in report mode (`policy.fail_check` without these severities) before letting it block.
