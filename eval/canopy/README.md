# Canopy baseline

Evaluation data built from [itsoltech/canopy-desktop](https://github.com/itsoltech/canopy-desktop): 268 merged PRs, 2,058 inline review comments (1,165 from the Claude review bot, the rest from people) and 1,359 PR conversation comments, fetched on 2026-09-23. The config under test is [examples/canopy/jev-review.yml](../../examples/canopy/jev-review.yml). It contains no rules of its own: it extends built-in presets and sets canopy's conventions as `vars` (paths, the try/catch allowed list, path validators, prefixes). Canopy serves as a test ground; [eval/control](../control) applies the same presets to a project with different conventions.

## What canopy already checks

| Check | How | Blocks merge |
| --- | --- | --- |
| Lint, unit tests, build | `ci.yml`: `npm run lint`, `npm test`, `npm run build` | yes |
| PR title and description | `pr-validation.yml`: Claude Haiku with `.github/prompts/pr-validation.md`, label `claude:pr-validation:passed` | yes, through `pr-labels.yml` |
| Code review | `code-review.yml`: Claude Opus with `.github/prompts/code-review.md`, label `claude:review:approved` | yes, through `pr-labels.yml` |

The PR validation rules are conventional prefix (`feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `build`), title under 72 characters, lowercase after the prefix, no trailing period, filled What and Why sections, a Why that explains user impact on `feat` PRs, and the template checklist.

Bot review comments by topic (keyword match on 1,165 comments, first match wins): accessibility 172, error handling and neverthrow 170, theming and hardcoded colors 127, IPC validation and security 84, memory leaks and cleanup 72, ts-pattern 70, type safety 60, missing docs 54, cross-platform 48, Svelte 5 runes 30, performance 26, secrets 17, other 219. Human comments focus on logic bugs the prompt does not list: races between async loads, renderer-supplied URLs and IDs trusted in the main process, process and file lifecycle on Windows, and state that goes stale across windows.

## Results

All numbers are from `jev-1.13.0` on 2026-09-23. The rule wording was refined on these same rows, so treat them as optimistic until a later set of PRs confirms them.

### PR title and description (191 rows, `eval/datasets/canopy-pr.jsonl`)

Labels come from the pr-validation bot, with manual corrections in `label-overrides.json` (each with a reason).

| Rule | Kind | Rows (positive) | Precision / recall |
| --- | --- | --- | --- |
| title-prefix, title-length, title-lowercase, title-period | regex | 152 (4, 12, 4, 1) | 100% / 100% |
| infra-not-feat (feat/fix on a CI or tooling-only change) | regex + `when.files_only` | 10 (3) | 100% / 100% |
| what-section, why-section, checklist | regex on parsed sections | 152 (13, 13, 7) | 100% / 100% |
| what-concrete | Jev | 151 (12) | 100% / 100% |
| why-reason | Jev | 154 (13) | 100% / 92% |
| feat-user-impact | Jev | 67 (12) | 100% / 100% |

Team policy applied here: changes to CI, tests and tooling use `chore` (dependencies `build`), not `feat`. With that, the two `feat` PRs the bot passed (#92 performance tooling, #121 a `.github`-only workflow) are real findings, and feat-user-impact has no errors. The single why-reason miss scores 0.69, inside the needs-human band.

Every regex disagreement with the bot was checked by hand and was a bot error: titles of 69, 70 and 71 characters reported as over 72; `ci:` accepted while `perf:` was rejected; uppercase after the prefix accepted in one run and rejected in the next; descriptions without What and Why sections passed.

### Code (`eval/datasets/canopy-code.jsonl`)

Review comments cannot serve as labels: comments that match a rule's keywords often discuss a different problem, and approved PRs contain violations nobody flagged. Code rows are labeled by reading, against the rules as `CLAUDE.md` and `code-review.md` write them; how canopy code has been written so far creates no exceptions. Where canopy has almost no real violations (its effects and validators are written correctly), violations are made by removing the fix from real code: the cleanup `return` of an `$effect`, the validator call of an IPC handler, the staleness check of an async load, or by rewriting a real `$derived` as `$state` + `$effect`.

| Rule (preset) | Rows (violations) | Labels | Precision / recall | Confirmed / needs human / missed |
| --- | --- | --- | --- | --- |
| errors.try-catch-outside-boundaries (`jev:result-errors`) | 119 (87) | every added try/catch in `src/main` except tests, by hand (`labels-try-catch.json`) | 98% / 93% | 81 / 2 / 4 |
| electron.ipc-unvalidated-input (`jev:electron`) | 49 (21) | 24 IPC handlers that reach fs/network/commands, by hand, plus 15 with validation removed and 20 without such calls (`labels-ipc-input.json`) | 100% / 95% | 20 / 1 / 0 |
| svelte.effect-without-cleanup (`jev:svelte5`) | 89 (32) | every added `$effect`; cleanup removed from the ones that create resources | 100% / 97–100% | 31 / 1 / 0 |
| svelte.effect-as-derived (`jev:svelte5`) | 118 (30) | 75 effects by hand plus 26 real `$derived` rewritten as effects (`labels-effect-derived.json`) | 100% / 87% | 26 / 4 / 0 |
| async.stale-write (`jev:async-state`) | 132 (27) | 124 async renderer functions by hand plus 10 with the staleness check removed (`labels-stale-write.json`) | 92–100% / 37–48% | 12 / 10 / 5 |

By the literal `CLAUDE.md` list, 87 of 119 merged try/catch blocks in `src/main` (73%) break the rule. `async.stale-write` is conservative: what it confirms is right, but about half of the violations land in the needs-human band because a hunk does not show whether an input can change during the request. A `changing_inputs` variable that listed canopy's switching inputs raised recall but dropped precision to 70% by flagging dialogs with fixed props, so it is not set for canopy.

`effect-as-derived` needed one project fact, given as `vars.pure_reads`: canopy's `get*()` store readers have no side effects. Without it, effects made of such calls were read as side effects.

Surface rules are regex `pattern` rules on added lines; `npm run scan-patterns` ran them over all 6,906 hunks of the 233 PRs. Hits: throw-new-error 109 hunks, hardcoded-color 132, docs.new-ipc-without-docs 65, sync-fs-main 34, switch-statement 18, docs.new-error-variant-without-docs 14, ipc-send-on 6, shortcut-label-os 3 (one, `TitlebarMenu.svelte`, rendered only on Windows and Linux, is excluded through `platform_specific_paths`), renderer-node-import 0, ipc-channel-name 0, preload-generic-invoke 0, legacy-export-let 0, any-without-reason 0. Each nonzero rule's sample was read; false positives found on the way (a platform helper, hyphenated channel names, `:any` inside strings, labels showing both Cmd and Ctrl) were fixed in the preset.

Icon-only buttons without `aria-label` (14 of 55 in canopy history) are left to the Svelte compiler's `a11y_consider_explicit_label` warning; canopy's CI passes on warnings, so `svelte-check --fail-on-warnings` would enforce it without a model.

### Full runs on merged PRs

First runs on #332, #337, #338 and #342 produced four false positives, all fixed in the presets and kept as rows in `eval/datasets/sample.jsonl`: DOMPurify-sanitized `{@html}`, a PowerShell command in an e2e test, SQL built from constant fragments with `?` placeholders, and the injection guard on docs that mention AI agents.

With the preset config (about 6 seconds per PR, 170k to 420k input tokens):

| PR | Confirmed findings | Needs human |
| --- | --- | --- |
| #324 | 7 × throw-new-error, 1 × try/catch around a gh call (all in `ipc/handlers.ts` and `TaskTrackerManager.ts`) | 4 × ipc-unvalidated-input (0.43–0.51) |
| #332 | none | none |
| #338 | 3 × throw-new-error, 1 × try/catch around `git worktree add`, 2 × sync-fs-main | 1 × try/catch |
| #342 | 1 × `throw new Error('Invalid task key')` in an IPC handler | 1 × ipc-unvalidated-input |
| #344 | 8 × throw-new-error in `ci/ipc.ts`, 1 × try/catch in `CiManager.ts` | none |

All of these PRs merged with the Claude review bot's approval.

## Reproduce

```sh
python3 eval/canopy/fetch_data.py /tmp/canopy-data     # needs gh auth; about 250 API calls
python3 eval/canopy/build_datasets.py /tmp/canopy-data       # canopy-pr.jsonl
python3 eval/canopy/build_code_dataset.py /tmp/canopy-data   # canopy-code.jsonl from the labels-*.json files
npm run scan-patterns -- --files /tmp/canopy-data/pr_files.json --config examples/canopy/jev-review.yml
npm run calibrate -- --data eval/datasets/canopy-pr.jsonl --config examples/canopy/jev-review.yml
npm run calibrate -- --data eval/datasets/canopy-code.jsonl --config examples/canopy/jev-review.yml
npm run review-local -- --pr 342 --repo itsoltech/canopy-desktop --config examples/canopy/jev-review.yml
```
