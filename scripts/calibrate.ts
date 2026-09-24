/** Measure labeled changes with the production decision policy. See eval/maintainability/README.md. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "../src/config/load.js";
import { packQuestions, type PlannedRequest } from "../src/jev/batch.js";
import { emptyEvaluation, evaluate } from "../src/jev/evaluate.js";
import { createJevPort } from "../src/jev/jevPort.js";
import { activeRules, canLocate, hasCandidate, isModelRule, pathMatches, QuestionKeys, verdictQuestion, whereQuestion } from "../src/jev/questions.js";
import { buildState } from "../src/jev/state.js";
import { fileLinesFindings, linePatternFindings, locate, patternFindings } from "../src/policy/findings.js";
import { buildSubjects } from "../src/run.js";
import type { Answer, ChangedFile, PrInfo, Subject } from "../src/types.js";
import { metrics, outcome, requestFingerprint, type Sample } from "./calibration-metrics.js";
import { arg, localGitHub, quietLogger, requireKey } from "./lib.js";

interface Row {
  id: string;
  path?: string;
  patch?: string;
  pr?: { title: string; body?: string };
  files?: ChangedFile[];
  file_text?: string;
  context?: unknown;
  labels: Record<string, { violates: boolean; line?: number; line_range?: [number, number]; expected?: string }>;
}

const dataPath = arg("data") ?? "eval/datasets/sample.jsonl";
const beta = Number(arg("beta") ?? 0.5);
const minPrecision = Number(arg("min-precision") ?? 0.9);
if (!(beta > 0) || !(minPrecision > 0 && minPrecision <= 1)) throw new Error("Invalid --beta or --min-precision");
const rows: Row[] = readFileSync(dataPath, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
if (!rows.length || new Set(rows.map((row) => row.id)).size !== rows.length || rows.some((row) => row.id.includes("|"))) throw new Error("Dataset needs nonempty, unique row IDs without | separators");
const local = localGitHub([], arg("config"));
const { config: cfg } = await loadConfig(".github/jev-review.yml", (path) => local.readFile(path, "local"));
if (arg("threshold") !== undefined) {
  const threshold = Number(arg("threshold"));
  if (!(threshold > 0 && threshold <= 1)) throw new Error("--threshold must be in (0, 1]");
  for (const rule of cfg.rules) if (isModelRule(rule)) rule.threshold = threshold;
}
const model = arg("model") ?? cfg.model;
const rules = new Map(cfg.rules.map((rule) => [rule.id, rule]));
const basePr: PrInfo = { number: 0, title: "", body: "", author: "", draft: false, labels: [], baseSha: "", headSha: "", isFork: false };
const keys = new QuestionKeys();
const samples = new Map<string, Sample>();
const requests: PlannedRequest[] = [];
const oversized: string[] = [];

for (const row of rows) {
  const pr = { ...basePr, title: row.pr?.title ?? "", body: row.pr?.body ?? "" };
  const changed = row.patch?.split("\n").filter((line) => !line.startsWith("@@")) ?? [];
  const files: ChangedFile[] = row.patch ? [{ path: row.path ?? "file", status: "modified", additions: changed.filter((line) => line.startsWith("+")).length, deletions: changed.filter((line) => line.startsWith("-")).length, patch: row.patch }] : row.files ?? [];
  const applicable = new Set(activeRules(cfg.rules, pr, files).map((rule) => rule.id));
  const built = buildSubjects(files, { ...cfg, rules: cfg.rules.filter((rule) => rule.id in row.labels), dimensions: [] });
  const subjects: Subject[] = built.subjects;
  for (const [ruleId, label] of Object.entries(row.labels)) {
    const rule = rules.get(ruleId);
    if (!rule) throw new Error(`row ${row.id}: unknown or disabled rule ${ruleId}`);
    const sample: Sample = { rowId: row.id, ruleId, truth: label.expected === "insufficient_context" ? null : label.violates, truthLine: label.line, truthRange: label.line_range, expected: label.expected, observations: [], selected: 0, missing: 0, filtered: new Set() };
    samples.set(`${row.id}|${ruleId}`, sample);
    if (!applicable.has(ruleId)) { sample.filtered.add("when"); continue; }
    if (!isModelRule(rule)) {
      const found = rule.type === "file_lines" ? await fileLinesFindings([rule], files, async () => row.file_text) : rule.field === "added_lines" ? linePatternFindings([rule], subjects) : patternFindings([rule], pr);
      if (rule.type === "file_lines" && row.file_text === undefined && files.some((file) => pathMatches(rule, file.path))) sample.missing++;
      else sample.deterministic = { fired: found.length > 0, line: found[0]?.location?.line };
    }
    if (!subjects.some((subject) => subject.kind === rule.scope)) sample.filtered.add(built.skippedFiles[0]?.reason ?? "no_subject");
  }
  for (const subject of subjects) {
    const questions = [];
    for (const ruleId of Object.keys(row.labels)) {
      const rule = rules.get(ruleId)!;
      if (!isModelRule(rule) || !applicable.has(ruleId) || rule.scope !== subject.kind) continue;
      const sample = samples.get(`${row.id}|${ruleId}`)!;
      if (subject.kind !== "pr" && !pathMatches(rule, subject.path)) { sample.filtered.add("path"); continue; }
      if (!hasCandidate(rule, subject)) { sample.filtered.add("candidate"); continue; }
      sample.selected++;
      const vmeta = { subject: { ...subject, key: `${row.id}|${subject.key}` }, role: "verdict" as const, target: ruleId };
      questions.push({ key: keys.next(vmeta), question: verdictQuestion(rule) });
      if (canLocate(rule, subject)) questions.push({ key: keys.next({ ...vmeta, role: "where" }), question: whereQuestion(rule, subject) });
    }
    const base = buildState(subject, pr, files, cfg);
    const state = row.context === undefined ? base : { ...base, context: row.context };
    const packed = packQuestions({ ...subject, key: `${row.id}|${subject.key}` }, state, questions, { maxRequestTokens: cfg.budget.max_request_tokens, maxStatePlusQuestionTokens: cfg.budget.max_state_plus_question_tokens });
    requests.push(...packed.requests);
    oversized.push(...packed.oversized);
  }
}

const fingerprint = requestFingerprint(model, requests);
const replay = arg("replay");
let evaluation = emptyEvaluation();
if (replay) {
  const saved = JSON.parse(readFileSync(replay, "utf8"));
  if (saved.version !== 1 || saved.fingerprint !== fingerprint) throw new Error("Replay rejected: model, state or questions changed. Run a new API calibration.");
  evaluation = { ...evaluation, ...saved.evaluation, answers: new Map(saved.evaluation.answers), models: new Set(saved.evaluation.models) };
  console.error(`Replaying ${rows.length} rows without API calls from ${replay}`);
} else {
  console.error(`Evaluating ${rows.length} rows in ${requests.length} requests with ${model}...`);
  if (requests.length) evaluation = await evaluate(requests, createJevPort({ apiKey: requireKey(), timeoutMs: 60_000, logger: quietLogger }), { model, concurrency: cfg.budget.concurrency, maxRunTokens: Number.MAX_SAFE_INTEGER, signal: new AbortController().signal }, evaluation);
}
for (const error of evaluation.errors) console.error(`error ${error.subjectKey}: ${error.message}`);
const dump = arg("dump");
if (dump) {
  writeFileSync(`${dump}.answers.json`, JSON.stringify({ version: 1, fingerprint, config: cfg, dataPath, evaluation: { ...evaluation, answers: [...evaluation.answers], models: [...evaluation.models] } }, null, 2) + "\n");
}

const whereByKey = new Map<string, Answer>();
for (const [key, meta] of keys.meta) {
  const answer = evaluation.answers.get(key);
  if (meta.role === "where" && answer) whereByKey.set(`${meta.subject.key}|${meta.target}`, answer);
}
for (const [key, meta] of keys.meta) {
  if (meta.role !== "verdict") continue;
  const sample = samples.get(`${meta.subject.key.split("|")[0]}|${meta.target}`)!;
  const answer = evaluation.answers.get(key);
  if (!answer) { sample.missing++; continue; }
  sample.observations.push({ answer, line: locate(rules.get(meta.target)!, meta.subject, whereByKey.get(`${meta.subject.key}|${meta.target}`))?.line });
}

const pct = (value: number | null) => value === null ? "n/a" : `${Math.round(value * 100)}%`;
const report = [`# Calibration: ${dataPath}`, "", `Model: ${[...evaluation.models].join(", ") || model} · rows: ${rows.length} · input tokens: ${evaluation.inputTokens}${replay ? " (replayed; no new API usage)" : ""}`, "", "Decisions use production judge(): threshold AND confidence. Unknown labels are excluded from precision/recall. No predictions or no positives means n/a, not 100%.", "", "| Rule | n (pos / unknown) | Thr | Confirmed P / R | TP / FP | Positive: human / missed | Clean: human | Abstain | Unknown findings | Preselection positives | Incomplete rows | Location top-1 / ±1 |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
const suggestions: string[] = [];
for (const rule of rules.values()) {
  const ss = [...samples.values()].filter((sample) => sample.ruleId === rule.id);
  if (!ss.length) continue;
  const m = metrics(ss, rule, cfg);
  const located = rule.locate ? ss.filter((sample) => sample.truth === true && (sample.truthLine !== undefined || sample.truthRange !== undefined) && outcome(sample, rule, cfg).status === "confirmed") : [];
  const within = (sample: Sample, slack: number) => {
    const line = outcome(sample, rule, cfg).line;
    const [lo, hi] = sample.truthRange ?? [sample.truthLine!, sample.truthLine!];
    return line !== undefined && line >= lo - slack && line <= hi + slack;
  };
  const selectedPos = ss.filter((sample) => sample.truth === true && (sample.selected > 0 || sample.deterministic !== undefined)).length;
  report.push(`| \`${rule.id}\` | ${ss.length} (${m.positives} / ${ss.filter((s) => s.truth === null).length}) | ${isModelRule(rule) ? rule.threshold : "code"} | ${pct(m.precision)} / ${pct(m.recall)} | ${m.tp} / ${m.fp} | ${m.humanPos} / ${m.positives - m.tp - m.humanPos} | ${m.humanNeg} | ${m.abstain} | ${m.unknownFindings} | ${selectedPos}/${m.positives} | ${m.errors} | ${located.length ? `${located.filter((s) => within(s, 0)).length}/${located.length} / ${located.filter((s) => within(s, 1)).length}/${located.length}` : "n/a"} |`);
  if (!isModelRule(rule) || !m.positives || m.errors || process.argv.includes("--no-suggest")) continue;
  const f = (p: number | null, r: number | null) => p !== null && r !== null && p + r > 0 ? (1 + beta ** 2) * p * r / (beta ** 2 * p + r) : 0;
  let best = { t: rule.threshold, f: m.precision !== null && m.precision >= minPrecision ? f(m.precision, m.recall) : -1 };
  for (let step = 1; step <= 20; step++) {
    const t = step / 20;
    const candidate = metrics(ss, rule, cfg, t);
    if (!candidate.tp || candidate.precision === null || candidate.precision < minPrecision || candidate.unknownFindings) continue;
    const score = f(candidate.precision, candidate.recall);
    if (score > best.f) best = { t, f: score };
  }
  if (best.f >= 0 && best.t !== rule.threshold) suggestions.push(`  - id: ${rule.id}`, `    threshold: ${best.t}`);
}

report.push("", "Preselection counts positives with at least one selected verdict (or deterministic check); it is coverage of this dataset, not of all possible code. Missed includes abstentions, filtering and errors; see per-row status. Clean: human measures review noise. Location is measured only on confirmed positives at the current policy, including line_range labels.");
const details = [...samples.values()].filter((sample) => {
  const result = outcome(sample, rules.get(sample.ruleId)!, cfg);
  return sample.missing || (sample.truth !== null && sample.truth !== (result.status === "confirmed")) || result.status === "needs_human" || result.status === "abstain" || (sample.expected && (result.choice ?? (result.status === "clear" || result.status === "not_asked" ? "absent" : result.status)) !== sample.expected);
});
if (details.length) {
  report.push("", "| Row | Rule | Expected | Decision | P(finding) | Confidence | Filtered |", "| --- | --- | --- | --- | --- | --- | --- |");
  for (const sample of details) {
    const result = outcome(sample, rules.get(sample.ruleId)!, cfg);
    report.push(`| ${sample.rowId} | ${sample.ruleId} | ${sample.expected ?? sample.truth} | ${result.status} | ${result.score.toFixed(3)} | ${result.confidence?.toFixed(3) ?? "n/a"} | ${sample.selected ? "" : [...sample.filtered].join(", ")} |`);
  }
}
if (process.argv.includes("--no-suggest")) report.push("", "Threshold search disabled (--no-suggest).");
else report.push("", `Threshold suggestions use production decisions and maximize F${beta}, requiring observed precision >= ${minPrecision}. These are tuning-set suggestions, not validation or permission to enable a rule.`, "", ...(suggestions.length ? ["```yaml", "rules:", ...suggestions, "```"] : ["No threshold changes suggested."]));
if (dump) writeFileSync(dump, [...samples.values()].map((sample) => JSON.stringify({ row: sample.rowId, rule: sample.ruleId, truth: sample.truth, expected: sample.expected, ...outcome(sample, rules.get(sample.ruleId)!, cfg), selected: sample.selected, answered: sample.observations.length, missing: sample.missing, filtered: [...sample.filtered], observations: sample.observations })).join("\n") + "\n");
const incomplete = evaluation.errors.length + evaluation.skippedRequests.length + oversized.length + [...samples.values()].reduce((sum, sample) => sum + sample.missing, 0);
if (incomplete) { report.push("", "INCOMPLETE: missing or failed evaluations. Do not use this run to enable rules."); process.exitCode = 1; }
mkdirSync("eval/reports", { recursive: true });
const out = `eval/reports/calibration-${new Date().toISOString().replace(/:/g, "")}.md`;
writeFileSync(out, report.join("\n") + "\n");
console.log(report.join("\n"));
console.error(`\nSaved ${out}${dump ? `\nSaved ${dump} and ${dump}.answers.json` : ""}`);
