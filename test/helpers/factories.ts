import type { ChoiceResponse, NoulResponse, ScoreResponse } from "@typesafe-ai/sdk";
import { ResolvedConfig } from "../../src/config/schema.js";
import { parsePatch } from "../../src/diff/parse.js";
import { hunkSubject } from "../../src/jev/state.js";
import type { PrInfo, Subject } from "../../src/types.js";

export const cfgWith = (raw: Record<string, unknown> = {}) => ResolvedConfig.parse(raw);

export const noulRule = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "noul",
  instructions: `Is ${id} violated?`,
  ...extra,
});

export const noul = (p: number): NoulResponse => ({ type: "noul", noul: p });

export const choiceAnswer = (probabilities: Record<string, number>, confidence = 0.9): ChoiceResponse => {
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
  return { type: "choice", choice, probabilities, confidence };
};

export const scoreAnswer = (score: number, _levels: number, confidence = 0.9): ScoreResponse =>
  ({ type: "score", score, confidence, legend: {}, probabilities: {} }) as unknown as ScoreResponse;

export function hunk(path = "src/a.ts", added = ["const a = 1;", "const b = 2;"]): Subject {
  const patch = `@@ -1,0 +1,${added.length} @@\n${added.map((l) => `+${l}`).join("\n")}`;
  return hunkSubject(`${path}#0`, parsePatch(path, patch)[0]!);
}

export const pr: PrInfo = {
  number: 7,
  title: "Add user search",
  body: "Adds search",
  author: "dev",
  draft: false,
  labels: [],
  baseSha: "base000",
  headSha: "head111",
  isFork: false,
};
