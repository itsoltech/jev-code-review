import { describe, expect, it } from "vitest";
import { estimateTokens, packQuestions } from "../../src/jev/batch.js";
import { QuestionKeys, questionsFor } from "../../src/jev/questions.js";
import { buildState, isTestPath, parseDescription } from "../../src/jev/state.js";
import { codeSnippet, inlineCode, renderTemplate } from "../../src/report/template.js";
import { cfgWith, hunk, noulRule, pr } from "../helpers/factories.js";

describe("renderTemplate", () => {
  it("fills values, filters and sections", () => {
    const out = renderTemplate("{{rule.id}} {{p|pct}}{{#flag}} yes{{/flag}}{{^flag}} no{{/flag}} {{missing}}", {
      rule: { id: "r" },
      p: 0.873,
      flag: false,
    });
    expect(out).toBe("r 87% no ");
  });
});

describe("codeSnippet / inlineCode", () => {
  it("uses a fence longer than any backtick run in the code", () => {
    expect(codeSnippet("a ``` b", "ts")).toBe("````ts\na ``` b\n````");
  });
  it("keeps table cells intact", () => {
    expect(inlineCode("a|`b`")).toBe("`a\\|'b'`");
  });
});

describe("questionsFor", () => {
  const cfg = cfgWith({
    rules: [
      noulRule("ts-only", { paths: ["**/*.ts"] }),
      noulRule("no-tests", { exclude_paths: ["**/*.test.ts"] }),
      noulRule("unlocated", { locate: false }),
      noulRule("pr-rule", { scope: "pr" }),
    ],
    dimensions: [{ id: "d", instructions: "x", criteria: ["a", "b"] }],
  });

  it("applies path filters and adds where-questions for located rules", () => {
    const keys = new QuestionKeys();
    const qs = questionsFor(hunk("src/a.ts"), cfg, keys, "eager").questions.map((q) => `${q.meta.role}:${q.meta.target}`);
    expect(qs).toEqual(["verdict:ts-only", "where:ts-only", "verdict:no-tests", "where:no-tests", "verdict:unlocated", "dimension:d"]);
    const test = questionsFor(hunk("src/a.test.ts"), cfg, keys, "none").questions.map((q) => q.meta.target);
    expect(test).toEqual(["ts-only", "unlocated", "d"]);
    expect(questionsFor(hunk("README.md"), cfg, keys, "none").questions.map((q) => q.meta.target)).toEqual(["no-tests", "unlocated", "d"]);
  });

  it("offers only added-line ids as locations", () => {
    const keys = new QuestionKeys();
    const where = questionsFor(hunk("src/a.ts", ["a", "b", "c"]), cfg, keys, "eager").questions[1]!.question;
    expect(where.type === "choice" && Object.keys(where.criteria)).toEqual(["L001", "L002", "L003"]);
  });
});

describe("packQuestions", () => {
  const q = (n: number) => ({ key: `q${n}`, question: { type: "noul" as const, instructions: "x".repeat(300) } });
  const subject = hunk();

  it("packs under the request limit and drops questions that can never fit", () => {
    const state = { s: "y".repeat(300) };
    const perQ = estimateTokens(q(0).question);
    const { requests, oversized } = packQuestions(subject, state, [q(1), q(2), q(3)], {
      maxRequestTokens: estimateTokens(state) + perQ * 2,
      maxStatePlusQuestionTokens: 10_000,
    });
    expect(requests.map((r) => Object.keys(r.questions))).toEqual([["q1", "q2"], ["q3"]]);
    expect(oversized).toEqual([]);

    const tiny = packQuestions(subject, state, [q(1)], { maxRequestTokens: 10_000, maxStatePlusQuestionTokens: estimateTokens(state) + 5 });
    expect(tiny).toEqual({ requests: [], oversized: ["q1"] });
  });
});

describe("buildState", () => {
  const cfg = cfgWith();

  it("sends the hunk with line ids and no PR body by default", () => {
    const state = buildState(hunk("src/a.ts", ["x"]), pr, [], cfg) as { pr: object; changes: { lines: string[] } };
    expect(state.pr).toEqual({ title: pr.title });
    expect(state.changes.lines).toEqual(["L001 + x"]);
  });

  it("sends the description only with PR-scope questions", () => {
    const withBody = cfgWith({ context: { include_pr_body: true } });
    const hunkState = buildState(hunk(), pr, [], withBody) as { pr: object };
    expect(hunkState.pr).toEqual({ title: pr.title });
    const prState = buildState({ kind: "pr", key: "pr" }, { ...pr, body: "  " }, [], withBody) as { pr: Record<string, unknown> };
    expect(prState.pr).toMatchObject({ title: pr.title, description: "", description_is_empty: true });
    const noBody = buildState({ kind: "pr", key: "pr" }, pr, [], cfg) as { pr: Record<string, unknown> };
    expect(noBody.pr.description).toBeUndefined();
  });

  it("splits the description into sections without template comments", () => {
    const body = "## What\r\n\r\n<!-- Short description. -->\r\n\r\n## Why\r\nUsers lost work.\r\n\r\n## Checklist\r\n- [x] Tests\r\n- [ ] Docs\r\n";
    expect(parseDescription(body)).toEqual({
      sections: { what: "", why: "Users lost work.", checklist: "- [x] Tests\n- [ ] Docs" },
      checklist: { checked: 1, unchecked: 1 },
    });
    const withBody = cfgWith({ context: { include_pr_body: true } });
    const state = buildState({ kind: "pr", key: "pr" }, { ...pr, body: "<!-- only a comment -->" }, [], withBody) as { pr: Record<string, unknown> };
    expect(state.pr.description_is_empty).toBe(true);
  });

  it("computes PR stats in code", () => {
    const files = [
      { path: "src/a.ts", status: "modified", additions: 5, deletions: 1 },
      { path: "src/a.test.ts", status: "modified", additions: 2, deletions: 0 },
    ];
    const state = buildState({ kind: "pr", key: "pr" }, pr, files, cfg) as { stats: Record<string, number> };
    expect(state.stats).toEqual({ files_changed: 2, lines_added: 7, lines_removed: 1, test_files_changed: 1, source_files_changed: 1 });
  });

  it.each([
    ["src/a.test.ts", true],
    ["tests/test_api.py", true],
    ["pkg/api_test.go", true],
    ["src/__tests__/x.js", true],
    ["src/contest.ts", false],
    ["src/api.ts", false],
  ])("isTestPath(%s) = %s", (path, expected) => {
    expect(isTestPath(path)).toBe(expected);
  });
});
