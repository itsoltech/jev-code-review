import { readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "../../../src/config/load.js";
import { packQuestions, type PlannedRequest } from "../../../src/jev/batch.js";
import { emptyEvaluation, evaluate } from "../../../src/jev/evaluate.js";
import { createJevPort } from "../../../src/jev/jevPort.js";
import { buildState } from "../../../src/jev/state.js";
import { dimensionQuestion } from "../../../src/jev/questions.js";
import { computeComposite } from "../../../src/policy/composite.js";
import { buildSubjects } from "../../../src/run.js";
import type { ChangedFile, PrInfo, QuestionMeta } from "../../../src/types.js";
import { localGitHub, quietLogger, requireKey } from "../../../scripts/lib.js";
import { requestFingerprint } from "../../../scripts/calibration-metrics.js";

const [dataPath, configPath, dest, dimId] = process.argv.slice(2);
if (!dataPath || !configPath || !dest || !dimId) throw new Error("Usage: measure_dimensions.ts <jsonl> <config> <output-json> <dim-id>");
const rows = readFileSync(dataPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const { config: cfg } = await loadConfig(".github/jev-review.yml", (path) => localGitHub([], configPath).readFile(path, "local"));
const dim = cfg.dimensions.find((d) => d.id === dimId);
if (!dim) throw new Error(`Missing dimension ${dimId}`);
const base: PrInfo = { number: 0, title: "", body: "", author: "", draft: false, labels: [], baseSha: "", headSha: "", isFork: false };
const requests: PlannedRequest[] = [];
const meta = new Map<string, QuestionMeta>();
const requestMap = new Map<string, string[]>();
const skipped = new Map<string, unknown>();
for (const row of rows) {
  const pr = { ...base, title: row.pr?.title ?? "", body: row.pr?.body ?? "" };
  const patchLines = row.patch?.split("\n").filter((line: string) => !line.startsWith("@@")) ?? [];
  const files: ChangedFile[] = row.patch ? [{ path: row.path, status: "modified", patch: row.patch, additions: patchLines.filter((x: string) => x.startsWith("+")).length, deletions: patchLines.filter((x: string) => x.startsWith("-")).length }] : row.files ?? [];
  const built = buildSubjects(files, { ...cfg, rules: [], dimensions: [dim] });
  skipped.set(row.id, built.skippedFiles);
  for (const subject of built.subjects.filter((subject) => subject.kind === dim.scope && (subject.kind === "pr" || subject.path === row.path))) {
    const key = `dim:${row.id}:${requestMap.get(row.id)?.length ?? 0}`;
    const question = { key, question: dimensionQuestion(dim) };
    const packed = packQuestions({ ...subject, key: `${row.id}|${subject.key}` }, buildState(subject, pr, files, cfg), [question], { maxRequestTokens: cfg.budget.max_request_tokens, maxStatePlusQuestionTokens: cfg.budget.max_state_plus_question_tokens });
    if (packed.oversized.length) throw new Error(`Oversized: ${row.id}: ${packed.oversized.join(", ")}`);
    requests.push(...packed.requests);
    meta.set(key, { subject, role: "dimension", target: dim.id });
    requestMap.set(row.id, [...(requestMap.get(row.id) ?? []), key]);
  }
}
const model = cfg.model;
const fingerprints = Object.fromEntries(rows.map((row) => [row.id, requestFingerprint(model, requests.filter((request) => request.subject.key.startsWith(`${row.id}|`)))]));
if (process.argv.includes("--fingerprints-only")) {
  console.log(JSON.stringify(fingerprints, null, 2));
  process.exit(0);
}
const result = requests.length ? await evaluate(requests, createJevPort({ apiKey: requireKey(), timeoutMs: 60_000, logger: quietLogger }), { model, concurrency: cfg.budget.concurrency, maxRunTokens: Number.MAX_SAFE_INTEGER, signal: new AbortController().signal }, emptyEvaluation()) : emptyEvaluation();
const results = rows.map((row) => {
  const keys = requestMap.get(row.id) ?? [];
  const missing = keys.filter((k) => !result.answers.has(k));
  const partialMeta = new Map(keys.map((k) => [k, meta.get(k)!]));
  const partialAnswers = new Map(keys.filter((k) => result.answers.has(k)).map((k) => [k, result.answers.get(k)!]));
  const composite = computeComposite(partialMeta, partialAnswers, { ...cfg, dimensions: [dim] });
  return { row: row.id, expected: row.expected_score ?? row.readability_expected, answers: keys.map((key) => ({ key, answer: result.answers.get(key) ?? null })), missing, skipped: skipped.get(row.id), composite: composite.dimensions[0] };
});
const payload = { dataPath, configPath, model, returnedModels: [...result.models], dimension: dim, fingerprint: requestFingerprint(model, requests), fingerprints, requests: requests.length, inputTokens: result.inputTokens, errors: result.errors, skippedRequests: result.skippedRequests, results };
writeFileSync(dest, JSON.stringify(payload, null, 2) + "\n");
if (result.errors.length || result.skippedRequests.length || results.some((r) => r.missing.length || !r.answers.length)) throw new Error(`INCOMPLETE dimension measurement: ${dest}`);
console.log(`${dimId}: ${rows.length} rows, ${requests.length} requests, ${result.inputTokens} tokens; ${dest}`);
for (const row of results) console.log(`${row.row}\tmanual=${row.expected}\tmodel=${row.composite?.value === undefined ? "n/a" : (row.composite.value * (dim.criteria.length - 1)).toFixed(2)}\tlowConfidence=${row.composite?.lowConfidence}\tsamples=${row.composite?.samples}`);
