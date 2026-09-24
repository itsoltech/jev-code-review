# Core presets: measured decisions

Measured on 2026-09-24 with `jev-1.13.0`. Scope: `base` (1 rule), `security` (6), `correctness` (4), `tests` (1). The `jev:base` guard is always loaded; the calibration config extends the other three presets. **Keep the eleven enabled rules at their existing thresholds, with two narrowly corrected prompts. Disable `tests.missing` in the shipped tests preset.** The calibration config explicitly re-enables that last rule to measure its rejected candidate policy; do not mistake its candidate measurements for enabled production behavior. There is no evidence here to promote any advisory rule to a blocking severity or to claim a future error rate.

## Reproduction and stored evidence

```sh
# Requires public /tmp/canopy-data/pr_files.json and prs_full.json; fetch if absent:
python3 eval/canopy/fetch_data.py /tmp/canopy-data
python3 eval/calibration/core/build.py
npm run calibrate -- --data eval/calibration/core/baseline.jsonl --config eval/calibration/core/jev-review.yml --dump eval/reports/core-final-baseline --no-suggest
npm run calibrate -- --data eval/calibration/core/holdout.jsonl --config eval/calibration/core/jev-review.yml --dump eval/reports/core-holdout --no-suggest
# Replay the saved full answers, without API calls, only if questions/state/model are unchanged:
npm run calibrate -- --data eval/calibration/core/holdout.jsonl --config eval/calibration/core/jev-review.yml --replay eval/reports/core-holdout.answers.json --dump eval/reports/core-holdout-diagnostic-replay --no-suggest
```

`baseline.jsonl` and `holdout.jsonl` are labeled, machine-readable row/PR datasets; `build.py` retains source links, provenance, and annotation notes. Existing sample/self-review examples are authored fixtures, not natural violations. Public canopy changes contribute ten real hunk slices and four PR-level rows; eight sourced mutations are explicitly tagged and must **not** be counted as independent natural observations. The frozen holdout is five *complete* public PRs (284, 285, 286, 287, 289), all 30 changed files with patches, not merely sampled hunks. The manifest `eval/preset-holdout.json` was read before inspecting them; their labels were written before any model answers and never altered in response. The regenerated holdout checksum remained `b11fab6772bc4b37dfa95c569c6c47702517e09c` after measuring it.

Raw row verdicts are ignored files `eval/reports/core-baseline`, `core-final-development`, `core-final-baseline`, `core-holdout`, and `core-holdout-diagnostic-replay`; adjacent `.answers.json` contain complete raw answers, resolved configs, and replay fingerprints. The initially measured 73-row report is `eval/reports/calibration-2026-09-24T064251.679Z.md`, final 74-row live report `eval/reports/calibration-2026-09-24T064714.686Z.md`, reserved PR live report `eval/reports/calibration-2026-09-24T064519.288Z.md`. Final live runs: 74/74 answered rows, 72,635 input tokens, and 5/5 answered reserved PR rows across 69 requests, 147,872 input tokens; zero incomplete rows/failed evaluations/skipped requests in both. The calibrator exits nonzero on incomplete evaluation. Its replay rejects changed model/state/questions; **prompt edits require fresh live answers**, while unchanged-question policy edits can replay. `--no-suggest` prevents tuning against these sparse counts.

## Per-rule outcomes

Each row is a *row/rule* label, not an independent estimate of production prevalence. `P/N` = positives/clean negatives. `TP/FP` = confirmed true/false findings. `H+/miss` = positive needs-human / missed (neither confirmed nor human). `H−` = clean needs-human. All twelve have zero misses and zero positive-human on the **final development set**; no rule has an abstention, unknown label, or incomplete row. Holdout reports are from the pre-disable *candidate* configuration; the final shipped `tests.missing` rule is disabled. Eleven holdout rules have **no positives**, making holdout recall/precision `n/a`, not 100%.

| Rule | Dev P/N | Dev TP/FP | Dev H+/miss; H− | Holdout P/N | Holdout TP/FP | Holdout H+/miss; H− | Decision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `meta.injection` | 5/21 | 5/0 | 0/0; 0 | 0/5 | 0/0 | 0/0; 0 | Auto, guard; no holdout positives |
| `sec.sql-concat` | 4/5 | 4/0 | 0/0; 0 | 0/5 | 0/0 | 0/0; 0 | Auto, existing blocker; fixture positives only |
| `sec.hardcoded-secret` | 2/2 | 2/0 | 0/0; 0 | 0/5 | 0/0 | 0/0; 0 | Auto, existing blocker; fixture positives only |
| `sec.command-injection` | 3/3 | 3/0 | 0/0; 0 | 0/5 | 0/0 | 0/0; 0 | Auto, existing blocker; fixture/mutation positives only |
| `sec.unsafe-html` | 3/3 | 3/0 | 0/0; **1** | 0/5 | 0/0 | 0/0; 0 | Auto advisory; sanitizer must reach sink |
| `sec.tls-verification-off` | 1/1 | 1/0 | 0/0; 0 | 0/5 | 0/0 | 0/0; 0 | Auto advisory; synthetic-only positive |
| `sec.sensitive-logging` | 1/2 | 1/0 | 0/0; 0 | 0/5 | 0/0 | 0/0; 0 | Auto advisory; synthetic-only positive |
| `corr.swallowed-error` | 2/2 | 2/0 | 0/0; 0 | 0/5 | 0/0 | 0/0; 0 | Auto advisory; fixture/mutation positives only |
| `corr.debug-leftover` | 1/2 | 1/0 | 0/0; 0 | 0/5 | 0/0 | 0/0; 0 | Auto advisory; excludes fixed protocol markers |
| `corr.floating-promise` | 2/3 | 2/0 | 0/0; 0 | 0/5 | 0/0 | 0/0; 0 | Auto advisory; authored fixtures only |
| `corr.todo-added` | 1/1 | 1/0 | 0/0; 0 | 0/5 | 0/0 | 0/0; 0 | Auto informational; real TODO and data-category counterexample |
| `tests.missing` | 2/2 | 2/0 | 0/0; 0 | **2/3** | **2/2** | 0/0; 0 | **Disabled**; frozen PRs expose two false alarms |

All rules' observed confirmed precision on **development rows** is 100%, but this is not a statistical guarantee: several have one positive, many have no naturally observed positive, and PR holdout negatives cannot measure recall. `tests.missing` had 50% confirmed precision on the held-out candidate run (2 TP, 2 FP). There are no human-only shipped decisions: the one uncertain `sec.unsafe-html` clean fixture remains an explicit needs-human review, and disabling the imprecise PR-level rule is safer than inventing a threshold.

## Diagnosis and holdout boundary

The first, pre-correction 73-row live run found `corr.debug-leftover` 1 TP / **1 FP**: a `console.log('__CANOPY_NAV__:back')` line is a webview's intentional message protocol, not a trace. The prompt now distinguishes fixed consumed protocol markers from debug logs, and the real unconditional updater trace remains confirmed. `sec.unsafe-html` initially had 2 confirmed TP, 1 positive human, 2 clean human; the sliced real Markdown example omitted its preceding `purify.sanitize` assignments, while a mutation's raw input was falsely sheltered by a nearby “sanitized above” comment. The final real/mutated slices expose the actual dataflow, and the corrected prompt judges the value reaching the sink, not a comment. On the final live run both unsafe mutations were confirmed and the real sanitized example was clean. The old sample fixture whose only visible evidence is a sanitization comment remains **clean sent to human** (0.63): its label assumes unseen sanitization, so neither a confirmed vulnerability nor proven safe dataflow follows from that hunk alone. The changed prompts were remeasured by live API, not replay.

PRs 285/286 change application behavior without tests and were correctly flagged; PR 284 changes a dependency install script, while 287/289 replace equivalent icon imports/aliases and should not trigger “behavior changed without tests.” The old broad `tests.missing` prompt flagged both icon refactors at 0.72. **Its frozen holdout was used as a go/no-go policy diagnostic to disable the rule; it is consequently not an untouched *final-policy* validation for that rule.** We did not tune its question, threshold, labels, or regex on these PRs. No post-change holdout precision claim is possible for a disabled rule. Other rules' prompts were finalized before running holdout; all their five PR labels are negative with zero findings, but cannot test sensitivity.

This is not a truly blind prospective holdout: titles/descriptions of the reserved PRs already appear in `eval/datasets/canopy-pr.jsonl`, and historical presets may have been tuned on earlier canopy material. Labels have no second annotator, samples are small/correlated, and some authored examples are unrealistic compared with changes in the wild. Preselection coverage on these selected rows says nothing about unseen missed candidates. Location among development confirmed positives with a known line: `meta.injection` exact 4/5 (within one 5/5); `sec.command-injection` exact 1/2 (within one 2/2). Do not treat the available 100% development precision as evidence that blocker rules satisfy ≥90% future precision; especially SQL, secrets, TLS and sensitive logging need genuine positive PRs and independently labeled hard negatives before stronger claims. No project-wide gates were run in this parallel calibration; parent owns those checks.
