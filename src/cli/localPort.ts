import type { GitHubPort } from "../ports.js";
import type { ChangedFile } from "../types.js";

/** Read-only GitHub port over a local change; every write is a no-op. */
export function localGitHub(files: ChangedFile[], readFile: (path: string) => string | undefined): GitHubPort {
  const none = async () => [];
  const noop = async () => {};
  return {
    readFile: async (path) => readFile(path),
    listFiles: async () => files,
    listReviewComments: none,
    listReviews: none,
    createReview: noop,
    dismissReview: noop,
    listIssueComments: none,
    createIssueComment: async () => 0,
    updateIssueComment: noop,
    addLabel: noop,
    removeLabel: noop,
    createCheckRun: noop,
  };
}
