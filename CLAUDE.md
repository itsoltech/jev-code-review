# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A pull request reviewer built on TypeSafe Jev (a System One model: it returns typed judgments with probabilities, never text). It ships two ways from one codebase: a GitHub Action (`action.yml` → `dist/index.js`, entry `src/main.ts`) and an npm CLI `@itsoltech/jev-code-review` (bin `jev-review` → `dist/cli.js`, entry `src/cli/bin.ts`). The repo is public; do not add names, code or data from private projects (use `ExampleProject` in examples; itsoltech/canopy-desktop is public and is the test ground).

## Commands

```sh
npm ci
npm run all                     # typecheck, tests, gen-schema, build; run before every commit
npm test                        # vitest
npx vitest run test/unit/cli.test.ts -t "reads a diff from stdin"   # one file / one test
npm run typecheck
npm run review-local -- --base main --config <config>                # the CLI from source, real API
npm run calibrate -- --data eval/datasets/<set>.jsonl --config <config>
npm run scan-patterns -- --files <pr_files.json> --config <config>   # regex rules only, no API
```

`dist/index.js`, `dist/cli.js` and `schema/jev-review.schema.json` are committed and CI fails when they are stale, so rebuild after any change under `src/` (the schema comes from the zod schema via `scripts/gen-schema.ts`). Presets are imported as raw YAML text: scripts must run through `scripts/run-ts.mjs` (esbuild with a `.yml` text loader), and `vitest.config.ts` mirrors that loader. Scripts that call the API read `TYPESAFE_API_KEY` from `.env`.

## Architecture

`src/run.ts` is the pipeline; both entries only build its ports and inputs:

1. Config: `src/config/load.ts` reads `.github/jev-review.yml` from the PR base commit and merges built-in presets → `extends` → the file by rule id (`merge.ts`), then interpolates `{{vars.x}}` per enabled rule (`vars.ts`); a missing var is a config error naming the rule. `schema.ts` (zod v4) is the source of truth for the config format.
2. Subjects: changed files become hunk, file or pr subjects; hunks too large for the token limits are re-split into windows (`src/diff/`, `buildSubjects` in `run.ts`).
3. Questions: `src/jev/questions.ts` picks rules per subject (`paths`, `exclude_paths`, `when`, `candidate_regex`), `state.ts` builds the state (numbered line ids, PR data, `project_notes`), `batch.ts` packs questions under Jev's limits (64k per request, 32k state + longest question).
4. Evaluation: `src/jev/evaluate.ts` is a work queue: retries 429/5xx/timeouts with backoff and lower concurrency, splits requests rejected as too large, never resends a 403 (Cloudflare WAF refusal) or other requests with the same state, and enforces the run token budget against actual usage.
5. Policy: `src/policy/findings.ts` turns answers into findings (threshold → confirmed, `needs_human_band` → needs human), plus deterministic `pattern` and `file_lines` rules without the model; `composite.ts` scores dimensions; `verdict.ts` applies `policy`.
6. Output: `src/report/` renders the summary, inline comments (fingerprinted for dedupe on re-runs), text, JSON and SARIF; `publish.ts` writes through `GitHubPort`.

Everything external goes through two ports, `GitHubPort` (`src/ports.ts`, Octokit in `src/github/octokitPort.ts`, a read-only local one in `src/cli/localPort.ts`) and `JevPort`, so pipeline tests (`test/pipeline/`) run end to end with `FakeGitHub` and the real SDK over a fake `fetch` (`test/helpers/fakes.ts`).

## Rules and presets

- Presets live in `src/presets/*.yml` and must be registered in `src/presets/index.ts`. Rule ids are generic (`sec.*`, `corr.*`, `slop.*`, `electron.*`, `svelte5.*`), never named after a project; project conventions enter through `vars` and `context.project_notes`, as in `examples/canopy/jev-review.yml`.
- Rule text is for Jev: English, literal, one narrow judgment per question, with concrete `criteria` for true and false. Question keys are not sent to the model, so the instructions must carry the full meaning. Jev cannot count; counting belongs in code (`state.ts` stats, `pattern`, `file_lines`).
- When a project's review history shows an established rule, the preset must detect and block violations of it; do not add exceptions that let the model excuse them.
- Measure every rule change with `npm run calibrate` on labeled rows in `eval/datasets/` (JSONL: `path` + `patch` or `pr`, labels `{violates, line | line_range}`), including negatives that look like positives. A rule blocks only at precision ≥ 90%. `eval/canopy/` holds the scripts and hand labels built from canopy-desktop; its builders redact private names on write.

## Releases and commits

Angular commit convention (`feat`, `fix`, `docs`; CI and release changes use `chore` or `ci`). The commit type decides the release: semantic-release (`.releaserc.json`, `.github/workflows/release.yml`, on every push to `main`) turns `fix` into a patch, `feat` into a minor and `BREAKING CHANGE:`/`feat!:` into a major release; other types release nothing. It bumps package.json, rebuilds and commits `dist/` and the schema, tags `vX.Y.Z`, moves the major tag (`v1`) that action users pin (`scripts/move-major-tag.sh`) and publishes to npm through trusted publishing (OIDC, no token). Never edit `version` by hand; the trusted publisher on npmjs.com is bound to the file name `release.yml`.
