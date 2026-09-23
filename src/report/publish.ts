import type { ResolvedConfig } from "../config/schema.js";
import { errorMessage } from "../jev/evaluate.js";
import type { Finding } from "../policy/findings.js";
import type { CheckAnnotation, GitHubPort, ReviewCommentInput } from "../ports.js";
import { FINGERPRINT_MARKER, fingerprintsIn, renderFinding, SEVERITY_LABEL } from "./comments.js";
import { renderSummary, SUMMARY_MARKER, verdictTitle, type ReviewReport } from "./summary.js";

export const REVIEW_MARKER = "<!-- jev-review:review -->";
const MAX_ANNOTATIONS = 50;

export interface PublishResult {
  summaryCommentId?: number;
  inlineComments: number;
  summary: string;
  warnings: string[];
}

/** Pick new located findings for inline comments, skipping ones already posted on earlier runs. */
export function selectInline(findings: Finding[], posted: Set<string>, max: number): Finding[] {
  return findings.filter((f) => f.location && !posted.has(f.fingerprint)).slice(0, max);
}

export async function publish(report: ReviewReport, gh: GitHubPort, cfg: ResolvedConfig): Promise<PublishResult> {
  const warnings: string[] = [];
  const { output } = cfg;
  const attempt = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      warnings.push(`${what} failed: ${errorMessage(e)}`);
    }
  };

  const posted = new Set((await gh.listReviewComments(FINGERPRINT_MARKER)).flatMap((c) => fingerprintsIn(c.body)));
  const inline = output.inline_comments ? selectInline(report.findings, posted, output.max_inline_comments) : [];
  const inlineSet = new Set([...inline.map((f) => f.fingerprint), ...report.findings.filter((f) => posted.has(f.fingerprint)).map((f) => f.fingerprint)]);
  const summary = renderSummary(report, inlineSet);

  let summaryCommentId: number | undefined;
  if (output.summary_comment) {
    await attempt("summary comment", async () => {
      const [existing] = await gh.listIssueComments(SUMMARY_MARKER);
      if (existing) {
        await gh.updateIssueComment(existing.id, summary);
        summaryCommentId = existing.id;
      } else {
        summaryCommentId = await gh.createIssueComment(summary);
      }
    });
  }

  let inlineComments = 0;
  const event = output.review ? report.verdict.event : "COMMENT";
  if (event !== "REQUEST_CHANGES" && output.review) {
    // A fixed PR should not stay blocked by an earlier bot review.
    await attempt("dismissing earlier review", async () => {
      for (const r of await gh.listReviews(REVIEW_MARKER)) {
        if (r.state === "CHANGES_REQUESTED") await gh.dismissReview(r.id, "Superseded by a newer Jev review.");
      }
    });
  }

  // A COMMENT review with no inline comments adds nothing the summary does not already say.
  if (inline.length > 0 || event !== "COMMENT") {
    const comments: ReviewCommentInput[] = inline.map((f) => ({
      path: f.location!.path,
      line: f.location!.line,
      body: renderFinding(f, cfg),
    }));
    const body = `${REVIEW_MARKER}\n**Jev review: ${verdictTitle(report)}.** Details are in the summary comment.`;
    await attempt("review", async () => {
      try {
        await gh.createReview({ commitId: report.pr.headSha, event, body, comments });
        inlineComments = comments.length;
      } catch (e) {
        if (!comments.length) throw e;
        // One bad comment position rejects the whole review; keep the verdict without inline comments.
        warnings.push(`inline comments rejected: ${errorMessage(e)}`);
        await gh.createReview({ commitId: report.pr.headSha, event, body, comments: [] });
      }
    });
  }

  if (output.labels) {
    const label = cfg.uncertainty.label;
    await attempt("label", () => (report.verdict.needsHuman ? gh.addLabel(label) : gh.removeLabel(label)));
  }

  if (output.check_run) {
    await attempt("check run", () =>
      gh.createCheckRun({
        headSha: report.pr.headSha,
        conclusion: report.verdict.failCheck ? "failure" : report.errors.length ? "neutral" : "success",
        title: verdictTitle(report),
        summary,
        annotations: annotations(report.findings),
      }),
    );
  }

  return { summaryCommentId, inlineComments, summary, warnings };
}

function annotations(findings: Finding[]): CheckAnnotation[] {
  return findings
    .filter((f) => f.location)
    .slice(0, MAX_ANNOTATIONS)
    .map((f) => ({
      path: f.location!.path,
      start_line: f.location!.line,
      end_line: f.location!.line,
      annotation_level: f.severity === "blocker" ? "failure" : f.severity === "info" ? "notice" : "warning",
      title: `${SEVERITY_LABEL[f.severity]}: ${f.rule.id}`,
      message: `${f.rule.description ?? f.rule.id} (${Math.round(f.probability * 100)}%${f.status === "needs_human" ? ", needs human review" : ""})`,
    }));
}
