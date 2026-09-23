import type { ResolvedConfig, Severity } from "../config/schema.js";
import type { Finding } from "../policy/findings.js";
import { languageOf } from "../jev/state.js";
import { codeSnippet, renderTemplate } from "./template.js";

export const SEVERITY_LABEL: Record<Severity, string> = {
  blocker: "Blocker",
  major: "Major",
  minor: "Minor",
  info: "Info",
};

export const FINGERPRINT_MARKER = "<!-- jev:f=";
const FINGERPRINT_RE = /<!-- jev:f=([0-9a-f]+) -->/g;

export function fingerprintsIn(body: string): string[] {
  return [...body.matchAll(FINGERPRINT_RE)].map((m) => m[1]!);
}

export function renderFinding(finding: Finding, cfg: ResolvedConfig): string {
  const { rule, location } = finding;
  const body = renderTemplate(rule.template ?? cfg.output.comment_template, {
    rule: { id: rule.id, description: rule.description ?? rule.id, severity: rule.severity },
    severity: finding.severity,
    severity_label: SEVERITY_LABEL[finding.severity],
    status: finding.status,
    needs_human: finding.status === "needs_human",
    probability: finding.probability,
    confidence: finding.confidence,
    label: finding.label,
    path: location?.path ?? (finding.subject.kind === "pr" ? undefined : finding.subject.path),
    line: location?.line,
    // Diff text only ever enters a comment as a fenced block.
    snippet: location ? codeSnippet(location.text, fenceLang(location.path)) : undefined,
  });
  return `${body.trim()}\n\n${FINGERPRINT_MARKER}${finding.fingerprint} -->`;
}

function fenceLang(path: string): string {
  const ext = path.split(".").at(-1) ?? "";
  return languageOf(path) === "unknown" ? "" : ext.toLowerCase();
}
