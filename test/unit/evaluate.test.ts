import { APITimeoutError, BadRequestError, InternalServerError, RateLimitError } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { estimateTokens, packQuestions, type PlannedRequest } from "../../src/jev/batch.js";
import { classifyFailure, emptyEvaluation, evaluate, type JevPort } from "../../src/jev/evaluate.js";
import { hunk } from "../helpers/factories.js";

const noul = { type: "noul" as const, instructions: "x" };
const request = (n: number, tag = "r"): PlannedRequest => {
  const questions = Object.fromEntries(Array.from({ length: n }, (_, i) => [`${tag}${i}`, noul]));
  return { subject: hunk(), state: { s: 1 }, questions, estimatedTokens: estimateTokens({ s: 1 }) + estimateTokens(questions) };
};
const answerAll = (qs: PlannedRequest["questions"]) =>
  Object.fromEntries(Object.keys(qs).map((k) => [k, { type: "noul" as const, noul: 0.1 }]));
const headers = new Headers();
const opts = { model: "jev-1.13.0", concurrency: 4, maxRunTokens: 1e9, signal: new AbortController().signal, sleep: async () => {} };

describe("classifyFailure", () => {
  it("separates transient, too large and fatal errors", () => {
    expect(classifyFailure(new RateLimitError(429, {}, headers, "slow down"))).toBe("transient");
    expect(classifyFailure(new InternalServerError(529, {}, headers, "overloaded"))).toBe("transient");
    expect(classifyFailure(new APITimeoutError(10_000))).toBe("transient");
    expect(classifyFailure(new BadRequestError(400, {}, headers, "context length exceeded"))).toBe("too_large");
    expect(classifyFailure(new Error("bug"))).toBe("fatal");
  });
});

describe("evaluate", () => {
  it("retries rate limits and overload after backoff and lowers concurrency meanwhile", async () => {
    let calls = 0;
    let parallel = 0;
    let peakAfterFailure = 0;
    let failed = false;
    const jev: JevPort = {
      async ask({ questions }) {
        const call = ++calls;
        parallel++;
        if (failed) peakAfterFailure = Math.max(peakAfterFailure, parallel);
        await new Promise((r) => setTimeout(r, 1));
        parallel--;
        if (call <= 2) {
          failed = true;
          throw call === 1 ? new RateLimitError(429, {}, headers, "slow") : new InternalServerError(529, {}, headers, "busy");
        }
        return { model: "jev-1.13.0", answers: answerAll(questions), inputTokens: 10 };
      },
    };
    const reqs = Array.from({ length: 8 }, (_, i) => request(1, `q${i}-`));
    const result = await evaluate(reqs, jev, opts);
    expect(result.errors).toEqual([]);
    expect(result.answers.size).toBe(8);
    expect(result.retries).toBe(2);
    expect(peakAfterFailure).toBeLessThan(4);
  });

  it("gives up after the configured attempts", async () => {
    const jev: JevPort = {
      async ask() {
        throw new RateLimitError(429, {}, headers, "slow");
      },
    };
    const result = await evaluate([request(1)], jev, { ...opts, maxAttempts: 3 });
    expect(result.retries).toBe(2);
    expect(result.errors).toHaveLength(1);
  });

  it("splits requests rejected as too large or timed out until they fit", async () => {
    const sizes: number[] = [];
    const jev: JevPort = {
      async ask({ questions }) {
        const n = Object.keys(questions).length;
        sizes.push(n);
        if (n > 4) throw new BadRequestError(400, {}, headers, "context length exceeded");
        if (n > 2) throw new APITimeoutError(30_000);
        return { model: "jev-1.13.0", answers: answerAll(questions), inputTokens: 5 };
      },
    };
    const result = await evaluate([request(8)], jev, opts);
    expect(result.answers.size).toBe(8);
    expect(result.errors).toEqual([]);
    expect(result.splits).toBe(1 + 2);
    expect(Math.max(...sizes.slice(-4))).toBeLessThanOrEqual(2);
  });

  it("reports a single question that is still too large as an error", async () => {
    const jev: JevPort = {
      async ask() {
        throw new BadRequestError(400, {}, headers, "too long");
      },
    };
    const result = await evaluate([request(1)], jev, opts);
    expect(result.errors).toHaveLength(1);
  });

  it("checks the budget against actual usage, not the chars/3 estimate", async () => {
    const reqs = Array.from({ length: 10 }, (_, i) => request(2, `b${i}-`));
    const estimate = reqs[0]!.estimatedTokens;
    // The API counts a quarter of the estimate, so all ten fit a budget of about four estimates.
    const jev: JevPort = {
      async ask({ questions }) {
        return { model: "jev-1.13.0", answers: answerAll(questions), inputTokens: Math.ceil(estimate / 4) };
      },
    };
    const result = await evaluate(reqs, jev, { ...opts, concurrency: 1, maxRunTokens: estimate * 4 });
    expect(result.skippedRequests).toEqual([]);
    expect(result.answers.size).toBe(20);
  });

  it("marks what the run timeout cut off as skipped with its reason", async () => {
    const controller = new AbortController();
    const jev: JevPort = {
      async ask({ questions }) {
        controller.abort();
        return { model: "jev-1.13.0", answers: answerAll(questions), inputTokens: 1 };
      },
    };
    const result = await evaluate([request(1, "a"), request(1, "b"), request(1, "c")], jev, {
      ...opts,
      concurrency: 1,
      signal: controller.signal,
    });
    expect(result.skippedRequests.map((s) => s.reason)).toEqual(["timeout", "timeout"]);
    expect(emptyEvaluation().splits).toBe(0);
  });
});

describe("packQuestions", () => {
  it("caps questions per request", () => {
    const qs = Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, question: noul }));
    const { requests } = packQuestions(hunk(), { s: 1 }, qs, { maxRequestTokens: 1e6, maxStatePlusQuestionTokens: 1e6, maxQuestions: 4 });
    expect(requests.map((r) => Object.keys(r.questions).length)).toEqual([4, 4, 2]);
  });
});
