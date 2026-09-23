import type { Question, ScoreCriteria } from "@typesafe-ai/sdk";
import picomatch from "picomatch";
import type { Dimension, ModelRule, ResolvedConfig, Rule } from "../config/schema.js";
import type { ChangedFile, PrInfo, QuestionMeta, Subject } from "../types.js";
import { parseDescription } from "./state.js";

/** Choice questions accept at most 255 options. */
export const MAX_CHOICE_OPTIONS = 255;

type Scoped = { paths: string[]; exclude_paths: string[] };
const matcherCache = new WeakMap<Scoped, (path: string) => boolean>();

export function pathMatches(entry: Scoped, path: string): boolean {
  let match = matcherCache.get(entry);
  if (!match) {
    const include = picomatch(entry.paths, { dot: true });
    const exclude = entry.exclude_paths.length ? picomatch(entry.exclude_paths, { dot: true }) : () => false;
    match = (p) => include(p) && !exclude(p);
    matcherCache.set(entry, match);
  }
  return match(path);
}

/**
 * Rules whose `when` conditions hold for this pull request. Evaluated in code before any
 * request, so a rule that does not apply costs nothing.
 */
export function activeRules(rules: Rule[], pr: Pick<PrInfo, "title" | "body">, files: Pick<ChangedFile, "path">[]): Rule[] {
  const sections = parseDescription(pr.body).sections;
  return rules.filter((rule) => {
    const when = rule.when;
    if (!when) return true;
    if (when.title_matches && !new RegExp(when.title_matches).test(pr.title)) return false;
    if (when.files_changed) {
      const match = picomatch(when.files_changed, { dot: true });
      if (!files.some((f) => match(f.path))) return false;
    }
    if (when.sections_filled?.some((name) => !sections[name.toLowerCase()])) return false;
    if (when.files_only) {
      const match = picomatch(when.files_only, { dot: true });
      if (!files.length || !files.every((f) => match(f.path))) return false;
    }
    if (when.files_unchanged) {
      const match = picomatch(when.files_unchanged, { dot: true });
      if (files.some((f) => match(f.path))) return false;
    }
    return true;
  });
}

export const isModelRule = (rule: Rule): rule is ModelRule => rule.type !== "pattern" && rule.type !== "file_lines";

/** Whether Jev should be asked this rule about this subject. Pattern rules never are. */
export function ruleApplies(rule: Rule, subject: Subject): rule is ModelRule {
  if (!isModelRule(rule) || rule.scope !== subject.kind) return false;
  if (subject.kind === "pr") return true;
  return pathMatches(rule, subject.path) && hasCandidate(rule, subject);
}

const candidateCache = new WeakMap<ModelRule, RegExp>();

/** True when the rule has no candidate_regex or an added line of the subject matches it. */
export function hasCandidate(rule: ModelRule, subject: Subject): boolean {
  if (!rule.candidate_regex || subject.kind === "pr") return true;
  let re = candidateCache.get(rule);
  if (!re) {
    re = new RegExp(rule.candidate_regex);
    candidateCache.set(rule, re);
  }
  for (const loc of subject.locations.values()) if (re.test(loc.text)) return true;
  return false;
}

export function dimensionApplies(dim: Dimension, subject: Subject): boolean {
  if (dim.scope !== subject.kind) return false;
  return subject.kind === "pr" || pathMatches(dim, subject.path);
}

export function verdictQuestion(rule: ModelRule): Question {
  switch (rule.type) {
    case "noul":
      return { type: "noul", instructions: rule.instructions, ...(rule.criteria ? { criteria: rule.criteria } : {}) };
    case "score":
      return { type: "score", instructions: rule.instructions, criteria: rule.criteria as unknown as ScoreCriteria };
    case "choice":
      return { type: "choice", instructions: rule.instructions, criteria: rule.criteria };
  }
}

/** Whether a where-question can be asked: the rule wants it and there is more than one candidate line. */
export function canLocate(rule: Rule, subject: Subject): boolean {
  if (!rule.locate || subject.kind === "pr") return false;
  return subject.locations.size > 1 && subject.locations.size <= MAX_CHOICE_OPTIONS;
}

/**
 * Line-location question (the "line-by-line search" pattern): a Choice over added-line ids.
 * Probabilities always sum to 1, so this is only read when the verdict question fired.
 */
export function whereQuestion(rule: ModelRule, subject: Subject): Question {
  if (subject.kind === "pr") throw new Error("PR-scope subjects have no lines");
  const criteria: Record<string, null> = {};
  for (const id of subject.locations.keys()) criteria[id] = null;
  return {
    type: "choice",
    instructions: {
      condition: rule.instructions,
      question:
        "Which added line in `changes.lines` is the clearest instance of `condition`? Answer with its line id.",
    },
    criteria,
  };
}

// The schema enforces at least two levels, which is what ScoreCriteria encodes as a tuple.
export function dimensionQuestion(dim: Dimension): Question {
  return { type: "score", instructions: dim.instructions, criteria: dim.criteria as unknown as ScoreCriteria };
}

export interface SubjectQuestions {
  subject: Subject;
  questions: { key: string; meta: QuestionMeta; question: Question }[];
}

export class QuestionKeys {
  private n = 0;
  readonly meta = new Map<string, QuestionMeta>();
  next(meta: QuestionMeta): string {
    // Keys are opaque: Jev never sees them, so all meaning lives in the question itself.
    const key = `q${++this.n}`;
    this.meta.set(key, meta);
    return key;
  }
}

/** All questions for one subject. `where` controls location questions (eager vs two-phase). */
export function questionsFor(
  subject: Subject,
  cfg: ResolvedConfig,
  keys: QuestionKeys,
  where: "eager" | "none",
): SubjectQuestions {
  const out: SubjectQuestions["questions"] = [];
  for (const rule of cfg.rules) {
    if (!ruleApplies(rule, subject)) continue;
    const meta: QuestionMeta = { subject, role: "verdict", target: rule.id };
    out.push({ key: keys.next(meta), meta, question: verdictQuestion(rule) });
    if (where === "eager" && canLocate(rule, subject)) {
      const wmeta: QuestionMeta = { subject, role: "where", target: rule.id };
      out.push({ key: keys.next(wmeta), meta: wmeta, question: whereQuestion(rule, subject) });
    }
  }
  for (const dim of cfg.dimensions) {
    if (!dimensionApplies(dim, subject)) continue;
    const meta: QuestionMeta = { subject, role: "dimension", target: dim.id };
    out.push({ key: keys.next(meta), meta, question: dimensionQuestion(dim) });
  }
  return { subject, questions: out };
}
