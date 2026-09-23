import type { Question } from "@typesafe-ai/sdk";
import type { Subject } from "../types.js";

/**
 * Conservative token estimate for JSON payloads (about 3 characters per token).
 * The SDK has no tokenizer; compare against `usage.input_tokens` when tuning budgets.
 */
export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 3);
}

export interface Limits {
  /** State plus all questions in one request. */
  maxRequestTokens: number;
  /** State plus the longest single question. */
  maxStatePlusQuestionTokens: number;
  /** Questions per request; unlimited when not set. */
  maxQuestions?: number;
}

export interface PlannedRequest {
  subject: Subject;
  state: unknown;
  questions: Record<string, Question>;
  estimatedTokens: number;
}

export interface BatchResult {
  requests: PlannedRequest[];
  /** Question keys dropped because the state alone leaves no room for them. */
  oversized: string[];
}

/**
 * Pack one subject's questions into as few requests as possible (greedy, in order).
 * Every question in a request sees the same state and is answered in parallel.
 */
export function packQuestions(
  subject: Subject,
  state: unknown,
  questions: { key: string; question: Question }[],
  limits: Limits,
): BatchResult {
  const stateTokens = estimateTokens(state);
  const requests: PlannedRequest[] = [];
  const oversized: string[] = [];
  let current: Record<string, Question> = {};
  let tokens = stateTokens;

  const flush = () => {
    if (Object.keys(current).length) requests.push({ subject, state, questions: current, estimatedTokens: tokens });
    current = {};
    tokens = stateTokens;
  };

  for (const { key, question } of questions) {
    const q = estimateTokens(question);
    if (stateTokens + q > limits.maxStatePlusQuestionTokens || stateTokens + q > limits.maxRequestTokens) {
      oversized.push(key);
      continue;
    }
    if (tokens + q > limits.maxRequestTokens || Object.keys(current).length >= (limits.maxQuestions ?? Infinity)) flush();
    current[key] = question;
    tokens += q;
  }
  flush();
  return { requests, oversized };
}
