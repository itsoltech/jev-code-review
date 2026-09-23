/**
 * Run the review on a local diff with the real Jev API, without touching GitHub.
 *
 *   git diff main... | TYPESAFE_API_KEY=... npm run review-local -- --config .github/jev-review.yml
 *   npm run review-local -- --diff change.patch --title "Add search" --body-file pr.md --json
 *   npm run review-local -- --pr 389 --repo itsoltech/canopy-desktop --config examples/canopy/jev-review.yml
 *
 * --pr fetches the diff, title and description with the GitHub CLI (gh) and posts nothing.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createJevPort } from "../src/jev/jevPort.js";
import type { ChangedFile } from "../src/types.js";
import { run } from "../src/run.js";
import { arg, filesFromGitDiff, localGitHub, quietLogger, requireKey } from "./lib.js";

const apiKey = requireKey();
const prNumber = arg("pr");
const gh = (...args: string[]) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
let files: ChangedFile[];
let title = arg("title") ?? "Local change";
let body = arg("body-file") ? readFileSync(arg("body-file")!, "utf8") : "";
if (prNumber) {
  const repoName = arg("repo") ?? JSON.parse(gh("repo", "view", "--json", "nameWithOwner")).nameWithOwner;
  // Same source as the action (pulls.listFiles): per-file patches, no 20k-line diff limit.
  const pages = gh("api", "--paginate", `repos/${repoName}/pulls/${prNumber}/files?per_page=100`);
  const listed = JSON.parse(`[${pages.trim().replace(/\]\s*\[/g, ",").slice(1, -1)}]`) as {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }[];
  files = listed.map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, ...(f.patch ? { patch: f.patch } : {}) }));
  const view = JSON.parse(gh("pr", "view", prNumber, "--repo", repoName, "--json", "title,body")) as { title: string; body: string };
  title = arg("title") ?? view.title;
  body = view.body;
} else {
  files = filesFromGitDiff(readFileSync(arg("diff") ?? 0, "utf8"));
}
if (!files.length) {
  console.error("No files in the diff.");
  process.exit(2);
}

const result = await run(
  { configPath: ".github/jev-review.yml", configRef: "base", model: arg("model"), dryRun: true, allowForkPrs: true },
  {
    gh: localGitHub(files, arg("config")),
    createJev: (cfg) =>
      createJevPort({ apiKey, timeoutMs: cfg.budget.request_timeout_seconds * 1000, logger: quietLogger }),
    pr: {
      number: Number(prNumber ?? 0),
      title,
      body,
      author: "local",
      draft: false,
      labels: [],
      baseSha: "local",
      headSha: "local",
      isFork: false,
    },
    log: { info: (m) => console.error(m), warning: (m) => console.error(`warning: ${m}`) },
  },
);

if (process.argv.includes("--json") && result.report) {
  const findings = result.report.findings.map((f) => ({
    rule: f.rule.id,
    severity: f.severity,
    status: f.status,
    probability: Number(f.probability.toFixed(3)),
    confidence: f.confidence,
    label: f.label,
    location: f.location,
  }));
  console.log(JSON.stringify({ verdict: result.report.verdict, composite: result.report.composite, findings }, null, 2));
} else {
  console.log(result.summary);
}
process.exitCode = result.failed ? 1 : 0;
