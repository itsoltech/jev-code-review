# Jev code review

A GitHub Action and a CLI that review pull requests with [TypeSafe Jev](https://docs.typesafe.ai). Review rules, thresholds and the verdict policy are defined in a YAML file in each repository.

Jev is a System One model: it does not write text, it returns typed judgments with probabilities (a yes/no probability, a choice between options, or a score on a rubric). This action uses that split deliberately. Each rule in the config is one narrow question. Jev answers it for every changed hunk, code turns the probabilities into findings, and the verdict (approve, comment, request changes, fail the check) is decided by the policy in the config. Comment text comes from templates, so nothing in a comment is generated from the diff.

## How a review runs

1. The config is read from the PR base commit, so a pull request cannot relax its own review rules.
2. Changed files are fetched through the API. Excluded, binary, oversized and removed files are listed in the summary instead of being reviewed.
3. Each hunk becomes one `state` with numbered lines (`L001 + code`). For every rule whose `paths` match, the action asks the rule's question, plus a Choice over the added-line ids to find where the problem is. All questions for a hunk go in one request, packed under Jev's token limits (64k per request, 32k for the state plus the longest question).
4. Probabilities become findings: at or above `threshold` is confirmed, inside `needs_human_band` is marked as needing a human, below is dropped. A location is only used when the rule fired and the location answer is confident.
5. Dimensions (Score questions) are normalized to 0..1, averaged over hunks weighted by added lines, and combined with your weights into a composite score.
6. The policy produces the verdict. The action posts inline comments on the flagged lines, one sticky summary comment, a formal review, a `needs-human-review` label when something is uncertain, and fails the job (a required check) when `policy.fail_check` says so.

Re-runs update the summary comment in place and skip inline comments that were already posted (each carries a fingerprint of rule, file and line text). When a PR that was blocked is fixed, the earlier REQUEST_CHANGES review is dismissed.

## Setup

Add `TYPESAFE_API_KEY` as a repository or organization secret, then add the workflow from [examples/workflow.yml](examples/workflow.yml):

```yaml
on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
  pull-requests: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: itsoltech/jev-code-review@v1
        with:
          typesafe-api-key: ${{ secrets.TYPESAFE_API_KEY }}
```

Without a config file the action uses `jev:recommended`. To block merges, mark the job as a required status check in branch protection.

## CLI

The same review runs outside GitHub Actions with the npm package [`@itsoltech/jev-code-review`](https://www.npmjs.com/package/@itsoltech/jev-code-review) (Node 20+ or Bun). It reads `TYPESAFE_API_KEY` from the environment or from `.env` in the current directory.

```sh
npx @itsoltech/jev-code-review                  # this branch against origin's default branch
bunx @itsoltech/jev-code-review --base develop   # against another branch
npx @itsoltech/jev-code-review --staged          # staged changes, for a pre-commit hook
git diff main... | npx @itsoltech/jev-code-review --diff - --title "Add search"
npx @itsoltech/jev-code-review --pr 342          # a GitHub pull request, read-only
npx @itsoltech/jev-code-review --pr 342 --post   # and publish the review like the action
```

A local change is the working tree (committed and uncommitted changes, without untracked files) against the merge base with `--base`. The pull request title is the oldest commit subject and the description is the commit messages, unless `--title` and `--body-file` are given. The config is `.github/jev-review.yml` from the working tree, or `--config <path>`; with `--pr` it is read from the base commit, as in the action, unless `--config` is given. `--pr` needs `GITHUB_TOKEN`, `GH_TOKEN` or a `gh auth login`, and uses the `origin` remote unless `--repo owner/name` is given. Nothing is written to GitHub without `--post`.

`--format` is `text` (default), `markdown` (the summary comment), `json` or `sarif` (for `github/codeql-action/upload-sarif` and editors); `--output <file>` writes it to a file. The exit code is 0 when the review passes, 1 when `policy.fail_check` fails it (or a request fails with `policy.on_error: fail`), and 2 for usage, config or setup errors. Run `npx @itsoltech/jev-code-review --help` for all options.

## Configuration

Put the config at `.github/jev-review.yml`. Add the schema comment on the first line for autocomplete and validation in editors with the YAML language server:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/itsoltech/jev-code-review/v1/schema/jev-review.schema.json
extends: ["jev:recommended"]
model: jev-1.13.0
rules:
  - id: sec.sql-concat        # tune an inherited rule
    threshold: 0.8
  - id: corr.todo-added       # turn one off
    enabled: false
  - id: team.no-console
    type: noul
    severity: minor
    paths: ["src/**/*.ts"]
    instructions: Does any added line (marked "+") in `changes.lines` call console.log?
```

[examples/jev-review.yml](examples/jev-review.yml) shows every section with comments. The full reference is the JSON Schema in [schema/jev-review.schema.json](schema/jev-review.schema.json), generated from [src/config/schema.ts](src/config/schema.ts).

Configs merge in this order: the built-in `jev:base` (the prompt-injection guard), then each `extends` entry, then the file itself. Settings merge deeply; `rules` and `dimensions` merge by `id`, where a later entry replaces the fields it sets and `enabled: false` removes the entry. `extends` accepts built-in presets and paths inside the repository. Remote URLs are rejected.

| Preset | Contents |
| --- | --- |
| `jev:security` | SQL built from variables, hardcoded secrets, shell commands built from variables, unescaped HTML, disabled TLS verification, secrets in logs |
| `jev:correctness` | swallowed errors, leftover debugging code, unawaited promises (JS/TS), new TODO comments |
| `jev:tests` | behavior changed without test changes (PR scope) |
| `jev:style` | naming score rule, readability dimension |
| `jev:recommended` | security, correctness, tests, plus a PR focus dimension |
| `jev:pr-description` | title is specific, title marked unfinished, description says what, why and how it was tested, issue reference, unfilled template (turns on `context.include_pr_body`) |
| `jev:conventional-title` | title prefix, length, lowercase, trailing period, user-facing prefix on an infrastructure-only change (all regex) |
| `jev:pr-template` | What/Why sections present (regex), What is concrete, Why gives a reason, user impact for user-facing prefixes (Jev) |
| `jev:docs-sync` | behavior change without docs (Jev), new IPC handler or error variant without docs (regex) |
| `jev:result-errors` | try/catch outside the allowed boundaries (Jev), `throw new Error` (regex) |
| `jev:electron` | Node imports in the renderer, send/on IPC, channel naming, generic preload invoke, sync fs in main, OS-only labels (regex); unvalidated renderer input in IPC handlers (Jev) |
| `jev:svelte5` | `$effect` without cleanup, `$effect` that should be `$derived` (Jev), legacy `export let` (regex), component size (`file_lines`) |
| `jev:async-state` | result written after `await` without a staleness check (Jev) |
| `jev:theming` | hardcoded colors (regex) |
| `jev:pattern-matching` | `switch` instead of a matcher library (regex) |
| `jev:type-hygiene` | `any` without a justification comment (regex with `unless_previous_line`) |
| `jev:code-slop` | 24 concrete anti-patterns ("AI slop"): failures returned as success, async Promise executors, casts instead of validation, tests without real assertions, placeholders that report success and more; each a present / absent / insufficient_context Choice with a candidate regex |

### Preset variables

Presets hold the rules; a project supplies its conventions through `vars`, so the same preset serves different codebases. A rule string can contain `{{vars.name}}`. A list is joined as "a, b or c" (`|and`, `|semi` and `|regex` join differently), a list element that is exactly `"{{vars.name}}"` expands into the items (for `paths`), and `{{vars.name?}}` is optional. Presets declare defaults in their own `vars:`; a variable a rule needs but nobody sets is a config error naming the rule, unless the rule is disabled.

```yaml
extends: [jev:result-errors, jev:electron]
vars:
  result_paths: ["src/main/**/*.ts"]
  result_type: a neverthrow Result or ResultAsync
  external_call_wrapper: fromExternalCall()
  allowed_try_catch: [killing or cleaning up a PTY or child process, JSON.parse of untrusted text]
  main_paths: ["src/main/**"]
  input_validators: [validatePathAccess(), an allowlist check]
```

Each preset file in [src/presets](src/presets) lists its variables with defaults at the top. [examples/canopy/jev-review.yml](examples/canopy/jev-review.yml) configures one real project and [eval/control/jev-review.yml](eval/control/jev-review.yml) another with different conventions; both are measured on labeled data.

`context.project_notes` is free text sent with every question: the project's contracts that a hunk does not show (what an empty list means, which calls are best effort). Rules that depend on a contract, such as most of `jev:code-slop`, answer `insufficient_context` without it.

### Rules

Every rule has an `id`, a `type`, `instructions` and optional `criteria`, following the TypeSafe primitives:

- `noul`: a yes/no question. `threshold` applies to P(yes), or to P(no) with `fires_on: "no"`, which lets a rule ask the natural question ("Does the description explain why?") and fire when the answer is no.
- `score`: an ordered rubric (2 to 10 levels). The answer is normalized to 0..1; `direction` says which end is bad and `threshold` applies to the bad end.
- `choice`: named options. `finding_labels` maps the options that count as problems to a severity.
- `pattern`: a regular expression checked in code, with no model call. Use it for exact formats. `field` is `title`, `description`, `section:<heading>` (one section of the description, empty when missing or left as a template comment) or `added_lines` (each added line in files matching `paths`, reported inline on the first match; `ignore_regex` skips allowed exceptions, `unless_previous_line` skips a line whose predecessor matches, such as a justification comment). `fires_when: no_match` means the regex describes the required format, `match` means it describes the problem.
- `file_lines`: a changed file longer than `max_lines` at the PR head, counted in code.

`candidate_regex` on a Jev rule is a pre-filter: the rule is asked only when an added line matches, so a regex finds candidates and Jev judges them.

Jev is the right tool when a check needs reading ("does the Why explain a reason?"). When the answer can be computed (title length, a prefix, a literal color, a forbidden import), a `pattern` rule is exact, free and never drifts. On canopy-desktop, the LLM validator miscounted title lengths and applied the prefix list inconsistently; the regex rules had no errors ([eval/canopy/README.md](eval/canopy/README.md)).

`when` limits a rule to pull requests where it makes sense, checked in code before any request: `title_matches` (regex on the title), `files_changed`, `files_unchanged` and `files_only` (globs), and `sections_filled` (description sections that must have content). For example, a rule that judges the quality of the Why section runs only when that section exists and a `pattern` rule reports when it is missing.

With `context.include_pr_body: true`, PR-scope questions get the description and, parsed in code, `pr.description_sections` (keyed by lowercase heading, template comments removed), `pr.description_is_empty` and `pr.checklist_items`. Questions can point at one section, such as `pr.description_sections.why`.

`scope` is `hunk` (default), `file` (all hunks of a file in one state) or `pr` (title, file list and counts computed in code). `severity` is `blocker`, `major`, `minor` or `info`. `template` overrides `output.comment_template` and can use `{{rule.id}}`, `{{rule.description}}`, `{{severity_label}}`, `{{probability|pct}}`, `{{confidence|pct}}`, `{{label}}`, `{{path}}`, `{{line}}`, `{{snippet}}` and sections such as `{{#needs_human}}...{{/needs_human}}`.

Jev reads questions literally, so rules work best when they name the exact condition and put boundary cases in `criteria`. Ask about added lines, keep one judgment per rule, and leave counting and arithmetic to code. Instructions must be self-contained: the rule id is never sent to the model. English gives the best accuracy.

### Policy

```yaml
policy:
  request_changes: { severities: [blocker], composite_below: 0.35 }
  fail_check: { severities: [blocker], composite_below: 0.3 }
  approve:
    enabled: false
    max_findings: { blocker: 0, major: 0, minor: 3 }
    composite_at_least: 0.8
    no_needs_human: true
  on_error: neutral   # or fail
```

APPROVE is off by default. When enabled, the action never approves a run with failed requests, budget skips, unreviewed files, uncertain findings or a fired injection guard. Bot approvals also need the repository setting "Allow GitHub Actions to create and approve pull requests", and they count toward required approvals. With `output.review_events: comment_only` the action never posts REQUEST_CHANGES and blocks only through the failed check, which avoids stale blocking reviews on protected branches.

## Inputs and outputs

Inputs: `typesafe-api-key` (required), `github-token`, `config-path`, `config-ref` (`base` or `head`), `model`, `dry-run`, `allow-fork-prs`, `fail-on-error`, `job-summary`.

Outputs: `status`, `verdict`, `check-failed`, `composite-score`, `findings-count`, `blockers-count`, `needs-human`, `model`, `input-tokens`, `summary-comment-id`. See [action.yml](action.yml).

## Security

The diff is untrusted input. It is sent only inside `state`, with a notice that its text is data and not instructions, and it reaches comments only as a fenced code block. Findings, verdicts and comment text are produced by code and templates, so injected text can at most move probabilities. The built-in `meta.injection` rule flags added text addressed to AI reviewers; a hit blocks APPROVE and adds the needs-human label. The PR description is not sent unless `context.include_pr_body` is true, and then only with PR-scope questions, never with hunks.

`pull_request_target` gives the job secrets and a write token for PRs from forks. That is acceptable here only because the action never checks out or executes PR code: the diff comes from the API and the config from the base commit. Do not add `actions/checkout` of the PR head to the same job. Fork PRs are skipped unless `allow-fork-prs: true`; enabling it lets anyone who opens a PR spend your TypeSafe budget, so consider a label gate. With the plain `pull_request` trigger, fork PRs get no secrets and a read-only token, and the action skips them.

The workflow needs `contents: read` and `pull-requests: write`, plus `checks: write` only with `output.check_run: true`. The API key is masked, and the SDK is pinned to `warn` logging because its debug level logs request bodies. Changed code is sent to TypeSafe; use `files.exclude` for paths that must not leave the repository.

## Cost and limits

Requests are sent through a queue: rate limits (429), overload (5xx, 529), timeouts and connection failures are retried with backoff up to `budget.request_attempts` times, with fewer parallel requests while the API pushes back; a request the API rejects as too large, or one that times out, is split into two with half the questions each; a hunk that does not fit the context window is cut into smaller windows. `budget.max_questions_per_request` (default 16) keeps requests small. The summary says whether anything was skipped because of `budget.max_run_tokens` or `budget.run_timeout_seconds`, and how many requests were retried or split.

TypeSafe bills input tokens. The state is sent once per request and all questions for a hunk share it, so adding rules is cheaper than adding hunks. `budget.max_run_tokens`, `budget.max_hunks` and `files.max_file_changes` cap a run; anything skipped is listed in the summary and prevents APPROVE. `context.location_strategy: two_phase` sends location questions only for rules that fired, at the cost of a second round trip. The summary reports the model version and input tokens of every run.

## Calibration

Default thresholds are starting points. Before relying on a rule, measure it on labeled hunks from your own code:

```sh
TYPESAFE_API_KEY=... npm run calibrate -- --data eval/datasets/sample.jsonl --config .github/jev-review.yml
```

Each JSONL row holds either a `path` and a `patch`, or a `pr` with `title` and `body` for PR-scope rules, plus labels such as `{"sec.sql-concat": {"violates": true, "line": 12}}` where `violates` means the rule should fire (`line_range: [first, last]` accepts any line of a block-level finding). `eval/datasets/pr-description.jsonl` with `--config eval/configs/pr-description.yml` calibrates the PR description preset. The report gives precision and recall at the current threshold, the rows each rule got wrong, a suggested threshold that maximizes F0.5, location accuracy, and a YAML patch. `eval/datasets/sample.jsonl` is a small starter set; aim for at least 30 labeled hunks per rule, including negatives that look similar to the positives. Re-run calibration whenever the pinned model version changes.

To try a config on a local change or an existing pull request without posting anything, use the [CLI](#cli), or `npm run review-local` to run it from source:

```sh
npm run review-local -- --base main --config .github/jev-review.yml
npm run review-local -- --pr 342 --repo itsoltech/canopy-desktop --config examples/canopy/jev-review.yml
```
 `npm run scan-patterns -- --files <pr_files.json> --config <config>` runs the regex rules over saved PR diffs without Jev and prints how often each fires, to review a pattern before enabling it. [examples/canopy/jev-review.yml](examples/canopy/jev-review.yml) is a complete config for itsoltech/canopy-desktop, and [eval/canopy/README.md](eval/canopy/README.md) describes how it was built and measured from that repository's review history.

## Development

```sh
npm ci
npm run typecheck && npm test
npm run all      # typecheck, tests, schema and dist bundle
```

`dist/index.js` (the action), `dist/cli.js` (the npm CLI) and `schema/jev-review.schema.json` are committed; CI fails when they are stale. The pipeline is split into pure modules (`diff/`, `config/`, `jev/`, `policy/`, `report/`) and two ports (`GitHubPort`, `JevPort`), so tests run the full pipeline with an in-memory GitHub and the real TypeSafe SDK over a fake `fetch`. Uncertain findings pass through an `Escalator` interface ([src/escalation/types.ts](src/escalation/types.ts)) before the verdict; v1 ships a no-op, and a later version can send them to a reasoning model or a human queue.

Releases are automatic. On every push to `main`, [semantic-release](https://semantic-release.gitbook.io) reads the commit messages since the last tag (Angular convention): `fix` makes a patch release, `feat` a minor release, and `BREAKING CHANGE:` (or `feat!:`) a major release; `docs`, `chore`, `ci`, `test` and `refactor` release nothing. It bumps `version` in package.json, rebuilds `dist/` and the schema, commits them as `chore(release): X.Y.Z`, tags `vX.Y.Z`, moves the major tag (`v1`) that action users pin, publishes the npm package through npm trusted publishing (OIDC, no token in the repository) and writes the GitHub release notes. Do not edit `version` by hand.

## License

[MIT](LICENSE). Use, modify and redistribute it, including commercially; keep the copyright notice.
