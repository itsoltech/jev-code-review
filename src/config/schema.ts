import { z } from "zod";

export const SEVERITIES = ["blocker", "major", "minor", "info"] as const;
export const Severity = z.enum(SEVERITIES);
export type Severity = z.infer<typeof Severity>;

/** Instructions and criteria entries: text, or structured JSON as the TypeSafe API accepts. */
const Entry = z.union([z.string(), z.record(z.string(), z.json()), z.array(z.json())]);
const Probability = z.number().min(0).max(1);
const Band = z
  .tuple([Probability, Probability])
  .refine(([lo, hi]) => lo <= hi, "band must be [low, high] with low <= high");
const Globs = z.array(z.string().min(1));

const ruleBase = {
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i, "use letters, digits, '.', '_' or '-'"),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  scope: z.enum(["hunk", "file", "pr"]).default("hunk"),
  paths: Globs.default(["**/*"]),
  exclude_paths: Globs.default([]),
  severity: Severity.default("major"),
  instructions: Entry,
  /** Ask Jev which added line the finding is on (hunk and file scope). */
  locate: z.boolean().default(true),
  /** Minimum confidence of the location choice (and of score/choice answers). */
  min_confidence: Probability.default(0.5),
  /** Overrides `uncertainty.needs_human_band` for this rule. */
  needs_human_band: Band.optional(),
  /** Mustache-style comment body; falls back to `output.comment_template`. */
  template: z.string().optional(),
  /** Marks the prompt-injection guard; its findings block APPROVE. */
  guard: z.boolean().default(false),
  /**
   * Ask Jev only when an added line matches (hunk and file scope). A cheap regex finds
   * candidates; the model judges them.
   */
  candidate_regex: z.string().refine((r) => { try { new RegExp(r); return true; } catch { return false; } }, "invalid regular expression").optional(),
  /** Ask the rule only when these hold (checked in code before any request). */
  when: z
    .object({
      /** Regex the PR title must match, e.g. "^feat". */
      title_matches: z.string().optional(),
      /** At least one changed file must match one of these globs. */
      files_changed: Globs.optional(),
      /** No changed file may match any of these globs. */
      files_unchanged: Globs.optional(),
      /** Every changed file must match one of these globs. */
      files_only: Globs.optional(),
      /** These description sections (by heading, case-insensitive) must exist and have content. */
      sections_filled: z.array(z.string().min(1)).optional(),
    })
    .optional(),
};

export const NoulRule = z.object({
  ...ruleBase,
  type: z.literal("noul"),
  criteria: z.object({ true: Entry.optional(), false: Entry.optional() }).optional(),
  /**
   * Which answer is the problem. "no" lets a rule ask the natural question
   * ("Does the description explain why?") and fire when the answer is no.
   */
  fires_on: z.enum(["yes", "no"]).default("yes"),
  /** Probability of the `fires_on` answer at or above this is a confirmed finding. */
  threshold: Probability.default(0.7),
});

export const ScoreRule = z.object({
  ...ruleBase,
  type: z.literal("score"),
  criteria: z.array(Entry).min(2).max(10),
  /** Which end of the rubric is bad. Level 0 is the first criteria entry. */
  direction: z.enum(["higher_is_worse", "lower_is_worse"]).default("higher_is_worse"),
  /** Normalized badness (0..1) at or above this is a confirmed finding. */
  threshold: Probability.default(0.66),
});

export const ChoiceRule = z.object({
  ...ruleBase,
  type: z.literal("choice"),
  criteria: z
    .record(z.string(), Entry.nullable())
    .refine((c) => Object.keys(c).length >= 2 && Object.keys(c).length <= 255, "2 to 255 options"),
  /** Options that count as findings, with their severity. Other options are fine. */
  finding_labels: z.record(z.string(), Severity),
  /** Probability of the finding label at or above this is a confirmed finding. */
  threshold: Probability.default(0.6),
});

/** Exact format checks done in code with a regex; no model call. */
export const PatternRule = z.object({
  ...ruleBase,
  type: z.literal("pattern"),
  /** Set from `field`: "hunk" for added_lines, "pr" otherwise. */
  scope: z.enum(["pr", "hunk"]).default("pr"),
  locate: z.boolean().default(false),
  instructions: Entry.optional(),
  /**
   * "title", "description", "section:<heading>" for one description section ("" when missing),
   * or "added_lines": each added line of the diff in files matching `paths` (fires on the first match).
   */
  field: z.union([
    z.enum(["title", "description", "added_lines"]),
    z.string().regex(/^section:.+$/, 'use "title", "description", "added_lines" or "section:<heading>"'),
  ]),
  regex: z.string().refine(isValidRegex, "invalid regular expression"),
  flags: z.string().regex(/^[imsu]*$/).default(""),
  /** added_lines only: lines matching this are skipped (allowed exceptions). */
  ignore_regex: z.string().refine(isValidRegex, "invalid regular expression").optional(),
  /** added_lines only: skip a line when the line above matches, e.g. a justification comment. */
  unless_previous_line: z.string().refine(isValidRegex, "invalid regular expression").optional(),
  /** match: the regex describes the problem; no_match: the regex describes the required format. */
  fires_when: z.enum(["match", "no_match"]).default("no_match"),
});

function isValidRegex(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

/** Files that grow past a line limit, counted in code from the file at the PR head. */
export const FileLinesRule = z.object({
  ...ruleBase,
  type: z.literal("file_lines"),
  scope: z.literal("file").default("file"),
  locate: z.literal(false).default(false),
  instructions: Entry.optional(),
  /** Accepts a number or a {{vars.x}} string. */
  max_lines: z.coerce.number().int().positive(),
});

export const Rule = z.discriminatedUnion("type", [NoulRule, ScoreRule, ChoiceRule, PatternRule, FileLinesRule]);
export type Rule = z.infer<typeof Rule>;
export type NoulRule = z.infer<typeof NoulRule>;
export type ScoreRule = z.infer<typeof ScoreRule>;
export type ChoiceRule = z.infer<typeof ChoiceRule>;
export type PatternRule = z.infer<typeof PatternRule>;
export type FileLinesRule = z.infer<typeof FileLinesRule>;
/** Rules answered by Jev; pattern and file_lines rules are checked in code. */
export type ModelRule = Exclude<Rule, PatternRule | FileLinesRule>;

export const Dimension = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  scope: z.enum(["hunk", "pr"]).default("hunk"),
  paths: Globs.default(["**/*"]),
  exclude_paths: Globs.default([]),
  weight: z.number().positive().default(1),
  instructions: Entry,
  /** Ordered from worst (level 0) to best. */
  criteria: z.array(Entry).min(2).max(10),
  /** Answers below this confidence are left out of the composite. */
  min_confidence: Probability.default(0.4),
});
export type Dimension = z.infer<typeof Dimension>;

const DEFAULT_TEMPLATE = [
  "**{{severity_label}}** · `{{rule.id}}`: {{rule.description}}",
  "",
  "Jev probability: {{probability|pct}}{{#confidence}} · confidence {{confidence|pct}}{{/confidence}}{{#label}} · `{{label}}`{{/label}}",
  "{{#needs_human}}",
  "_Uncertain: a human reviewer should check this._",
  "{{/needs_human}}",
].join("\n");

/** Preset parameters, referenced from rules as {{vars.name}}; see src/config/vars.ts. */
export const Vars = z.record(z.string().regex(/^[A-Za-z0-9_]+$/), z.union([z.string(), z.array(z.string())]));

export const Settings = z.object({
  version: z.literal(1).default(1),
  vars: Vars.default({}),
  model: z.string().default("jev-latest"),
  files: z
    .object({
      include: Globs.default(["**/*"]),
      exclude: Globs.default([
        "**/*.lock",
        "**/package-lock.json",
        "**/pnpm-lock.yaml",
        "**/dist/**",
        "**/*.min.*",
        "**/__snapshots__/**",
        "**/*.snap",
      ]),
      /** Files with more changed lines than this are not reviewed. */
      max_file_changes: z.number().int().positive().default(1500),
    })
    .prefault({}),
  budget: z
    .object({
      max_hunks: z.number().int().positive().default(150),
      max_request_tokens: z.number().int().positive().max(64000).default(48000),
      /** Fewer questions per request means smaller, faster requests that time out less. */
      max_questions_per_request: z.number().int().min(1).max(200).default(16),
      max_state_plus_question_tokens: z.number().int().positive().max(32000).default(28000),
      /** Input tokens per run; at $0.042 per million tokens, 5M costs about $0.21. */
      max_run_tokens: z.number().int().positive().default(5000000),
      concurrency: z.number().int().min(1).max(32).default(8),
      run_timeout_seconds: z.number().int().positive().default(600),
      /** Attempts per request after rate limits, overload, timeouts or connection failures. */
      request_attempts: z.number().int().min(1).max(10).default(4),
      request_timeout_seconds: z.number().int().positive().default(30),
    })
    .prefault({}),
  context: z
    .object({
      include_pr_title: z.boolean().default(true),
      /** Send the PR description with PR-scope questions. Author-controlled text; off by default. */
      include_pr_body: z.boolean().default(false),
      max_hunk_lines: z.number().int().min(4).max(250).default(120),
      /** eager: location question sent with every rule; two_phase: only for rules that fired. */
      location_strategy: z.enum(["eager", "two_phase"]).default("eager"),
      /** Project conventions and contracts sent with every question, e.g. what an empty list means. */
      project_notes: z.string().optional(),
    })
    .prefault({}),
  uncertainty: z
    .object({
      needs_human_band: Band.default([0.4, 0.7]),
      label: z.string().default("needs-human-review"),
    })
    .prefault({}),
  policy: z
    .object({
      request_changes: z
        .object({
          severities: z.array(Severity).default(["blocker"]),
          composite_below: Probability.optional(),
        })
        .prefault({}),
      approve: z
        .object({
          enabled: z.boolean().default(false),
          max_findings: z.partialRecord(Severity, z.number().int().min(0)).default({ blocker: 0, major: 0 }),
          composite_at_least: Probability.default(0.8),
          no_needs_human: z.boolean().default(true),
        })
        .prefault({}),
      fail_check: z
        .object({
          severities: z.array(Severity).default(["blocker"]),
          composite_below: Probability.optional(),
        })
        .prefault({}),
      /** What to do when Jev or GitHub calls fail. */
      on_error: z.enum(["neutral", "fail"]).default("neutral"),
    })
    .prefault({}),
  output: z
    .object({
      inline_comments: z.boolean().default(true),
      max_inline_comments: z.number().int().min(0).max(100).default(25),
      summary_comment: z.boolean().default(true),
      review: z.boolean().default(true),
      /** comment_only never posts REQUEST_CHANGES; blocking happens through the failed check. */
      review_events: z.enum(["full", "comment_only"]).default("full"),
      check_run: z.boolean().default(false),
      job_summary: z.boolean().default(true),
      labels: z.boolean().default(true),
      comment_template: z.string().default(DEFAULT_TEMPLATE),
    })
    .prefault({}),
  skip: z
    .object({
      drafts: z.boolean().default(true),
      authors: z.array(z.string()).default(["dependabot[bot]", "renovate[bot]"]),
      labels: z.array(z.string()).default(["skip-jev"]),
    })
    .prefault({}),
});

export const ResolvedConfig = Settings.extend({
  rules: z.array(Rule).default([]),
  dimensions: z.array(Dimension).default([]),
});
export type ResolvedConfig = z.infer<typeof ResolvedConfig>;

/** A partial entry that changes an inherited rule or dimension by id. */
const Override = z
  .object({ id: z.string().min(1), enabled: z.boolean().optional() })
  .catchall(z.unknown());

/** Shape of one YAML file before merging; used for the editor JSON Schema. */
export const ConfigFile = z.object({
  $schema: z.string().optional(),
  extends: z.array(z.string()).default([]),
  version: z.literal(1).optional(),
  model: z.string().optional(),
  vars: Vars.optional(),
  files: Settings.shape.files.unwrap().partial().optional(),
  budget: Settings.shape.budget.unwrap().partial().optional(),
  context: Settings.shape.context.unwrap().partial().optional(),
  uncertainty: Settings.shape.uncertainty.unwrap().partial().optional(),
  policy: Settings.shape.policy.unwrap().partial().optional(),
  output: Settings.shape.output.unwrap().partial().optional(),
  skip: Settings.shape.skip.unwrap().partial().optional(),
  rules: z.array(z.union([Rule, Override])).optional(),
  dimensions: z.array(z.union([Dimension, Override])).optional(),
});
