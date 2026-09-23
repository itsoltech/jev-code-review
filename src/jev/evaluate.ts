import { APIConnectionError, APIError, RateLimitError } from "@typesafe-ai/sdk";
import type { Answer } from "../types.js";
import { estimateTokens, type PlannedRequest } from "./batch.js";

export interface JevReply {
  model: string;
  answers: Record<string, Answer>;
  inputTokens: number;
}

/** The only way the pipeline talks to TypeSafe. */
export interface JevPort {
  ask(request: { state: unknown; questions: PlannedRequest["questions"]; model: string }, signal: AbortSignal): Promise<JevReply>;
}

export interface EvalError {
  subjectKey: string;
  message: string;
}

export type SkipReason = "budget" | "timeout";

export interface Evaluation {
  answers: Map<string, Answer>;
  errors: EvalError[];
  /** Requests not sent because the run token budget or the run timeout was reached. */
  skippedRequests: { request: PlannedRequest; reason: SkipReason }[];
  inputTokens: number;
  models: Set<string>;
  /** Requests retried after a rate limit, overload, timeout or connection failure. */
  retries: number;
  /** Requests split in half because they were too large or too slow. */
  splits: number;
}

export interface EvaluateOptions {
  model: string;
  /** Upper bound on parallel requests; lowered while the API pushes back and raised again after. */
  concurrency: number;
  maxRunTokens: number;
  signal: AbortSignal;
  /** Attempts per request for transient failures, on top of the SDK's own retries. */
  maxAttempts?: number;
  /** First backoff delay; doubles per attempt. */
  backoffMs?: number;
  /** Injected in tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export function emptyEvaluation(): Evaluation {
  return { answers: new Map(), errors: [], skippedRequests: [], inputTokens: 0, models: new Set(), retries: 0, splits: 0 };
}

type Failure = "transient" | "too_large" | "fatal";

/** 429 and 5xx (529 overloaded) and connection problems pass; 400/413/422 may be a request that is too big. */
export function classifyFailure(e: unknown): Failure {
  if (e instanceof RateLimitError || e instanceof APIConnectionError) return "transient";
  if (e instanceof APIError) {
    if (e.status === 408 || e.status === 429 || e.status >= 500) return "transient";
    if (e.status === 400 || e.status === 413 || e.status === 422) return "too_large";
  }
  return "fatal";
}

const isTimeout = (e: unknown) => e instanceof Error && e.name === "APITimeoutError";

/** Split a request into two with half of the questions each; the state is shared. */
export function splitRequest(req: PlannedRequest): [PlannedRequest, PlannedRequest] | undefined {
  const entries = Object.entries(req.questions);
  if (entries.length < 2) return undefined;
  const half = Math.ceil(entries.length / 2);
  const make = (part: typeof entries): PlannedRequest => {
    const questions = Object.fromEntries(part);
    return { ...req, questions, estimatedTokens: estimateTokens(req.state) + estimateTokens(questions) };
  };
  return [make(entries.slice(0, half)), make(entries.slice(half))];
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

/**
 * Send planned requests through a work queue:
 * - rate limits, overload, timeouts and connection failures are retried with backoff after the
 *   SDK's own retries, and the number of parallel requests is halved while they happen;
 * - a request the API rejects as too large, or one that times out, is split in half;
 * - the run token budget is checked against actual usage, with estimates scaled by the ratio of
 *   actual to estimated tokens seen so far;
 * - whatever is left when the run timeout fires is reported as skipped, not failed.
 */
export async function evaluate(
  requests: PlannedRequest[],
  jev: JevPort,
  opts: EvaluateOptions,
  into: Evaluation = emptyEvaluation(),
): Promise<Evaluation> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const backoffMs = opts.backoffMs ?? 2000;
  const sleep = opts.sleep ?? defaultSleep;
  const queue = requests.map((request) => ({ request, attempt: 0 }));
  let limit = Math.max(1, opts.concurrency);
  let inFlight = 0;
  let reserved = 0;
  let estimated = 0;
  let actual = 0;
  let calmStreak = 0;

  // chars/3 overestimates; once replies arrive, scale estimates by what the API really counted.
  const projected = (req: PlannedRequest) => Math.ceil(req.estimatedTokens * (estimated > 0 ? Math.min(1, actual / estimated) : 1));

  const pushBack = () => {
    limit = Math.max(1, Math.floor(limit / 2));
    calmStreak = 0;
  };

  const handle = async (job: { request: PlannedRequest; attempt: number }): Promise<void> => {
    const req = job.request;
    const cost = projected(req);
    if (opts.signal.aborted) return void into.skippedRequests.push({ request: req, reason: "timeout" });
    if (into.inputTokens + reserved + cost > opts.maxRunTokens) return void into.skippedRequests.push({ request: req, reason: "budget" });
    reserved += cost;
    try {
      const reply = await jev.ask({ state: req.state, questions: req.questions, model: opts.model }, opts.signal);
      into.models.add(reply.model);
      into.inputTokens += reply.inputTokens;
      estimated += req.estimatedTokens;
      actual += reply.inputTokens;
      for (const [key, answer] of Object.entries(reply.answers)) into.answers.set(key, answer);
      if (++calmStreak >= 4 && limit < opts.concurrency) {
        limit++;
        calmStreak = 0;
      }
    } catch (e) {
      if (opts.signal.aborted) return void into.skippedRequests.push({ request: req, reason: "timeout" });
      const failure = classifyFailure(e);
      const halves = (failure === "too_large" || isTimeout(e)) && splitRequest(req);
      if (halves) {
        // Smaller requests fit the context limits and answer faster.
        into.splits++;
        queue.unshift(...halves.map((request) => ({ request, attempt: job.attempt })));
        return;
      }
      if (failure === "transient" && job.attempt + 1 < maxAttempts) {
        into.retries++;
        pushBack();
        const hinted = e instanceof RateLimitError ? e.retryAfterMs : undefined;
        await sleep(hinted ?? backoffMs * 2 ** job.attempt * (0.75 + Math.random() * 0.5), opts.signal);
        queue.push({ request: req, attempt: job.attempt + 1 });
        return;
      }
      into.errors.push({ subjectKey: req.subject.key, message: errorMessage(e) });
    } finally {
      reserved -= cost;
    }
  };

  await new Promise<void>((resolve) => {
    const pump = () => {
      while (inFlight < limit && queue.length) {
        const job = queue.shift()!;
        inFlight++;
        void handle(job).finally(() => {
          inFlight--;
          pump();
        });
      }
      if (!inFlight && !queue.length) resolve();
    };
    pump();
  });
  return into;
}

/** Short, single-line error text; API error bodies can be long and are never needed in full. */
export function errorMessage(e: unknown): string {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return text.replace(/\s+/g, " ").slice(0, 300);
}
