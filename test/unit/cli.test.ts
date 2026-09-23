import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { githubRepo, localChange, type Git } from "../../src/cli/git.js";
import { runCli, type CliIo } from "../../src/cli/main.js";
import { filesFromGitDiff } from "../../src/diff/gitDiff.js";
import { pr as basePr } from "../helpers/factories.js";
import { FakeGitHub, fakeJev, quietOracle, text, type Oracle } from "../helpers/fakes.js";

const DIFF = [
  "diff --git a/src/users.ts b/src/users.ts",
  "index 1111111..2222222 100644",
  "--- a/src/users.ts",
  "+++ b/src/users.ts",
  "@@ -10,1 +10,3 @@ export async function findUser(db, id) {",
  "   const table = 'users';",
  "+  const sql = 'SELECT * FROM users WHERE id = ' + id;",
  "+  return db.query(sql);",
  "",
].join("\n");

const CONFIG = `extends: ["jev:security"]
model: jev-1.13.0
rules:
  - id: sec.hardcoded-secret
    enabled: false
policy:
  fail_check: { severities: [blocker] }
`;

const sqlOracle: Oracle = (state, q) => {
  const line = (state.changes?.lines ?? []).filter((l) => l.includes("SELECT"))[0];
  if (q.type === "noul" && text(q).includes("SQL")) return { type: "noul", noul: line ? 0.95 : 0.02 };
  if (q.type === "choice" && text(q).includes("clearest instance") && line) {
    const id = line.split(" ")[0]!;
    const labels = Object.keys(q.criteria);
    return { type: "choice", choice: id, confidence: 0.9, probabilities: Object.fromEntries(labels.map((l) => [l, l === id ? 0.95 : 0.05 / (labels.length - 1)])) };
  }
  return quietOracle(state, q);
};

/** git that answers the commands the CLI runs for a local change. */
function fakeGit(root: string, commits = "feat: add user lookup\x1fBody text\x1e"): Git {
  return (...args) => {
    const cmd = args.join(" ");
    if (cmd === "rev-parse --show-toplevel") return `${root}\n`;
    if (cmd.startsWith("symbolic-ref")) return "origin/main\n";
    if (cmd === "rev-parse HEAD") return "head000\n";
    if (cmd.startsWith("merge-base")) return "base000\n";
    if (cmd.includes(" diff ")) return DIFF;
    if (cmd.startsWith("log")) return commits;
    if (cmd.startsWith("ls-files")) return "";
    if (cmd === "remote get-url origin") return "git@github.com:acme/app.git\n";
    throw new Error(`unexpected git ${cmd}`);
  };
}

function setup(extra: Partial<CliIo> = {}) {
  const root = mkdtempSync(join(tmpdir(), "jev-cli-"));
  mkdirSync(join(root, ".github"));
  writeFileSync(join(root, ".github/jev-review.yml"), CONFIG);
  const out: string[] = [];
  const err: string[] = [];
  const { createJev, log } = fakeJev(sqlOracle);
  const io: CliIo = {
    cwd: root,
    env: { TYPESAFE_API_KEY: "test-key" },
    git: fakeGit(root),
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    createJev: (cfg) => createJev(cfg),
    ...extra,
  };
  return { root, io, out, err, log };
}

describe("cli", () => {
  it("prints help and version", async () => {
    const { io, out } = setup();
    expect(await runCli(["--help"], io)).toBe(0);
    expect(out[0]).toContain("--pr <number>");
    expect(await runCli(["-v"], io)).toBe(0);
    expect(out[1]).toBe("dev");
  });

  it("rejects bad usage with exit code 2", async () => {
    const { io, err } = setup();
    expect(await runCli(["--post"], io)).toBe(2);
    expect(await runCli(["--format", "xml"], io)).toBe(2);
    expect(await runCli(["--pr", "3", "--base", "main"], io)).toBe(2);
    expect(await runCli(["--nope"], io)).toBe(2);
    expect(err.join("\n")).toContain("--post needs --pr");
  });

  it("needs an API key", async () => {
    const { io, err } = setup({ env: {} });
    expect(await runCli([], io)).toBe(2);
    expect(err.join("\n")).toContain("TYPESAFE_API_KEY");
  });

  it("reviews the local change and fails on a blocker", async () => {
    const { io, out, log } = setup();
    expect(await runCli([], io)).toBe(1);
    expect(out[0]).toContain("sec.sql-concat");
    expect(out[0]).toContain("src/users.ts:11");
    // The title and description come from the commits.
    expect(JSON.stringify(log.requests)).toContain("feat: add user lookup");
  });

  it("writes JSON and SARIF", async () => {
    const { io, out } = setup();
    await runCli(["--format", "json"], io);
    const json = JSON.parse(out[0]!);
    expect(json.findings[0]).toMatchObject({ rule: "sec.sql-concat", severity: "blocker", path: "src/users.ts" });

    await runCli(["--format", "sarif"], io);
    const sarif = JSON.parse(out[1]!);
    expect(sarif.version).toBe("2.1.0");
    const result = sarif.runs[0].results[0];
    expect(result).toMatchObject({ ruleId: "sec.sql-concat", level: "error", ruleIndex: 0 });
    expect(result.locations[0].physicalLocation).toEqual({ artifactLocation: { uri: "src/users.ts" }, region: { startLine: 11 } });
  });

  it("reads a diff from stdin", async () => {
    const { io, out } = setup({ stdin: () => DIFF, git: () => { throw new Error("git is not used"); } });
    expect(await runCli(["--diff", "-", "--title", "Add lookup"], io)).toBe(1);
    expect(out[0]).toContain("sec.sql-concat");
  });

  it("reviews a pull request read-only, and publishes only with --post", async () => {
    const gh = new FakeGitHub();
    gh.files = filesFromGitDiff(DIFF);
    gh.repoFiles.set(`${basePr.baseSha}:.github/jev-review.yml`, CONFIG);
    const github = async (token: string, repo: string, number: number) => {
      expect([token, repo, number]).toEqual(["gh-token", "acme/app", 7]);
      return { gh, pr: { ...basePr, number } };
    };
    const { io } = setup({ env: { TYPESAFE_API_KEY: "k", GITHUB_TOKEN: "gh-token" }, github });
    expect(await runCli(["--pr", "7"], io)).toBe(1);
    expect(gh.writes).toBe(0);
    expect(await runCli(["--pr", "7", "--post"], io)).toBe(1);
    expect(gh.reviews[0]?.event).toBe("REQUEST_CHANGES");
  });
});

describe("local change", () => {
  it("uses the oldest commit subject as the title and every message as the description", () => {
    const git = fakeGit("/r", "fix: first\x1f\x1efeat: second\x1fwhy it matters\x1e");
    const change = localChange(git, {});
    expect(change.title).toBe("fix: first");
    expect(change.body).toBe("fix: first\n\nfeat: second\n\nwhy it matters");
    expect(change.files.map((f) => f.path)).toEqual(["src/users.ts"]);
    expect(localChange(git, { staged: true }).title).toBe("Uncommitted changes");
  });

  it("reads owner/name from the origin remote", () => {
    expect(githubRepo(fakeGit("/r"))).toBe("acme/app");
    expect(githubRepo(() => "https://github.com/itsoltech/jev-code-review.git\n")).toBe("itsoltech/jev-code-review");
    expect(githubRepo(() => "https://gitlab.com/a/b.git\n")).toBeUndefined();
  });

  it("marks renamed files", () => {
    const diff = "diff --git a/a.ts b/b.ts\nsimilarity index 90%\nrename from a.ts\nrename to b.ts\n@@ -1 +1 @@\n-x\n+y\n";
    expect(filesFromGitDiff(diff)[0]).toMatchObject({ path: "b.ts", status: "renamed", additions: 1, deletions: 1 });
  });
});
