import { createHash } from "node:crypto";
import type { ChoiceResponse, NoulResponse, ScoreResponse } from "@typesafe-ai/sdk";
import type { FileLinesRule, ModelRule, PatternRule, ResolvedConfig, Rule, Severity } from "../config/schema.js";
import { pathMatches } from "../jev/questions.js";
import { parseDescription } from "../jev/state.js";
import type { Answer, Location, PrInfo, QuestionMeta, Subject } from "../types.js";

export type FindingStatus = "confirmed" | "needs_human";

export interface Finding {
  rule: Rule;
  severity: Severity;
  status: FindingStatus;
  subject: Subject;
  /** Where to attach an inline comment; missing when the rule is not located or the location is unsure. */
  location?: Location;
  /** Probability of the firing answer for noul, probability of the finding label for choice, normalized badness for score. */
  probability: number;
  confidence?: number;
  /** Choice rules: the option that triggered the finding. */
  label?: string;
  fingerprint: string;
}

interface Judgment {
  status: FindingStatus;
  severity: Severity;
  probability: number;
  confidence?: number;
  label?: string;
}

export function bandFor(rule: Rule, cfg: ResolvedConfig): [number, number] {
  return rule.needs_human_band ?? cfg.uncertainty.needs_human_band;
}

/** Turn one verdict answer into a judgment, or null when the rule did not fire. */
export function judge(rule: ModelRule, answer: Answer, cfg: ResolvedConfig): Judgment | null {
  const [bandLow] = bandFor(rule, cfg);
  switch (rule.type) {
    case "noul": {
      const yes = (answer as NoulResponse).noul;
      const p = rule.fires_on === "no" ? 1 - yes : yes;
      if (p >= rule.threshold) return { status: "confirmed", severity: rule.severity, probability: p };
      if (p >= bandLow) return { status: "needs_human", severity: rule.severity, probability: p };
      return null;
    }
    case "score": {
      const a = answer as ScoreResponse;
      const normalized = a.score / (rule.criteria.length - 1);
      const bad = rule.direction === "higher_is_worse" ? normalized : 1 - normalized;
      if (bad < rule.threshold) return null;
      const status = a.confidence >= rule.min_confidence ? "confirmed" : "needs_human";
      return { status, severity: rule.severity, probability: bad, confidence: a.confidence };
    }
    case "choice": {
      const a = answer as ChoiceResponse;
      let best: { label: string; p: number } | undefined;
      for (const label of Object.keys(rule.finding_labels)) {
        const p = a.probabilities[label] ?? 0;
        if (!best || p > best.p) best = { label, p };
      }
      if (!best || best.p < bandLow) return null;
      const severity = rule.finding_labels[best.label]!;
      const sure = best.p >= rule.threshold && a.confidence >= rule.min_confidence;
      return { status: sure ? "confirmed" : "needs_human", severity, probability: best.p, confidence: a.confidence, label: best.label };
    }
  }
}

/** Resolve the finding's line from the where-answer, or the only added line when there is one. */
export function locate(rule: Rule, subject: Subject, where: Answer | undefined): Location | undefined {
  if (subject.kind === "pr" || !rule.locate) return undefined;
  if (subject.locations.size === 1) return subject.locations.values().next().value;
  if (!where || where.type !== "choice") return undefined;
  if (where.confidence < rule.min_confidence) return undefined;
  return subject.locations.get(where.choice);
}

export function fingerprint(ruleId: string, subject: Subject, location: Location | undefined): string {
  const anchor =
    subject.kind === "pr"
      ? "pr"
      : location
        ? `${subject.path}|${location.text.trim().replace(/\s+/g, " ")}`
        : `${subject.path}|${subject.kind === "hunk" ? subject.hunk.header : "file"}`;
  return createHash("sha1").update(`${ruleId}|${anchor}`).digest("hex").slice(0, 16);
}

/**
 * Build findings from answers. A where-answer is only read when its verdict fired:
 * Choice probabilities sum to 1, so some line always "wins" even when nothing is wrong.
 */
export function deriveFindings(
  meta: Map<string, QuestionMeta>,
  answers: Map<string, Answer>,
  cfg: ResolvedConfig,
): Finding[] {
  const rules = new Map(cfg.rules.map((r) => [r.id, r]));
  const whereByRule = new Map<string, Answer>();
  for (const [key, m] of meta) {
    const a = answers.get(key);
    if (m.role === "where" && a) whereByRule.set(`${m.subject.key}|${m.target}`, a);
  }

  const byFingerprint = new Map<string, Finding>();
  for (const [key, m] of meta) {
    if (m.role !== "verdict") continue;
    const rule = rules.get(m.target);
    const answer = answers.get(key);
    if (!rule || rule.type === "pattern" || rule.type === "file_lines" || !answer) continue;
    const j = judge(rule, answer, cfg);
    if (!j) continue;
    const location = locate(rule, m.subject, whereByRule.get(`${m.subject.key}|${rule.id}`));
    const finding: Finding = { rule, subject: m.subject, location, fingerprint: fingerprint(rule.id, m.subject, location), ...j };
    // Overlapping hunk windows can report the same issue twice; keep the stronger one.
    const prev = byFingerprint.get(finding.fingerprint);
    if (!prev || finding.probability > prev.probability) byFingerprint.set(finding.fingerprint, finding);
  }
  return [...byFingerprint.values()].sort(compareFindings);
}

export function patternField(field: string, pr: Pick<PrInfo, "title" | "body">): string {
  if (field === "title") return pr.title;
  if (field === "description") return pr.body;
  return parseDescription(pr.body).sections[field.slice("section:".length).toLowerCase()] ?? "";
}

/** Pattern rules are checked in code against the PR title or description. */
export function patternFindings(rules: Rule[], pr: Pick<PrInfo, "title" | "body">): Finding[] {
  const subject: Subject = { kind: "pr", key: "pr" };
  return rules
    .filter((r): r is PatternRule => r.type === "pattern" && r.field !== "added_lines")
    .flatMap((rule) => {
      const text = patternField(rule.field, pr);
      const matched = new RegExp(rule.regex, rule.flags).test(text);
      if (matched !== (rule.fires_when === "match")) return [];
      return [{ rule, severity: rule.severity, status: "confirmed" as const, subject, probability: 1, fingerprint: fingerprint(rule.id, subject, undefined) }];
    });
}

/** added_lines pattern rules: the first matching added line of each hunk becomes a located finding. */
export function linePatternFindings(rules: Rule[], subjects: Subject[]): Finding[] {
  const linePatterns = rules.filter((r): r is PatternRule => r.type === "pattern" && r.field === "added_lines");
  const out = new Map<string, Finding>();
  for (const rule of linePatterns) {
    const regex = new RegExp(rule.regex, rule.flags);
    const ignore = rule.ignore_regex ? new RegExp(rule.ignore_regex, rule.flags) : undefined;
    const unlessAbove = rule.unless_previous_line ? new RegExp(rule.unless_previous_line, rule.flags) : undefined;
    for (const subject of subjects) {
      if (subject.kind !== "hunk" || !pathMatches(rule, subject.path)) continue;
      const lines = subject.hunk.lines.filter((l) => l.kind !== "del");
      for (const [i, line] of lines.entries()) {
        if (line.kind !== "add" || !regex.test(line.text) || ignore?.test(line.text)) continue;
        if (unlessAbove && i > 0 && unlessAbove.test(lines[i - 1]!.text)) continue;
        const location = subject.locations.get(line.id)!;
        const fp = fingerprint(rule.id, subject, location);
        out.set(fp, { rule, severity: rule.severity, status: "confirmed", subject, location, probability: 1, fingerprint: fp });
        break;
      }
    }
  }
  return [...out.values()];
}

/** file_lines rules: changed files longer than max_lines at the PR head (read in code). */
export async function fileLinesFindings(
  rules: Rule[],
  files: { path: string; status: string }[],
  read: (path: string) => Promise<string | undefined>,
): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const rule of rules.filter((r): r is FileLinesRule => r.type === "file_lines")) {
    for (const file of files) {
      if (file.status === "removed" || !pathMatches(rule, file.path)) continue;
      const text = await read(file.path);
      if (text === undefined) continue;
      const count = text.replace(/\n$/, "").split("\n").length;
      if (count <= rule.max_lines) continue;
      const subject: Subject = { kind: "file", key: `${file.path}#size`, path: file.path, hunks: [], addedLines: 0, locations: new Map() };
      out.push({
        rule,
        severity: rule.severity,
        status: "confirmed",
        subject,
        probability: 1,
        label: `${count} lines (limit ${rule.max_lines})`,
        fingerprint: fingerprint(rule.id, subject, undefined),
      });
    }
  }
  return out;
}

const SEVERITY_ORDER: Record<Severity, number> = { blocker: 0, major: 1, minor: 2, info: 3 };

export function compareFindings(a: Finding, b: Finding): number {
  return (
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    (a.status === b.status ? 0 : a.status === "confirmed" ? -1 : 1) ||
    b.probability - a.probability
  );
}
