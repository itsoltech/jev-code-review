import type { Finding } from "../policy/findings.js";
import type { CompositeResult } from "../policy/composite.js";
import { countBySeverity, unreviewed, type RunHealth, type Verdict } from "../policy/verdict.js";
import type { PrInfo } from "../types.js";
import { SEVERITY_LABEL } from "./comments.js";
import { inlineCode } from "./template.js";

export const SUMMARY_MARKER = "<!-- jev-review:summary -->";

export interface ReviewReport {
  pr: PrInfo;
  verdict: Verdict;
  findings: Finding[];
  composite: CompositeResult;
  health: RunHealth;
  models: string[];
  inputTokens: number;
  requests: number;
  reviewedSubjects: number;
  sources: string[];
  warnings: string[];
  errors: string[];
}

const EVENT_TITLE = { APPROVE: "Approved", COMMENT: "Commented", REQUEST_CHANGES: "Changes requested" } as const;

export function verdictTitle(report: ReviewReport): string {
  const { verdict } = report;
  const parts: string[] = [EVENT_TITLE[verdict.event]];
  if (verdict.failCheck) parts.push("check failed");
  if (verdict.needsHuman) parts.push("needs human review");
  return parts.join(", ");
}

function where(f: Finding): string {
  if (f.location) return `\`${f.location.path}:${f.location.line}\``;
  if (f.subject.kind === "pr") return "pull request";
  return `\`${f.subject.path}\``;
}

export function renderSummary(report: ReviewReport, inline: Set<string>): string {
  const { findings, composite, health, verdict } = report;
  const counts = countBySeverity(findings);
  const uncertain = findings.filter((f) => f.status === "needs_human").length;
  const lines: string[] = [SUMMARY_MARKER, `### Jev review: ${verdictTitle(report)}`, ""];

  lines.push(
    `Confirmed: ${counts.blocker} blocker, ${counts.major} major, ${counts.minor} minor, ${counts.info} info. ` +
      `Uncertain: ${uncertain}.` +
      (composite.composite !== undefined ? ` Composite score: **${composite.composite.toFixed(2)}**.` : ""),
  );
  if (verdict.reasons.length) {
    lines.push("", ...verdict.reasons.map((r) => `- ${r}`));
  }

  if (findings.length) {
    lines.push("", "| Severity | Rule | Where | Probability | Status |", "| --- | --- | --- | --- | --- |");
    for (const f of findings) {
      const status = f.status === "needs_human" ? "needs human" : "confirmed";
      const rule = `\`${f.rule.id}\`${f.rule.description ? ` ${f.rule.description.replace(/\|/g, "\\|")}` : ""}`;
      const label = f.label ? ` (${inlineCode(f.label, 40)})` : "";
      const place = `${where(f)}${inline.has(f.fingerprint) ? " (inline)" : ""}`;
      lines.push(`| ${SEVERITY_LABEL[f.severity]} | ${rule}${label} | ${place} | ${Math.round(f.probability * 100)}% | ${status} |`);
    }
  } else {
    lines.push("", "No findings.");
  }

  if (composite.dimensions.length) {
    lines.push("", "| Dimension | Score (0-1) | Weight | Samples |", "| --- | --- | --- | --- |");
    for (const d of composite.dimensions) {
      const value = d.value === undefined ? "n/a" : d.value.toFixed(2);
      const low = d.lowConfidence ? ` (+${d.lowConfidence} low confidence)` : "";
      lines.push(`| \`${d.id}\` | ${value} | ${d.weight} | ${d.samples}${low} |`);
    }
  }

  const notReviewed = unreviewed(health);
  const coverage: string[] = [];
  if (notReviewed.length) coverage.push(...notReviewed.map((f) => `- ${inlineCode(f.path, 120)}: ${f.reason.replace("_", " ")}`));
  const byBudget = health.skippedByBudget ?? 0;
  const byBlock = health.skippedByBlock ?? 0;
  const byTimeout = health.skippedRequests - byBudget - byBlock;
  if (byBudget) coverage.push(`- ${byBudget} request(s) skipped: budget.max_run_tokens reached`);
  if (byBlock) coverage.push(`- ${byBlock} request(s) skipped: the same content was already blocked (see errors)`);
  if (byTimeout) coverage.push(`- ${byTimeout} request(s) skipped: budget.run_timeout_seconds reached`);
  if (health.oversizedQuestions) coverage.push(`- ${health.oversizedQuestions} question(s) too large for the token limits`);
  if (report.errors.length) coverage.push(...report.errors.slice(0, 10).map((e) => `- error: ${e.replace(/[<>]/g, "")}`));
  if (coverage.length) {
    lines.push("", `<details><summary>Not fully reviewed (${coverage.length})</summary>`, "", ...coverage, "", "</details>");
  }

  const models = report.models.length ? report.models.join(", ") : "none";
  lines.push(
    "",
    `<sub>Model ${models} · ${report.requests} request(s)` +
      (health.retries ? ` · ${health.retries} retried` : "") +
      (health.splits ? ` · ${health.splits} split` : "") +
      ` · ${report.inputTokens.toLocaleString("en-US")} input tokens · ` +
      `${report.reviewedSubjects} unit(s) reviewed · head ${report.pr.headSha.slice(0, 7)} · config: ${report.sources.join(", ")}</sub>`,
  );
  return lines.join("\n");
}
