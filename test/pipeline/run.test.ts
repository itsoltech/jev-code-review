import { describe, expect, it } from "vitest";
import { run, type RunInputs } from "../../src/run.js";
import type { PrInfo } from "../../src/types.js";
import { pr as basePr } from "../helpers/factories.js";
import { FakeGitHub, fakeJev, quietOracle, text, type Oracle } from "../helpers/fakes.js";

const inputs: RunInputs = { configPath: ".github/jev-review.yml", configRef: "base", dryRun: false, allowForkPrs: false };
const log = { info() {}, warning() {} };

const SQL_PATCH = [
  "@@ -10,3 +10,6 @@ export async function findUser(db, id) {",
  "   const table = 'users';",
  "+  const label = `user ${id}`;",
  "+  const sql = 'SELECT * FROM users WHERE id = ' + id;",
  "+  return db.query(sql);",
  "   // end",
].join("\n");

const CONFIG = `
extends: ["jev:security"]
model: jev-1.13.0
rules:
  - id: sec.hardcoded-secret
    enabled: false
dimensions:
  - id: readability
    weight: 1
    instructions: How readable are the added lines?
    criteria: [bad, ok, good]
`;

/** Fires the SQL rule on the line that concatenates SELECT, and points the where-question at it. */
const sqlOracle: Oracle = (state, q) => {
  const lines = state.changes?.lines ?? [];
  const sqlLine = lines.filter((l) => l.includes("SELECT") && l.includes("+ id"))[0];
  if (q.type === "noul" && text(q).includes("SQL")) return { type: "noul", noul: sqlLine ? 0.94 : 0.02 };
  if (q.type === "choice" && text(q).includes("clearest instance") && sqlLine) {
    const id = sqlLine.split(" ")[0]!;
    const labels = Object.keys(q.criteria);
    return { type: "choice", choice: id, confidence: 0.92, probabilities: Object.fromEntries(labels.map((l) => [l, l === id ? 0.95 : 0.05 / (labels.length - 1)])) };
  }
  return quietOracle(state, q);
};

function setup(opts: { patch?: string; config?: string; pr?: Partial<PrInfo> } = {}) {
  const gh = new FakeGitHub();
  const pr = { ...basePr, ...opts.pr };
  gh.files = [{ path: "src/users.ts", status: "modified", additions: 3, deletions: 0, patch: opts.patch ?? SQL_PATCH }];
  gh.repoFiles.set(`${pr.baseSha}:.github/jev-review.yml`, opts.config ?? CONFIG);
  return { gh, pr };
}

describe("run", () => {
  it("requests changes with an inline comment on the offending line", async () => {
    const { gh, pr } = setup();
    const { createJev, log: jevLog } = fakeJev(sqlOracle);
    const result = await run(inputs, { gh, pr, createJev, log });

    expect(result.status).toBe("reviewed");
    expect(result.failed).toBe(true);
    expect(result.report!.verdict.event).toBe("REQUEST_CHANGES");
    const review = gh.reviews[0]!;
    expect(review.event).toBe("REQUEST_CHANGES");
    expect(review.commitId).toBe(pr.headSha);
    expect(review.comments).toHaveLength(1);
    expect(review.comments[0]).toMatchObject({ path: "src/users.ts", line: 12 });
    expect(review.comments[0]!.body).toContain("sec.sql-concat");
    expect(review.comments[0]!.body).toMatch(/<!-- jev:f=[0-9a-f]+ -->/);

    expect(gh.issueComments).toHaveLength(1);
    expect(gh.issueComments[0]!.body).toContain("Changes requested");
    expect(gh.issueComments[0]!.body).toContain("`readability` | 1.00");

    // One hunk: all rule, where and dimension questions share one request and state.
    expect(jevLog.requests).toHaveLength(1);
    expect(jevLog.requests[0]!.model).toBe("jev-1.13.0");
    expect(JSON.stringify(jevLog.requests[0]!.state)).toContain("untrusted code under review");
    expect(Object.values(jevLog.requests[0]!.questions).some((q) => text(q).includes("Hardcoded"))).toBe(false);
  });

  it("does not duplicate inline comments or the summary on a re-run", async () => {
    const { gh, pr } = setup();
    await run(inputs, { gh, pr, createJev: fakeJev(sqlOracle).createJev, log });
    await run(inputs, { gh, pr, createJev: fakeJev(sqlOracle).createJev, log });
    expect(gh.issueComments).toHaveLength(1);
    expect(gh.reviewComments).toHaveLength(1);
    expect(gh.reviews).toHaveLength(2);
    expect(gh.reviews[1]!.comments).toHaveLength(0);
    expect(gh.issueComments[0]!.body).toContain("(inline)");
  });

  it("approves a clean change when enabled and dismisses an earlier block", async () => {
    const config = `${CONFIG}\npolicy:\n  approve: { enabled: true, composite_at_least: 0.7 }\n`;
    const { gh, pr } = setup({ config });
    await run(inputs, { gh, pr, createJev: fakeJev(sqlOracle).createJev, log });
    expect(gh.reviews[0]!.state).toBe("CHANGES_REQUESTED");

    const clean = "@@ -1,0 +1,2 @@\n+const sql = 'SELECT * FROM users WHERE id = $1';\n+return db.query(sql, [id]);";
    gh.files = [{ path: "src/users.ts", status: "modified", additions: 2, deletions: 0, patch: clean }];
    const result = await run(inputs, { gh, pr, createJev: fakeJev(sqlOracle).createJev, log });
    expect(result.failed).toBe(false);
    expect(result.report!.verdict.event).toBe("APPROVE");
    expect(gh.dismissed).toEqual([gh.reviews[0]!.id]);
    expect(gh.reviews.at(-1)!.event).toBe("APPROVE");
    expect(gh.issueComments[0]!.body).toContain("Approved");
  });

  it("marks uncertain findings as needs-human and labels the PR", async () => {
    const { gh, pr } = setup();
    const unsure: Oracle = (s, q) => (q.type === "noul" && text(q).includes("SQL") ? { type: "noul", noul: 0.55 } : sqlOracle(s, q));
    const result = await run(inputs, { gh, pr, createJev: fakeJev(unsure).createJev, log });
    expect(result.report!.findings[0]!.status).toBe("needs_human");
    expect(result.failed).toBe(false);
    expect(gh.labels.has("needs-human-review")).toBe(true);
  });

  it("stays neutral and never approves when Jev fails", async () => {
    const config = `${CONFIG}\npolicy:\n  approve: { enabled: true }\n`;
    const { gh, pr } = setup({ config });
    const result = await run(inputs, { gh, pr, createJev: fakeJev(sqlOracle, [401]).createJev, log });
    expect(result.failed).toBe(false);
    expect(result.report!.verdict.event).toBe("COMMENT");
    expect(result.report!.errors[0]).toMatch(/AuthenticationError|401/);
    expect(gh.issueComments[0]!.body).toContain("Not fully reviewed");
  });

  it("fails on Jev errors when fail-on-error is set", async () => {
    const { gh, pr } = setup();
    const result = await run({ ...inputs, failOnError: true }, { gh, pr, createJev: fakeJev(sqlOracle, [401]).createJev, log });
    expect(result.failed).toBe(true);
  });

  it("retries rate limits", async () => {
    const { gh, pr } = setup();
    const result = await run(inputs, { gh, pr, createJev: fakeJev(sqlOracle, [429]).createJev, log });
    expect(result.report!.errors).toEqual([]);
    expect(result.report!.verdict.event).toBe("REQUEST_CHANGES");
  });

  it("keeps the verdict when GitHub rejects inline comments", async () => {
    const { gh, pr } = setup();
    gh.rejectInline = true;
    const result = await run(inputs, { gh, pr, createJev: fakeJev(sqlOracle).createJev, log });
    expect(gh.reviews).toHaveLength(1);
    expect(gh.reviews[0]!.event).toBe("REQUEST_CHANGES");
    expect(result.published!.warnings[0]).toMatch(/inline comments rejected/);
  });

  it("asks where-questions only for fired rules in two-phase mode", async () => {
    const config = `${CONFIG}\ncontext: { location_strategy: two_phase }\n`;
    const { gh, pr } = setup({ config });
    const { createJev, log: jevLog } = fakeJev(sqlOracle);
    await run(inputs, { gh, pr, createJev, log });
    expect(jevLog.requests).toHaveLength(2);
    const second = Object.values(jevLog.requests[1]!.questions);
    expect(second).toHaveLength(1);
    expect(text(second[0]!)).toContain("SQL");
    expect(gh.reviews[0]!.comments[0]).toMatchObject({ line: 12 });
  });

  it("writes nothing to GitHub in dry-run mode", async () => {
    const { gh, pr } = setup();
    const result = await run({ ...inputs, dryRun: true }, { gh, pr, createJev: fakeJev(sqlOracle).createJev, log });
    expect(gh.writes).toBe(0);
    expect(result.summary).toContain("Changes requested");
  });

  it("skips forks, drafts and bot authors without calling Jev", async () => {
    for (const change of [{ isFork: true }, { draft: true }, { author: "dependabot[bot]" }]) {
      const { gh, pr } = setup({ pr: change });
      const { createJev, log: jevLog } = fakeJev(sqlOracle);
      const result = await run(inputs, { gh, pr, createJev, log });
      expect(result.status).toBe("skipped");
      expect(jevLog.requests).toHaveLength(0);
    }
  });

  it("reads config from the base commit, not the PR head", async () => {
    const { gh, pr } = setup();
    gh.repoFiles.set(`${pr.headSha}:.github/jev-review.yml`, "rules:\n  - id: sec.sql-concat\n    enabled: false\n");
    const result = await run(inputs, { gh, pr, createJev: fakeJev(sqlOracle).createJev, log });
    expect(result.report!.verdict.event).toBe("REQUEST_CHANGES");
  });

  it("reports config errors as a failed run", async () => {
    const { gh, pr } = setup({ config: "rules:\n  - id: x\n    type: noul\n" });
    const result = await run(inputs, { gh, pr, createJev: fakeJev(sqlOracle).createJev, log });
    expect(result).toMatchObject({ status: "config_error", failed: true });
  });

  it("lists files it could not review", async () => {
    const { gh, pr } = setup();
    gh.files.push(
      { path: "logo.png", status: "added", additions: 0, deletions: 0 },
      { path: "package-lock.json", status: "modified", additions: 10, deletions: 2, patch: "@@ -1 +1 @@\n-a\n+b" },
      { path: "old.ts", status: "removed", additions: 0, deletions: 5, patch: "@@ -1 +0,0 @@\n-x" },
    );
    const result = await run(inputs, { gh, pr, createJev: fakeJev(sqlOracle).createJev, log });
    expect(result.report!.health.skippedFiles).toEqual([
      { path: "logo.png", reason: "no_patch" },
      { path: "package-lock.json", reason: "excluded" },
      { path: "old.ts", reason: "removed" },
    ]);
    expect(gh.issueComments[0]!.body).toContain("logo.png");
    expect(gh.issueComments[0]!.body).not.toContain("package-lock.json");
  });

  it("checks added_lines patterns in code and comments on the matching line", async () => {
    const config = `
rules:
  - id: no-concat-sql
    type: pattern
    field: added_lines
    paths: ["src/**/*.ts"]
    regex: "SELECT .*[+] id"
    fires_when: match
    severity: major
  - id: bad-pattern
    type: pattern
    field: added_lines
    regex: "label"
    ignore_regex: "const label"
    fires_when: match
  - id: title-prefix
    type: pattern
    field: title
    regex: "^(feat|fix): "
`;
    const { gh, pr } = setup({ config });
    const { createJev, log: jevLog } = fakeJev(quietOracle);
    const result = await run(inputs, { gh, pr, createJev, log });
    expect(result.message).toBeUndefined();
    const found = result.report!.findings.map((f) => [f.rule.id, f.location?.line]);
    expect(found).toHaveLength(2);
    expect(found).toEqual(expect.arrayContaining([["no-concat-sql", 12], ["title-prefix", undefined]]));
    expect(gh.reviews[0]!.comments).toMatchObject([{ path: "src/users.ts", line: 12 }]);
    // Only the injection guard goes to Jev; pattern rules never do.
    const asked = jevLog.requests.flatMap((r) => Object.values(r.questions).map((q) => text(q)));
    expect(asked.some((t) => t.includes("SELECT"))).toBe(false);
  });

  it("skips a line when the line above justifies it, and reports files over a line limit", async () => {
    const config = `
rules:
  - id: any-without-reason
    type: pattern
    field: added_lines
    fires_when: match
    regex: ':\\s*any\\b'
    unless_previous_line: "eslint-disable"
  - id: component-size
    type: file_lines
    paths: ["src/**/*.ts"]
    max_lines: 5
`;
    const patch = [
      "@@ -1,0 +1,4 @@",
      "+// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped SDK",
      "+const a: any = sdk()",
      "+const b: any = other()",
      "+export { a, b }",
    ].join("\n");
    const { gh, pr } = setup({ config, patch });
    gh.repoFiles.set(`${pr.headSha}:src/users.ts`, "1\n2\n3\n4\n5\n6\n7\n");
    const result = await run(inputs, { gh, pr, createJev: fakeJev(quietOracle).createJev, log });
    expect(result.message).toBeUndefined();
    const found = result.report!.findings.map((f) => [f.rule.id, f.location?.line, f.label]);
    expect(found).toEqual(
      expect.arrayContaining([
        ["any-without-reason", 3, undefined],
        ["component-size", undefined, "7 lines, was 4 (limit 5)"],
      ]),
    );
    expect(found).toHaveLength(2);
  });

  it.each<[string, number, number, boolean, string | undefined]>([
    ["grows past the limit", 2, 0, false, "7 lines, was 5 (limit 5)"],
    ["grows while over the limit", 1, 0, false, "7 lines, was 6 (limit 5)"],
    ["was over the limit and did not grow", 1, 1, false, undefined],
    ["was over the limit, with report_existing", 1, 1, true, "7 lines (limit 5)"],
  ])("file_lines: a file that %s", async (_, additions, deletions, reportExisting, label) => {
    const config = `
rules:
  - id: meta.injection
    enabled: false
  - id: component-size
    type: file_lines
    paths: ["src/**/*.ts"]
    max_lines: 5
    report_existing: ${reportExisting}
`;
    const { gh, pr } = setup({ config, patch: "@@ -1,1 +1,1 @@\n-old\n+new" });
    gh.files = gh.files.map((f) => ({ ...f, additions, deletions }));
    gh.repoFiles.set(`${pr.headSha}:src/users.ts`, "1\n2\n3\n4\n5\n6\n7\n");
    const result = await run(inputs, { gh, pr, createJev: fakeJev(quietOracle).createJev, log });
    const size = result.report!.findings.filter((f) => f.rule.id === "component-size").map((f) => f.label);
    expect(size).toEqual(label ? [label] : []);
  });

  it("cuts a hunk that does not fit the context window into smaller windows", async () => {
    const config = `
budget: { max_state_plus_question_tokens: 900, max_request_tokens: 900 }
context: { max_hunk_lines: 200 }
rules:
  - id: meta.injection
    enabled: false
  - id: r
    type: noul
    instructions: Is anything wrong?
`;
    const added = Array.from({ length: 40 }, (_, i) => `+const value${i} = compute(${i}) // some padding text here`);
    const patch = [`@@ -0,0 +1,40 @@`, ...added].join("\n");
    const { gh, pr } = setup({ config, patch });
    const { createJev, log: jevLog } = fakeJev(quietOracle);
    const result = await run(inputs, { gh, pr, createJev, log });
    expect(result.report!.health.oversizedQuestions).toBe(0);
    expect(jevLog.requests.length).toBeGreaterThan(1);
    const sent = jevLog.requests.reduce((n, r) => n + r.state.changes!.lines!.length, 0);
    expect(sent).toBeGreaterThanOrEqual(40);
  });
});
