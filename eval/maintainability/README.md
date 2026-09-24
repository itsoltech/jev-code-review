# Maintainability preset: measurements

`jev:maintainability` ([src/presets/maintainability.yml](../../src/presets/maintainability.yml)) checks changes that make later changes harder. Five rules are Jev Choices (`present` / `absent` / `insufficient_context`, the last one an abstention) judged on a single hunk with no stated contract; four are regex rules. Rules that need a contract or other files (mode flags, temporal coupling, contradictory state fields, hidden dependencies, duplicate implementations, incomplete migrations) are left out: judged on one hunk they would answer `insufficient_context` or guess.

All runs use `jev-1.13.0` on 2026-09-24.

## Decision and reproduction

Use the preset for advisory findings. Keep `resource-lifetime` disabled. These measurements do
not justify promoting the Jev rules to blocking severities.

```sh
eval/maintainability/run.sh                         # synthetic + real; API calls
eval/maintainability/run.sh --only challenge        # 20 additional cases; API calls
eval/maintainability/run.sh --rule maint.magic-delay
eval/maintainability/run.sh --config my.yml
eval/maintainability/run.sh --rebuild               # rebuild real rows from source labels
eval/maintainability/run.sh --replay <report-dir> --config my.yml --no-suggest
```

Requires `TYPESAFE_API_KEY` in `.env`, Node/npm, Python 3 and jq. `--only real` and `--only syn`
select one of the original datasets. Each run creates a unique `eval/reports/maintainability-*`
directory containing dataset/config snapshots, Markdown reports, disagreements and dumps. The
`*.answers.json` files also contain the resolved configuration, full raw answers and a hash of
the model/state/questions. Replay needs the same dataset selection and question content; only
local policy changes such as thresholds and bands can reuse the answers. No API key is needed
for replay. A failed or missing evaluation makes calibration exit nonzero, retaining its report.

`build_canopy.py` applies the shared `eval/anonymize.py` policy to public PR hunks before writing
`canopy-maintainability.jsonl`: unrelated project identifiers and company-specific CI/tracker
hosts become example values. Reports captured before this redaction may not replay against the
rebuilt dataset; use a fresh live run when preparing release calibration evidence.
Rebuilding requires the private mapping described in `eval/canopy/README.md`.


`--threshold` overrides the actual threshold in calibration, not just the disagreement list.
`--no-suggest` freezes policy for measurement. Threshold suggestions require observed precision
of at least 0.9, but are development suggestions, not statistical evidence of future precision.

## What the metrics mean

The report uses the production `judge()` function, including `min_confidence`, and aggregates
all hunk decisions for each labeled row. It reports false confirmed findings and unnecessary
human reviews separately. Unknown labels (`expected: insufficient_context`) are not negatives;
they are excluded from precision/recall and their findings are reported separately. No predicted
positives means undefined precision, and no true positives means undefined recall (`n/a`).

The previous report counted probability above threshold as confirmed even if low confidence
sent it to a person. It also returned 100% recall for datasets with no violations, could lose a
zero-score answer behind a filtered hunk, omitted failed evaluations, and measured locations
at a suggested threshold. These errors are corrected. Preselection coverage now has its own
column, but covers this labeled dataset only; it does not measure regex recall over an unbiased
sample of all changes.

## Real code: canopy-desktop (150 rows)

`eval/datasets/canopy-maintainability.jsonl` is built by [build_canopy.py](build_canopy.py) from the 268 merged canopy-desktop PRs fetched by [eval/canopy/fetch_data.py](../canopy/fetch_data.py) and two label files:

- [labels-canopy.json](labels-canopy.json): of the 367 hunks that pass a rule's `candidate_regex` (resource-lifetime 183, timeout 135, magic-delay 97, test-weakening 80, blanket-suppression 6), every hunk Jev scored 0.3 or more on a first run, 12 random others per rule, and every hunk the `.onX(` subscription pattern added. Each was read and labeled by hand, with the full file at the merge commit where the hunk was not enough (`needs_file`).
- [labels-reviewer.json](labels-reviewer.json): four places the canopy review bot flagged for the same problem (a fixed `waitForTimeout` before reading state, listeners left on `window` when a component unmounts mid-drag, update subscriptions released only when an update event fires), as a window of the file at the commit it commented on.

```sh
python3 eval/canopy/fetch_data.py /tmp/canopy-data      # once
python3 eval/maintainability/build_canopy.py /tmp/canopy-data
npm run calibrate -- --data eval/datasets/canopy-maintainability.jsonl --config eval/maintainability/jev-review.yml
```

Final policy, measured per rule (same labels, no relabeling to match Jev):

| Rule | Rows (violations) | Threshold / human floor | Confirmed / human / missed violations | Confirmed FP / clean human |
| --- | --- | --- | --- | --- |
| magic-delay | 25 (10; one additional unknown) | 0.95 / 0.75 | 8 / 2 / 0 | 0 / 0 |
| timeout-without-cancellation | 17 (2) | 0.8 / 0.55 | 0 / 2 / 0 | 0 / 0 |
| blanket-suppression | 4 (1) | 0.6 / 0.4 | 1 / 0 / 0 | 0 / 0 |
| test-weakening | 14 (0) | 0.8 / 0.6 | 0 / 0 / 0 | 0 / 0 |
| resource-lifetime (**disabled**, measured baseline only) | 97 (9) | 0.6 / 0.4 | 2 / 1 / 6 | 0 / 5 |

The clipboard example in PR 149 remains unknown and goes to human review. Resource lifetime
also produced nine abstentions. There are 150 distinct rows and 157 row/rule labels; several
rows are labeled for multiple rules. Confirmed precision is 100% for magic-delay and
blanket-suppression on this data; timeout and test-weakening have no confirmed predictions, so
their real-code precision is not measurable. Human review is not counted as confirmed recall.

The regex rules (`file-wide-lint-disable`, `ts-nocheck`, `strict-off`, `focused-test`) match no added line in the 268 PRs.

Why these decisions:

- **Magic delay:** include timer callbacks, readiness before sending an event, and setup helpers returning as if ready. The previous production decisions confirmed 6/10 and missed four. Broader wording initially accused an update notification grace period with probability 0.99. Explicit exceptions and the conservative policy now suppress that row. The clipboard case cannot establish the external API's completion contract and stays with a person. Merely lowering the original threshold or adding a 0.35 human band did not address the missing semantics.
- **Timeout:** passing an `AbortSignal` is insufficient unless it actually aborts at the deadline. The preset now makes that distinction. The two real positives are copies of a similar RPC transport: the timer drops the pending request but sends no cancellation. The state-changing handlers (`tools.spawn`, `tabs.close`, `pty.write`, `pty.kill`) are in other PR files, so the 0.71/0.75 answers should remain advisory to a person. Synthetics and mutations verify explicit writes and real cancellation.
- **Test weakening:** PR 262 deletes `src/main/pty/WsBridge.ts`; changing `wsUrlIsRuntime: true` to exact `wsUrl: ''` is consistent with deleting the bridge, not weakening the same assertion. The 0.8 threshold and 0.6 human floor suppress the previous 0.49 human-review noise. There are no natural positive examples here; real-code mutations cover lost argument checks, lost exact error text, and a Boolean value weakened to a type check.
- **Resource lifetime:** keep disabled. Low recall, clean rows sent to humans and abstentions make the rule unsuitable for regular review. It needs owner/cleanup context and better decomposition before enabling. The evaluation config explicitly enables it for experiments; the shipped preset does not.
- **Locations:** magic-delay had only 5/8 exact locations at the selected policy, and timeout had 0/2 in the baseline. Both now use `locate: false`: findings remain in the summary with a file path. Restricting line candidates and measuring accepted alternative anchors are future work.

## Synthetic rows (52)

`eval/datasets/maintainability.jsonl` pairs violations with similar-looking counterexamples:
backoff/polling/debounce/fake timers, teardown/returned disposers, timeout cancellation, scoped
suppressions, changed expected values and stronger assertions. No row carries `context`.
For enabled rules the final policy confirms 20/21 positives and sends one magic-delay positive
to a person, with no confirmed FP or clean human reviews. Disabled resource-lifetime confirms
1/3, missing two in the baseline.

## Additional challenge (20 rows)

[maintainability-challenge.jsonl](../datasets/maintainability-challenge.jsonl) has ten violations
and ten counterexamples, including mutations of public canopy tests with source IDs. Labels and
code were written before measuring the candidate; three diff header lengths were corrected
afterward. This is a regression challenge, **not an independent blind holdout**. No label notes
or mutation explanations are sent to Jev.

The final run confirmed 9/10 violations and sent one setup-helper delay to a person. It had no
confirmed FP and no clean human reviews. An earlier run of the same magic-delay wording, with
line-location questions enabled, sent one correctly awaited write to a person (P=0.79); the
final run scored it 0.69. This variation is a reason to retain a human band and collect more
data, not evidence that the false-positive rate is zero in production.

## Saved evidence

Reports are ignored by git but remain locally under `eval/reports/`:

| Evidence | Directory / file |
| --- | --- |
| Corrected baseline, all 202 original rows | `maintainability-20260924T081544-40Zbpg/` |
| Final magic-delay, live API | `maintainability-20260924T082531-mravHA/` |
| Final timeout policy, replay of live answers | `maintainability-20260924T082533-Crlm1Z/` |
| Test-weakening policy and unchanged rules, baseline replay | `maintainability-20260924T082025-ACCGiD/` |
| Final challenge, live API | `maintainability-20260924T082615-ZYYwGo/` |

Replays cost no new API tokens. This session used about 1.79 million input tokens including the
original report, corrected baseline and targeted experiments. Unit verification:
`npx vitest run test/unit` — 102 passed; after the final policy changes and an added fixture
integrity test, `npx vitest run test/unit/calibration.test.ts test/unit/config.test.ts` — 20 passed.
CLI/Action bundles were regenerated. No typecheck, E2E or GitHub publishing was performed.

## Not measured

Positives are few and correlated: the two timeout rows are similar implementations, and the
settings test appears in both a PR hunk and a reviewer window. Historical rows were already used
to tune prompts; splitting them at PR 300 now would not create an unseen holdout. Labels have no
independent agreement measurement. No unbiased preselection-recall audit was performed.

All Jev rules remain `minor`, so default `fail_check`/`request_changes` policies on `blocker` do
not block on them; `maint.focused-test` is `major`. Pure deletion hunks are not reviewed. Enclosing
context retrieval, retry after `insufficient_context`, and an `all_of` pipeline are not implemented
by this calibration. Resource-lifetime remains disabled pending those improvements and new data.
