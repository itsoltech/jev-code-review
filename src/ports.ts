import type { ReviewEvent } from "./policy/verdict.js";
import type { ChangedFile } from "./types.js";

export interface ReviewCommentInput {
  path: string;
  line: number;
  body: string;
}

export interface ExistingComment {
  id: number;
  body: string;
}

export interface ExistingReview {
  id: number;
  state: string;
  body: string;
}

export interface CheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "failure" | "warning" | "notice";
  title: string;
  message: string;
}

/** Everything the pipeline needs from GitHub; implemented with Octokit and faked in tests. */
export interface GitHubPort {
  /** Read a file at a commit; undefined when missing. */
  readFile(path: string, ref: string): Promise<string | undefined>;
  listFiles(): Promise<ChangedFile[]>;
  /** Inline review comments on the PR whose body contains `marker`. */
  listReviewComments(marker: string): Promise<ExistingComment[]>;
  /** Reviews on the PR whose body contains `marker`. */
  listReviews(marker: string): Promise<ExistingReview[]>;
  createReview(input: { commitId: string; event: ReviewEvent; body: string; comments: ReviewCommentInput[] }): Promise<void>;
  dismissReview(id: number, message: string): Promise<void>;
  /** Issue comments on the PR whose body contains `marker`. */
  listIssueComments(marker: string): Promise<ExistingComment[]>;
  createIssueComment(body: string): Promise<number>;
  updateIssueComment(id: number, body: string): Promise<void>;
  addLabel(name: string): Promise<void>;
  removeLabel(name: string): Promise<void>;
  createCheckRun(input: {
    headSha: string;
    conclusion: "success" | "failure" | "neutral";
    title: string;
    summary: string;
    annotations: CheckAnnotation[];
  }): Promise<void>;
}
