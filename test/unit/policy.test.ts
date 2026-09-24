import { describe, expect, it } from "vitest";
import { computeComposite } from "../../src/policy/composite.js";
import { abstentions, deriveFindings, judge, patternFindings, type Finding } from "../../src/policy/findings.js";
import { activeRules } from "../../src/jev/questions.js";
import { decide, type RunHealth } from "../../src/policy/verdict.js";
import type { ModelRule } from "../../src/config/schema.js";
import type { Answer, QuestionMeta, Subject } from "../../src/types.js";
import { cfgWith, choiceAnswer, hunk, noul, noulRule, scoreAnswer } from "../helpers/factories.js";

const healthy: RunHealth = { errors: 0, skippedRequests: 0, oversizedQuestions: 0, skippedFiles: [] };

function answersFor(entries: [string, QuestionMeta, Answer][]) {
  return {
    meta: new Map(entries.map(([k, m]) => [k, m])),
    answers: new Map(entries.map(([k, , a]) => [k, a])),
  };
}

describe("judge", () => {
  const cfg = cfgWith({ rules: [noulRule("r", { threshold: 0.7 })] });
  const rule = cfg.rules[0] as ModelRule;

  it.each([
    [0.95, "confirmed"],
    [0.7, "confirmed"],
    [0.69, "needs_human"],
    [0.4, "needs_human"],
    [0.39, null],
  ])("noul %s -> %s", (p, status) => {
    expect(judge(rule, noul(p), cfg)?.status ?? null).toBe(status);
  });

  it("fires on a no answer when fires_on is no", () => {
    const c = cfgWith({ rules: [noulRule("r", { fires_on: "no" })] });
    expect(judge(c.rules[0] as ModelRule, noul(0.1), c)).toMatchObject({ status: "confirmed", probability: 0.9 });
    expect(judge(c.rules[0] as ModelRule, noul(0.95), c)).toBeNull();
  });

  it("uses a per-rule band", () => {
    const c = cfgWith({ rules: [noulRule("r", { needs_human_band: [0.6, 0.7] })] });
    expect(judge(c.rules[0] as ModelRule, noul(0.5), c)).toBeNull();
  });

  it("scores: direction, threshold and confidence", () => {
    const c = cfgWith({
      rules: [
        { id: "s", type: "score", instructions: "x", criteria: ["good", "ok", "bad", "awful"], threshold: 0.66 },
        { id: "l", type: "score", instructions: "x", criteria: ["bad", "good"], direction: "lower_is_worse", threshold: 0.5 },
      ],
    });
    const [s, l] = c.rules as ModelRule[];
    expect(judge(s!, scoreAnswer(2.4, 4), c)?.status).toBe("confirmed");
    expect(judge(s!, scoreAnswer(2.4, 4, 0.2), c)?.status).toBe("needs_human");
    expect(judge(s!, scoreAnswer(1, 4), c)).toBeNull();
    expect(judge(l!, scoreAnswer(0.2, 2), c)?.probability).toBeCloseTo(0.8);
  });

  it("choices: finding labels decide severity", () => {
    const c = cfgWith({
      rules: [
        {
          id: "c",
          type: "choice",
          instructions: "x",
          criteria: { none: null, xss: null, traversal: null },
          finding_labels: { xss: "major", traversal: "blocker" },
        },
      ],
    });
    const rule = c.rules[0] as ModelRule;
    expect(judge(rule, choiceAnswer({ none: 0.9, xss: 0.05, traversal: 0.05 }), c)).toBeNull();
    const hit = judge(rule, choiceAnswer({ none: 0.1, xss: 0.1, traversal: 0.8 }), c);
    expect(hit).toMatchObject({ status: "confirmed", severity: "blocker", label: "traversal" });
    expect(judge(rule, choiceAnswer({ none: 0.5, xss: 0.45, traversal: 0.05 }), c)?.status).toBe("needs_human");
  });
});

describe("deriveFindings", () => {
  const cfg = cfgWith({ rules: [noulRule("r")] });
  const s = hunk("src/a.ts", ["const q = 'SELECT ' + id;", "run(q);"]);

  it("locates confirmed findings through the where answer", () => {
    const { meta, answers } = answersFor([
      ["q1", { subject: s, role: "verdict", target: "r" }, noul(0.9)],
      ["q2", { subject: s, role: "where", target: "r" }, choiceAnswer({ L001: 0.9, L002: 0.1 })],
    ]);
    const [f] = deriveFindings(meta, answers, cfg);
    expect(f?.location).toEqual({ path: "src/a.ts", line: 1, text: "const q = 'SELECT ' + id;" });
  });

  it("ignores the where answer when the verdict did not fire", () => {
    const { meta, answers } = answersFor([
      ["q1", { subject: s, role: "verdict", target: "r" }, noul(0.05)],
      ["q2", { subject: s, role: "where", target: "r" }, choiceAnswer({ L001: 0.99, L002: 0.01 })],
    ]);
    expect(deriveFindings(meta, answers, cfg)).toEqual([]);
  });

  it("drops the location when the where answer is unsure", () => {
    const { meta, answers } = answersFor([
      ["q1", { subject: s, role: "verdict", target: "r" }, noul(0.9)],
      ["q2", { subject: s, role: "where", target: "r" }, choiceAnswer({ L001: 0.5, L002: 0.5 }, 0.1)],
    ]);
    expect(deriveFindings(meta, answers, cfg)[0]?.location).toBeUndefined();
  });

  it("uses the only added line without a where question", () => {
    const one = hunk("src/b.ts", ["eval(x);"]);
    const { meta, answers } = answersFor([["q1", { subject: one, role: "verdict", target: "r" }, noul(0.8)]]);
    expect(deriveFindings(meta, answers, cfg)[0]?.location?.line).toBe(1);
  });

  it("deduplicates overlapping windows by fingerprint", () => {
    const a = hunk("src/c.ts", ["x();"]);
    const b = { ...hunk("src/c.ts", ["x();"]), key: "other" } as Subject;
    const { meta, answers } = answersFor([
      ["q1", { subject: a, role: "verdict", target: "r" }, noul(0.8)],
      ["q2", { subject: b, role: "verdict", target: "r" }, noul(0.95)],
    ]);
    const findings = deriveFindings(meta, answers, cfg);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.probability).toBe(0.95);
  });
});

describe("abstentions", () => {
  const cfg = cfgWith({
    rules: [
      {
        id: "c",
        type: "choice",
        instructions: "x",
        criteria: { present: null, absent: null, insufficient_context: null },
        finding_labels: { present: "minor" },
        abstain_labels: ["insufficient_context"],
      },
      { id: "plain", type: "choice", instructions: "x", criteria: { present: null, absent: null, insufficient_context: null }, finding_labels: { present: "minor" } },
    ],
  });
  const s = hunk();

  it("counts verdicts answered with an abstain label that did not fire", () => {
    const { meta, answers } = answersFor([
      ["q1", { subject: s, role: "verdict", target: "c" }, choiceAnswer({ present: 0.05, absent: 0.15, insufficient_context: 0.8 })],
      ["q2", { subject: s, role: "verdict", target: "c" }, choiceAnswer({ present: 0.05, absent: 0.9, insufficient_context: 0.05 })],
      ["q3", { subject: s, role: "verdict", target: "c" }, choiceAnswer({ present: 0.45, absent: 0.05, insufficient_context: 0.5 })],
      ["q4", { subject: s, role: "verdict", target: "plain" }, choiceAnswer({ present: 0.05, absent: 0.15, insufficient_context: 0.8 })],
    ]);
    // q3 is a needs-human finding, so it is not an abstention; "plain" declares no abstain labels.
    expect(abstentions(meta, answers, cfg)).toEqual(["c"]);
  });
});

describe("computeComposite", () => {
  it("weights hunks by added lines and dimensions by weight", () => {
    const cfg = cfgWith({
      dimensions: [
        { id: "read", weight: 3, instructions: "x", criteria: ["bad", "ok", "good"] },
        { id: "focus", scope: "pr", weight: 1, instructions: "x", criteria: ["bad", "good"] },
      ],
    });
    const big = hunk("a.ts", ["1", "2", "3"]);
    const small = { ...hunk("b.ts", ["1"]), key: "b" } as Subject;
    const prSubject: Subject = { kind: "pr", key: "pr" };
    const { meta, answers } = answersFor([
      ["q1", { subject: big, role: "dimension", target: "read" }, scoreAnswer(2, 3)],
      ["q2", { subject: small, role: "dimension", target: "read" }, scoreAnswer(0, 3)],
      ["q3", { subject: prSubject, role: "dimension", target: "focus" }, scoreAnswer(0, 2)],
    ]);
    const result = computeComposite(meta, answers, cfg);
    expect(result.dimensions[0]!.value).toBeCloseTo(0.75);
    expect(result.composite).toBeCloseTo((3 * 0.75 + 1 * 0) / 4);
  });

  it("leaves out low-confidence answers", () => {
    const cfg = cfgWith({ dimensions: [{ id: "d", instructions: "x", criteria: ["a", "b"], min_confidence: 0.5 }] });
    const { meta, answers } = answersFor([["q1", { subject: hunk(), role: "dimension", target: "d" }, scoreAnswer(1, 2, 0.1)]]);
    const result = computeComposite(meta, answers, cfg);
    expect(result.composite).toBeUndefined();
    expect(result.dimensions[0]!.lowConfidence).toBe(1);
  });
});

describe("decide", () => {
  const base = { rules: [noulRule("block", { severity: "blocker" }), noulRule("minor", { severity: "minor" }), noulRule("guard", { guard: true })] };
  const finding = (cfg: ReturnType<typeof cfgWith>, id: string, status: Finding["status"] = "confirmed"): Finding => {
    const rule = cfg.rules.filter((r) => r.id === id)[0]!;
    return { rule, severity: rule.severity, status, subject: hunk(), probability: 0.9, fingerprint: id };
  };

  it("requests changes and fails the check on blockers", () => {
    const cfg = cfgWith(base);
    const v = decide([finding(cfg, "block")], undefined, healthy, cfg);
    expect(v).toMatchObject({ event: "REQUEST_CHANGES", failCheck: true });
  });

  it("comment_only keeps the failed check but posts a comment review", () => {
    const cfg = cfgWith({ ...base, output: { review_events: "comment_only" } });
    expect(decide([finding(cfg, "block")], undefined, healthy, cfg)).toMatchObject({ event: "COMMENT", failCheck: true });
  });

  it("does not approve unless enabled", () => {
    const cfg = cfgWith(base);
    expect(decide([], undefined, healthy, cfg).event).toBe("COMMENT");
  });

  it("approves a clean run when enabled", () => {
    const cfg = cfgWith({ ...base, policy: { approve: { enabled: true } } });
    expect(decide([finding(cfg, "minor")], undefined, healthy, cfg).event).toBe("APPROVE");
  });

  it.each<[string, Partial<RunHealth>]>([
    ["errors", { errors: 1 }],
    ["budget skips", { skippedRequests: 2 }],
    ["unreviewed files", { skippedFiles: [{ path: "big.bin", reason: "no_patch" }] }],
    ["abstentions", { abstentions: ["slop.api-mismatch"] }],
  ])("never approves with %s", (_, h) => {
    const cfg = cfgWith({ ...base, policy: { approve: { enabled: true } } });
    expect(decide([], undefined, { ...healthy, ...h }, cfg).event).toBe("COMMENT");
  });

  it("approves despite abstentions when no_abstentions is off", () => {
    const cfg = cfgWith({ ...base, policy: { approve: { enabled: true, no_abstentions: false } } });
    expect(decide([], undefined, { ...healthy, abstentions: ["slop.api-mismatch"] }, cfg).event).toBe("APPROVE");
  });

  it("still approves when only excluded files were skipped", () => {
    const cfg = cfgWith({ ...base, policy: { approve: { enabled: true } } });
    const h = { ...healthy, skippedFiles: [{ path: "a.lock", reason: "excluded" as const }] };
    expect(decide([], undefined, h, cfg).event).toBe("APPROVE");
  });

  it("never approves with guard or uncertain findings, and flags needs-human", () => {
    const cfg = cfgWith({ ...base, policy: { approve: { enabled: true } } });
    const guard = decide([finding(cfg, "guard", "needs_human")], undefined, healthy, cfg);
    expect(guard).toMatchObject({ event: "COMMENT", needsHuman: true });
    expect(decide([finding(cfg, "minor", "needs_human")], undefined, healthy, cfg).event).toBe("COMMENT");
  });

  it("uses composite thresholds", () => {
    const cfg = cfgWith({
      ...base,
      dimensions: [{ id: "d", instructions: "x", criteria: ["a", "b"] }],
      policy: { approve: { enabled: true }, request_changes: { composite_below: 0.3 }, fail_check: { composite_below: 0.2 } },
    });
    expect(decide([], 0.9, healthy, cfg).event).toBe("APPROVE");
    expect(decide([], 0.5, healthy, cfg).event).toBe("COMMENT");
    expect(decide([], 0.25, healthy, cfg)).toMatchObject({ event: "REQUEST_CHANGES", failCheck: false });
    expect(decide([], 0.1, healthy, cfg).failCheck).toBe(true);
  });

  it("fails on errors only when on_error is fail", () => {
    expect(decide([], undefined, { ...healthy, errors: 1 }, cfgWith(base)).failCheck).toBe(false);
    expect(decide([], undefined, { ...healthy, errors: 1 }, cfgWith({ ...base, policy: { on_error: "fail" } })).failCheck).toBe(true);
  });
});

describe("pattern rules", () => {
  const cfg = cfgWith({
    rules: [
      { id: "prefix", type: "pattern", field: "title", regex: "^(feat|fix|chore)(\\([a-z-]+\\))?: ", severity: "minor" },
      { id: "length", type: "pattern", field: "title", regex: "^.{72,}$", fires_when: "match" },
      { id: "no-body", type: "pattern", field: "description", regex: "\\S" },
    ],
  });
  const ids = (title: string, body = "text") => patternFindings(cfg.rules, { title, body }).map((f) => f.rule.id);

  it("fires on no_match and match as configured", () => {
    expect(ids("feat(terminal): add split panes")).toEqual([]);
    expect(ids("Add split panes")).toEqual(["prefix"]);
    expect(ids(`fix: ${"x".repeat(70)}`)).toEqual(["length"]);
    expect(ids("fix: y", "   ")).toEqual(["no-body"]);
  });

  it("rejects invalid regexes in config", () => {
    expect(() => cfgWith({ rules: [{ id: "bad", type: "pattern", field: "title", regex: "(" }] })).toThrow();
  });
});

describe("activeRules", () => {
  const cfg = cfgWith({
    rules: [
      noulRule("feat-only", { scope: "pr", when: { title_matches: "^feat" } }),
      noulRule("main-changed", { scope: "pr", when: { files_changed: ["src/main/**"], files_unchanged: ["docs/**"] } }),
      noulRule("why-quality", { scope: "pr", when: { sections_filled: ["Why"] } }),
      noulRule("ci-only", { scope: "pr", when: { files_only: [".github/**"] } }),
      noulRule("always"),
    ],
  });
  const ids = (title: string, paths: string[], body = "") => activeRules(cfg.rules, { title, body }, paths.map((path) => ({ path }))).map((r) => r.id);

  it("drops rules whose conditions do not hold", () => {
    expect(ids("feat: x", ["src/main/a.ts"])).toEqual(["feat-only", "main-changed", "always"]);
    expect(ids("fix: x", ["src/renderer/a.ts"])).toEqual(["always"]);
    expect(ids("fix: x", ["src/main/a.ts", "docs/a.md"])).toEqual(["always"]);
    expect(ids("fix: x", [".github/workflows/a.yml"])).toEqual(["ci-only", "always"]);
    expect(ids("fix: x", [".github/a.yml", "src/a.ts"])).toEqual(["always"]);
    expect(ids("fix: x", [], "## Why\n<!-- fill me -->")).toEqual(["always"]);
    expect(ids("fix: x", [], "## Why\nUsers lost work.")).toEqual(["why-quality", "always"]);
  });

  it("checks description sections with pattern rules", () => {
    const c = cfgWith({ rules: [{ id: "what", type: "pattern", field: "section:What", regex: "\\S" }] });
    const fired = (body: string) => patternFindings(c.rules, { title: "", body }).length > 0;
    expect(fired("## What\n<!-- Short description -->\n## Why\nx")).toBe(true);
    expect(fired("## Summary\nx")).toBe(true);
    expect(fired("## What\nAdds panes.")).toBe(false);
  });
});
