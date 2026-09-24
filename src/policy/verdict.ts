import type { ResolvedConfig, Severity } from "../config/schema.js";
import type { SkippedFile } from "../types.js";
import type { Finding } from "./findings.js";

export type ReviewEvent = "APPROVE" | "COMMENT" | "REQUEST_CHANGES";

export interface RunHealth {
  errors: number;
  skippedRequests: number;
  /** Part of skippedRequests that the token budget stopped. */
  skippedByBudget?: number;
  /** Part of skippedRequests not sent because a request with the same state was blocked. */
  skippedByBlock?: number;
  retries?: number;
  splits?: number;
  /** Questions dropped because the state left no room for them. */
  oversizedQuestions: number;
  /** Rule ids of choice verdicts answered with an abstain label, one per question. */
  abstentions?: string[];
  skippedFiles: SkippedFile[];
}

export interface Verdict {
  event: ReviewEvent;
  failCheck: boolean;
  needsHuman: boolean;
  reasons: string[];
}

/** Files that were not reviewed for reasons other than config choice or deletion. */
export const unreviewed = (health: RunHealth) =>
  health.skippedFiles.filter((f) => f.reason !== "excluded" && f.reason !== "removed");

export function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { blocker: 0, major: 0, minor: 0, info: 0 };
  for (const f of findings) if (f.status === "confirmed") counts[f.severity]++;
  return counts;
}

/** All verdict policy lives here, in code; Jev only supplies the judgments. */
export function decide(
  findings: Finding[],
  composite: number | undefined,
  health: RunHealth,
  cfg: ResolvedConfig,
): Verdict {
  const { policy } = cfg;
  const reasons: string[] = [];
  const confirmed = findings.filter((f) => f.status === "confirmed");
  const guardHits = findings.filter((f) => f.rule.guard);
  const needsHuman = findings.some((f) => f.status === "needs_human") || guardHits.length > 0;
  const counts = countBySeverity(findings);

  const severityHit = (severities: Severity[]) => confirmed.filter((f) => severities.includes(f.severity));
  const below = (limit: number | undefined) => limit !== undefined && composite !== undefined && composite < limit;

  let failCheck = false;
  const failHits = severityHit(policy.fail_check.severities);
  if (failHits.length) {
    failCheck = true;
    reasons.push(`${failHits.length} finding(s) with severity ${policy.fail_check.severities.join("/")}`);
  }
  if (below(policy.fail_check.composite_below)) {
    failCheck = true;
    reasons.push(`composite score ${composite!.toFixed(2)} is below ${policy.fail_check.composite_below}`);
  }
  if (health.errors > 0 && policy.on_error === "fail") {
    failCheck = true;
    reasons.push(`${health.errors} Jev request(s) failed and policy.on_error is "fail"`);
  }

  const requestChanges =
    severityHit(policy.request_changes.severities).length > 0 || below(policy.request_changes.composite_below);

  let event: ReviewEvent = requestChanges ? "REQUEST_CHANGES" : "COMMENT";
  if (!requestChanges && policy.approve.enabled) {
    const blockers = approveBlockers(findings, counts, composite, health, cfg, guardHits.length);
    if (blockers.length === 0) event = "APPROVE";
    else reasons.push(`not approved: ${blockers.join("; ")}`);
  }
  if (event === "REQUEST_CHANGES" && cfg.output.review_events === "comment_only") event = "COMMENT";
  if (guardHits.length) reasons.push("possible instructions to an automated reviewer found in the diff");

  return { event, failCheck, needsHuman, reasons };
}

function approveBlockers(
  findings: Finding[],
  counts: Record<Severity, number>,
  composite: number | undefined,
  health: RunHealth,
  cfg: ResolvedConfig,
  guardHits: number,
): string[] {
  const { approve } = cfg.policy;
  const out: string[] = [];
  // Never approve what was not fully reviewed.
  if (health.errors) out.push(`${health.errors} failed request(s)`);
  if (health.skippedRequests) out.push(`${health.skippedRequests} request(s) skipped by budget, timeout or a blocked request`);
  if (health.oversizedQuestions) out.push(`${health.oversizedQuestions} question(s) did not fit the token limits`);
  const notReviewed = unreviewed(health);
  if (notReviewed.length) out.push(`${notReviewed.length} file(s) not reviewed`);
  const abstained = health.abstentions?.length ?? 0;
  if (approve.no_abstentions && abstained) out.push(`${abstained} rule check(s) without enough context`);
  if (guardHits) out.push("injection guard fired");
  if (approve.no_needs_human && findings.some((f) => f.status === "needs_human")) out.push("uncertain findings");
  for (const [severity, max] of Object.entries(approve.max_findings) as [Severity, number][]) {
    if (counts[severity] > max) out.push(`${counts[severity]} ${severity} finding(s) (max ${max})`);
  }
  if (cfg.dimensions.length && (composite === undefined || composite < approve.composite_at_least)) {
    out.push(`composite ${composite === undefined ? "unavailable" : composite.toFixed(2)} < ${approve.composite_at_least}`);
  }
  return out;
}
