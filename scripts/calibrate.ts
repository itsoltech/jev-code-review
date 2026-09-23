/**
 * Measure rules against labeled hunks and suggest thresholds.
 *
 *   TYPESAFE_API_KEY=... npm run calibrate -- --data eval/datasets/sample.jsonl [--config .github/jev-review.yml] [--beta 0.5]
 *
 * Dataset rows (JSONL), either a hunk or a pull request:
 *   {"id": "sql-1", "path": "src/a.ts", "patch": "@@ -1,0 +1,2 @@\n+...", "labels": {"sec.sql-concat": {"violates": true, "line": 2}}}
 *   {"id": "pr-1", "pr": {"title": "Fix bug", "body": ""}, "files": [...], "labels": {"pr.title-specific": {"violates": true}}}
 * `labels` lists only the rules the row is labeled for; `violates` means the rule should fire;
 * `line` is the new-file line of the violation; `line_range: [first, last]` accepts any line in a block.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "../src/config/load.js";
import type { ModelRule, Rule } from "../src/config/schema.js";
import { packQuestions, type PlannedRequest } from "../src/jev/batch.js";
import { emptyEvaluation, evaluate } from "../src/jev/evaluate.js";
import { createJevPort } from "../src/jev/jevPort.js";
import { activeRules, canLocate, hasCandidate, isModelRule, pathMatches, QuestionKeys, verdictQuestion, whereQuestion } from "../src/jev/questions.js";
import { buildState } from "../src/jev/state.js";
import { bandFor, fileLinesFindings, judge, linePatternFindings, locate, patternFindings } from "../src/policy/findings.js";
import { buildSubjects } from "../src/run.js";
import type { Answer, ChangedFile, PrInfo, Subject } from "../src/types.js";
import { arg, localGitHub, quietLogger, requireKey } from "./lib.js";

interface Row {
  id: string;
  path?: string;
  patch?: string;
  pr?: { title: string; body?: string };
  files?: ChangedFile[];
  /** Full file at the PR head, for file_lines rules. */
  file_text?: string;
  /** Facts about the code under review (its contract, callers), sent as `context` in the state. */
  context?: unknown;
  labels: Record<string, { violates: boolean; line?: number; line_range?: [number, number]; expected?: string }>;
}

interface Sample {
  rowId: string;
  ruleId: string;
  truth: boolean;
  truthLine?: number;
  /** Accepted lines for block-level findings; overrides truthLine when set. */
  truthRange?: [number, number];
  /** Choice rules: the option Jev picked and the one the row expects. */
  choice?: string;
  expected?: string;
  /** Strength of the finding in 0..1: P(yes), label probability or normalized badness. */
  score: number;
  line?: number;
}

const apiKey = requireKey();
const dataPath = arg("data") ?? "eval/datasets/sample.jsonl";
const beta = Number(arg("beta") ?? 0.5);
const rows: Row[] = readFileSync(dataPath, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const local = localGitHub([], arg("config"));
const { config: cfg } = await loadConfig(".github/jev-review.yml", (path) => local.readFile(path, "local"));
const model = arg("model") ?? cfg.model;
const rules = new Map(cfg.rules.map((r) => [r.id, r]));
const basePr: PrInfo = { number: 0, title: "", body: "", author: "", draft: false, labels: [], baseSha: "", headSha: "", isFork: false };

// Every row is judged for its labeled rules on every hunk; rule thresholds are ignored here.
const keys = new QuestionKeys();
const samples = new Map<string, Sample>();
const thresholdOf = (rule: Rule) => (isModelRule(rule) ? rule.threshold : 0.5);
const requests: PlannedRequest[] = [];
for (const row of rows) {
  const pr = { ...basePr, title: row.pr?.title ?? "", body: row.pr?.body ?? "" };
  let files: ChangedFile[];
  let subjects: Subject[];
  if (row.patch) {
    files = [{ path: row.path ?? "file", status: "modified", additions: 1, deletions: 0, patch: row.patch }];
    subjects = buildSubjects(files, { ...cfg, rules: [], dimensions: [] }).subjects;
  } else {
    files = row.files ?? [];
    subjects = [{ kind: "pr", key: "pr" }];
  }
  const applicable = new Set(activeRules(cfg.rules, pr, files).map((r) => r.id));
  for (const [ruleId, label] of Object.entries(row.labels)) {
    const rule = rules.get(ruleId);
    if (!rule) throw new Error(`row ${row.id}: unknown rule ${ruleId}`);
    // Rules checked in code (pattern, file_lines) are scored here so the report covers every rule.
    if ((rule.type === "pattern" || rule.type === "file_lines") && applicable.has(ruleId)) {
      const found =
        rule.type === "file_lines"
          ? await fileLinesFindings([rule], files, async () => row.file_text)
          : rule.field === "added_lines"
            ? linePatternFindings([rule], subjects)
            : patternFindings([rule], pr);
      samples.set(`${row.id}|${ruleId}`, {
        rowId: row.id,
        ruleId,
        truth: label.violates,
        truthLine: label.line,
        truthRange: label.line_range,
        score: found.length ? 1 : 0,
        line: found[0]?.location?.line,
      });
    }
  }
  for (const subject of subjects) {
    const questions = [];
    for (const ruleId of Object.keys(row.labels)) {
      const rule = rules.get(ruleId);
      // Rules whose `when` does not hold are never asked, so the label is not a sample.
      if (!rule || !isModelRule(rule) || !applicable.has(ruleId)) continue;
      // Production never asks a rule about files outside its paths or without a candidate line.
      if (subject.kind !== "pr" && (!pathMatches(rule, subject.path) || !hasCandidate(rule, subject))) {
        const label = row.labels[ruleId]!;
        samples.set(`${row.id}|${ruleId}`, { rowId: row.id, ruleId, truth: label.violates, score: 0, ...(label.expected ? { expected: label.expected } : {}) });
        continue;
      }
      const vmeta = { subject: { ...subject, key: `${row.id}|${subject.key}` }, role: "verdict" as const, target: ruleId };
      questions.push({ key: keys.next(vmeta), question: verdictQuestion(rule) });
      if (canLocate(rule, subject)) {
        const wmeta = { ...vmeta, role: "where" as const };
        questions.push({ key: keys.next(wmeta), question: whereQuestion(rule, subject) });
      }
    }
    const base = buildState(subject, pr, files, cfg);
    const state = row.context === undefined ? base : { ...base, context: row.context };
    requests.push(
      ...packQuestions({ ...subject, key: `${row.id}|${subject.key}` }, state, questions, {
        maxRequestTokens: cfg.budget.max_request_tokens,
        maxStatePlusQuestionTokens: cfg.budget.max_state_plus_question_tokens,
      }).requests,
    );
  }
}

console.error(`Evaluating ${rows.length} rows in ${requests.length} requests with ${model}...`);
const jev = createJevPort({ apiKey, timeoutMs: 60_000, logger: quietLogger });
const evaluation = await evaluate(requests, jev, {
  model,
  concurrency: cfg.budget.concurrency,
  maxRunTokens: Number.MAX_SAFE_INTEGER,
  signal: new AbortController().signal,
}, emptyEvaluation());
for (const e of evaluation.errors) console.error(`error ${e.subjectKey}: ${e.message}`);

/** Normalized strength of an answer regardless of thresholds. */
function strength(rule: ModelRule, answer: Answer): number {
  if (rule.type === "noul" && answer.type === "noul") return rule.fires_on === "no" ? 1 - answer.noul : answer.noul;
  const loose = { ...cfg, uncertainty: { ...cfg.uncertainty, needs_human_band: [0, 1] as [number, number] } };
  const relaxed = { ...rule, threshold: 0, needs_human_band: [0, 1] as [number, number] } as ModelRule;
  return judge(relaxed, answer, loose)?.probability ?? 0;
}

// One sample per (row, rule): the strongest hunk decides, like a reviewer reading the whole file.
const whereByKey = new Map<string, Answer>();
for (const [key, m] of keys.meta) {
  const answer = evaluation.answers.get(key);
  if (m.role === "where" && answer) whereByKey.set(`${m.subject.key}|${m.target}`, answer);
}
for (const [key, m] of keys.meta) {
  const answer = evaluation.answers.get(key);
  if (m.role !== "verdict" || !answer) continue;
  const rowId = m.subject.key.split("|")[0]!;
  const row = rows.filter((r) => r.id === rowId)[0]!;
  const rule = rules.get(m.target) as ModelRule;
  const score = strength(rule, answer);
  const id = `${rowId}|${rule.id}`;
  const prev = samples.get(id);
  if (prev && prev.score >= score) continue;
  const loc = locate(rule, m.subject, whereByKey.get(`${m.subject.key}|${rule.id}`));
  const label = row.labels[rule.id]!;
  samples.set(id, {
    rowId,
    ruleId: rule.id,
    truth: label.violates,
    truthLine: label.line,
    truthRange: label.line_range,
    score,
    line: loc?.line,
    ...(answer.type === "choice" ? { choice: answer.choice } : {}),
    ...(label.expected ? { expected: label.expected } : {}),
  });
}

const report: string[] = [`# Calibration: ${dataPath}`, "", `Model: ${[...evaluation.models].join(", ")} · rows: ${rows.length} · input tokens: ${evaluation.inputTokens}`, ""];
report.push(
  "| Rule | n (pos) | Current thr | P / R at current | Violations: confirmed / needs human / missed | Suggested thr | P / R / F at suggested | Location top-1 / ±1 |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
);
const patch: string[] = ["rules:"];

for (const rule of rules.values()) {
  const ss = [...samples.values()].filter((s) => s.ruleId === rule.id);
  if (!ss.length) continue;
  const pos = ss.filter((s) => s.truth).length;
  const at = (t: number) => {
    const tp = ss.filter((s) => s.truth && s.score >= t).length;
    const fp = ss.filter((s) => !s.truth && s.score >= t).length;
    const p = tp + fp ? tp / (tp + fp) : 1;
    const r = pos ? tp / pos : 1;
    const f = p + r ? ((1 + beta ** 2) * p * r) / (beta ** 2 * p + r) : 0;
    return { p, r, f };
  };
  const threshold = thresholdOf(rule);
  let best = { t: threshold, ...at(threshold) };
  for (let t = 0.05; t <= 0.951; t += 0.05) {
    const m = at(t);
    if (m.f > best.f) best = { t: Number(t.toFixed(2)), ...m };
  }
  const located = ss.filter((s) => s.truth && s.truthLine !== undefined && s.score >= best.t);
  const range = (s: Sample): [number, number] => s.truthRange ?? [s.truthLine!, s.truthLine!];
  const within = (s: Sample, slack: number) => s.line !== undefined && s.line >= range(s)[0] - slack && s.line <= range(s)[1] + slack;
  const top1 = located.filter((s) => within(s, 0)).length;
  const near = located.filter((s) => within(s, 1)).length;
  const cur = at(threshold);
  const bandLow = isModelRule(rule) ? bandFor(rule, cfg)[0] : threshold;
  const positives = ss.filter((s) => s.truth);
  const confirmed = positives.filter((s) => s.score >= threshold).length;
  const uncertain = positives.filter((s) => s.score < threshold && s.score >= bandLow).length;
  const outcome = `${confirmed} / ${uncertain} / ${positives.length - confirmed - uncertain}`;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  report.push(
    `| \`${rule.id}\` | ${ss.length} (${pos}) | ${isModelRule(rule) ? threshold : "code"} | ${pct(cur.p)} / ${pct(cur.r)} | ${outcome} | ${best.t} | ` +
      `${pct(best.p)} / ${pct(best.r)} / ${best.f.toFixed(2)} | ${located.length ? `${pct(top1 / located.length)} / ${pct(near / located.length)}` : "n/a"} |`,
  );
  if (isModelRule(rule) && best.t !== threshold) patch.push(`  - id: ${rule.id}`, `    threshold: ${best.t}`);
}

const withExpected = [...samples.values()].filter((s) => s.expected !== undefined);
if (withExpected.length) {
  report.push("", "Choice answers against expected labels:", "", "| Rule | Rows | Same answer | Rows that differ (expected -> answered) |", "| --- | --- | --- | --- |");
  for (const rule of rules.values()) {
    const ss = withExpected.filter((s) => s.ruleId === rule.id);
    if (!ss.length) continue;
    // A rule that was not asked (no candidate line, path excluded) counts as "absent".
    const wrong = ss.filter((s) => (s.choice ?? "absent") !== s.expected);
    report.push(`| \`${rule.id}\` | ${ss.length} | ${ss.length - wrong.length} | ${wrong.map((s) => `${s.rowId}: ${s.expected} -> ${s.choice ?? "not asked"}`).join("; ")} |`);
  }
}

const misses = [...samples.values()].filter((s) => s.truth !== s.score >= thresholdOf(rules.get(s.ruleId)!));
if (misses.length) {
  report.push("", "Misclassified at the current threshold:", "", "| Row | Rule | Expected | Score |", "| --- | --- | --- | --- |");
  for (const m of misses) report.push(`| ${m.rowId} | \`${m.ruleId}\` | ${m.truth ? "fire" : "no finding"} | ${m.score.toFixed(2)} |`);
}

report.push("", `Suggested thresholds maximize F${beta} (beta < 1 favors precision). Check the sample size before applying.`, "");
report.push(...(patch.length > 1 ? ["```yaml", ...patch, "```"] : ["No threshold changes suggested."]));
const text = report.join("\n");
mkdirSync("eval/reports", { recursive: true });
const out = `eval/reports/calibration-${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.md`;
writeFileSync(out, text);
console.log(text);
console.error(`\nSaved ${out}`);
