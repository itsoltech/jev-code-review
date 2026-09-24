import type { Finding } from "../policy/findings.js";
import { countBySeverity, unreviewed } from "../policy/verdict.js";
import { verdictTitle, type ReviewReport } from "./summary.js";

export function findingPlace(f: Finding): string {
  if (f.location) return `${f.location.path}:${f.location.line}`;
  return f.subject.kind === "pr" ? "pull request" : f.subject.path;
}

const describe = (f: Finding) => `${f.rule.description ?? f.rule.id}${f.label ? ` (${f.label})` : ""}`;

/** Plain text for a terminal: one line per finding, then the verdict and what was not reviewed. */
export function renderText(report: ReviewReport): string {
  const { findings, verdict, health } = report;
  const counts = countBySeverity(findings);
  const uncertain = findings.filter((f) => f.status === "needs_human").length;
  const lines: string[] = [];
  const width = Math.min(60, Math.max(0, ...findings.map((f) => findingPlace(f).length)));
  for (const f of findings) {
    const status = f.status === "needs_human" ? "  [needs human]" : "";
    lines.push(
      `${f.severity.padEnd(7)} ${findingPlace(f).padEnd(width)}  ${f.rule.id}  ${describe(f)} ${Math.round(f.probability * 100)}%${status}`,
    );
  }
  if (findings.length) lines.push("");
  lines.push(`Jev review: ${verdictTitle(report)}`);
  lines.push(`Confirmed: ${counts.blocker} blocker, ${counts.major} major, ${counts.minor} minor, ${counts.info} info. Uncertain: ${uncertain}.`);
  if (report.composite.composite !== undefined) lines.push(`Composite score: ${report.composite.composite.toFixed(2)}`);
  for (const r of verdict.reasons) lines.push(`- ${r}`);
  const notReviewed = unreviewed(health);
  if (notReviewed.length) lines.push(`Not reviewed: ${notReviewed.map((f) => `${f.path} (${f.reason.replace("_", " ")})`).join(", ")}`);
  if (health.skippedRequests) lines.push(`Skipped requests: ${health.skippedRequests}`);
  if (health.abstentions?.length) lines.push(`Without enough context: ${[...new Set(health.abstentions)].join(", ")} (${health.abstentions.length})`);
  for (const e of report.errors) lines.push(`error: ${e}`);
  lines.push(`Model ${report.models.join(", ") || "none"} · ${report.requests} request(s) · ${report.inputTokens.toLocaleString("en-US")} input tokens`);
  return lines.join("\n");
}

/** Stable machine-readable form of a review. */
export function reportJson(report: ReviewReport) {
  return {
    verdict: report.verdict,
    composite: report.composite,
    findings: report.findings.map((f) => ({
      rule: f.rule.id,
      description: f.rule.description,
      severity: f.severity,
      status: f.status,
      probability: Number(f.probability.toFixed(3)),
      confidence: f.confidence,
      label: f.label,
      path: f.location?.path ?? (f.subject.kind === "pr" ? undefined : f.subject.path),
      location: f.location,
      fingerprint: f.fingerprint,
    })),
    /** Rule ids of checks answered without enough context, one per question. */
    abstentions: report.health.abstentions ?? [],
    errors: report.errors,
    warnings: report.warnings,
    models: report.models,
    requests: report.requests,
    input_tokens: report.inputTokens,
  };
}
