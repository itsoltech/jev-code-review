import { createHash } from "node:crypto";
import type { ModelRule, ResolvedConfig, Rule } from "../src/config/schema.js";
import { isModelRule } from "../src/jev/questions.js";
import { judge } from "../src/policy/findings.js";
import type { Answer } from "../src/types.js";

export interface Observation {
  answer: Answer;
  line?: number;
}

export interface Sample {
  rowId: string;
  ruleId: string;
  /** Unknown ground truth must not be counted as a clean example. */
  truth: boolean | null;
  truthLine?: number;
  truthRange?: [number, number];
  expected?: string;
  observations: Observation[];
  selected: number;
  missing: number;
  filtered: Set<string>;
  deterministic?: { fired: boolean; line?: number };
}

export type Outcome = "confirmed" | "needs_human" | "abstain" | "clear" | "not_asked" | "error";
const priority: Record<Outcome, number> = { confirmed: 5, needs_human: 4, error: 3, abstain: 2, clear: 1, not_asked: 0 };

export function strength(rule: ModelRule, answer: Answer): number {
  if (rule.type === "noul" && answer.type === "noul") return rule.fires_on === "no" ? 1 - answer.noul : answer.noul;
  if (rule.type === "choice" && answer.type === "choice") return Math.max(0, ...Object.keys(rule.finding_labels).map((key) => answer.probabilities[key] ?? 0));
  if (rule.type === "score" && answer.type === "score") {
    const value = answer.score / (rule.criteria.length - 1);
    return rule.direction === "higher_is_worse" ? value : 1 - value;
  }
  throw new Error(`Answer type ${answer.type} does not match rule ${rule.id} (${rule.type})`);
}

/** Aggregate decisions, not just probabilities: any confirmed hunk is a confirmed row. */
export function outcome(sample: Sample, rule: Rule, cfg: ResolvedConfig, threshold?: number) {
  let best: { status: Outcome; score: number; line?: number; choice?: string; confidence?: number } = {
    status: sample.missing ? "error" : "not_asked", score: 0,
  };
  if (sample.deterministic) return { ...best, status: sample.deterministic.fired ? "confirmed" as const : "clear" as const, score: sample.deterministic.fired ? 1 : 0, line: sample.deterministic.line };
  if (!isModelRule(rule)) return best;
  const effective = threshold === undefined ? rule : { ...rule, threshold };
  for (const observation of sample.observations) {
    const answer = observation.answer;
    const score = strength(rule, answer);
    const judgment = judge(effective, answer, cfg);
    const status: Outcome = judgment?.status ?? (rule.type === "choice" && answer.type === "choice" && rule.abstain_labels.includes(answer.choice) ? "abstain" : "clear");
    if (priority[status] > priority[best.status] || (status === best.status && score > best.score)) {
      best = { status, score, line: observation.line, ...(answer.type === "choice" ? { choice: answer.choice } : {}), ...(answer.type !== "noul" ? { confidence: answer.confidence } : {}) };
    }
  }
  return best;
}

export function metrics(samples: Sample[], rule: Rule, cfg: ResolvedConfig, threshold?: number) {
  const evaluated = samples.map((sample) => ({ sample, ...outcome(sample, rule, cfg, threshold) }));
  const positives = samples.filter((sample) => sample.truth === true).length;
  const tp = evaluated.filter((s) => s.sample.truth === true && s.status === "confirmed").length;
  const fp = evaluated.filter((s) => s.sample.truth === false && s.status === "confirmed").length;
  const humanPos = evaluated.filter((s) => s.sample.truth === true && s.status === "needs_human").length;
  const humanNeg = evaluated.filter((s) => s.sample.truth === false && s.status === "needs_human").length;
  const abstain = evaluated.filter((s) => s.status === "abstain").length;
  const unknownFindings = evaluated.filter((s) => s.sample.truth === null && (s.status === "confirmed" || s.status === "needs_human")).length;
  const errors = samples.filter((s) => s.missing > 0).length;
  return { tp, fp, positives, humanPos, humanNeg, abstain, unknownFindings, errors, precision: tp + fp ? tp / (tp + fp) : null, recall: positives ? tp / positives : null };
}

/** Reuse answers only when model, state and questions are identical. Thresholds are local policy. */
export function requestFingerprint(model: string, requests: { state: unknown; questions: unknown }[]): string {
  return createHash("sha256").update(JSON.stringify({ model, requests: requests.map(({ state, questions }) => ({ state, questions })) })).digest("hex");
}
