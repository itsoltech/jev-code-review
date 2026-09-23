import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";
import type { ResolvedConfig } from "./config/schema.js";
import { prFromContext } from "./github/context.js";
import { createGitHubPort } from "./github/octokitPort.js";
import { createJevPort } from "./jev/jevPort.js";
import { run } from "./run.js";

function booleanInput(name: string, fallback: boolean): boolean {
  return core.getInput(name) === "" ? fallback : core.getBooleanInput(name);
}

async function main(): Promise<void> {
  const apiKey = core.getInput("typesafe-api-key", { required: true });
  core.setSecret(apiKey);
  const token = core.getInput("github-token", { required: true });

  const pr = prFromContext(context);
  if (!pr) {
    core.notice(`Jev review runs on pull_request events; got "${context.eventName}". Nothing to do.`);
    return;
  }

  const configRef = core.getInput("config-ref") || "base";
  if (configRef !== "base" && configRef !== "head") throw new Error(`config-ref must be "base" or "head", got "${configRef}"`);
  const failOnError = core.getInput("fail-on-error");

  const gh = createGitHubPort(getOctokit(token), context.repo, pr.number);
  const createJev = (cfg: ResolvedConfig) =>
    createJevPort({
      apiKey,
      timeoutMs: cfg.budget.request_timeout_seconds * 1000,
      logger: { debug: core.debug, info: core.info, warn: core.warning, error: core.error },
    });

  const result = await run(
    {
      configPath: core.getInput("config-path") || ".github/jev-review.yml",
      configRef,
      model: core.getInput("model") || undefined,
      dryRun: booleanInput("dry-run", false),
      allowForkPrs: booleanInput("allow-fork-prs", false),
      failOnError: failOnError === "" ? undefined : core.getBooleanInput("fail-on-error"),
    },
    { gh, createJev, pr, log: { info: core.info, warning: core.warning } },
  );

  if (booleanInput("job-summary", true)) await core.summary.addRaw(result.summary, true).write();

  const report = result.report;
  core.setOutput("status", result.status);
  core.setOutput("verdict", report?.verdict.event ?? "");
  core.setOutput("check-failed", String(result.failed));
  core.setOutput("composite-score", report?.composite.composite?.toFixed(3) ?? "");
  core.setOutput("findings-count", String(report?.findings.length ?? 0));
  core.setOutput("blockers-count", String(report?.findings.filter((f) => f.status === "confirmed" && f.severity === "blocker").length ?? 0));
  core.setOutput("needs-human", String(report?.verdict.needsHuman ?? false));
  core.setOutput("model", report?.models.join(",") ?? "");
  core.setOutput("input-tokens", String(report?.inputTokens ?? 0));
  core.setOutput("summary-comment-id", String(result.published?.summaryCommentId ?? ""));

  if (result.status === "skipped") core.notice(result.message ?? "Jev review skipped.");
  if (result.failed) core.setFailed(result.message ?? `Jev review: ${report?.verdict.reasons.join("; ") || "check failed"}`);
}

main().catch((e: unknown) => {
  core.setFailed(e instanceof Error ? e.message : String(e));
});
