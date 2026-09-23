import type { Severity } from "../config/schema.js";
import type { Finding } from "../policy/findings.js";
import { VERSION } from "../version.js";
import type { ReviewReport } from "./summary.js";

const LEVEL: Record<Severity, "error" | "warning" | "note"> = { blocker: "error", major: "error", minor: "warning", info: "note" };

function location(f: Finding) {
  if (f.location) {
    return [{ physicalLocation: { artifactLocation: { uri: f.location.path }, region: { startLine: f.location.line } } }];
  }
  if (f.subject.kind !== "pr") return [{ physicalLocation: { artifactLocation: { uri: f.subject.path } } }];
  // Pull-request findings have no file; code scanning needs one, so they are left without a location.
  return undefined;
}

/** SARIF 2.1.0, for GitHub code scanning (upload-sarif) and editors. */
export function renderSarif(report: ReviewReport) {
  const rules = [...new Map(report.findings.map((f) => [f.rule.id, f.rule])).values()];
  const index = new Map(rules.map((r, i) => [r.id, i]));
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "jev-code-review",
            version: VERSION,
            informationUri: "https://github.com/itsoltech/jev-code-review",
            rules: rules.map((r) => ({
              id: r.id,
              shortDescription: { text: r.description ?? r.id },
              defaultConfiguration: { level: LEVEL[r.severity] },
              properties: { severity: r.severity, type: r.type },
            })),
          },
        },
        results: report.findings.map((f) => {
          const locations = location(f);
          return {
            ruleId: f.rule.id,
            ruleIndex: index.get(f.rule.id),
            level: LEVEL[f.severity],
            message: {
              text:
                `${f.rule.description ?? f.rule.id}${f.label ? ` (${f.label})` : ""}. ` +
                `Probability ${Math.round(f.probability * 100)}%${f.status === "needs_human" ? ", needs human review" : ""}.`,
            },
            ...(locations ? { locations } : {}),
            partialFingerprints: { jevFinding: f.fingerprint },
            properties: { severity: f.severity, status: f.status, probability: f.probability, confidence: f.confidence, label: f.label },
          };
        }),
      },
    ],
  };
}
