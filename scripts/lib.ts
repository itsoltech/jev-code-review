import { readFileSync } from "node:fs";
import type { GitHubPort } from "../src/ports.js";
import type { ChangedFile } from "../src/types.js";

/** Split `git diff` output into per-file patches shaped like GitHub's pulls.listFiles. */
export function filesFromGitDiff(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const section of diff.split(/^diff --git /m).slice(1)) {
    const header = section.slice(0, section.indexOf("\n"));
    const path = /\sb\/(.+)$/.exec(header)?.[1] ?? header;
    const start = section.search(/^@@ /m);
    const patch = start >= 0 ? section.slice(start) : undefined;
    const lines = patch?.split("\n") ?? [];
    files.push({
      path,
      status: /^deleted file/m.test(section) ? "removed" : /^new file/m.test(section) ? "added" : "modified",
      additions: lines.filter((l) => l.startsWith("+")).length,
      deletions: lines.filter((l) => l.startsWith("-")).length,
      ...(patch ? { patch } : {}),
    });
  }
  return files;
}

/** Read-only GitHub port over local files; every write is a no-op. */
export function localGitHub(files: ChangedFile[], configPath?: string): GitHubPort {
  const none = async () => [];
  const noop = async () => {};
  return {
    readFile: async (path) => (configPath && path === ".github/jev-review.yml" ? readFileSync(configPath, "utf8") : undefined),
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

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function requireKey(): string {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) {
    console.error("Set TYPESAFE_API_KEY first.");
    process.exit(2);
  }
  return key;
}

export const quietLogger = { debug() {}, info() {}, warn: console.warn, error: console.error };
