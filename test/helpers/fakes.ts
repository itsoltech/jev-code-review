import type { Question } from "@typesafe-ai/sdk";
import type { ResolvedConfig } from "../../src/config/schema.js";
import { createJevPort } from "../../src/jev/jevPort.js";
import type { CheckAnnotation, ExistingComment, ExistingReview, GitHubPort, ReviewCommentInput } from "../../src/ports.js";
import type { ReviewEvent } from "../../src/policy/verdict.js";
import type { ChangedFile } from "../../src/types.js";

type AnyState = { changes?: { lines?: string[] }; stats?: Record<string, number> };

/** Decides one answer from the request state and question; mimics Jev for pipeline tests. */
export type Oracle = (state: AnyState, question: Question & { instructions?: unknown }) => unknown;

/** Instruction text of a question, flattened, for matching in oracles. */
export const text = (q: { instructions?: unknown }) => JSON.stringify(q.instructions ?? "");

/** Default oracle: nothing fires, scores are mid-to-good, choices pick the first option. */
export const quietOracle: Oracle = (_state, q) => {
  if (q.type === "noul") return { type: "noul", noul: 0.03 };
  if (q.type === "score") {
    const n = q.criteria.length;
    return { type: "score", score: n - 1, confidence: 0.9, legend: {}, probabilities: {} };
  }
  const labels = Object.keys(q.criteria);
  return { type: "choice", choice: labels[0], confidence: 0.9, probabilities: Object.fromEntries(labels.map((l, i) => [l, i === 0 ? 1 : 0])) };
};

export interface FakeJevLog {
  requests: { state: AnyState; questions: Record<string, Question>; model: string }[];
}

/** A fetch that answers /v1/systemone with the oracle; optional HTTP failures first. */
export function fakeFetch(oracle: Oracle, log: FakeJevLog, failures: number[] = []): typeof fetch {
  const pending = [...failures];
  return (async (_url: string, init?: RequestInit) => {
    const status = pending.shift();
    if (status) {
      return new Response(JSON.stringify({ detail: "fail" }), { status, headers: { "content-type": "application/json" } });
    }
    const body = JSON.parse(String(init?.body));
    log.requests.push(body);
    const answers = Object.fromEntries(
      Object.entries(body.questions as Record<string, Question>).map(([k, q]) => [k, oracle(body.state, q)]),
    );
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 1000, output_tokens: 10 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

export function fakeJev(oracle: Oracle, failures: number[] = []) {
  const log: FakeJevLog = { requests: [] };
  const createJev = (_cfg: ResolvedConfig) =>
    createJevPort({
      apiKey: "test-key",
      timeoutMs: 5000,
      maxRetries: 2,
      fetch: fakeFetch(oracle, log, failures) as never,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
  return { createJev, log };
}

export class FakeGitHub implements GitHubPort {
  files: ChangedFile[] = [];
  repoFiles = new Map<string, string>(); // `${ref}:${path}`
  reviewComments: ExistingComment[] = [];
  reviews: (ExistingReview & { event: ReviewEvent; comments: ReviewCommentInput[]; commitId: string })[] = [];
  issueComments: ExistingComment[] = [];
  dismissed: number[] = [];
  labels = new Set<string>();
  checkRuns: { conclusion: string; annotations: CheckAnnotation[] }[] = [];
  writes = 0;
  rejectInline = false;
  private nextId = 100;

  async readFile(path: string, ref: string) {
    return this.repoFiles.get(`${ref}:${path}`);
  }
  async listFiles() {
    return this.files;
  }
  async listReviewComments(marker: string) {
    return this.reviewComments.filter((c) => c.body.includes(marker));
  }
  async listReviews(marker: string) {
    return this.reviews.filter((r) => r.body.includes(marker));
  }
  async createReview(input: { commitId: string; event: ReviewEvent; body: string; comments: ReviewCommentInput[] }) {
    this.writes++;
    if (this.rejectInline && input.comments.length) throw Object.assign(new Error("Line could not be resolved"), { status: 422 });
    const state = { APPROVE: "APPROVED", COMMENT: "COMMENTED", REQUEST_CHANGES: "CHANGES_REQUESTED" }[input.event];
    this.reviews.push({ id: this.nextId++, state, ...input });
    for (const c of input.comments) this.reviewComments.push({ id: this.nextId++, body: c.body });
  }
  async dismissReview(id: number) {
    this.writes++;
    this.dismissed.push(id);
    const review = this.reviews.filter((r) => r.id === id)[0];
    if (review) review.state = "DISMISSED";
  }
  async listIssueComments(marker: string) {
    return this.issueComments.filter((c) => c.body.includes(marker));
  }
  async createIssueComment(body: string) {
    this.writes++;
    const id = this.nextId++;
    this.issueComments.push({ id, body });
    return id;
  }
  async updateIssueComment(id: number, body: string) {
    this.writes++;
    const c = this.issueComments.filter((x) => x.id === id)[0]!;
    c.body = body;
  }
  async addLabel(name: string) {
    this.writes++;
    this.labels.add(name);
  }
  async removeLabel(name: string) {
    this.writes++;
    this.labels.delete(name);
  }
  async createCheckRun(input: { conclusion: string; annotations: CheckAnnotation[] }) {
    this.writes++;
    this.checkRuns.push(input);
  }
}
