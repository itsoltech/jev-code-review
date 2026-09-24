import picomatch from "picomatch";
import { ConfigError, loadConfig } from "./config/load.js";
import type { ResolvedConfig } from "./config/schema.js";
import { parsePatch, type Hunk } from "./diff/parse.js";
import { splitHunk } from "./diff/split.js";
import { noopEscalator } from "./escalation/noop.js";
import type { Escalator } from "./escalation/types.js";
import { packQuestions, type PlannedRequest } from "./jev/batch.js";
import { emptyEvaluation, errorMessage, evaluate, type JevPort } from "./jev/evaluate.js";
import { activeRules, canLocate, isModelRule, QuestionKeys, questionsFor, ruleApplies, whereQuestion } from "./jev/questions.js";
import { buildState, fileSubject, hunkSubject } from "./jev/state.js";
import { computeComposite } from "./policy/composite.js";
import { abstentions, compareFindings, deriveFindings, fileLinesFindings, judge, linePatternFindings, patternFindings } from "./policy/findings.js";
import { countBySeverity, decide, type RunHealth } from "./policy/verdict.js";
import type { GitHubPort } from "./ports.js";
import { publish, type PublishResult } from "./report/publish.js";
import { renderSummary, type ReviewReport } from "./report/summary.js";
import type { ChangedFile, PrInfo, SkippedFile, Subject } from "./types.js";

/** Hunks are not cut below this many lines when they do not fit the context window. */
const MIN_WINDOW_LINES = 8;

export interface RunInputs {
  configPath: string;
  /** Read config from the base commit (default; a PR cannot weaken its own review) or the head. */
  configRef: "base" | "head";
  model?: string;
  dryRun: boolean;
  allowForkPrs: boolean;
  /** Overrides `policy.on_error` when set. */
  failOnError?: boolean;
}

export interface Log {
  info(message: string): void;
  warning(message: string): void;
}

export interface RunDeps {
  gh: GitHubPort;
  /** Built after the config is loaded so client settings can come from it. */
  createJev: (cfg: ResolvedConfig) => JevPort;
  pr: PrInfo;
  log: Log;
  escalator?: Escalator;
}

export interface RunResult {
  status: "reviewed" | "skipped" | "config_error";
  message?: string;
  /** Whether the action should fail its check. */
  failed: boolean;
  report?: ReviewReport;
  published?: PublishResult;
  /** Markdown for the job summary. */
  summary: string;
}

export async function run(inputs: RunInputs, deps: RunDeps): Promise<RunResult> {
  const { gh, pr, log } = deps;

  if (pr.isFork && !inputs.allowForkPrs) {
    const message = "Pull request comes from a fork and allow-fork-prs is false; skipping.";
    return { status: "skipped", message, failed: false, summary: message };
  }

  let cfg: ResolvedConfig;
  let sources: string[];
  const warnings: string[] = [];
  try {
    const ref = inputs.configRef === "head" ? pr.headSha : pr.baseSha;
    const loaded = await loadConfig(inputs.configPath, (path) => gh.readFile(path, ref));
    ({ config: cfg, sources } = loaded);
    warnings.push(...loaded.warnings);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    const message = `Invalid Jev review config:\n${e.message}`;
    return { status: "config_error", message, failed: true, summary: `### Jev review: config error\n\n\`\`\`\n${e.message}\n\`\`\`` };
  }
  if (inputs.failOnError !== undefined) cfg.policy.on_error = inputs.failOnError ? "fail" : "neutral";

  const skip = skipReason(pr, cfg);
  if (skip) return { status: "skipped", message: skip, failed: false, summary: `Jev review skipped: ${skip}` };

  const model = inputs.model || cfg.model;
  if (/-(latest|preview)$/.test(model)) {
    warnings.push(`Model alias ${model} can change without notice; pin a version such as jev-1.13.0 once thresholds are tuned.`);
  }

  const files = await gh.listFiles();
  // Rules whose `when` does not hold for this PR are dropped before any request.
  cfg = { ...cfg, rules: activeRules(cfg.rules, pr, files) };
  const { subjects, skippedFiles } = buildSubjects(files, cfg);
  const keys = new QuestionKeys();
  const limits = {
    maxRequestTokens: cfg.budget.max_request_tokens,
    maxStatePlusQuestionTokens: cfg.budget.max_state_plus_question_tokens,
    maxQuestions: cfg.budget.max_questions_per_request,
  };
  const eager = cfg.context.location_strategy === "eager";

  const requests: PlannedRequest[] = [];
  let oversized = 0;
  const states = new Map<string, unknown>();
  const work = [...subjects];
  while (work.length) {
    const subject = work.shift()!;
    const { questions } = questionsFor(subject, cfg, keys, eager ? "eager" : "none");
    if (!questions.length) continue;
    const state = buildState(subject, pr, files, cfg);
    const packed = packQuestions(subject, state, questions, limits);
    // A hunk too large for the context window is cut into smaller windows and asked again.
    if (packed.oversized.length && subject.kind === "hunk" && subject.hunk.lines.length > MIN_WINDOW_LINES) {
      const half = Math.ceil(subject.hunk.lines.length / 2);
      splitHunk(subject.hunk, half).forEach((h, i) => work.unshift(hunkSubject(`${subject.key}.${i}`, h)));
      continue;
    }
    states.set(subject.key, state);
    requests.push(...packed.requests);
    oversized += packed.oversized.length;
  }

  const jev = deps.createJev(cfg);
  const signal = AbortSignal.timeout(cfg.budget.run_timeout_seconds * 1000);
  const evalOpts = {
    model,
    concurrency: cfg.budget.concurrency,
    maxRunTokens: cfg.budget.max_run_tokens,
    maxAttempts: cfg.budget.request_attempts,
    signal,
  };
  log.info(`Sending ${requests.length} request(s) to ${model} for ${states.size} unit(s).`);
  const evaluation = await evaluate(requests, jev, evalOpts, emptyEvaluation());

  if (!eager) {
    // Two-phase: ask where-questions only for rules that fired.
    const followUps: PlannedRequest[] = [];
    const fired = new Map<string, { subject: Subject; ruleIds: string[] }>();
    const rules = new Map(cfg.rules.filter(isModelRule).map((r) => [r.id, r]));
    for (const [key, m] of keys.meta) {
      const rule = rules.get(m.target);
      const answer = evaluation.answers.get(key);
      if (m.role !== "verdict" || !rule || !answer || !canLocate(rule, m.subject) || !judge(rule, answer, cfg)) continue;
      const entry = fired.get(m.subject.key) ?? { subject: m.subject, ruleIds: [] };
      entry.ruleIds.push(rule.id);
      fired.set(m.subject.key, entry);
    }
    for (const { subject, ruleIds } of fired.values()) {
      const questions = ruleIds.map((id) => {
        const rule = rules.get(id)!;
        const meta = { subject, role: "where" as const, target: id };
        return { key: keys.next(meta), question: whereQuestion(rule, subject) };
      });
      const packed = packQuestions(subject, states.get(subject.key), questions, limits);
      followUps.push(...packed.requests);
      oversized += packed.oversized.length;
    }
    if (followUps.length) {
      log.info(`Locating ${followUps.length} request(s) of fired rules.`);
      requests.push(...followUps);
      await evaluate(followUps, jev, evalOpts, evaluation);
    }
  }

  for (const m of evaluation.models) {
    if (!model.endsWith("-latest") && !model.endsWith("-preview") && m !== model && !m.startsWith(`${model}.`)) {
      warnings.push(`Requested model ${model} but ${m} answered.`);
    }
  }

  const sizeFindings = await fileLinesFindings(cfg.rules, files, (path) => gh.readFile(path, pr.headSha));
  let findings = [
    ...patternFindings(cfg.rules, pr),
    ...sizeFindings,
    ...linePatternFindings(cfg.rules, subjects),
    ...deriveFindings(keys.meta, evaluation.answers, cfg),
  ].sort(compareFindings);
  const escalator = deps.escalator ?? noopEscalator;
  const uncertain = findings.filter((f) => f.status === "needs_human");
  if (uncertain.length && escalator !== noopEscalator) {
    const replaced = await escalator.escalate(uncertain, { pr, config: cfg });
    findings = [...findings.filter((f) => f.status !== "needs_human"), ...replaced].sort(compareFindings);
  }

  const composite = computeComposite(keys.meta, evaluation.answers, cfg);
  const health: RunHealth = {
    errors: evaluation.errors.length,
    skippedRequests: evaluation.skippedRequests.length,
    skippedByBudget: evaluation.skippedRequests.filter((s) => s.reason === "budget").length,
    skippedByBlock: evaluation.skippedRequests.filter((s) => s.reason === "blocked").length,
    retries: evaluation.retries,
    splits: evaluation.splits,
    oversizedQuestions: oversized,
    abstentions: abstentions(keys.meta, evaluation.answers, cfg),
    skippedFiles,
  };
  const verdict = decide(findings, composite.composite, health, cfg);

  const report: ReviewReport = {
    pr,
    verdict,
    findings,
    composite,
    health,
    models: [...evaluation.models],
    inputTokens: evaluation.inputTokens,
    requests: requests.length - evaluation.skippedRequests.length,
    reviewedSubjects: states.size,
    sources,
    warnings,
    errors: evaluation.errors.map((e) => `${e.subjectKey}: ${e.message}`),
  };
  for (const w of warnings) log.warning(w);
  for (const e of report.errors) log.warning(`Jev request failed: ${e}`);

  let published: PublishResult | undefined;
  if (!inputs.dryRun) {
    try {
      published = await publish(report, gh, cfg);
      for (const w of published.warnings) log.warning(w);
    } catch (e) {
      log.warning(`Publishing the review failed: ${errorMessage(e)}`);
    }
  }

  const counts = countBySeverity(findings);
  log.info(
    `Verdict ${verdict.event}${verdict.failCheck ? " (check fails)" : ""}: ` +
      `${counts.blocker} blocker, ${counts.major} major, ${counts.minor} minor, ${counts.info} info.`,
  );
  return {
    status: "reviewed",
    failed: verdict.failCheck,
    report,
    published,
    summary: published?.summary ?? renderSummary(report, new Set()),
  };
}

export function skipReason(pr: PrInfo, cfg: ResolvedConfig): string | undefined {
  if (cfg.skip.drafts && pr.draft) return "draft pull request";
  if (cfg.skip.authors.includes(pr.author)) return `author ${pr.author} is in skip.authors`;
  const label = pr.labels.filter((l) => cfg.skip.labels.includes(l))[0];
  if (label) return `label ${label}`;
  return undefined;
}

export function buildSubjects(files: ChangedFile[], cfg: ResolvedConfig) {
  const include = picomatch(cfg.files.include, { dot: true });
  const exclude = cfg.files.exclude.length ? picomatch(cfg.files.exclude, { dot: true }) : () => false;
  const skippedFiles: SkippedFile[] = [];
  const subjects: Subject[] = [];
  let hunkCount = 0;

  for (const file of files) {
    if (file.status === "removed") skippedFiles.push({ path: file.path, reason: "removed" });
    else if (!include(file.path) || exclude(file.path)) skippedFiles.push({ path: file.path, reason: "excluded" });
    else if (!file.patch) skippedFiles.push({ path: file.path, reason: "no_patch" });
    else if (file.additions + file.deletions > cfg.files.max_file_changes) skippedFiles.push({ path: file.path, reason: "too_large" });
    else {
      const hunks = parsePatch(file.path, file.patch).flatMap((h) => splitHunk(h, cfg.context.max_hunk_lines));
      const withAdds = hunks.filter((h) => h.lines.some((l) => l.kind === "add"));
      if (!withAdds.length) continue; // pure deletions: nothing to comment on
      if (hunkCount + withAdds.length > cfg.budget.max_hunks) {
        skippedFiles.push({ path: file.path, reason: "budget" });
        continue;
      }
      hunkCount += withAdds.length;
      withAdds.forEach((h: Hunk, i) => subjects.push(hunkSubject(`${file.path}#${i}`, h)));
      const fileSub = fileSubject(`${file.path}#file`, file.path, withAdds);
      if (cfg.rules.some((r) => ruleApplies(r, fileSub))) subjects.push(fileSub);
    }
  }

  const prSubject: Subject = { kind: "pr", key: "pr" };
  if (cfg.rules.some((r) => r.scope === "pr" && isModelRule(r)) || cfg.dimensions.some((d) => d.scope === "pr")) subjects.push(prSubject);
  return { subjects, skippedFiles };
}
