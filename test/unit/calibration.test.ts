import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { metrics, outcome, requestFingerprint, type Sample } from "../../scripts/calibration-metrics.js";
import type { ModelRule } from "../../src/config/schema.js";
import { cfgWith, choiceAnswer } from "../helpers/factories.js";

const cfg = cfgWith({ rules: [{ id: "r", type: "choice", instructions: "Judge the change", criteria: { present: null, absent: null, insufficient_context: null }, finding_labels: { present: "minor" }, abstain_labels: ["insufficient_context"], threshold: 0.6, min_confidence: 0.5 }] });
const rule = cfg.rules[0] as ModelRule;
const sample = (overrides: Partial<Sample> = {}): Sample => ({ rowId: "a", ruleId: "r", truth: true, selected: 1, missing: 0, observations: [], filtered: new Set(), ...overrides });
const observation = (p: number, confidence: number) => ({ answer: choiceAnswer({ present: p, absent: 1 - p, insufficient_context: 0 }, confidence) });

describe("calibration production decisions", () => {
  it("does not claim low-confidence probabilities above threshold are confirmed", () => {
    const s = sample({ observations: [observation(0.67, 0.4)] });
    expect(outcome(s, rule, cfg)).toMatchObject({ status: "needs_human", score: 0.67 });
    expect(metrics([s], rule, cfg)).toMatchObject({ tp: 0, humanPos: 1, precision: null, recall: 0 });
  });

  it("keeps a confirmed hunk even when another hunk has higher probability but low confidence", () => {
    const s = sample({ observations: [observation(0.7, 0.7), observation(0.75, 0.4)], selected: 2 });
    expect(outcome(s, rule, cfg)).toMatchObject({ status: "confirmed", score: 0.7 });
    expect(outcome(s, rule, cfg, 0.8).status).toBe("needs_human");
  });

  it("distinguishes absent, missing answers and candidate misses, without dropping rows", () => {
    const clear = sample({ observations: [observation(0, 1)], truth: false });
    const missing = sample({ missing: 1 });
    const filtered = sample({ selected: 0, filtered: new Set(["candidate"]) });
    expect(outcome(clear, rule, cfg).status).toBe("clear");
    expect(outcome(missing, rule, cfg).status).toBe("error");
    expect(outcome(filtered, rule, cfg).status).toBe("not_asked");
    expect(metrics([clear, missing, filtered], rule, cfg)).toMatchObject({ positives: 2, errors: 1, recall: 0 });
  });

  it("counts human noise and abstentions separately from false accusations", () => {
    const human = sample({ truth: false, observations: [observation(0.51, 0.3)] });
    const abstain = sample({ truth: false, observations: [{ answer: choiceAnswer({ present: 0.1, absent: 0.1, insufficient_context: 0.8 }, 0.7) }] });
    expect(metrics([human, abstain], rule, cfg)).toMatchObject({ fp: 0, humanNeg: 1, abstain: 1, precision: null, recall: null });
  });

  it("does not treat unknown labels as clean rows or inflate precision", () => {
    const unknown = sample({ truth: null, observations: [observation(0.9, 0.9)] });
    expect(metrics([unknown], rule, cfg)).toMatchObject({ tp: 0, fp: 0, positives: 0, unknownFindings: 1, precision: null, recall: null });
  });

  it("preserves incomplete coverage even if another hunk is confirmed", () => {
    const s = sample({ missing: 1, selected: 2, observations: [observation(0.9, 0.9)] });
    expect(metrics([s], rule, cfg)).toMatchObject({ tp: 1, errors: 1 });
  });
});

it("rejects replay when model, state or questions differ", () => {
  const request = { state: { code: "before" }, questions: { q1: { type: "noul", instructions: "check" } } };
  const hash = requestFingerprint("jev-1.13.0", [request]);
  expect(requestFingerprint("jev-1.13.0", [request])).toBe(hash);
  expect(requestFingerprint("other", [request])).not.toBe(hash);
  expect(requestFingerprint("jev-1.13.0", [{ ...request, state: { code: "after" } }])).not.toBe(hash);
  expect(requestFingerprint("jev-1.13.0", [{ ...request, questions: { q1: { type: "noul", instructions: "changed" } } }])).not.toBe(hash);
});

it("keeps challenge diff headers consistent with the code sent to Jev", () => {
  const rows = readFileSync(new URL("../../eval/datasets/maintainability-challenge.jsonl", import.meta.url), "utf8").trim().split("\n");
  const ids = new Set<string>();
  for (const raw of rows) {
    const row = JSON.parse(raw) as { id: string; patch: string };
    expect(ids.has(row.id), row.id).toBe(false);
    ids.add(row.id);
    const [header, ...lines] = row.patch.split("\n");
    const counts = /^@@ -\d+,(\d+) \+\d+,(\d+) @@/.exec(header!);
    expect(counts, row.id).not.toBeNull();
    expect(lines.filter((line) => line.startsWith(" ") || line.startsWith("-")).length, row.id).toBe(Number(counts![1]));
    expect(lines.filter((line) => line.startsWith(" ") || line.startsWith("+")).length, row.id).toBe(Number(counts![2]));
  }
});
