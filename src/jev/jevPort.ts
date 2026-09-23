import { TypeSafeClient, type Fetch, type Logger } from "@typesafe-ai/sdk";
import type { Answer } from "../types.js";
import type { JevPort } from "./evaluate.js";

export interface JevClientOptions {
  apiKey: string;
  timeoutMs: number;
  logger: Logger;
  /** Injected in tests to replay recorded responses. */
  fetch?: Fetch;
  maxRetries?: number;
}

export function createJevPort(opts: JevClientOptions): JevPort {
  const client = new TypeSafeClient({
    apiKey: opts.apiKey,
    timeout: opts.timeoutMs,
    // Debug level logs request bodies (the diff); never allow it, even via TYPESAFE_LOG_LEVEL.
    logLevel: "warn",
    logger: opts.logger,
    retry: { maxRetries: opts.maxRetries ?? 3 },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  return {
    async ask({ state, questions, model }, signal) {
      const result = await client.systemOne({ state: state as never, questions, model }, { signal });
      return {
        model: result.model,
        answers: result.answers as Record<string, Answer>,
        inputTokens: result.usage.input_tokens,
      };
    },
  };
}
